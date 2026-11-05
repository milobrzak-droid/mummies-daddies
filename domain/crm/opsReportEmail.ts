// E-mailová podoba provozního přehledu (domain/crm/opsReport.ts), která
// odchází v pondělí a v pátek. Jen rendering — žádné I/O, nic neodesílá.
// Odesílá domain/crm/digestDelivery.ts stejně jako dřív: z Viktorovy schránky,
// jen členům týmu s obchodní rolí, nejvýš jednou za pražský den.
//
// STRUČNĚ: z každé sekce nejvýš EMAIL_ITEMS_PER_SECTION položek s odkazem na
// záznam v Cockpitu a důkazem, zbytek odkazem „a dalších N" na sekci stránky
// Týden. Prázdné sekce jen jedním řádkem („Bez položek: …"). Zdroj pravdy je
// Cockpit; e-mail je jen doručovací kanál.
//
// CO V E-MAILU NENÍ: částky, rozsah nabídky, měření dopadu, kontakty klientů,
// obsah pošty ani zápisů schůzek. Nese jen názvy, stavy, data a počty — týž
// druh údajů jako dosavadní přehled týdne (firmy, obchody, blokace), nově
// i u dodávek, milníků, rozhodnutí a kapacit (ty v Cockpitu vidí celý tým).
//
// HTML je e-mailově bezpečné: tabulky + inline styly, žádné externí CSS/JS/
// obrázky, max. šířka 600 px, systémový font. Všechna data se escapují a
// odkazy vedou jen na cesty v Cockpitu (APP_URL + cesta).

import { COMPANY } from '@/config'
import {
  EMAIL_COLORS, EMAIL_FONT, emailListTable, emailSectionHeading, emailSourceRow, escapeHtml, normalizeAppUrl,
  type DigestEmail,
} from '@/domain/crm/digestEmail'
import { opsReportItemCount, type OpsItem, type OpsReport, type OpsSection, type OpsTone } from '@/domain/crm/opsReport'
import { plural } from '@/domain/crm/today'

/** Kolik položek na sekci e-mail vypíše (zbytek je v Cockpitu). */
export const EMAIL_ITEMS_PER_SECTION = 5

export type OpsReportEmailOptions = {
  /** Základní URL Cockpitu, musí být https (např. https://www.mummiesdaddies.com). */
  appUrl: string
  /** Lidsky čitelné datum, např. „pondělí 5. 10. 2026". */
  generatedAtLabel: string
  /** Kolik položek na sekci; výchozí EMAIL_ITEMS_PER_SECTION. */
  perSection?: number
}

const C = EMAIL_COLORS
const FONT = EMAIL_FONT
// Stejné odstíny jako --c-warn a --c-pos v app/globals.css (text ≥ 4,5:1 na bílé).
const WARN = '#966319'
const POS = '#187C4E'
const TONE_COLOR: Record<OpsTone, string> = { neg: C.neg, warn: WARN, ok: POS, info: C.slate }

/** Adresa stránky Týden pro daný týden (i s kotvou sekce). */
export function overviewPath(week: OpsReport['week'], section?: OpsSection['key']): string {
  return `/cockpit/prehled-tydne?tyden=${week}${section ? `#${section}` : ''}`
}

