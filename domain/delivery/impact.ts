// Dopad dodávky, vlastnictví a souhlas s referencí (kap. 6, migrace 0061).
// Čistá doménová logika bez DB — akce v domain/delivery/actions/impact.ts.
//
// PENÍZE: metric_observation vidí celý tým, obchody a částky ale jen
// obchodní role (rozhodnutí majitele 2026-09-28, can_see_sales()). Měna proto
// nesmí být v jednotce ani v názvu metriky. CURRENCY_PATTERN je znak po znaku
// shodný s CHECK metric_observation_no_currency_check v 0061 (hlídá
// test/delivery-impact.test.ts). Peněžní dopad patří do finančních záznamů.
import { z } from 'zod'
import { COMPANY } from '@/config'
import { SHAREPOINT_URL_RE } from '@/domain/delivery/documents'

export const CURRENCY_PATTERN =
  '[€$£]|(^|[^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž])(czk|kč|kc|eur|euro|eura|usd|gbp|chf|pln|korun|koruna|koruny)([^a-z0-9áäčďéěíĺľňóôöŕřšťúůüýž]|$)'
const CURRENCY_RE = new RegExp(CURRENCY_PATTERN)

/** Obsahuje text měnu? (stejně jako SQL: lower() a regex) */
export function containsCurrency(text: string | null | undefined): boolean {
  if (!text) return false
  return CURRENCY_RE.test(text.toLowerCase())
}

export const CURRENCY_MESSAGE =
  'Peníze sem nepatří — dopad v penězích vidí jen obchod a zapisuje se do finančních záznamů.'

const emptyToNull = (v: unknown) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v)
const optNumber = z.preprocess(
  (v) => {
    const e = emptyToNull(v)
    return typeof e === 'string' ? e.replace(/\s/g, '').replace(',', '.') : e
  },
  z.coerce.number({ message: 'Zadej číslo.' }).finite('Zadej číslo.').nullable(),
)
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const optId = z.preprocess((v) => (v === '' || v == null ? null : v), id.nullable())
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Zadej datum.')

export const metricObservationSchema = z
  .object({
    metric: z.string().trim().min(1, 'Vyplň metriku.').max(100, 'Nejvýš 100 znaků.'),
    unit: z.preprocess(emptyToNull, z.string().trim().max(30, 'Nejvýš 30 znaků.').nullable()),
    baseline: optNumber,
    actual: optNumber,
    observed_on: isoDate,
    note: z.preprocess(emptyToNull, z.string().trim().max(1000, 'Nejvýš 1000 znaků.').nullable()),
    document_id: optId,
  })
  .superRefine((v, ctx) => {
    if (v.baseline === null && v.actual === null) {
      ctx.addIssue({ code: 'custom', path: ['baseline'], message: 'Vyplň výchozí hodnotu nebo skutečnost.' })
    }
    if (containsCurrency(v.metric)) ctx.addIssue({ code: 'custom', path: ['metric'], message: CURRENCY_MESSAGE })
    if (containsCurrency(v.unit)) ctx.addIssue({ code: 'custom', path: ['unit'], message: CURRENCY_MESSAGE })
  })
export type MetricObservationInput = z.infer<typeof metricObservationSchema>

export type ImpactDelta = { abs: number; pct: number | null } | null

/** Rozdíl skutečnost − výchozí hodnota; procenta jen když baseline ≠ 0. */
export function impactDelta(baseline: number | null, actual: number | null): ImpactDelta {
  if (baseline === null || actual === null || !Number.isFinite(baseline) || !Number.isFinite(actual)) return null
  const abs = Math.round((actual - baseline) * 1000) / 1000
  const pct = baseline === 0 ? null : Math.round(((actual - baseline) / Math.abs(baseline)) * 1000) / 10
  return { abs, pct }
}

export function formatDelta(d: ImpactDelta, unit: string | null): string {
  if (!d) return '—'
  const sign = d.abs > 0 ? '+' : d.abs < 0 ? '−' : '±'
  const n = Math.abs(d.abs).toLocaleString('cs-CZ')
  const u = unit ? ` ${unit}` : ''
  const p = d.pct === null ? '' : ` (${d.pct > 0 ? '+' : d.pct < 0 ? '−' : '±'}${Math.abs(d.pct).toLocaleString('cs-CZ')} %)`
  return `${sign}${n}${u}${p}`
}

// --- Vlastnictví ----------------------------------------------------------

export const DELIVERY_TEAM_KEYS = COMPANY.deliveryTeams.map((t) => t.key) as readonly string[]
export const DELIVERY_TEAM_LABEL: Record<string, string> = Object.fromEntries(
  COMPANY.deliveryTeams.map((t) => [t.key, t.label]),
)

const optUuid = z.preprocess(emptyToNull, z.string().uuid('Vyber člena týmu.').nullable())

export const ownershipSchema = z
  .object({
    owner_id: optUuid,
    deputy_id: optUuid,
    delivery_team: z.preprocess(
      emptyToNull,
      z.string().refine((v) => DELIVERY_TEAM_KEYS.includes(v), 'Vyber tým.').nullable(),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.deputy_id !== null && v.owner_id === null) {
      ctx.addIssue({ code: 'custom', path: ['owner_id'], message: 'Zástupce bez vlastníka nedává smysl — vyber vlastníka.' })
    }
    if (v.deputy_id !== null && v.deputy_id === v.owner_id) {
      ctx.addIssue({ code: 'custom', path: ['deputy_id'], message: 'Zástupce musí být jiný člověk než vlastník.' })
    }
  })
export type OwnershipInput = z.infer<typeof ownershipSchema>

// --- Souhlas s referencí --------------------------------------------------

export const referenceConsentSchema = z
  .object({
    consent_on: isoDate,
    document_id: optId,
    new_title: z.preprocess(emptyToNull, z.string().trim().max(200, 'Nejvýš 200 znaků.').nullable()),
    new_url: z.preprocess(
      emptyToNull,
      z
        .string()
        .trim()
        .max(2000, 'Odkaz je moc dlouhý.')
        .regex(SHAREPOINT_URL_RE, 'Odkaz musí vést na SharePoint (https://…sharepoint.com/…).')
        .nullable(),
    ),
  })
  .superRefine((v, ctx) => {
    const hasNew = v.new_url !== null || v.new_title !== null
    if (v.document_id === null && !hasNew) {
      ctx.addIssue({
        code: 'custom',
        path: ['document_id'],
        message: 'Souhlas musí být doložený — vyber dokument nebo přidej odkaz na SharePoint.',
      })
    }
    if (v.document_id !== null && hasNew) {
      ctx.addIssue({ code: 'custom', path: ['document_id'], message: 'Vyber buď existující dokument, nebo nový odkaz — ne obojí.' })
    }
    if (v.document_id === null && hasNew) {
      if (v.new_url === null) ctx.addIssue({ code: 'custom', path: ['new_url'], message: 'Vyplň odkaz na SharePoint.' })
      if (v.new_title === null) ctx.addIssue({ code: 'custom', path: ['new_title'], message: 'Vyplň název dokumentu.' })
    }
  })

/** Zrcadlo CHECK reference_card_consent_check: schválená jen s dokladem a datem. */
export function referenceConsentOk(card: {
  approved_public: boolean
  consent_evidence_id?: number | null
  consent_at?: string | null
}): boolean {
  return !card.approved_public || (card.consent_evidence_id != null && card.consent_at != null)
}
