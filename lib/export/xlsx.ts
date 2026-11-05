// Tabulka → .xlsx (exceljs). Každá tabulka exportu je jeden list: tučné
// záhlaví v prvním řádku, zmrazený první řádek, automatický filtr, šířky
// podle obsahu a číselné formáty (Kč, datum d. m. rrrr). Poslední list
// „Informace" nese název přehledu, filtry, datum exportu a firmu.
//
// Textové hodnoty jdou do buňky vždy jako text (ne vzorec): exceljs zapisuje
// řetězec jako sdílený text, takže „=SUMA(…)" ve jménu firmy Excel nespustí.
import ExcelJS from 'exceljs'
import {
  columnTotals, filtersLine, formatCell, formatDateTimeText, hasTotals, toExcelDate, toNumber,
  type ExportCellType, type ExportDocument, type ExportTable, type ExportValue,
} from './table'

/** Excelové formáty buněk (kód formátu je v anglické syntaxi, Excel ho zobrazí podle jazyka). */
export const XLSX_NUM_FMT: Readonly<Record<ExportCellType, string | null>> = {
  text: null,
  number: null, // obecný formát Excelu: celé číslo bez desetinné čárky, desetinné jen když jsou
  czk: '#,##0 "Kč"',
  percent: '0" %"',
  date: 'd. m. yyyy',
  datetime: 'd. m. yyyy h:mm',
}

// Ne 9: exceljs šířku 9 bere jako výchozí a do souboru ji nezapíše.
const MIN_WIDTH = 10
const MAX_WIDTH = 60
const WIDTH_SAMPLE = 2000
const INFO_SHEET = 'Informace'

/** Název listu: max. 31 znaků, bez []:*?/\ a jedinečný v sešitu. */
export function sheetName(title: string, taken: Set<string>): string {
  const clean = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'List'
  let name = clean.slice(0, 31)
  for (let i = 2; taken.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`
    name = clean.slice(0, 31 - suffix.length) + suffix
  }
  taken.add(name.toLowerCase())
  return name
}

/** Šířka sloupce ve znacích podle nejdelšího textu (záhlaví i hodnoty). */
export function columnWidth(header: string, values: readonly string[]): number {
  let longest = header.length + 2 // + místo na šipku filtru
  for (const v of values) {
    for (const line of v.split('\n')) longest = Math.max(longest, line.length)
  }
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest + 2))
}

function cellValue(v: ExportValue, type: ExportCellType): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'boolean') return v ? 'ano' : 'ne'
  if (type === 'number' || type === 'czk' || type === 'percent') return toNumber(v) ?? String(v)
  if (type === 'date' || type === 'datetime') return toExcelDate(v, type) ?? String(v)
  return String(v)
}

function columnLetter(n: number): string {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

/** Text do patičky tisku; & je v Excelu řídicí znak patičky. */
function footerText(t: string): string {
  return t.replace(/&/g, '&&')
}

function addTableSheet(wb: ExcelJS.Workbook, table: ExportTable, name: string): void {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
    // Tisk z Excelu: A4 na šířku, všechny sloupce na šířku stránky, záhlaví na každé stránce.
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printTitlesRow: '1:1', margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L${footerText(name)}&RStrana &P z &N` },
  })
  const types = table.columns.map((c) => c.type ?? 'text')

  ws.columns = table.columns.map((c, i) => {
    const sample = table.rows.slice(0, WIDTH_SAMPLE).map((r) => formatCell(r[i], types[i]))
    const fmt = XLSX_NUM_FMT[types[i]]
    return {
      header: c.header,
      key: `c${i}`,
      width: columnWidth(c.header, sample),
      style: fmt ? { numFmt: fmt } : {},
    }
  })

  const header = ws.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle', wrapText: true }
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEDE8' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF8A8F98' } } }
  })

  for (const row of table.rows) {
    const added = ws.addRow(row.map((v, i) => cellValue(v, types[i])))
    added.alignment = { vertical: 'top', wrapText: true }
  }

  const last = table.rows.length + 1
  if (table.columns.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, last), column: table.columns.length } }
  }

  // Řádek „Celkem": SUBTOTAL(109) sčítá jen řádky, které filtr nechal viditelné.
  if (hasTotals(table)) {
    const totals = columnTotals(table)
    const values: ExcelJS.CellValue[] = table.columns.map((_, i) => {
      if (totals[i] === null) return null
      const col = columnLetter(i + 1)
      return { formula: `SUBTOTAL(109,${col}2:${col}${last})`, result: totals[i]! }
    })
    if (values[0] === null) values[0] = 'Celkem'
    const totalRow = ws.addRow([])
    totalRow.values = values
    totalRow.font = { bold: true }
    totalRow.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FF8A8F98' } } } })
  }

  if (table.rows.length === 0) {
    ws.getCell('A2').value = table.emptyText ?? 'Žádné záznamy pro zvolené filtry.'
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF5A616B' } }
  }
}

function addInfoSheet(wb: ExcelJS.Workbook, doc: ExportDocument, name: string): void {
  const ws = wb.addWorksheet(name)
  ws.columns = [{ width: 22 }, { width: 80 }]
  const rows: [string, string][] = [
    ['Přehled', doc.title],
    ['Firma', doc.companyName],
    ['Datum exportu', formatDateTimeText(doc.generatedAt)],
    ...(doc.generatedBy ? [['Exportoval/a', doc.generatedBy] as [string, string]] : []),
    ['Filtry', filtersLine(doc.filters).replace(/^Filtry: /, '')],
    ...doc.tables.map((t) => [`List „${t.title}"`, `${t.rows.length} řádků`] as [string, string]),
  ]
  ws.addRow([doc.title]).font = { bold: true, size: 14 }
  ws.addRow([])
  for (const r of rows) {
    const added = ws.addRow(r)
    added.getCell(1).font = { bold: true }
    added.getCell(2).alignment = { wrapText: true, vertical: 'top' }
  }
}

/** Sestaví sešit (bez zápisu) — testy čtou listy přímo. */
export function buildWorkbook(doc: ExportDocument): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = doc.companyName
  wb.title = doc.title
  wb.created = doc.generatedAt
  wb.modified = doc.generatedAt
  const taken = new Set<string>([INFO_SHEET.toLowerCase()])
  for (const table of doc.tables) addTableSheet(wb, table, sheetName(table.title, taken))
  addInfoSheet(wb, doc, INFO_SHEET)
  return wb
}

/** ExportDocument → bajty .xlsx. */
export async function renderXlsx(doc: ExportDocument): Promise<Uint8Array> {
  const buf = await buildWorkbook(doc).xlsx.writeBuffer()
  return new Uint8Array(buf as ArrayBuffer)
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
