// E-mailová podoba přehledu (domain/crm/digest.ts). Jen rendering — žádné
// I/O, nic neodesílá (to dělá domain/crm/digestDelivery.ts). Dvě varianty:
// 'weekly' = přehled týdne (po/pá), 'daily' = krátký ranní souhrn (ostatní
// dny, jen když je co hlásit; digest bez sekce „Firmy k oslovení").
//
// Proč funkce bere kromě `digest` i zdrojová pole (`source`): Digest nese jen
// hotové řádky textu, ne ID záznamů. Aby šla každá položka prolinkovat do
// Cockpitu, spárujeme řádky sekce s položkami zdroje podle pořadí — buildDigest
// mapuje pole 1:1 (followUps.map(followUpLine) atd.), takže index sedí. Pokud
// by počty nesouhlasily, funkce radši vyhodí chybu, než aby poslala špatné odkazy.
//
// HTML je e-mailově bezpečné: tabulky + inline styly, žádné externí CSS/JS/obrázky,
// max. šířka 600 px, systémový font. Veškerá data se escapují.

import type { BlockedDeal, Digest, DigestInput } from '@/domain/crm/digest'
import { moreLine, renderDigestText, sectionTotal } from '@/domain/crm/digest'

export const EMAIL_COLORS = {
  navy: '#141922',
  ink: '#1A1F28',
  slate: '#5A6472',
  line: '#E7E9EE',
  accent: '#FF5A5F',
  neg: '#C4362F',
  white: '#FFFFFF',
  bg: '#F5F6F8',
} as const

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

export type DigestEmailSource = Pick<DigestInput, 'followUps' | 'outreach' | 'blockedDeals'>

export type DigestEmailOptions = {
  /** Základní URL Cockpitu, musí být https (např. https://cockpit.enter.ltd). */
  appUrl: string
  /** Lidsky čitelné datum/čas vygenerování, např. "pondělí 28. 9. 2026". */
  generatedAtLabel: string
  /** Zdrojová data, ze kterých vznikl digest — kvůli odkazům na záznamy. */
  source: DigestEmailSource
  /**
   * Cesta k obchodu. Výchozí je detail obchodu pod klientem
   * /clients/{account_id}/deals/{deal_id}; bez account_id záložně pipeline.
   * Volající může přepsat.
   */
  dealPath?: (dealId: number, accountId: number | null) => string
  /** 'weekly' (výchozí) = přehled týdne, 'daily' = ranní souhrn. */
  variant?: DigestEmailVariant
}

export type DigestEmailVariant = 'weekly' | 'daily'

