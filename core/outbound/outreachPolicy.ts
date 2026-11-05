// Právní brána oslovení (P7). Čistá funkce bez I/O: rozhodne, JAK se smí
// firmu ze signálu oslovit. Výchozí cesta je vždy ta bezpečnější.
//
// PRÁVNÍ RÁMEC (k ověření právníkem, docs/OUTBOUND.md):
//   * Samostatně odeslaný e-mail s nabídkou je obchodní sdělení
//     (§ 2 písm. f) a § 7 zák. 480/2004 Sb.). Bez předchozího souhlasu je
//     nezákonný i na firemní adresy (praxe ÚOOÚ).
//   * Výjimka § 7 odst. 3: stávající zákazník, jehož kontakt máme z prodeje,
//     u OBDOBNÝCH výrobků/služeb, s jasnou možností odmítnutí v každé zprávě.
//   * Jinak jen s doloženým souhlasem (znění, verze, čas, zdroj).
//   * Nové firmy ze signálů: žádný e-mail. Agent připraví lead, kontext a
//     návrh oslovení pro člověka (telefon, osobně, LinkedIn ručně).
//   * B2B jen na pracovní adresy firem (žádné freemaily, žádné soukromé
//     osoby) — oprávněný zájem čl. 6 odst. 1 písm. f) GDPR.
import { FREEMAIL_DOMAINS, senderDomain } from '@/core/agents/inquiryExtraction'
import type { PragueWindow } from '@/core/followUpCadence'

export type OutreachBasis = 'existing_customer' | 'consent' | 'none'
export type OutreachChannel = 'auto_email' | 'review_email' | 'manual'

/** Výsledek brány: kanál, nebo „teď ne" (wait) / „vůbec ne" (none). */
export type OutreachDecision =
  | { channel: OutreachChannel; basis: OutreachBasis; reasons: OutreachReason[] }
  | { channel: 'wait'; basis: OutreachBasis; reasons: OutreachReason[] }
  | { channel: 'none'; basis: OutreachBasis; reasons: OutreachReason[] }

export const OUTREACH_REASONS = [
  'opted_out', 'no_email', 'freemail', 'no_legal_basis', 'consent_incomplete', 'consent_withdrawn',
  'not_similar_service', 'vip', 'sensitive', 'autosend_off', 'outside_window', 'daily_limit',
  'no_template', 'existing_customer', 'consent',
] as const
export type OutreachReason = (typeof OUTREACH_REASONS)[number]

export const OUTREACH_REASON_LABELS: Readonly<Record<OutreachReason, string>> = {
  opted_out: 'adresa je odhlášená / kontakt nesouhlasí s oslovením',
  no_email: 'chybí e-mail kontaktu',
  freemail: 'soukromá adresa (freemail) — B2B jen na pracovní adresy',
  no_legal_basis: 'nová firma bez souhlasu — e-mail je zakázaný, jen osobní oslovení',
  consent_incomplete: 'souhlas není doložený (chybí znění, verze, čas nebo zdroj)',
  consent_withdrawn: 'souhlas byl odvolán',
  not_similar_service: 'u stávajícího klienta jen obdobné služby (§ 7 odst. 3)',
  vip: 'VIP kontakt — e-mail až po schválení',
  sensitive: 'citlivý kontakt — e-mail až po schválení',
  autosend_off: 'samostatné odeslání je vypnuté — e-mail až po schválení',
  outside_window: 'mimo okno odesílání — odejde v dalším běhu',
  daily_limit: 'denní limit oslovení vyčerpán — odejde v dalším běhu',
  no_template: 'pro signál není schválená šablona',
  existing_customer: 'stávající zákazník (§ 7 odst. 3)',
  consent: 'doložený souhlas',
}

export interface ConsentEvidence {
  wording: string | null
  wordingVersion: string | null
  grantedAt: string | null
  source: string | null
  withdrawnAt: string | null
}

export interface OutreachInput {
  /** Stávající zákazník = firma s vyhraným obchodem (kontakt z prodeje). */
  isExistingCustomer: boolean
  /** Nabízená služba je obdobná tomu, co si zákazník kupoval (catering, akce). */
  similarService: boolean
  /** Souhlas kontaktu (outreach_consent), pokud je. */
  consent: ConsentEvidence | null
  email: string | null
  /** contact.do_not_contact, poznámka „nekontaktovat" nebo otisk v outreach_suppression. */
  optedOut: boolean
  vip: boolean
  sensitive: boolean
  templateAvailable: boolean
  /** OUTBOUND_AUTOSEND_ENABLED === 'true'. */
  autosendEnabled: boolean
  withinWindow: boolean
  sentToday: number
  dailyLimit: number
}

export function isWorkEmail(email: string | null | undefined): boolean {
  const d = senderDomain(email)
  if (!d) return false
  return !(FREEMAIL_DOMAINS as readonly string[]).includes(d)
}

export function consentIsComplete(c: ConsentEvidence | null): boolean {
  return !!c && !!c.wording?.trim() && !!c.wordingVersion?.trim() && !!c.grantedAt && !!c.source?.trim() && !c.withdrawnAt
}

export function decideOutreach(x: OutreachInput): OutreachDecision {
  // Právní titul pro e-mail.
  let basis: OutreachBasis = 'none'
  const reasons: OutreachReason[] = []
  if (x.isExistingCustomer && x.similarService) { basis = 'existing_customer'; reasons.push('existing_customer') }
  else if (consentIsComplete(x.consent)) { basis = 'consent'; reasons.push('consent') }

  if (x.optedOut) return { channel: 'none', basis, reasons: ['opted_out'] }

  // Bez titulu: jen návrh pro člověka (důvod, proč ne e-mail).
  const manual = (r: OutreachReason) => ({ channel: 'manual' as const, basis: 'none' as const, reasons: [r] })
  if (basis === 'none') {
    if (x.consent?.withdrawnAt) return manual('consent_withdrawn')
    if (x.consent) return manual('consent_incomplete')
    if (x.isExistingCustomer) return manual('not_similar_service')
    return manual('no_legal_basis')
  }
  if (!x.email) return manual('no_email')
  if (!isWorkEmail(x.email)) return manual('freemail')
  if (!x.templateAvailable) return manual('no_template')

  // Titul je; citlivé, VIP nebo vypnuté samostatné odeslání → koncept ke schválení.
  if (x.vip) return { channel: 'review_email', basis, reasons: [...reasons, 'vip'] }
  if (x.sensitive) return { channel: 'review_email', basis, reasons: [...reasons, 'sensitive'] }
  if (!x.autosendEnabled) return { channel: 'review_email', basis, reasons: [...reasons, 'autosend_off'] }
  if (!x.withinWindow) return { channel: 'wait', basis, reasons: [...reasons, 'outside_window'] }
  if (x.sentToday >= x.dailyLimit) return { channel: 'wait', basis, reasons: [...reasons, 'daily_limit'] }
  return { channel: 'auto_email', basis, reasons }
}

/** Je okamžik v okně odesílání (místní čas firmy, dny ISO 1–7, hodiny [from, to))? */
export function isWithinWindow(date: Date, window: PragueWindow, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN)
  const iso = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd) + 1
  return window.days.includes(iso) && hour >= window.fromHour && hour < window.toHour
}
