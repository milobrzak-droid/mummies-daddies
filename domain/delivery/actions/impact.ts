'use server'
// Dopad dodávky, vlastnictví a souhlas s referencí (kap. 6, migrace 0061).
//
// Každá exportovaná akce začíná tryRequireUser({ aal2: true }). Zápisy jdou
// přes uživatelského klienta (RLS + AAL2); výjimka je zápis evidence —
// INSERT do `evidence` smí jen service_role (0038). Stejný vzor jako
// akceptace milníku (actions/milestones.ts): doklad je dokument dodávky
// (engagement_document), evidence source_id 'engagement_document:<id>',
// web_link = URL přečtená z DB, nikdy z formuláře.
//
// Kód je tolerantní k nenasazené 0061: chybějící tabulka (42P01/PGRST205)
// nebo sloupec (42703/PGRST204) → klidná hláška místo chyby.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { pragueToday } from '@/lib/pragueDate'
import { isMissingRelation } from '@/core/loopQueries'
import { recordEvidence } from '@/core/evidence'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { isMissingColumnError } from '@/domain/crm/dealInvariant'
import { SHAREPOINT_URL_RE } from '@/domain/delivery/documents'
import { metricObservationSchema, ownershipSchema, referenceConsentSchema } from '@/domain/delivery/impact'
import {
  IMPACT_SETTINGS_COLUMNS,
  impactSettingsSchema,
  primaryObservationSchema,
  resolveMetric,
  type ImpactSettings,
} from '@/domain/delivery/impactMetric'
import type { ZodError } from 'zod'

const MISSING_0061 = 'Tahle část ještě není dostupná — čeká na migraci 0061.'
const MISSING_0088 = 'Hlavní metrika ještě není dostupná — čeká na migraci 0088.'
const MISSING_DOCS = 'Dokumenty ještě nejsou dostupné — čekají na migraci 0051.'
const NOT_FOUND_ENGAGEMENT = 'Dodávka nebyla nalezena.'

type Db = Awaited<ReturnType<typeof createClient>>

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

const editPath = (accountId: number, engagementId: number) => `/cockpit/clients/${accountId}/engagements/${engagementId}/edit`

async function engagementBelongs(s: Db, accountId: number, engagementId: number): Promise<boolean> {
  const { data, error } = await s.from('engagement').select('id, account_id').eq('id', engagementId).maybeSingle()
  if (error) return false
  return !!data && (data as { account_id: number }).account_id === accountId
}

type DocSource = { document_id: number | null; new_title?: string | null; new_url?: string | null }

/** Dokument dodávky (existující nebo nový) → řádek evidence. */
async function evidenceFromDocument(
  s: Db,
  engagementId: number,
  userId: string,
  src: DocSource,
): Promise<{ ok: true; id: number } | { ok: false; result: ActionResult }> {
  let doc: { id: number; url: string }
  if (src.document_id !== null) {
    const { data, error } = await s
      .from('engagement_document')
      .select('id, url')
      .eq('id', src.document_id)
      .eq('engagement_id', engagementId)
      .maybeSingle()
    if (isMissingRelation(error)) return { ok: false, result: { success: false, error: MISSING_DOCS } }
    if (error) return { ok: false, result: { success: false, error: dbErrorMessage('action.impact', error) } }
    if (!data) return { ok: false, result: { success: false, fieldErrors: { document_id: 'Dokument nepatří k této dodávce.' } } }
    doc = data as typeof doc
  } else {
    const { data, error } = await s
      .from('engagement_document')
      .insert({ engagement_id: engagementId, title: src.new_title, url: src.new_url, kind: 'podklad', created_by: userId })
      .select('id, url')
      .single()
    if (isMissingRelation(error)) return { ok: false, result: { success: false, error: MISSING_DOCS } }
    if (error || !data) return { ok: false, result: { success: false, error: dbErrorMessage('action.impact', error) } }
    doc = data as typeof doc
  }
  // Obrana do hloubky: evidence smí ukazovat jen do SharePointu.
  if (!SHAREPOINT_URL_RE.test(doc.url)) {
    return { ok: false, result: { success: false, error: 'Doklad musí být odkaz do SharePointu.' } }
  }
  const ev = await recordEvidence(
    createAdminClient(),
    { kind: 'file', sourceId: `engagement_document:${doc.id}`, webLink: doc.url },
    `user:${userId}`,
  )
  if (!ev.ok) return { ok: false, result: { success: false, error: 'Doklad se nepodařilo zapsat. Zkuste to prosím znovu.' } }
  return { ok: true, id: ev.id }
}

