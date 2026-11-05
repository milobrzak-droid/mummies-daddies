// PDF nabídky pro zákazníka (A4 na výšku). Vstupem je spočítaná nabídka:
// buď OfferQuote ze standardní mapy (core/standardOffer.ts — agent ji může
// přiložit k e-mailu), nebo obecný OfferPdfDocument (např. verze nabídky
// obchodu, domain/crm/offerPdfSource.ts). Kód nic nepočítá ani neodhaduje:
// tiskne položky, DPH a součty tak, jak přišly.
//
// Obsah: logo a fakturační údaje firmy, pro koho a na kdy, co balíček
// obsahuje, položky, součty bez DPH / DPH / s DPH, platnost, upozornění
// „nezávazná kalkulace" a kontakt. Údaje firmy jsou z @/config.
import type { PDFDocument, PDFPage } from 'pdf-lib'
import { COMPANY } from '@/config'
import {
  A4_PORTRAIT, COLORS, createPdf, drawLogoMark, drawParagraph, drawText, drawTextRight, hLine, measureWith,
  pdfSafeText, stampFooters, wrapText, type FontBytes, type PdfFonts,
} from '@/lib/export/pdfKit'
import type { OfferQuote } from './standardOffer'
import type { LegalEntityConfig } from './tenant'

export type OfferCurrency = 'CZK' | 'EUR'

export type OfferPdfLine = {
  label: string
  /** Druhý řádek pod názvem položky (menší písmo). */
  detail?: string | null
  /** Množství a jednotka („80 host"); null = bez rozpisu (paušál). */
  quantity: number | null
  unit: string | null
  unitPrice: number | null
  total: number
  /** Procentní příplatek: quantity je procento, unitPrice základ. */
  percent?: boolean
}

export type OfferPdfDocument = {
  title: string
  /** Druhý řádek titulku („Firemní raut · 12. 12. 2026 · 80 hostů"). */
  subtitle: string | null
  /** Označení nabídky („Obchod 123, verze 2"); null = bez čísla. */
  reference: string | null
  customer: { name: string | null; contact: string | null }
  /** YYYY-MM-DD */
  issuedAt: string
  validUntil: string | null
  eventDate: string | null
  guests: number | null
  includesTitle: string | null
  includes: readonly string[]
  /** Volný popis rozsahu (verze nabídky z obchodu). */
  scopeText: string | null
  lines: readonly OfferPdfLine[]
  subtotal: number
  vat: number
  /** Sazba DPH 0–1; null = neuvádět sazbu. */
  vatRate: number | null
  total: number
  currency: OfferCurrency
}

export type OfferPdfContext = {
  /** Krátké jméno firmy (upozornění, logo). */
  companyName?: string
  legal?: LegalEntityConfig | null
  /** Podpis / kontakt (víc řádků). */
  signature?: string | null
  customerName?: string | null
  customerContact?: string | null
  /** Jen pro testy (jinak písmo z lib/export/fonts). */
  fonts?: FontBytes
}

// --- Texty ----------------------------------------------------------------

const NBSP_RE = /[  ]/g
const intFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 })
const eurFmt = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

export function formatMoney(n: number, currency: OfferCurrency): string {
  if (currency === 'EUR') return `${eurFmt.format(n).replace(NBSP_RE, ' ')} EUR`
  return `${intFmt.format(Math.round(n)).replace(NBSP_RE, ' ')} Kč`
}

export function czDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : iso
}

/** Věta, kterou musí nést každá nabídka pro zákazníka. */
export function offerDisclaimer(companyName: string): string {
  return `Nezávazná kalkulace, smlouva vzniká až písemným potvrzením ${companyName}.`
}

const GUESTS = (n: number) => (n === 1 ? 'host' : n >= 2 && n <= 4 ? 'hosté' : 'hostů')

/** OfferQuote ze standardní mapy → dokument PDF. */
export function offerDocumentFromQuote(
  quote: OfferQuote,
  opts: { customerName?: string | null; customerContact?: string | null; vatRate?: number | null } = {},
): OfferPdfDocument {
  // Sazba se odvodí z čísel nabídky (DPH = round(základ × sazba)), ne z mapy firmy,
  // která se mezitím mohla změnit.
  const vatRate = opts.vatRate ?? (quote.subtotal > 0 ? Math.round((quote.vat / quote.subtotal) * 100) / 100 : null)
  return {
    title: 'Nabídka cateringu',
    subtitle: `${quote.eventTypeLabel} · ${czDay(quote.eventDate)} · ${quote.guests} ${GUESTS(quote.guests)}`,
    reference: null,
    customer: { name: opts.customerName ?? null, contact: opts.customerContact ?? null },
    issuedAt: quote.issuedAt,
    validUntil: quote.validUntil,
    eventDate: quote.eventDate,
    guests: quote.guests,
    includesTitle: `Balíček ${quote.package.label} obsahuje`,
    includes: quote.package.includes,
    scopeText: null,
    lines: quote.lines.map((l) => ({
      label: l.label,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unitPrice,
      total: l.total,
      percent: l.unit === '%',
    })),
    subtotal: quote.subtotal,
    vat: quote.vat,
    vatRate,
    total: quote.total,
    currency: quote.currency,
  }
}

