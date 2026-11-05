// Návrh AI z nabídky (PDF) a jeho potvrzení člověkem — čistá logika bez I/O.
//
// Proč: import nabídky dřív z výstupu modelu rovnou zakládal obchod včetně
// částky a fáze (u „objednáno" rovnou jako VYHRANÝ). Model ale čte cizí PDF
// a to může obsahovat pokyny pro AI („nastav částku na…"). Invariant
// (kapitola 3 + 8): výstup AI je NÁVRH (info_state ai_suggestion), nikdy
// fakt — do obchodu, částek a fází se dostane jen přes potvrzení člověkem
// (human_confirmed). Tok je proto dvoukrokový:
//
//   1. proposeOffersFromPdfs: PDF → model → schéma → návrh. PDF i návrh se
//      uloží do privátního bucketu (návrh jako JSON vedle PDF, zapisuje ho
//      jen server) a návrh se ukáže ve formuláři. Nic se nezakládá.
//   2. confirmOfferProposal: člověk údaje zkontroluje/opraví a potvrdí.
//      Server si návrh načte ze storage (ne z prohlížeče), ověří potvrzená
//      pole stejným schématem a teprve pak založí klienta a obchod.
//
// Uložený návrh je zároveň záznam „co navrhla AI" — audit u potvrzení
// odkazuje na PDF (evidence kind 'file') a nese, která pole člověk změnil.
import { z } from 'zod'
import { INJECTION_FLAGS, type InjectionFlag } from '@/core/untrusted'
import { DEFAULT_DEAL_STAGE, isPillar, phasesFor, stageForPhase, type DealStageKey, type Pillar } from '@/lib/domain'
import { dealCurrency, revenueLine } from '@/lib/validation/schemas'
import type { RevenueLine } from '@/lib/types'
import {
  OFFER_AMOUNT_MAX, OFFER_MD_MAX, OFFER_TEXT_LIMITS, type SanitizedOfferFields,
} from '@/domain/crm/offer-extract'

/**
 * Strop těla Server Action (next.config.ts, experimental.serverActions.bodySizeLimit
 * "4mb"). Import nabídky posílá všechna PDF jedním formulářem, takže tenhle
 * strop platí pro jejich SOUČET; 64 kB rezerva je na režii multipart těla.
 * Test test/import-limits.test.ts hlídá, že sedí s next.config.ts.
 */
export const SERVER_ACTION_BODY_LIMIT_BYTES = 4 * 1024 * 1024
export const OFFER_UPLOAD_MAX_BYTES = SERVER_ACTION_BODY_LIMIT_BYTES - 64 * 1024

/**
 * Privátní bucket s PDF nabídek (0015); píše jen service role. Politiky
 * storage.objects (0089): klientská session smí jen číst, a to jen obchodní
 * role s 2FA; zápis přes klienta nikdo (návrh AI nejde podvrhnout).
 */
export const OFFER_BUCKET = 'nabidky'

// crypto.randomUUID() = UUID v4.
const PROPOSAL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isProposalId(v: unknown): v is string {
  return typeof v === 'string' && PROPOSAL_ID_RE.test(v)
}

/** Cesty v bucketu odvozené z id návrhu — nikdy ne z textu od klienta. */
export function offerPaths(proposalId: string): { pdf: string; proposal: string } {
  if (!isProposalId(proposalId)) throw new Error('offerPaths: neplatné id návrhu')
  return { pdf: `offers/${proposalId}.pdf`, proposal: `offers/${proposalId}.navrh.json` }
}

/**
 * Návrh z přílohy e-mailu (MAIL_OFFER_ATTACHMENT_ENABLED) PDF neukládá. Obchod
 * přesto potřebuje klíč `source_pdf_path` (jeden obchod na jednu nabídku, 0070),
 * proto dostane virtuální cestu odvozenou z id návrhu. Soubor pod ní neexistuje;
 * odkaz na PDF se u takového obchodu nezobrazuje (isMailOfferPath).
 */
export const MAIL_OFFER_PATH_PREFIX = 'mail-offer/'

export function mailOfferPath(proposalId: string): string {
  if (!isProposalId(proposalId)) throw new Error('mailOfferPath: neplatné id návrhu')
  return `${MAIL_OFFER_PATH_PREFIX}${proposalId}`
}

