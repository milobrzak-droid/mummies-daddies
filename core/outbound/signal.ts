// Signál outbound agenta (P7): normalizovaný tvar, který vrací každý zdroj
// (konektory ARES, veřejné zakázky, RSS/iCal, inzeráty a signály z CRM).
// Čisté typy a funkce, bez I/O a bez hodnot firmy.
import { z } from 'zod'
import { OUTBOUND_SOURCES, type OutboundSource } from './config'

export const SIGNAL_KINDS = ['public_tender', 'event', 'job_posting', 'crm_anniversary', 'crm_season', 'company_change'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

export const SIGNAL_KIND_LABELS: Readonly<Record<SignalKind, string>> = {
  public_tender: 'Veřejná zakázka',
  event: 'Akce / event',
  job_posting: 'Inzerát na pozici',
  crm_anniversary: 'Výročí poslední akce',
  crm_season: 'Sezóna u klienta',
  company_change: 'Změna u firmy',
}

/** Stavy outbound_signal.status (CHECK v 0107). */
export const SIGNAL_STATUSES = ['new', 'lead', 'review', 'dismissed', 'blocked', 'failed'] as const
export type SignalStatus = (typeof SIGNAL_STATUSES)[number]

export const SIGNAL_STATUS_LABELS: Readonly<Record<SignalStatus, string>> = {
  new: 'Nový',
  lead: 'Lead v CRM',
  review: 'Ke kontrole',
  dismissed: 'Odložený',
  blocked: 'Zablokovaný',
  failed: 'Chyba',
}

/**
 * Ověřený fakt ze zdroje (co přesně zdroj uvádí). Jediný materiál, ze
 * kterého smí vzniknout personalizace oslovení — model nic nedomýšlí.
 */
export interface VerifiedFact {
  key: string
  value: string
  sourceUrl: string | null
}

export interface SignalCandidate {
  source: OutboundSource
  kind: SignalKind
  /** Klíč idempotence v rámci zdroje (id zakázky, guid položky, uid události …). */
  externalRef: string
  title: string
  url: string | null
  /** Den, ke kterému se signál vztahuje (termín akce, lhůta zakázky …). */
  signalDate: string | null
  company: { ico: string | null; name: string | null }
  facts: readonly VerifiedFact[]
  /** Signály z CRM rovnou nesou klienta. */
  accountId?: number | null
  contactId?: number | null
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const httpUrl = z.string().max(1000).regex(/^https?:\/\//)

export const signalCandidateSchema = z.object({
  source: z.enum(OUTBOUND_SOURCES),
  kind: z.enum(SIGNAL_KINDS),
  externalRef: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(300),
  url: httpUrl.nullable(),
  signalDate: day.nullable(),
  company: z.object({
    ico: z.string().regex(/^\d{8}$/).nullable(),
    name: z.string().trim().min(1).max(200).nullable(),
  }),
  facts: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    value: z.string().trim().min(1).max(300),
    sourceUrl: httpUrl.nullable(),
  })).max(20),
  accountId: z.number().int().positive().nullable().optional(),
  contactId: z.number().int().positive().nullable().optional(),
})

/** Zkrátí a očistí řetězec ze zdroje (řídicí znaky, bílé znaky). */
export function cleanText(s: string | null | undefined, max: number): string | null {
  if (s == null) return null
  // eslint-disable-next-line no-control-regex
  const v = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!v) return null
  return v.length > max ? `${v.slice(0, max - 1)}…` : v
}

/** IČO na 8 číslic, nebo null (OSVČ i firmy; neplatné tvary pryč). */
export function normalizeIco(s: string | null | undefined): string | null {
  const v = (s ?? '').replace(/\s/g, '')
  if (!/^\d{1,8}$/.test(v)) return null
  return v.padStart(8, '0')
}

/** Ověří kandidáta (zdroj je nedůvěryhodný) — neplatný se zahodí. */
export function parseSignalCandidate(x: unknown): SignalCandidate | null {
  const r = signalCandidateSchema.safeParse(x)
  return r.success ? (r.data as SignalCandidate) : null
}

/** Payload pro RPC outbound_signal_upsert (snake_case). */
export function signalUpsertPayload(c: SignalCandidate): Record<string, unknown> {
  return {
    source: c.source,
    kind: c.kind,
    external_ref: c.externalRef,
    title: c.title,
    url: c.url,
    signal_date: c.signalDate,
    ico: c.company.ico,
    company_name: c.company.name,
    facts: c.facts.map((f) => ({ key: f.key, value: f.value, source_url: f.sourceUrl })),
    account_id: c.accountId ?? null,
    contact_id: c.contactId ?? null,
  }
}

/** Fakta z DB (snake_case) zpět na VerifiedFact. */
export function factsFromRow(raw: unknown): VerifiedFact[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((f) => {
    if (!f || typeof f !== 'object') return []
    const o = f as Record<string, unknown>
    if (typeof o.key !== 'string' || typeof o.value !== 'string') return []
    return [{ key: o.key, value: o.value, sourceUrl: typeof o.source_url === 'string' ? o.source_url : null }]
  })
}

/** Text bez diakritiky, malými písmeny (porovnání klíčových slov a regionů). */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Obsahuje text některé z klíčových slov (bez diakritiky, na hranici slova)? */
export function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const t = ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `
  return keywords.filter((k) => {
    const kk = fold(k).replace(/[^a-z0-9]+/g, ' ').trim()
    return kk && t.includes(` ${kk}`)
  })
}
