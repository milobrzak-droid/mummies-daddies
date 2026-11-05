import ExcelJS from 'exceljs'
import { describe, expect, test } from 'vitest'
import { buildWorkbook, columnWidth, renderXlsx, sheetName, XLSX_NUM_FMT } from '@/lib/export/xlsx'
import {
  asciiSlug, columnTotals, exportFileName, filtersLine, formatCell, toExcelDate, toExportTable, type ExportDocument,
} from '@/lib/export/table'

// lib/export/table.ts a lib/export/xlsx.ts: tabulka → .xlsx. Soubor se
// vyrenderuje do bajtů a znovu načte exceljs, takže test vidí totéž co Excel.

const DOC: ExportDocument = {
  title: 'Obchody',
  companyName: 'Mummies and Daddies',
  filters: [{ label: 'Stav', value: 'otevřené' }, { label: 'Hledání', value: '„Šťastná"' }],
  generatedAt: new Date('2026-11-05T13:03:00Z'),
  generatedBy: 'Jana Dvořáková',
  fileBase: 'obchody',
  tables: [{
    title: 'Obchody',
    columns: [
      { header: 'Klient' },
      { header: 'Hodnota', type: 'czk', total: true },
      { header: 'Follow-up', type: 'date' },
      { header: 'Poslední aktivita', type: 'datetime' },
      { header: 'Hosté', type: 'number' },
    ],
    rows: [
      ['Účetní kancelář Šťastná s.r.o.', '186000.00', '2026-11-10', '2026-11-03T13:45:00Z', 120],
      ['=SUM(A1:A9)', 96750, null, '2026-11-04T23:30:00Z', null],
      ['Žluťoučký kůň', null, '2026-12-31', null, 8],
    ],
  }],
}

async function reload(doc: ExportDocument) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load((await renderXlsx(doc)) as never)
  return wb
}

describe('formát buněk (table.ts)', () => {
  test('Kč, datum a okamžik česky v pásmu firmy', () => {
    expect(formatCell('186000.00', 'czk')).toBe('186 000 Kč')
    expect(formatCell('2026-11-10', 'date')).toBe('10. 11. 2026')
    // 23:30 UTC 4. 11. je v Praze už 5. 11. 0:30.
    expect(formatCell('2026-11-04T23:30:00Z', 'date')).toBe('5. 11. 2026')
    expect(formatCell('2026-11-04T23:30:00Z', 'datetime')).toBe('5. 11. 2026 0:30')
    expect(formatCell(true)).toBe('ano')
    expect(formatCell(null, 'czk')).toBe('')
  })

  test('toExcelDate: kalendářní den bez posunu, okamžik v pražském čase', () => {
    expect(toExcelDate('2026-11-10', 'date')!.toISOString()).toBe('2026-11-10T00:00:00.000Z')
    expect(toExcelDate('2026-07-01T10:15:00Z', 'datetime')!.toISOString()).toBe('2026-07-01T12:15:00.000Z')
    expect(toExcelDate('nesmysl', 'date')).toBeNull()
  })

  test('název souboru ASCII s dnem exportu, popis filtrů', () => {
    expect(exportFileName({ fileBase: 'Klienti a kontakty', generatedAt: new Date('2026-11-05T23:30:00Z') }, 'xlsx'))
      .toBe('klienti-a-kontakty-2026-11-06.xlsx')
    expect(asciiSlug('Týdenní přehled — vedení')).toBe('tydenni-prehled-vedeni')
    expect(filtersLine([])).toMatch(/bez filtru/)
    expect(filtersLine(DOC.filters)).toBe('Filtry: Stav: otevřené · Hledání: „Šťastná"')
  })

  test('toExportTable a součty', () => {
    const t = toExportTable('T', [
      { header: 'A', value: (r: { a: string; b: number }) => r.a },
      { header: 'B', type: 'czk', total: true, value: (r) => r.b },
    ], [{ a: 'x', b: 1 }, { a: 'y', b: 2.5 }])
    expect(t.columns).toEqual([{ header: 'A' }, { header: 'B', type: 'czk', total: true }])
    expect(t.rows).toEqual([['x', 1], ['y', 2.5]])
    expect(columnTotals(t)).toEqual([null, 3.5])
  })
})