/** Jen cesta v Cockpitu („/…", ne „//host"); cokoli jiného vede na přehled. */
function safePath(href: string): string {
  return /^\/(?!\/)[^\s"'<>\\]*$/.test(href) ? href : '/cockpit/prehled-tydne'
}

/**
 * Adresa pro odkazy v náhledu e-mailu na stránce: APP_URL, a když chybí nebo
 * není https (lokální vývoj), výchozí adresa Cockpitu firmy.
 */
export function previewAppUrl(env: Record<string, string | undefined>): string {
  try {
    return normalizeAppUrl(env.APP_URL?.trim() ?? '')
  } catch {
    return `https://www.${COMPANY.emailDomain}`
  }
}

type Shown = { section: OpsSection; items: OpsItem[]; more: number }

function shownSections(report: OpsReport, perSection: number): Shown[] {
  return report.sections
    .filter((s) => s.total > 0)
    .map((section) => {
      const items = section.key === FINANCE_KEY ? [] : section.items.slice(0, perSection)
      return { section, items, more: section.total - items.length }
    })
}

/** Sekce bez položek, o kterých víme, že jsou prázdné (nenačtené sem nepatří). */
function calmSections(report: OpsReport): OpsSection[] {
  return report.sections.filter((s) => s.total === 0 && s.unavailable.length === 0)
}

function itemRow(item: OpsItem, base: string): string {
  return `<tr><td style="padding:10px 0;border-top:1px solid ${C.line};font-family:${FONT};">` +
    `<a href="${escapeHtml(base + safePath(item.href))}" style="font-size:14px;line-height:20px;font-weight:600;color:${C.ink};text-decoration:underline;">${escapeHtml(item.title)}</a>` +
    `<div style="padding-top:2px;font-size:13px;line-height:18px;color:${TONE_COLOR[item.tone]};">${escapeHtml(item.detail)}</div>` +
    `<div style="padding-top:2px;font-size:12px;line-height:16px;color:${C.slate};">Důkaz: ${escapeHtml(item.proof)}</div>` +
    `</td></tr>`
}

function moreRow(text: string, href: string): string {
  return `<tr><td style="padding:10px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:18px;">` +
    `<a href="${escapeHtml(href)}" style="color:${C.navy};font-weight:600;">${escapeHtml(text)}</a></td></tr>`
}

function paragraph(text: string, color: string = C.slate, padding = '8px 32px 0 32px'): string {
  return `<tr><td style="padding:${padding};font-family:${FONT};font-size:13px;line-height:18px;color:${color};">${escapeHtml(text)}</td></tr>`
}

const moreText = (n: number) => `… a dalších ${n} — celý seznam v Cockpitu`
/** Rozdíly z iDokladu do e-mailu jen jako počet — čísla dokladů a firmy zůstávají v Cockpitu. */
const FINANCE_KEY: OpsSection['key'] = 'finance-rozdily'
const financeText = (n: number) => `${n} ${plural(n, 'rozdíl čeká', 'rozdíly čekají', 'rozdílů čeká')} na vyřešení — detail jen v Cockpitu`

export function renderOpsReportEmail(report: OpsReport, options: OpsReportEmailOptions): DigestEmail {
  const base = normalizeAppUrl(options.appUrl)
  const perSection = Math.max(1, options.perSection ?? EMAIL_ITEMS_PER_SECTION)
  const label = options.generatedAtLabel.replace(/[\r\n]+/g, ' ').trim()
  const total = opsReportItemCount(report)
  const title = 'Přehled týdne'
  const heading = report.isEmpty ? 'Tento týden nic nečeká' : report.headline

  const subject = report.isEmpty
    ? `${title} ${label}: nic nečeká`
    : `${title} ${label}: ${total} ${plural(total, 'položka', 'položky', 'položek')} (${report.headline.replace(/\.$/, '')})`

  const overviewUrl = base + overviewPath(report.week)
  const scope = `Obchody a posuny milníků ${report.window.label}; ostatní je stav k ${label}.`
  const shown = shownSections(report, perSection)
  const calm = calmSections(report)

  const body: string[] = [
    `<tr><td style="padding:28px 32px 4px 32px;border-top:4px solid ${C.accent};font-family:${FONT};font-size:12px;line-height:16px;letter-spacing:0.04em;text-transform:uppercase;color:${C.slate};">Cockpit · ${title} · ${escapeHtml(label)}</td></tr>`,
    `<tr><td style="padding:4px 32px 0 32px;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:${C.navy};">${escapeHtml(heading)}</td></tr>`,
    paragraph(scope),
  ]
  if (report.unavailable.length > 0) {
    body.push(paragraph(`Nepodařilo se načíst: ${report.unavailable.join(', ')}. Ověř to v Cockpitu, přehled to může podhodnocovat.`, C.neg))
  }

  for (const s of shown) {
    const rows = s.items.map((i) => itemRow(i, base))
    if (s.more > 0) rows.push(moreRow(s.section.key === FINANCE_KEY ? financeText(s.more) : moreText(s.more), base + overviewPath(report.week, s.section.key)))
    body.push(emailSectionHeading(`${s.section.title} (${s.section.total})`), emailListTable(rows.join('')))
  }

  if (calm.length > 0) {
    body.push(paragraph(`Bez položek: ${calm.map((s) => s.title).join(', ')}.`, C.slate, '20px 32px 0 32px'))
  }

  if (report.sources) {
    body.push(emailSectionHeading(report.sources.title, C.slate), emailListTable(report.sources.lines.map(emailSourceRow).join('')))
  }

  body.push(
    `<tr><td style="padding:24px 32px 28px 32px;font-family:${FONT};font-size:13px;line-height:18px;color:${C.slate};">` +
      `<a href="${escapeHtml(overviewUrl)}" style="color:${C.navy};font-weight:600;">Otevřít přehled v Cockpitu</a><br>` +
      `Automaticky vygenerováno ${escapeHtml(label)}. Každá položka vede na svůj záznam v Cockpitu.</td></tr>`,
  )

  const html =
    `<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:${C.bg};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:${C.bg};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:600px;background-color:${C.white};border:1px solid ${C.line};">` +
    body.join('') +
    `</table></td></tr></table></body></html>`

  const text: string[] = [`${title} ${label}`, heading, scope]
  if (report.unavailable.length > 0) text.push(`Nepodařilo se načíst: ${report.unavailable.join(', ')}.`)
  for (const s of shown) {
    text.push('', `## ${s.section.title} (${s.section.total})`)
    for (const i of s.items) text.push(`- ${i.title} — ${i.detail}`, `  Důkaz: ${i.proof}`, `  ${base + safePath(i.href)}`)
    if (s.more > 0) text.push(`- ${s.section.key === FINANCE_KEY ? financeText(s.more) : moreText(s.more)}: ${base + overviewPath(report.week, s.section.key)}`)
  }
  if (calm.length > 0) text.push('', `Bez položek: ${calm.map((s) => s.title).join(', ')}.`)
  if (report.sources) text.push('', `## ${report.sources.title}`, ...report.sources.lines)
  text.push('', `Otevřít v Cockpitu: ${overviewUrl}`)

  return { subject, html, text: text.join('\n') }
}