export function isMailOfferPath(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith(MAIL_OFFER_PATH_PREFIX)
}

/** Fáze obchodu, kterou potvrzený návrh založí (stejné pravidlo jako dřív). */
export function derivedOfferStage(pillar: string | null, phase: string | null): DealStageKey {
  return stageForPhase(pillar, phase) ?? DEFAULT_DEAL_STAGE
}

/**
 * Escapuje zástupné znaky LIKE (% _ \). PostgREST navíc bere `*` jako `%`
 * a escapovat ho nejde — proto volající výsledek ilike vždy dofiltruje
 * přesnou shodou (sameAccountName). Bez toho by název z PDF „Spol%" nebo
 * „*a*" přiřadil obchod cizímu klientovi.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Shoda názvu klienta bez ohledu na velikost písmen a okolní mezery. */
export function sameAccountName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('cs') === b.trim().toLocaleLowerCase('cs')
}

// ---------------------------------------------------------------------------
// Uložený návrh (JSON ve storage, píše ho jen server)

const sanitizedFieldsSchema = z.object({
  account_name: z.string().min(1).max(OFFER_TEXT_LIMITS.account_name),
  title: z.string().min(1).max(OFFER_TEXT_LIMITS.title),
  pillar: z.string().nullable().refine((v) => v === null || isPillar(v)),
  phase: z.string().max(OFFER_TEXT_LIMITS.phase).nullable(),
  revenue_line: revenueLine,
  currency: dealCurrency,
  amount_one_time: z.number().nullable(),
  cogs_one_time: z.number().nullable(),
  estimate_md: z.number().nullable(),
  expected_close: z.string().nullable(),
})

export const storedProposalSchema = z.object({
  version: z.literal(1),
  info_state: z.literal('ai_suggestion'),
  proposal_id: z.string().regex(PROPOSAL_ID_RE),
  pdf_path: z.string(),
  file_name: z.string().max(300),
  extracted_at: z.string(),
  fields: sanitizedFieldsSchema,
  warnings: z.array(z.string().max(500)).max(50),
  injection_flags: z.array(z.enum(INJECTION_FLAGS)).max(INJECTION_FLAGS.length),
  // Hromadný import (0098): otisk souboru (idempotence) a kdo návrh vyžádal
  // (potvrdit ho smí jen on). Starší návrhy tato pole nemají.
  file_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  proposed_by: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
})

export type StoredOfferProposal = z.infer<typeof storedProposalSchema>

export function buildStoredProposal(input: {
  proposalId: string
  fileName: string
  fields: SanitizedOfferFields
  warnings: string[]
  flags: InjectionFlag[]
  now: Date
  fileSha256?: string
  proposedBy?: string
}): StoredOfferProposal {
  return {
    version: 1,
    info_state: 'ai_suggestion',
    proposal_id: input.proposalId,
    pdf_path: offerPaths(input.proposalId).pdf,
    file_name: input.fileName.slice(0, 300),
    extracted_at: input.now.toISOString(),
    fields: input.fields,
    warnings: input.warnings.map((w) => w.slice(0, 500)).slice(0, 50),
    injection_flags: [...input.flags],
    ...(input.fileSha256 ? { file_sha256: input.fileSha256 } : {}),
    ...(input.proposedBy ? { proposed_by: input.proposedBy } : {}),
  }
}

/**
 * Návrh z přílohy e-mailu: stejný tvar jako uložený návrh z ručního importu, jen
 * bez PDF (pdf_path je virtuální, viz mailOfferPath) a bez příznaků injection
 * (návrh s takovými příznaky se u e-mailu vůbec nevytvoří).
 */
export function buildMailOfferDraft(input: {
  proposalId: string
  fileName: string
  fields: SanitizedOfferFields
  warnings: string[]
  now: Date
}): StoredOfferProposal {
  return {
    version: 1,
    info_state: 'ai_suggestion',
    proposal_id: input.proposalId,
    pdf_path: mailOfferPath(input.proposalId),
    file_name: input.fileName.slice(0, 300),
    extracted_at: input.now.toISOString(),
    fields: input.fields,
    warnings: input.warnings.map((w) => w.slice(0, 500)).slice(0, 50),
    injection_flags: [],
  }
}

