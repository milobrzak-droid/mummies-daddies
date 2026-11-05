// Tabulka → PDF (A4 na šířku). Hlavička s názvem přehledu, filtry, datem
// exportu a firmou; tabulka se zalomeným textem, stránkováním a opakovaným
// záhlavím na každé stránce; patička „Firma · Přehled" a „Strana X z Y".
//
// Rozvržení (šířky sloupců, zalomení, stránkování) jsou čisté funkce nad
// měřením textu, aby šly testovat bez kreslení.
import type { PDFFont, PDFPage } from 'pdf-lib'
import {
  A4_LANDSCAPE, COLORS, createPdf, drawText, drawTextRight, hLine, measureWith, pdfSafeText, stampFooters, wrapText,
  type FontBytes, type MeasureFn, type PdfFonts,
} from './pdfKit'
import {
  columnTotals, filtersLine, formatCell, formatCzkText, formatDateTimeText, hasTotals, isNumericType,
  type ExportCellType, type ExportDocument, type ExportTable,
} from './table'

export const PDF_CONTENT_TYPE = 'application/pdf'

const MARGIN = 32
const FOOTER_SPACE = 30
const CELL_PAD_X = 4
const CELL_PAD_Y = 3
/** Nejvýš řádků textu v jedné buňce; zbytek se ořízne „…" (celý text je v Excelu). */
export const MAX_CELL_LINES = 8
/** Slovo delší než tohle (URL, e-mail) se smí rozdělit; kratší ne. */
const MAX_WORD = 90

type Sizes = { body: number; header: number; line: number }
const NORMAL: Sizes = { body: 8.5, header: 8.5, line: 10.6 }
const SMALL: Sizes = { body: 7.2, header: 7.2, line: 9 }

/** Sloupce, které se nezalamují (čísla, data): dostanou celou svou šířku. */
export function isFixedType(type: ExportCellType | undefined): boolean {
  return isNumericType(type) || type === 'date' || type === 'datetime'
}

/**
 * Šířky sloupců. Pevné sloupce (čísla, data) dostanou přirozenou šířku,
 * textové nejdřív své minimum (nejdelší slovo — slova se pak nedělí) a zbytek
 * místa „vodováhou": sloupec, kterému chybí málo, dostane, co potřebuje;
 * ostatní se podělí poměrně k tomu, co jim do přirozené šířky chybí. Co zbude,
 * jde poměrně textovým sloupcům. Součet = `available`.
 */
export function computeColumnWidths(
  natural: readonly number[],
  fixed: readonly boolean[],
  minWidth: readonly number[],
  available: number,
): number[] {
  const n = natural.length
  if (n === 0) return []
  const base = natural.map((w, i) => (fixed[i] ? w : Math.min(minWidth[i], w)))
  const baseSum = base.reduce((a, b) => a + b, 0)
  const flexible = natural.map((_, i) => i).filter((i) => !fixed[i])
  if (baseSum >= available || flexible.length === 0) {
    // Nevejde se ani minimum (nebo nic pružného není): poměrně zmenšit/zvětšit vše.
    return base.map((w) => (w / (baseSum || 1)) * available)
  }
  const widths = [...base]
  let budget = available - baseSum
  let open = flexible.filter((i) => natural[i] > base[i])
  while (open.length > 0 && budget > 0) {
    const share = budget / open.length
    const need = (i: number) => natural[i] - widths[i]
    const small = open.filter((i) => need(i) <= share)
    if (small.length === 0) {
      const sum = open.reduce((acc, i) => acc + need(i), 0)
      for (const i of open) widths[i] += (need(i) / sum) * budget
      budget = 0
      break
    }
    for (const i of small) {
      budget -= need(i)
      widths[i] = natural[i]
    }
    open = open.filter((i) => !small.includes(i))
  }
  if (budget > 0.5) {
    const sum = flexible.reduce((acc, i) => acc + widths[i], 0) || 1
    for (const i of flexible) widths[i] += (widths[i] / sum) * budget
  }
  return widths
}

