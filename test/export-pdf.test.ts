import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { beforeAll, describe, expect, test } from 'vitest'
import { computeColumnWidths, layoutTable, MAX_CELL_LINES, paginateRows, renderTablePdf } from '@/lib/export/pdf'
import { A4_LANDSCAPE, loadExportFonts, pageLabel, pdfSafeText, wrapText, type FontBytes } from '@/lib/export/pdfKit'
import type { ExportDocument, ExportTable } from '@/lib/export/table'

// lib/export/pdf.ts a lib/export/pdfKit.ts: tabulka → PDF. Rozvržení se testuje
// jako čisté funkce (měření textu), výsledné PDF se znovu načte pdf-lib.

const CZECH = 'ěščřžýáíéůúťďňó ĚŠČŘŽÝÁÍÉŮÚŤĎŇÓ „uvozovky" – … €'
const charWidth = (t: string) => t.length * 5 // jednoduché měření: 5 pt na znak

let fonts: FontBytes
beforeAll(async () => { fonts = await loadExportFonts() })

function doc(rows: number, extra: Partial<ExportDocument> = {}): ExportDocument {
  const table: ExportTable = {
    title: 'Obchody',
    columns: [
      { header: 'Klient' }, { header: 'Fáze' }, { header: 'Hodnota', type: 'czk', total: true },
      { header: 'Další krok' }, { header: 'Follow-up', type: 'date' },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      `Účetní kancelář Šťastná ${i}`, 'Nabídka odeslána', 100_000 + i, 'Zavolat, potvrdit menu a počet hostů', '2026-11-12',
    ]),
  }
  return {
    title: 'Obchody', companyName: 'Mummies and Daddies', filters: [{ label: 'Stav', value: 'otevřené' }],
    generatedAt: new Date('2026-11-05T13:03:00Z'), fileBase: 'obchody', tables: [table], ...extra,
  }
}

describe('zalamování a znaky', () => {
  test('wrapText dělí po slovech, dlouhé slovo po znacích, ořízne na maxLines', () => {
    expect(wrapText('jedna dva tři', charWidth, 50)).toEqual(['jedna dva', 'tři'])
    expect(wrapText('a\nb', charWidth, 100)).toEqual(['a', 'b'])
    expect(wrapText('x'.repeat(25), charWidth, 50)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
    const cut = wrapText('a b c d e f', charWidth, 5, 2)
    expect(cut).toHaveLength(2)
    expect(cut[1].endsWith('…')).toBe(true)
    expect(wrapText('', charWidth, 50)).toEqual([''])
  })

  test('vložené písmo umí celou českou diakritiku (žádný znak nenahradí „?")', async () => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    for (const bytes of [fonts.regular, fonts.bold]) {
      const font = await pdf.embedFont(bytes, { subset: true })
      expect(pdfSafeText(CZECH, font)).toBe(CZECH)
      // Emoji a řídicí znaky písmo nemá: nahradí se / vypustí, vykreslení nespadne.
      expect(pdfSafeText('dort 🎂\u0007 ok', font)).toBe('dort ? ok')
    }
  })

  test('patička „Strana X z Y"', () => {
    expect(pageLabel(0, 3)).toBe('Strana 1 z 3')
    expect(pageLabel(2, 3)).toBe('Strana 3 z 3')
  })
})