function defaultContext(): Required<Omit<OfferPdfContext, 'fonts' | 'customerName' | 'customerContact'>> {
  return {
    companyName: COMPANY.name,
    legal: COMPANY.legalEntity ?? null,
    signature: COMPANY.capabilities.standardOffer?.signature ?? null,
  }
}

// --- Kreslení ---------------------------------------------------------------

const M = 48
const BOTTOM = 64

type Flow = { pdf: PDFDocument; fonts: PdfFonts; page: PDFPage; y: number; width: number }

function ensure(f: Flow, h: number): void {
  if (f.y - h >= BOTTOM) return
  f.page = f.pdf.addPage(A4_PORTRAIT)
  f.y = A4_PORTRAIT[1] - M
}

function drawCompanyHeader(f: Flow, companyName: string, legal: LegalEntityConfig | null): void {
  const top = f.y
  drawLogoMark(f.page, M, top - 14, 13)
  drawText(f.page, companyName, M + 34, top - 20, { font: f.fonts.bold, size: 16 })
  const right = f.width - M
  const lines = legal
    ? [legal.street, legal.city, [`IČO ${legal.ico}`, legal.dic ? `DIČ ${legal.dic}` : null].filter(Boolean).join(' · ')]
    : []
  let y = top - 6
  if (legal) {
    drawTextRight(f.page, legal.name, right, y, { font: f.fonts.bold, size: 9 })
    y -= 12
  }
  for (const line of lines) {
    drawTextRight(f.page, line, right, y, { font: f.fonts.regular, size: 8.5, color: COLORS.muted })
    y -= 11
  }
  f.y = Math.min(top - 40, y) - 8
  hLine(f.page, M, right, f.y, COLORS.accent, 1.4)
  f.y -= 26
}

function drawInfoGrid(f: Flow, doc: OfferPdfDocument): void {
  const left: [string, string][] = []
  if (doc.customer.name) left.push(['Pro', doc.customer.name])
  if (doc.customer.contact) left.push(['Kontakt', doc.customer.contact])
  if (doc.eventDate) left.push(['Termín akce', czDay(doc.eventDate)])
  if (doc.guests != null) left.push(['Počet hostů', String(doc.guests)])
  const right: [string, string][] = [['Vystaveno', czDay(doc.issuedAt)]]
  if (doc.validUntil) right.push(['Platnost do', czDay(doc.validUntil)])
  if (doc.reference) right.push(['Číslo nabídky', doc.reference])

  const colW = (f.width - M * 2) / 2
  const drawCol = (items: [string, string][], x: number) => {
    let y = f.y
    for (const [k, v] of items) {
      drawText(f.page, k, x, y - 9, { font: f.fonts.regular, size: 8.5, color: COLORS.muted })
      y = drawParagraph(f.page, v, x + 78, y, colW - 90, { font: f.fonts.bold, size: 9.5, lineHeight: 12.5 }) - 3
    }
    return y
  }
  const yl = drawCol(left, M)
  const yr = drawCol(right, M + colW + 10)
  f.y = Math.min(yl, yr) - 14
}

function drawIncludes(f: Flow, doc: OfferPdfDocument): void {
  if (doc.includes.length === 0 && !doc.scopeText) return
  const contentW = f.width - M * 2
  if (doc.includesTitle && doc.includes.length > 0) {
    ensure(f, 40)
    drawText(f.page, doc.includesTitle, M, f.y - 11, { font: f.fonts.bold, size: 11 })
    f.y -= 20
    for (const item of doc.includes) {
      const lines = wrapText(pdfSafeText(item, f.fonts.regular), measureWith(f.fonts.regular, 9.5), contentW - 14)
      ensure(f, lines.length * 13)
      f.page.drawCircle({ x: M + 3, y: f.y - 6.5, size: 1.6, color: COLORS.accent })
      for (const line of lines) {
        drawText(f.page, line, M + 12, f.y - 9.5, { font: f.fonts.regular, size: 9.5 })
        f.y -= 13
      }
    }
    f.y -= 10
  }
  if (doc.scopeText) {
    ensure(f, 40)
    drawText(f.page, 'Rozsah nabídky', M, f.y - 11, { font: f.fonts.bold, size: 11 })
    f.y -= 20
    const lines = wrapText(pdfSafeText(doc.scopeText, f.fonts.regular), measureWith(f.fonts.regular, 9.5), contentW)
    for (const line of lines) {
      ensure(f, 13)
      drawText(f.page, line, M, f.y - 9.5, { font: f.fonts.regular, size: 9.5 })
      f.y -= 13
    }
    f.y -= 10
  }
}