/**
 * Stránkování: výšky řádků → index stránky každého řádku. `firstSpace` je
 * místo pro řádky na první stránce tabulky (pod nadpisem a záhlavím),
 * `pageSpace` na každé další (pod opakovaným záhlavím).
 */
export function paginateRows(heights: readonly number[], firstSpace: number, pageSpace: number): number[] {
  const out: number[] = []
  let page = 0
  let left = firstSpace
  for (const h of heights) {
    // Na čerstvé stránce se řádek vykreslí vždy (víc místa už nebude).
    if (h > left && left < pageSpace) {
      page += 1
      left = pageSpace
    }
    out.push(page)
    left -= h
  }
  return out
}

type CellLayout = { lines: string[]; align: 'left' | 'right' }
type RowLayout = { cells: CellLayout[]; height: number; bold?: boolean }

export type TableLayout = {
  widths: number[]
  header: RowLayout
  rows: RowLayout[]
  sizes: Sizes
}

/** Rozvržení tabulky pro danou šířku (čisté — jen měří text). */
export function layoutTable(table: ExportTable, fonts: { body: MeasureFn; bold: MeasureFn; bodySmall: MeasureFn; boldSmall: MeasureFn; safe: (t: string, bold?: boolean) => string }, available: number): TableLayout {
  const types = table.columns.map((c) => c.type ?? 'text')
  const totals = hasTotals(table) ? columnTotals(table) : null
  const texts = table.rows.map((r) => r.map((v, i) => fonts.safe(formatCell(v, types[i]))))
  const totalTexts = totals?.map((t, i) => (t === null ? (i === 0 ? 'Celkem' : '') : types[i] === 'czk' ? formatCzkText(t) : formatCell(t, types[i])))
  const headers = table.columns.map((c) => fonts.safe(c.header, true))

  const measureAll = (small: boolean) => {
    const body = small ? fonts.bodySmall : fonts.body
    const bold = small ? fonts.boldSmall : fonts.bold
    // Záhlaví se smí zalomit, šířku sloupce tak určuje obsah a nejdelší slovo záhlaví.
    const headerWord = (h: string) => Math.max(...h.split(' ').map((word) => bold(word)))
    const natural = table.columns.map((_, i) => {
      let w = headerWord(headers[i])
      for (const row of texts.slice(0, 500)) for (const line of row[i].split('\n')) w = Math.max(w, body(line))
      if (totalTexts) w = Math.max(w, bold(totalTexts[i]))
      return Math.min(w, 260) + CELL_PAD_X * 2
    })
    // Minimum = nejdelší slovo záhlaví i obsahu (nejvýš MAX_WORD), ať se slova nedělí.
    const min = headers.map((h, i) => {
      let w = Math.max(headerWord(h), 24)
      for (const row of texts.slice(0, 500)) {
        for (const word of row[i].split(/\s+/)) if (word) w = Math.max(w, Math.min(body(word), MAX_WORD))
      }
      return w + CELL_PAD_X * 2
    })
    return { natural, min, body, bold }
  }

  let small = false
  let m = measureAll(false)
  const fixed = types.map(isFixedType)
  const fixedSum = m.natural.reduce((s, w, i) => s + (fixed[i] ? w : 0), 0)
  const minSum = m.min.reduce((s, w) => s + w, 0)
  if (fixedSum > available * 0.6 || minSum > available) {
    small = true
    m = measureAll(true)
  }
  const sizes = small ? SMALL : NORMAL
  // Když je místa dost, ať se nezalamuje ani záhlaví čísel a dat („Počet obchodů").
  const full = m.natural.map((w, i) => (fixed[i] ? Math.max(w, m.bold(headers[i]) + CELL_PAD_X * 2) : w))
  const natural = full.reduce((a, b) => a + b, 0) <= available ? full : m.natural
  const widths = computeColumnWidths(natural, fixed, m.min, available)

  const layoutRow = (cells: string[], measure: MeasureFn, bold = false, header = false): RowLayout => {
    const laid = cells.map((text, i) => ({
      // Čísla a data se nezalamují (mají svou šířku); záhlaví a text ano.
      lines: fixed[i] && !header ? [text] : wrapText(text, measure, Math.max(8, widths[i] - CELL_PAD_X * 2), MAX_CELL_LINES),
      align: (isNumericType(types[i]) ? 'right' : 'left') as 'left' | 'right',
    }))
    const lines = Math.max(1, ...laid.map((c) => c.lines.length))
    return { cells: laid, height: lines * sizes.line + CELL_PAD_Y * 2, bold }
  }

  const header = layoutRow(headers, m.bold, true, true)
  const rows = texts.map((r) => layoutRow(r, m.body))
  if (totalTexts) rows.push(layoutRow(totalTexts, m.bold, true))
  return { widths, header, rows, sizes }
}