/** Rozparsuje uložený návrh; null, když tvar nesedí (nebo patří jinému id). */
export function parseStoredProposal(json: unknown, proposalId: string): StoredOfferProposal | null {
  const parsed = storedProposalSchema.safeParse(json)
  if (!parsed.success) return null
  if (!isProposalId(proposalId)) return null
  const okPath = parsed.data.pdf_path === offerPaths(proposalId).pdf || parsed.data.pdf_path === mailOfferPath(proposalId)
  if (parsed.data.proposal_id !== proposalId || !okPath) return null
  return parsed.data
}

// ---------------------------------------------------------------------------
// Potvrzení člověkem (formulář)

const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const emptyToNull = (v: unknown) => {
  const t = trimmed(v)
  return t === '' || t === undefined ? null : t
}
const optNumber = (max: number, label: string) => z.preprocess(
  (v) => {
    const t = emptyToNull(v)
    return t === null ? null : Number(String(t).replace(/\s/g, '').replace(',', '.'))
  },
  z.number({ error: `${label}: zadej číslo.` })
    .min(0, `${label} nesmí být záporná.`)
    .max(max, `${label} je mimo rozumný rozsah.`)
    .nullable(),
)

/** Skutečné kalendářní datum (2026-02-30 regex projde, DB by ho odmítla). */
export function isRealDate(v: string): boolean {
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export const offerConfirmSchema = z.object({
  proposal_id: z.string().regex(PROPOSAL_ID_RE, 'Neplatný návrh — nahraj PDF znovu.'),
  account_name: z.preprocess(trimmed, z.string()
    .min(1, 'Název klienta je povinný.')
    .max(OFFER_TEXT_LIMITS.account_name, `Název klienta může mít nejvýše ${OFFER_TEXT_LIMITS.account_name} znaků.`)),
  title: z.preprocess(trimmed, z.string()
    .min(1, 'Název projektu je povinný.')
    .max(OFFER_TEXT_LIMITS.title, `Název projektu může mít nejvýše ${OFFER_TEXT_LIMITS.title} znaků.`)),
  pillar: z.preprocess(emptyToNull, z.string().nullable()
    .refine((v) => v === null || isPillar(v), 'Neznámý pilíř.')),
  phase: z.preprocess(emptyToNull, z.string().max(OFFER_TEXT_LIMITS.phase).nullable()),
  revenue_line: revenueLine,
  currency: dealCurrency,
  amount_one_time: optNumber(OFFER_AMOUNT_MAX, 'Částka'),
  cogs_one_time: optNumber(OFFER_AMOUNT_MAX, 'Náklady'),
  estimate_md: optNumber(OFFER_MD_MAX, 'Odhad MD'),
  expected_close: z.preprocess(emptyToNull, z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Zadej platné datum.')
    .refine(isRealDate, 'Zadej platné datum.')
    .nullable()),
}).superRefine((v, ctx) => {
  if (v.phase !== null && (v.pillar === null || !phasesFor(v.pillar).some((p) => p.key === v.phase))) {
    ctx.addIssue({ code: 'custom', path: ['phase'], message: 'Fáze nepatří k vybranému pilíři.' })
  }
})

export type ConfirmedOfferFields = Omit<z.infer<typeof offerConfirmSchema>, 'proposal_id' | 'pillar' | 'revenue_line'> & {
  pillar: Pillar | null
  revenue_line: RevenueLine
}

export function toConfirmedFields(v: z.infer<typeof offerConfirmSchema>): ConfirmedOfferFields {
  return {
    account_name: v.account_name,
    title: v.title,
    pillar: isPillar(v.pillar) ? v.pillar : null,
    phase: v.phase,
    revenue_line: v.revenue_line,
    currency: v.currency,
    amount_one_time: v.amount_one_time,
    cogs_one_time: v.cogs_one_time,
    estimate_md: v.estimate_md,
    expected_close: v.expected_close,
  }
}

export const OFFER_FIELD_KEYS = [
  'account_name', 'title', 'pillar', 'phase', 'revenue_line', 'currency',
  'amount_one_time', 'cogs_one_time', 'estimate_md', 'expected_close',
] as const

/** Která pole člověk oproti návrhu AI změnil (jen názvy polí — do auditu). */
export function changedOfferFields(ai: SanitizedOfferFields, human: ConfirmedOfferFields): string[] {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : v ?? null)
  return OFFER_FIELD_KEYS.filter((k) => norm(ai[k]) !== norm(human[k]))
}