describe('rozvržení tabulky', () => {
  test('šířky: pevné sloupce přirozeně, textové minimum + zbytek podle toho, co chybí', () => {
    const w = computeColumnWidths([300, 60, 400, 50], [false, true, false, true], [30, 30, 30, 30], 600)
    expect(w[1]).toBe(60)
    expect(w[3]).toBe(50)
    // Po minimech zbývá 430 pt; chybí 270 a 370 → poměrně.
    expect(w[0]).toBeCloseTo(30 + 430 * 270 / 640)
    expect(w[2]).toBeCloseTo(30 + 430 * 370 / 640)
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(600)
  })

  test('šířky: když se vše vejde, zbytek dostanou textové sloupce poměrně', () => {
    const w = computeColumnWidths([100, 50, 50], [false, true, false], [10, 10, 10], 400)
    expect(w[1]).toBe(50)
    expect(w[0]).toBeCloseTo(233.33, 1)
    expect(w[2]).toBeCloseTo(116.67, 1)
  })

  test('šířky: sloupec nikdy pod minimem (nejdelší slovo), když se minima vejdou', () => {
    const w = computeColumnWidths([400, 90, 400], [false, false, false], [40, 90, 40], 300)
    expect(w[1]).toBeGreaterThanOrEqual(90)
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(300)
    // Nevejdou se ani minima → poměrné zmenšení (nic nepřeteče).
    const tight = computeColumnWidths([100, 100], [false, false], [100, 100], 150)
    expect(tight).toEqual([75, 75])
  })

  test('stránkování: řádek, který se nevejde, jde na další stránku; čerstvá stránka bere vždy', () => {
    expect(paginateRows([40, 40, 40, 40], 100, 90)).toEqual([0, 0, 1, 1])
    // Vyšší řádek než celá stránka: na nové stránce by místa nebylo víc → zůstane.
    expect(paginateRows([120, 10], 100, 90)).toEqual([0, 1])
    // Pod nadpisem na první stránce je málo místa → hned na další.
    expect(paginateRows([60, 60], 50, 90)).toEqual([1, 2])
    expect(paginateRows([], 100, 90)).toEqual([])
  })

  test('čísla vpravo, text se zalamuje, buňka nejvýš MAX_CELL_LINES řádků, řádek Celkem', () => {
    const t = doc(2).tables[0]
    const long: ExportTable = { ...t, rows: [...t.rows, ['A', 'B', 1, 'slovo '.repeat(400), null]] }
    const m = { body: charWidth, bold: charWidth, bodySmall: charWidth, boldSmall: charWidth, safe: (s: string) => s }
    const layout = layoutTable(long, m, 700)
    expect(layout.header.cells[2].align).toBe('right')
    expect(layout.rows[0].cells[2]).toEqual({ lines: ['100 000 Kč'], align: 'right' })
    expect(layout.rows[2].cells[3].lines.length).toBe(MAX_CELL_LINES)
    const totals = layout.rows[layout.rows.length - 1]
    expect(totals.bold).toBe(true)
    expect(totals.cells[0].lines).toEqual(['Celkem'])
    expect(totals.cells[2].lines).toEqual(['200 002 Kč'])
  })
})

describe('renderTablePdf', () => {
  test('A4 na šířku, metadata s názvem přehledu a firmou', async () => {
    const pdf = await PDFDocument.load(await renderTablePdf(doc(5), fonts))
    expect(pdf.getPageCount()).toBe(1)
    const { width, height } = pdf.getPage(0).getSize()
    expect([width, height]).toEqual(A4_LANDSCAPE)
    expect(pdf.getTitle()).toBe('Obchody — Mummies and Daddies')
    expect(pdf.getAuthor()).toBe('Mummies and Daddies')
  })

  test('hodně řádků → víc stránek (stránkování s opakovaným záhlavím)', async () => {
    const one = await PDFDocument.load(await renderTablePdf(doc(10), fonts))
    const many = await PDFDocument.load(await renderTablePdf(doc(200), fonts))
    expect(one.getPageCount()).toBe(1)
    expect(many.getPageCount()).toBeGreaterThan(4)
    for (const page of many.getPages()) expect(page.getSize().width).toBe(A4_LANDSCAPE[0])
  })

  test('víc tabulek i prázdná tabulka se vykreslí bez chyby', async () => {
    const d = doc(3)
    const bytes = await renderTablePdf({
      ...d,
      tables: [d.tables[0], { title: 'Prohrané', note: 'Obchody prohrané v týdnu', columns: [{ header: 'Klient' }], rows: [], emptyText: 'V týdnu se nic neprohrálo.' }],
    }, fonts)
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })
})