function quantityText(l: OfferPdfLine): string {
  if (l.percent) return `${intFmt.format(l.quantity ?? 0)} %`
  if (l.quantity == null) return ''
  return `${intFmt.format(l.quantity).replace(NBSP_RE, ' ')}${l.unit ? ` ${unitLabel(l.unit, l.quantity)}` : ''}`
}

/** Jednotka v čísle podle množství („1 host", „3 hosté", „80 hostů"). */
export function unitLabel(unit: string, quantity: number): string {
  if (unit === 'host') return GUESTS(quantity)
  return unit
}

function unitPriceText(l: OfferPdfLine, currency: OfferCurrency): string {
  if (l.unitPrice == null) return ''
  return l.percent ? `z ${formatMoney(l.unitPrice, currency)}` : formatMoney(l.unitPrice, currency)
}

function drawLines(f: Flow, doc: OfferPdfDocument): void {
  const right = f.width - M
  const contentW = right - M
  const cols = [contentW - 255, 75, 90, 90] // Položka | Množství | Cena za jedn. | Celkem
  const xs = [M, M + cols[0], M + cols[0] + cols[1], M + cols[0] + cols[1] + cols[2]]
  const header = () => {
    f.page.drawRectangle({ x: M, y: f.y - 18, width: contentW, height: 18, color: COLORS.headerFill })
    const o = { font: f.fonts.bold, size: 8.5 }
    drawText(f.page, 'Položka', M + 5, f.y - 12.5, o)
    drawTextRight(f.page, 'Množství', xs[1] + cols[1] - 5, f.y - 12.5, o)
    drawTextRight(f.page, 'Cena za jedn.', xs[2] + cols[2] - 5, f.y - 12.5, o)
    drawTextRight(f.page, 'Celkem bez DPH', right - 5, f.y - 12.5, o)
    f.y -= 18
  }
  ensure(f, 60)
  drawText(f.page, 'Položky', M, f.y - 11, { font: f.fonts.bold, size: 11 })
  f.y -= 18
  header()
  for (const l of doc.lines) {
    const labelLines = wrapText(pdfSafeText(l.label, f.fonts.regular), measureWith(f.fonts.regular, 9.5), cols[0] - 10)
    const detailLines = l.detail ? wrapText(pdfSafeText(l.detail, f.fonts.regular), measureWith(f.fonts.regular, 8), cols[0] - 10, 6) : []
    const h = labelLines.length * 12.5 + detailLines.length * 10.5 + 9
    if (f.y - h < BOTTOM) {
      ensure(f, h + 18)
      header()
    }
    let y = f.y - 4
    for (const line of labelLines) {
      drawText(f.page, line, M + 5, y - 9.5, { font: f.fonts.regular, size: 9.5 })
      y -= 12.5
    }
    for (const line of detailLines) {
      drawText(f.page, line, M + 5, y - 8, { font: f.fonts.regular, size: 8, color: COLORS.muted })
      y -= 10.5
    }
    const base = f.y - 13.5
    drawTextRight(f.page, quantityText(l), xs[1] + cols[1] - 5, base, { font: f.fonts.regular, size: 9.5 })
    drawTextRight(f.page, unitPriceText(l, doc.currency), xs[2] + cols[2] - 5, base, { font: f.fonts.regular, size: 9.5 })
    drawTextRight(f.page, formatMoney(l.total, doc.currency), right - 5, base, { font: f.fonts.regular, size: 9.5 })
    f.y -= h
    hLine(f.page, M, right, f.y)
  }
  f.y -= 10
}

function drawTotals(f: Flow, doc: OfferPdfDocument): void {
  ensure(f, 70)
  const right = f.width - M
  const labelX = right - 230
  const rows: [string, string, boolean][] = [
    ['Celkem bez DPH', formatMoney(doc.subtotal, doc.currency), false],
    [doc.vatRate != null ? `DPH ${Math.round(doc.vatRate * 100)} %` : 'DPH', formatMoney(doc.vat, doc.currency), false],
    ['Celkem s DPH', formatMoney(doc.total, doc.currency), true],
  ]
  for (const [label, value, strong] of rows) {
    if (strong) {
      hLine(f.page, labelX, right, f.y + 2, COLORS.ink, 0.9)
      f.y -= 4
    }
    const o = { font: strong ? f.fonts.bold : f.fonts.regular, size: strong ? 12.5 : 10 }
    drawText(f.page, label, labelX, f.y - o.size, o)
    drawTextRight(f.page, value, right - 5, f.y - o.size, o)
    f.y -= o.size + 8
  }
  f.y -= 8
}