describe('renderXlsx', () => {
  test('list s daty: tučné záhlaví, zmrazený 1. řádek, autofiltr, formáty Kč a data', async () => {
    const wb = await reload(DOC)
    const ws = wb.getWorksheet('Obchody')!
    expect(ws).toBeDefined()
    expect(ws.getRow(1).values).toEqual([undefined, 'Klient', 'Hodnota', 'Follow-up', 'Poslední aktivita', 'Hosté'])
    expect(ws.getRow(1).getCell(1).font?.bold).toBe(true)
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(ws.autoFilter).toEqual('A1:E4')

    const r2 = ws.getRow(2)
    expect(r2.getCell(1).value).toBe('Účetní kancelář Šťastná s.r.o.')
    expect(r2.getCell(2).value).toBe(186000)
    expect(r2.getCell(2).numFmt).toBe(XLSX_NUM_FMT.czk)
    expect((r2.getCell(3).value as Date).toISOString()).toBe('2026-11-10T00:00:00.000Z')
    expect(r2.getCell(3).numFmt).toBe('d. m. yyyy')
    expect((r2.getCell(4).value as Date).toISOString()).toBe('2026-11-03T14:45:00.000Z')
    expect(r2.getCell(4).numFmt).toBe('d. m. yyyy h:mm')
    expect(r2.getCell(5).value).toBe(120)
  })

  test('text, který vypadá jako vzorec, zůstane textem', async () => {
    const ws = (await reload(DOC)).getWorksheet('Obchody')!
    const cell = ws.getRow(3).getCell(1)
    expect(cell.value).toBe('=SUM(A1:A9)')
    expect(cell.formula).toBeUndefined()
  })

  test('řádek Celkem sčítá jen viditelné řádky (SUBTOTAL 109)', async () => {
    const ws = (await reload(DOC)).getWorksheet('Obchody')!
    const total = ws.getRow(5)
    expect(total.getCell(1).value).toBe('Celkem')
    expect(total.getCell(2).value).toMatchObject({ formula: 'SUBTOTAL(109,B2:B4)', result: 282750 })
    expect(total.font?.bold).toBe(true)
  })

  test('šířky podle obsahu v mezích 10–60 znaků', async () => {
    const ws = (await reload(DOC)).getWorksheet('Obchody')!
    expect(ws.getColumn(1).width).toBe('Účetní kancelář Šťastná s.r.o.'.length + 2)
    expect(ws.getColumn(5).width).toBe(10) // „Hosté" + šipka filtru → minimum
    expect(columnWidth('A', ['x'.repeat(500)])).toBe(60)
    expect(columnWidth('A', [])).toBe(10)
  })

  test('list Informace: název, firma, datum exportu, filtry a počty', async () => {
    const wb = await reload(DOC)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Obchody', 'Informace'])
    const info = wb.getWorksheet('Informace')!
    const text = info.getSheetValues().flat().filter((v) => typeof v === 'string').join(' | ')
    expect(text).toContain('Obchody')
    expect(text).toContain('Mummies and Daddies')
    expect(text).toContain('5. 11. 2026 14:03')
    expect(text).toContain('Jana Dvořáková')
    expect(text).toContain('Stav: otevřené · Hledání: „Šťastná"')
    expect(text).toContain('3 řádků')
  })

  test('prázdná tabulka nese větu místo dat; názvy listů jsou platné a jedinečné', async () => {
    const wb = buildWorkbook({
      ...DOC,
      tables: [
        { title: 'Nové leady', columns: [{ header: 'Klient' }], rows: [], emptyText: 'V týdnu nepřibyl žádný lead.' },
        { title: 'Nové leady', columns: [{ header: 'Klient' }], rows: [['A']] },
      ],
    })
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Nové leady', 'Nové leady (2)', 'Informace'])
    expect(wb.getWorksheet('Nové leady')!.getCell('A2').value).toBe('V týdnu nepřibyl žádný lead.')
    const taken = new Set<string>()
    const long = sheetName('Pipeline: fáze / týden [45]? a ještě mnohem delší název', taken)
    expect(long.length).toBeLessThanOrEqual(31)
    expect(long).not.toMatch(/[[\]:*?/\\]/)
    expect(long.startsWith('Pipeline fáze týden 45 a')).toBe(true)
    expect(sheetName('', taken)).toBe('List')
  })
})

describe('tisk z Excelu', () => {
  test('A4 na šířku, na šířku stránky, záhlaví opakované, patička se stránkou', async () => {
    const ws = (await reload(DOC)).getWorksheet('Obchody')!
    expect(ws.pageSetup).toMatchObject({ paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' })
    expect(ws.headerFooter.oddFooter).toBe('&LObchody&RStrana &P z &N')
  })
})