/** Nové měření dopadu (baseline / skutečnost), volitelně s dokladem. */
export async function createMetricObservation(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = metricObservationSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const input = parsed.data
  if (input.observed_on > pragueToday()) {
    return { success: false, fieldErrors: { observed_on: 'Datum měření nesmí být v budoucnosti.' } }
  }
  const s = await createClient()
  if (!(await engagementBelongs(s, accountId, engagementId))) return { success: false, error: NOT_FOUND_ENGAGEMENT }

  // Nejdřív ověřit, že 0061 je nasazená — jinak by vznikla osiřelá evidence.
  const probe = await s.from('metric_observation').select('id').limit(0)
  if (isMissingRelation(probe.error)) return { success: false, error: MISSING_0061 }

  let evidenceId: number | null = null
  if (input.document_id !== null) {
    const ev = await evidenceFromDocument(s, engagementId, user.id, { document_id: input.document_id })
    if (!ev.ok) return ev.result
    evidenceId = ev.id
  }
  // created_by neposíláme: DB ho doplní z auth.uid() a trigger hlídá podvrh.
  const { error } = await s.from('metric_observation').insert({
    engagement_id: engagementId,
    metric: input.metric,
    unit: input.unit,
    baseline: input.baseline,
    actual: input.actual,
    observed_on: input.observed_on,
    note: input.note,
    evidence_id: evidenceId,
  })
  if (isMissingRelation(error)) return { success: false, error: MISSING_0061 }
  if (error) return { success: false, error: dbErrorMessage('action.impact', error) }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

export async function deleteMetricObservation(
  accountId: number,
  engagementId: number,
  observationId: number,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, observationId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  if (!(await engagementBelongs(s, accountId, engagementId))) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  const { data, error } = await s
    .from('metric_observation')
    .delete()
    .eq('id', observationId)
    .eq('engagement_id', engagementId)
    .select('id')
  if (isMissingRelation(error)) return { success: false, error: MISSING_0061 }
  if (error) return { success: false, error: dbErrorMessage('action.impact', error) }
  if (!data?.length) return { success: false, error: 'Měření nebylo nalezeno.' }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

/** Vlastník, zástupce a realizační tým dodávky. */
export async function updateEngagementOwnership(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = ownershipSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const { data, error } = await s
    .from('engagement')
    .update(parsed.data)
    .eq('id', engagementId)
    .eq('account_id', accountId)
    .select('id')
  if (isMissingColumnError(error as { code?: string } | null)) return { success: false, error: MISSING_0061 }
  if (error) return { success: false, error: dbErrorMessage('action.impact', error) }
  if (!data?.length) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

/** Souhlas klienta s referencí — jen s dokladem (CHECK reference_card_consent_check). */
export async function recordReferenceConsent(
  accountId: number,
  engagementId: number,
  cardId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, cardId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = referenceConsentSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const input = parsed.data
  if (input.consent_on > pragueToday()) {
    return { success: false, fieldErrors: { consent_on: 'Datum souhlasu nesmí být v budoucnosti.' } }
  }
  const s = await createClient()
  if (!(await engagementBelongs(s, accountId, engagementId))) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  const { data: card, error: cardError } = await s
    .from('reference_card')
    .select('id, consent_evidence_id')
    .eq('id', cardId)
    .eq('engagement_id', engagementId)
    .maybeSingle()
  // Výběr sloupce z 0061 zároveň ověří nasazení migrace — před zápisem
  // dokumentu a evidence, aby nevznikaly osiřelé řádky.
  if (isMissingColumnError(cardError as { code?: string } | null)) return { success: false, error: MISSING_0061 }
  if (cardError) return { success: false, error: dbErrorMessage('action.impact', cardError) }
  if (!card) return { success: false, error: 'Referenční karta nebyla nalezena.' }

  const ev = await evidenceFromDocument(s, engagementId, user.id, input)
  if (!ev.ok) return ev.result

  const after = { approved_public: true, consent_evidence_id: ev.id, consent_at: `${input.consent_on}T12:00:00Z` }
  const { data: updated, error } = await s
    .from('reference_card')
    .update(after)
    .eq('id', cardId)
    .eq('engagement_id', engagementId)
    .select('id')
  if (isMissingColumnError(error as { code?: string } | null)) return { success: false, error: MISSING_0061 }
  if (error) return { success: false, error: dbErrorMessage('action.impact', error) }
  if (!updated?.length) return { success: false, error: 'Referenční karta nebyla nalezena.' }
  // reference_card je od 0064 krytá triggerem (approved_public je v allow-listu
  // hodnot) — appkový zápis smí být jen záloha, dokud migrace neběží.
  if (!(await dbAuditActive())) {
    await recordAudit(
      'reference_card',
      cardId,
      'reference_card.consent_recorded',
      { approved_public: false },
      after,
      { type: 'user', id: user.id },
      { evidenceId: ev.id, infoState: 'human_confirmed' },
    )
  }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

/** Stažení souhlasu: reference přestane být použitelná, doklad zůstává jako historie. */
export async function withdrawReferenceConsent(
  accountId: number,
  engagementId: number,
  cardId: number,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, cardId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  if (!(await engagementBelongs(s, accountId, engagementId))) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  const { data, error } = await s
    .from('reference_card')
    .update({ approved_public: false })
    .eq('id', cardId)
    .eq('engagement_id', engagementId)
    .select('id')
  if (error) return { success: false, error: dbErrorMessage('action.impact', error) }
  if (!data?.length) return { success: false, error: 'Referenční karta nebyla nalezena.' }
  // reference_card je od 0064 krytá triggerem (approved_public je v allow-listu
  // hodnot) — appkový zápis smí být jen záloha, dokud migrace neběží.
  if (!(await dbAuditActive())) {
    await recordAudit(
      'reference_card',
      cardId,
      'reference_card.consent_withdrawn',
      { approved_public: true },
      { approved_public: false },
      { type: 'user', id: user.id },
    )
  }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

// --- Hlavní metrika dopadu (0088) ------------------------------------------

/**
 * Volba hlavní metriky dodávky a doložené „zatím nelze měřit". Kdo a kdy
 * u „nelze měřit" doplní DB trigger (engagement_impact_unmeasurable_stamp).
 */
export async function saveImpactSettings(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = impactSettingsSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const { data, error } = await s
    .from('engagement')
    .update(parsed.data)
    .eq('id', engagementId)
    .eq('account_id', accountId)
    .select('id')
  if (isMissingColumnError(error as { code?: string } | null)) return { success: false, error: MISSING_0088 }
  if ((error as { code?: string } | null)?.code === '23514') {
    return { success: false, error: 'Údaje metriky neprošly kontrolou (peníze nebo příliš krátký důvod).' }
  }
  if (error) return { success: false, error: dbErrorMessage('action.impact', error) }
  if (!data?.length) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

/**
 * Měření hlavní metriky: výchozí stav (před) nebo výsledek (po). Název,
 * jednotka a klíč metriky se berou z dodávky v DB, ne z formuláře — měření
 * tak vždy patří k metrice, kterou dodávka opravdu má.
 */
export async function recordPrimaryObservation(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = primaryObservationSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const input = parsed.data
  if (input.observed_on > pragueToday()) {
    return { success: false, fieldErrors: { observed_on: 'Datum měření nesmí být v budoucnosti.' } }
  }
  const s = await createClient()
  const { data: eng, error: engError } = await s
    .from('engagement')
    .select(`id, account_id, kind, ${IMPACT_SETTINGS_COLUMNS}`)
    .eq('id', engagementId)
    .maybeSingle()
  if (isMissingColumnError(engError as { code?: string } | null)) return { success: false, error: MISSING_0088 }
  if (engError) return { success: false, error: dbErrorMessage('action.impact', engError) }
  const row = eng as ({ account_id: number; kind: string } & ImpactSettings) | null
  if (!row || row.account_id !== accountId) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  const metric = resolveMetric(row)

  // Ověřit metric_key dřív, než vznikne evidence (jinak by osiřela).
  const probe = await s.from('metric_observation').select('metric_key').limit(0)
  if (isMissingRelation(probe.error)) return { success: false, error: MISSING_0061 }
  if (isMissingColumnError(probe.error as { code?: string } | null)) return { success: false, error: MISSING_0088 }

  let evidenceId: number | null = null
  if (input.document_id !== null) {
    const ev = await evidenceFromDocument(s, engagementId, user.id, { document_id: input.document_id })
    if (!ev.ok) return ev.result
    evidenceId = ev.id
  }
  const { error } = await s.from('metric_observation').insert({
    engagement_id: engagementId,
    metric_key: metric.key,
    metric: metric.label,
    unit: metric.unit,
    baseline: input.which === 'baseline' ? input.value : null,
    actual: input.which === 'actual' ? input.value : null,
    observed_on: input.observed_on,
    note: input.note,
    evidence_id: evidenceId,
  })
  if (isMissingRelation(error)) return { success: false, error: MISSING_0061 }
  if (isMissingColumnError(error as { code?: string } | null)) return { success: false, error: MISSING_0088 }
  if (error) return { success: false, error: dbErrorMessage('action.impact', error) }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}