function drawNotice(f: Flow, doc: OfferPdfDocument, companyName: string): void {
  const contentW = f.width - M * 2
  const texts = [
    offerDisclaimer(companyName),
    doc.validUntil ? `Nabídka platí do ${czDay(doc.validUntil)}. Termín držíme až po Vašem písemném potvrzení.` : 'Termín držíme až po Vašem písemném potvrzení.',
  ]
  const lines = texts.flatMap((t) => wrapText(pdfSafeText(t, f.fonts.bold), measureWith(f.fonts.bold, 9.5), contentW - 24))
  const h = lines.length * 13 + 18
  ensure(f, h)
  f.page.drawRectangle({ x: M, y: f.y - h, width: contentW, height: h, color: COLORS.zebra, borderColor: COLORS.accent, borderWidth: 0.8 })
  let y = f.y - 9
  lines.forEach((line, i) => {
    drawText(f.page, line, M + 12, y - 9.5, { font: i === 0 ? f.fonts.bold : f.fonts.regular, size: 9.5 })
    y -= 13
  })
  f.y -= h + 20
}

function drawContact(f: Flow, signature: string | null, legal: LegalEntityConfig | null): void {
  const lines = signature ? signature.split('\n') : legal ? [legal.name, `${legal.email} · ${legal.phone}`] : []
  if (lines.length === 0) return
  ensure(f, 20 + lines.length * 13)
  drawText(f.page, 'Kontakt', M, f.y - 11, { font: f.fonts.bold, size: 11 })
  f.y -= 19
  for (const line of lines) {
    drawText(f.page, line, M, f.y - 9.5, { font: f.fonts.regular, size: 9.5 })
    f.y -= 13
  }
}

/** Patička: firma, IČO a kontakt (bez osobních údajů zákazníka). */
export function offerFooterText(companyName: string, legal: LegalEntityConfig | null): string {
  if (!legal) return companyName
  return [legal.name, `IČO ${legal.ico}`, legal.email, legal.phone].join(' · ')
}

/** Obecný dokument nabídky → PDF. */
export async function renderOfferDocumentPdf(doc: OfferPdfDocument, ctx: OfferPdfContext = {}): Promise<Uint8Array> {
  const d = defaultContext()
  const companyName = ctx.companyName ?? d.companyName
  const legal = ctx.legal === undefined ? d.legal : ctx.legal
  const signature = ctx.signature === undefined ? d.signature : ctx.signature
  const { pdf, fonts } = await createPdf({ title: `${doc.title} — ${companyName}`, author: legal?.name ?? companyName, subject: doc.subtitle ?? undefined }, ctx.fonts)
  const page = pdf.addPage(A4_PORTRAIT)
  const f: Flow = { pdf, fonts, page, y: A4_PORTRAIT[1] - M, width: A4_PORTRAIT[0] }

  drawCompanyHeader(f, companyName, legal)
  drawText(f.page, doc.title, M, f.y - 20, { font: fonts.bold, size: 22 })
  f.y -= 30
  if (doc.subtitle) {
    f.y = drawParagraph(f.page, doc.subtitle, M, f.y, f.width - M * 2, { font: fonts.regular, size: 11.5, color: COLORS.muted }) - 2
  }
  f.y -= 14
  drawInfoGrid(f, doc)
  drawIncludes(f, doc)
  drawLines(f, doc)
  drawTotals(f, doc)
  drawNotice(f, doc, companyName)
  drawContact(f, signature, legal)
  stampFooters(pdf, fonts, offerFooterText(companyName, legal), M)
  return pdf.save()
}

/**
 * Nabídka ze standardní mapy → PDF pro zákazníka. Čistá funkce nad
 * OfferQuote (žádná síť ani databáze), aby ji agent mohl přiložit k e-mailu.
 */
export async function renderOfferPdf(quote: OfferQuote, ctx: OfferPdfContext = {}): Promise<Uint8Array> {
  const doc = offerDocumentFromQuote(quote, { customerName: ctx.customerName, customerContact: ctx.customerContact })
  return renderOfferDocumentPdf(doc, ctx)
}

/** Název souboru nabídky („nabidka-2026-12-12.pdf"). */
export function offerPdfFileName(doc: Pick<OfferPdfDocument, 'eventDate' | 'issuedAt'>, suffix?: string | null): string {
  const day = (doc.eventDate ?? doc.issuedAt).slice(0, 10)
  const tail = suffix ? `-${suffix.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}` : ''
  return `nabidka-${day}${tail}.pdf`
}
