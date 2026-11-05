// Společné kousky PDF výstupů (pdf-lib + fontkit): vložené písmo s češtinou,
// zalamování textu, barvy a patička „Strana X z Y". Žádný prohlížeč na
// serveru — PDF se skládá přímo z textu a čar, takže běží i na Vercelu.
//
// Písmo: Geist Regular a Bold (SIL Open Font License, lib/export/fonts/OFL.txt).
// Standardní písma PDF (Helvetica, WinAnsi) české znaky ě, š, č, ř, ž, ů
// neumí, proto se písmo vždy vkládá (podmnožina jen použitých znaků).
// Na Vercelu soubory písma do funkce přibalí outputFileTracingIncludes
// v next.config.ts.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'

export const A4_PORTRAIT: [number, number] = [595.28, 841.89]
export const A4_LANDSCAPE: [number, number] = [841.89, 595.28]

export const COLORS = {
  ink: rgb(0.106, 0.122, 0.141),
  muted: rgb(0.353, 0.38, 0.42),
  line: rgb(0.78, 0.79, 0.8),
  headerFill: rgb(0.937, 0.929, 0.91),
  zebra: rgb(0.975, 0.972, 0.965),
  accent: rgb(0.949, 0.408, 0.235),
  white: rgb(1, 1, 1),
} satisfies Record<string, RGB>

export type FontBytes = { regular: Uint8Array; bold: Uint8Array }

export const FONT_DIR = path.join(process.cwd(), 'lib', 'export', 'fonts')

let fontCache: Promise<FontBytes> | null = null

/** Bajty písma (načtené jednou na proces). */
export function loadExportFonts(): Promise<FontBytes> {
  fontCache ??= Promise.all([
    readFile(path.join(FONT_DIR, 'Geist-Regular.ttf')),
    readFile(path.join(FONT_DIR, 'Geist-Bold.ttf')),
  ]).then(([regular, bold]) => ({ regular: new Uint8Array(regular), bold: new Uint8Array(bold) }))
    .catch((e) => {
      fontCache = null
      throw e
    })
  return fontCache
}

export type PdfFonts = { regular: PDFFont; bold: PDFFont }

/** Nový dokument s vloženým písmem a metadaty. */
export async function createPdf(meta: { title: string; author: string; subject?: string }, fonts?: FontBytes): Promise<{ pdf: PDFDocument; fonts: PdfFonts }> {
  const bytes = fonts ?? await loadExportFonts()
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const regular = await pdf.embedFont(bytes.regular, { subset: true })
  const bold = await pdf.embedFont(bytes.bold, { subset: true })
  pdf.setTitle(meta.title, { showInWindowTitleBar: true })
  pdf.setAuthor(meta.author)
  pdf.setCreator(meta.author)
  pdf.setProducer(meta.author)
  pdf.setLanguage('cs-CZ')
  if (meta.subject) pdf.setSubject(meta.subject)
  return { pdf, fonts: { regular, bold } }
}

// --- Text -------------------------------------------------------------------

const charsetCache = new WeakMap<PDFFont, Set<number>>()

const REPLACEMENTS: Record<string, string> = {
  '\t': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
  '‑': '-', '−': '-', '﻿': '',
}

/**
 * Text, který písmo umí vykreslit: řídicí znaky pryč, nezlomitelné mezery na
 * mezeru, znak mimo písmo (emoji, cizí písmo) na „?" — jinak by v PDF zbyl
 * prázdný čtvereček nebo by vykreslení spadlo.
 */
export function pdfSafeText(text: string, font: PDFFont): string {
  let set = charsetCache.get(font)
  if (!set) {
    set = new Set(font.getCharacterSet())
    charsetCache.set(font, set)
  }
  let out = ''
  for (const ch of text.normalize('NFC')) {
    if (ch === '\n') { out += ch; continue }
    if (ch in REPLACEMENTS) { out += REPLACEMENTS[ch]; continue }
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue
    out += set.has(cp) ? ch : '?'
  }
  return out
}

/** Šířka textu (bez kontroly znaků — volej na už ošetřený text). */
export type MeasureFn = (text: string) => number

export function measureWith(font: PDFFont, size: number): MeasureFn {
  return (t) => font.widthOfTextAtSize(t, size)
}