// --- Kreslení -------------------------------------------------------------------

type Ctx = {
  doc: ExportDocument
  fonts: PdfFonts
  pdf: Awaited<ReturnType<typeof createPdf>>['pdf']
  page: PDFPage
  y: number
  pageWidth: number
  pageHeight: number
}

const contentWidth = (c: Ctx) => c.pageWidth - MARGIN * 2
const bottomLimit = MARGIN + FOOTER_SPACE - 10
/** Výška hlavičky pokračovací stránky (název přehledu a čára). */
const CONTINUATION_HEADER = 26

function drawFirstHeader(c: Ctx): void {
  const { fonts, doc, page } = c
  const right = c.pageWidth - MARGIN
  let y = c.pageHeight - MARGIN
  drawText(page, doc.companyName, MARGIN, y - 8, { font: fonts.bold, size: 9, color: COLORS.accent })
  drawTextRight(page, `Exportováno ${formatDateTimeText(doc.generatedAt)}${doc.generatedBy ? ` · ${doc.generatedBy}` : ''}`, right, y - 8, { font: fonts.regular, size: 8, color: COLORS.muted })
  y -= 30
  drawText(page, doc.title, MARGIN, y, { font: fonts.bold, size: 17 })
  y -= 16
  const filterLines = wrapText(pdfSafeText(filtersLine(doc.filters), fonts.regular), measureWith(fonts.regular, 8.5), contentWidth(c), 3)
  for (const line of filterLines) {
    drawText(page, line, MARGIN, y, { font: fonts.regular, size: 8.5, color: COLORS.muted })
    y -= 11
  }
  y -= 4
  hLine(page, MARGIN, right, y, COLORS.ink, 0.8)
  c.y = y - 12
}

function drawContinuationHeader(c: Ctx): void {
  const { fonts, doc, page } = c
  const right = c.pageWidth - MARGIN
  const y = c.pageHeight - MARGIN - 8
  drawText(page, doc.title, MARGIN, y, { font: fonts.bold, size: 9.5 })
  drawTextRight(page, doc.companyName, right, y, { font: fonts.regular, size: 8, color: COLORS.muted })
  hLine(page, MARGIN, right, y - 6)
  c.y = c.pageHeight - MARGIN - CONTINUATION_HEADER
}

function newPage(c: Ctx): void {
  c.page = c.pdf.addPage(A4_LANDSCAPE)
  drawContinuationHeader(c)
}

function drawRow(c: Ctx, row: RowLayout, widths: number[], sizes: Sizes, fill: 'header' | 'zebra' | null): void {
  const { page, fonts } = c
  const font: PDFFont = row.bold ? fonts.bold : fonts.regular
  const size = row.bold && fill === 'header' ? sizes.header : sizes.body
  const top = c.y
  if (fill) {
    page.drawRectangle({
      x: MARGIN, y: top - row.height, width: contentWidth(c), height: row.height,
      color: fill === 'header' ? COLORS.headerFill : COLORS.zebra,
    })
  }
  let x = MARGIN
  row.cells.forEach((cell, i) => {
    let baseline = top - CELL_PAD_Y - size
    for (const line of cell.lines) {
      if (cell.align === 'right') drawTextRight(page, line, x + widths[i] - CELL_PAD_X, baseline, { font, size })
      else drawText(page, line, x + CELL_PAD_X, baseline, { font, size })
      baseline -= sizes.line
    }
    x += widths[i]
  })
  if (fill === 'header') hLine(page, MARGIN, MARGIN + contentWidth(c), top - row.height, COLORS.muted, 0.7)
  c.y = top - row.height
}