export type DigestEmail = { subject: string; html: string; text: string }

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function normalizeAppUrl(appUrl: string): string {
  let url: URL
  try {
    url = new URL(appUrl)
  } catch {
    throw new Error(`appUrl není platná URL: ${appUrl}`)
  }
  if (url.protocol !== 'https:') throw new Error(`appUrl musí být https: ${appUrl}`)
  if (url.username || url.password) throw new Error('appUrl nesmí obsahovat přihlašovací údaje')
  if (url.search || url.hash) throw new Error('appUrl nesmí obsahovat query ani fragment')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

const defaultDealPath = (id: number, accountId: number | null) =>
  accountId != null
    ? `/cockpit/clients/${encodeURIComponent(String(accountId))}/deals/${encodeURIComponent(String(id))}`
    : `/cockpit/pipeline?deal=${encodeURIComponent(String(id))}`

// Česká shoda pro předmět (1 položka / 2–4 položky / 5+ položek).
function itemsWord(n: number): string {
  if (n === 1) return 'položka'
  if (n >= 2 && n <= 4) return 'položky'
  return 'položek'
}

type LinkedLine = { text: string; href: string }
type LinkedSection = { title: string; lines: LinkedLine[]; more: LinkedLine | null; total: number }

function linkSections(digest: Digest, source: DigestEmailSource, base: string, dealPath: (id: number, accountId: number | null) => string): LinkedSection[] {
  const hrefsByTitle: Record<string, string[]> = {
    'Follow-upy po termínu': source.followUps.map((n) => base + dealPath(n.deal_id, n.account_id)),
    'Firmy k oslovení': source.outreach.map((o) => `${base}/cockpit/clients/${encodeURIComponent(String(o.account_id))}`),
    'Blokované obchody': source.blockedDeals.map((b: BlockedDeal) => base + dealPath(b.id, b.account_id)),
  }
  return digest.sections.map((section) => {
    const hrefs = hrefsByTitle[section.title]
    if (!hrefs) throw new Error(`Neznámá sekce digestu: ${section.title}`)
    // Oříznutá sekce (SECTION_LIMITS): vypsané řádky = prvních N položek zdroje.
    const total = sectionTotal(section)
    if (hrefs.length !== total) {
      throw new Error(`Sekce "${section.title}" neodpovídá zdrojovým datům (${total} vs ${hrefs.length})`)
    }
    return {
      title: section.title,
      lines: section.lines.map((text, i) => ({ text, href: hrefs[i] })),
      more: section.more ? { text: moreLine(section.more.hidden), href: base + section.more.path } : null,
      total,
    }
  })
}

const C = EMAIL_COLORS

function sectionHeading(title: string, color: string = C.navy): string {
  return `<tr><td style="padding:24px 32px 8px 32px;font-family:${FONT};font-size:16px;line-height:22px;font-weight:600;color:${color};">${escapeHtml(title)}</td></tr>`
}

function linkedRow(line: LinkedLine): string {
  return `<tr><td style="padding:10px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:20px;color:${C.ink};">` +
    `<a href="${escapeHtml(line.href)}" style="color:${C.ink};text-decoration:underline;">${escapeHtml(line.text)}</a></td></tr>`
}

function plainRow(text: string): string {
  const alert = text.includes(' — zastaralé') || text.includes(' — chyba')
  const color = alert || text.includes(': nikdy') ? C.neg : C.slate
  return `<tr><td style="padding:8px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:18px;color:${color};">${escapeHtml(text)}</td></tr>`
}

function listTable(rows: string): string {
  return `<tr><td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table></td></tr>`
}

// Sdílené díly pro provozní přehled (opsReportEmail.ts): stejné písmo, nadpis
// sekce, tabulka seznamu a řádek „Stavu zdrojů", ať oba e-maily vypadají stejně.
export const EMAIL_FONT = FONT
export { sectionHeading as emailSectionHeading, listTable as emailListTable, plainRow as emailSourceRow }

export function renderDigestEmail(digest: Digest, options: DigestEmailOptions): DigestEmail {
  const base = normalizeAppUrl(options.appUrl)
  const dealPath = options.dealPath ?? defaultDealPath
  const sections = linkSections(digest, options.source, base, dealPath)
  // Celkové počty (i skryté položky oříznutých sekcí), stejně jako headline.
  const total = sections.reduce((sum, s) => sum + s.total, 0)
  const label = options.generatedAtLabel.replace(/[\r\n]+/g, ' ').trim()
  const daily = options.variant === 'daily'
  const title = daily ? 'Ranní souhrn' : 'Přehled týdne'
  // Ranní souhrn bez položek odchází jen kvůli zdrojům (Digest.sourceAlerts).
  const emptyNote = daily
    ? (digest.sourceAlerts > 0 ? 'zdroje dat vyžadují pozornost' : 'nic nečeká')
    : 'nic nečeká'
  const emptyHeading = daily
    ? (digest.sourceAlerts > 0 ? 'Zdroje dat vyžadují pozornost' : 'Dnes nic nečeká')
    : 'Tento týden nic nečeká'
  const emptyBody = daily
    ? 'Žádné follow-upy po termínu ani blokované obchody.' + (digest.sourceAlerts > 0 ? ' Pozornost vyžaduje stav zdrojů níže.' : '')
    : 'Žádné follow-upy po termínu, žádné firmy k oslovení, žádné blokované obchody.'

  const subject = digest.isEmpty
    ? `${title} ${label}: ${emptyNote}`
    : `${title} ${label}: ${total} ${itemsWord(total)} (${digest.headline.replace(/\.$/, '')})`

  const overviewUrl = `${base}/cockpit/prehled-tydne`
  const body: string[] = []

  body.push(
    `<tr><td style="padding:28px 32px 4px 32px;border-top:4px solid ${C.accent};font-family:${FONT};font-size:12px;line-height:16px;letter-spacing:0.04em;text-transform:uppercase;color:${C.slate};">Cockpit · ${title} · ${escapeHtml(label)}</td></tr>`,
    `<tr><td style="padding:4px 32px 0 32px;font-family:${FONT};font-size:20px;line-height:28px;font-weight:600;color:${C.navy};">${escapeHtml(digest.isEmpty ? emptyHeading : digest.headline)}</td></tr>`,
  )

  if (digest.isEmpty) {
    body.push(`<tr><td style="padding:8px 32px 0 32px;font-family:${FONT};font-size:14px;line-height:20px;color:${C.slate};">${escapeHtml(emptyBody)}</td></tr>`)
  } else {
    for (const s of sections) {
      const rows = [...s.lines, ...(s.more ? [s.more] : [])]
      body.push(sectionHeading(s.title), listTable(rows.map(linkedRow).join('')))
    }
  }

  body.push(sectionHeading(digest.sources.title, C.slate), listTable(digest.sources.lines.map(plainRow).join('')))

  body.push(
    `<tr><td style="padding:24px 32px 28px 32px;font-family:${FONT};font-size:13px;line-height:18px;color:${C.slate};">` +
      `<a href="${escapeHtml(overviewUrl)}" style="color:${C.navy};font-weight:600;">Otevřít přehled v Cockpitu</a><br>` +
      `Automaticky vygenerováno ${escapeHtml(label)}.</td></tr>`,
  )

  const html =
    `<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:${C.bg};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:${C.bg};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:600px;background-color:${C.white};border:1px solid ${C.line};">` +
    body.join('') +
    `</table></td></tr></table></body></html>`

  const textLines = [renderDigestText(digest), '', `Otevřít v Cockpitu: ${overviewUrl}`]
  if (!digest.isEmpty) {
    textLines.push('', 'Odkazy na záznamy:')
    for (const s of sections) {
      for (const l of s.lines) textLines.push(`- ${l.text}: ${l.href}`)
      if (s.more) textLines.push(`- ${s.more.text}: ${s.more.href}`)
    }
  }
  const text = (digest.isEmpty ? `${emptyHeading}.\n\n` : '') + textLines.join('\n')

  return { subject, html, text }
}