function breakLongWord(word: string, measure: MeasureFn, maxWidth: number): string[] {
  const parts: string[] = []
  let cur = ''
  for (const ch of word) {
    if (cur && measure(cur + ch) > maxWidth) {
      parts.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) parts.push(cur)
  return parts
}

/**
 * Zalomí text do řádků širokých nejvýš `maxWidth`. Respektuje konce řádků,
 * dlouhé slovo (URL, e-mail) rozdělí po znacích. `maxLines` ořízne zbytek
 * a poslední řádek ukončí „…".
 */
export function wrapText(text: string, measure: MeasureFn, width: number, maxLines = Infinity): string[] {
  // Tolerance na zaokrouhlení: sloupec široký přesně na slovo ho nesmí rozdělit.
  const maxWidth = width + 0.01
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ').filter((w, i, all) => w !== '' || (i === 0 && all.length === 1))
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let cur = ''
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word
      if (measure(candidate) <= maxWidth) {
        cur = candidate
        continue
      }
      if (cur) lines.push(cur)
      if (measure(word) <= maxWidth) {
        cur = word
      } else {
        const parts = breakLongWord(word, measure, maxWidth)
        lines.push(...parts.slice(0, -1))
        cur = parts[parts.length - 1] ?? ''
      }
    }
    lines.push(cur)
  }
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  let last = kept[maxLines - 1]
  while (last && measure(`${last}…`) > maxWidth) last = last.slice(0, -1)
  kept[maxLines - 1] = `${last}…`
  return kept
}

// --- Kreslení -----------------------------------------------------------------

export type TextOpts = { font: PDFFont; size: number; color?: RGB }

/** Text na řádek (y = účaří). Vrací šířku. */
export function drawText(page: PDFPage, text: string, x: number, y: number, o: TextOpts): number {
  const safe = pdfSafeText(text, o.font).replace(/\n/g, ' ')
  if (safe) page.drawText(safe, { x, y, size: o.size, font: o.font, color: o.color ?? COLORS.ink })
  return o.font.widthOfTextAtSize(safe, o.size)
}

/** Text zarovnaný doprava k `right`. */
export function drawTextRight(page: PDFPage, text: string, right: number, y: number, o: TextOpts): void {
  const safe = pdfSafeText(text, o.font).replace(/\n/g, ' ')
  drawText(page, safe, right - o.font.widthOfTextAtSize(safe, o.size), y, o)
}

/**
 * Zalomený odstavec od `y` (horní hrana) dolů; vrací novou horní hranu pod ním.
 * Volající hlídá, že se vejde na stránku.
 */
export function drawParagraph(page: PDFPage, text: string, x: number, y: number, width: number, o: TextOpts & { lineHeight?: number }): number {
  const lh = o.lineHeight ?? o.size * 1.3
  const lines = wrapText(pdfSafeText(text, o.font), measureWith(o.font, o.size), width)
  let top = y
  for (const line of lines) {
    drawText(page, line, x, top - o.size, o)
    top -= lh
  }
  return top
}

export function hLine(page: PDFPage, x1: number, x2: number, y: number, color: RGB = COLORS.line, thickness = 0.6): void {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color })
}

/** „Strana 2 z 5". */
export function pageLabel(index: number, count: number): string {
  return `Strana ${index + 1} z ${count}`
}

/** Patička na všech stránkách (až když je známý počet stran). */
export function stampFooters(pdf: PDFDocument, fonts: PdfFonts, left: string, margin: number): void {
  const pages = pdf.getPages()
  pages.forEach((page, i) => {
    const { width } = page.getSize()
    const y = margin * 0.55
    hLine(page, margin, width - margin, y + 10)
    drawText(page, left, margin, y, { font: fonts.regular, size: 7.5, color: COLORS.muted })
    drawTextRight(page, pageLabel(i, pages.length), width - margin, y, { font: fonts.regular, size: 7.5, color: COLORS.muted })
  })
}

/** Zástupné logo firmy (kruh se středem v barvě značky) — stejné jako public/logo.svg. */
export function drawLogoMark(page: PDFPage, x: number, yCenter: number, r: number): void {
  page.drawCircle({ x: x + r, y: yCenter, size: r, color: COLORS.accent })
  page.drawCircle({ x: x + r, y: yCenter, size: r * 0.42, color: COLORS.white })
}