function drawTable(c: Ctx, table: ExportTable, showTitle: boolean): void {
  const { fonts } = c
  const measure = {
    body: measureWith(fonts.regular, NORMAL.body),
    bold: measureWith(fonts.bold, NORMAL.header),
    bodySmall: measureWith(fonts.regular, SMALL.body),
    boldSmall: measureWith(fonts.bold, SMALL.header),
    safe: (t: string, bold?: boolean) => pdfSafeText(t, bold ? fonts.bold : fonts.regular),
  }
  const layout = layoutTable(table, measure, contentWidth(c))
  const titleSpace = showTitle ? 20 + (table.note ? 12 : 0) : 0
  const firstRow = layout.rows[0]?.height ?? 16
  if (c.y - titleSpace - layout.header.height - firstRow < bottomLimit) newPage(c)

  if (showTitle) {
    drawText(c.page, table.title, MARGIN, c.y - 11, { font: fonts.bold, size: 11.5 })
    c.y -= 17
    if (table.note) {
      drawText(c.page, table.note, MARGIN, c.y - 8, { font: fonts.regular, size: 8, color: COLORS.muted })
      c.y -= 12
    }
    c.y -= 3
  }

  if (table.rows.length === 0) {
    drawText(c.page, table.emptyText ?? 'Žádné záznamy pro zvolené filtry.', MARGIN, c.y - 10, { font: fonts.regular, size: 9, color: COLORS.muted })
    c.y -= 26
    return
  }

  drawRow(c, layout.header, layout.widths, layout.sizes, 'header')
  const totalsIndex = hasTotals(table) ? layout.rows.length - 1 : -1
  const pageSpace = c.pageHeight - MARGIN - CONTINUATION_HEADER - layout.header.height - bottomLimit
  const pages = paginateRows(layout.rows.map((r) => r.height), c.y - bottomLimit, pageSpace)
  layout.rows.forEach((row, i) => {
    if (pages[i] !== (i === 0 ? 0 : pages[i - 1])) {
      newPage(c)
      drawRow(c, layout.header, layout.widths, layout.sizes, 'header')
    }
    if (i === totalsIndex) hLine(c.page, MARGIN, MARGIN + contentWidth(c), c.y, COLORS.ink, 0.8)
    drawRow(c, row, layout.widths, layout.sizes, i % 2 === 1 && i !== totalsIndex ? 'zebra' : null)
  })
  c.y -= 18
}

/** ExportDocument → bajty PDF (A4 na šířku). `fonts` jen pro testy (jinak z lib/export/fonts). */
export async function renderTablePdf(doc: ExportDocument, fontBytes?: FontBytes): Promise<Uint8Array> {
  const { pdf, fonts } = await createPdf({ title: `${doc.title} — ${doc.companyName}`, author: doc.companyName, subject: filtersLine(doc.filters) }, fontBytes)
  const page = pdf.addPage(A4_LANDSCAPE)
  const [pageWidth, pageHeight] = A4_LANDSCAPE
  const c: Ctx = { doc, fonts, pdf, page, y: 0, pageWidth, pageHeight }
  drawFirstHeader(c)
  const showTitles = doc.tables.length > 1 || doc.tables.some((t) => t.note)
  for (const table of doc.tables) drawTable(c, table, showTitles)
  stampFooters(pdf, fonts, `${doc.companyName} · ${doc.title}`, MARGIN)
  return pdf.save()
}
