'use server'
// Zápisy milníků dodávky (0042) a předávacího balíčku (0054), kap. 6.
//
// Každá exportovaná akce začíná tryRequireUser({ aal2: true }). Zápisy jdou
// přes uživatelského klienta (RLS + AAL2); jediná výjimka je zápis evidence
// při akceptaci — INSERT do `evidence` smí jen service_role (0038), proto
// createAdminClient, a to až PO ověření, že dokument patří k této dodávce
// a člen týmu ho pod RLS vidí.
//
// Evidence akceptace: source_kind 'file', source_id 'engagement_document:<id>'
// (nebo 'engagement_document:<id>@v<verze>', když dokument nese schválenou
// verzi, 0094), web_link = URL dokumentu přečtená z DB (ne z formuláře). Řádek
// evidence je sdílený ukazatel (UNIQUE kind+id, první zápis vyhrává) — jmenný
// prostor s id dokumentu zaručuje, že si uživatel nemůže „zabrat" ukazatel
// jiného zdroje; odkaz je navíc omezený na *.sharepoint.com (0051 CHECK + regex).
//
// Přijatý milník odkazuje na KONKRÉTNÍ verzi dokumentu (0094,
// engagement_milestone.acceptance_document_version_id): tu, která byla
// schválena a odeslána klientovi. Když se dokument od schválení změnil
// (otevřený nález denní kontroly), akceptace neprojde — klient by přijal něco
// jiného, než co je v SharePointu teď. Po přijetí se odeslaný dokument označí
// jako přijatý.
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
import { hasOpenFinding } from '@/domain/delivery/documentFindings'
import { isMissingDocumentColumn } from '@/domain/delivery/documentVersions'
import { findDealPublic } from '@/lib/queries/dealPublic'
import { auditRowPayload } from '@/core/auditCoverage'
import { IMPACT_SETTINGS_COLUMNS, baselineMetricOk, type ImpactSettings } from '@/domain/delivery/impactMetric'
import {
  buildHandoffPackage,
  handoffLabel,
  handoffSchema,
  isMilestoneLocked,
  isMilestoneStatus,
  milestoneAcceptSchema,
  milestoneCreateSchema,
  milestoneDueSchema,
  milestoneUpdateSchema,
  nextMilestoneStatuses,
  transitionMilestone,
  validateHandoff,
  type MilestoneStatus,
} from '@/domain/delivery/milestone'
import type { ZodError } from 'zod'

const MISSING_MILESTONES = 'Milníky ještě nejsou dostupné — čekají na migraci 0042.'
const MISSING_HANDOFF = 'Předávací balíček ještě není dostupný — čeká na migraci 0054.'
const NOT_FOUND_ENGAGEMENT = 'Dodávka nebyla nalezena.'
const NOT_FOUND_MILESTONE = 'Milník nebyl nalezen.'
const STALE = 'Milník mezitím změnil stav. Načti prosím stránku znovu.'
const LOCKED = 'Přijatý milník už upravit nejde — nese doklad akceptace od klienta.'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

function editPath(accountId: number, engagementId: number): string {
  return `/cockpit/clients/${accountId}/engagements/${engagementId}/edit`
}

type Db = Awaited<ReturnType<typeof createClient>>

// Dodávka musí patřit k firmě z URL — jinak by šlo přes cizí accountId
// ověřovat kontakty jiné firmy.
async function engagementBelongs(s: Db, accountId: number, engagementId: number): Promise<boolean | 'error'> {
  const { data, error } = await s.from('engagement').select('id, account_id').eq('id', engagementId).maybeSingle()
  if (error) return 'error'
  return !!data && (data as { account_id: number }).account_id === accountId
}

async function contactBelongs(s: Db, accountId: number, contactId: number): Promise<boolean> {
  const { data, error } = await s.from('contact').select('id').eq('id', contactId).eq('account_id', accountId).maybeSingle()
  return !error && !!data
}

type MilestoneRow = {
  id: number
  status: MilestoneStatus
  title: string
  owner_id: string | null
  deputy_id: string | null
  due_on: string | null
  accepted_at: string | null
  accepted_by_contact_id: number | null
  acceptance_evidence_id: number | null
}

async function loadMilestone(
  s: Db,
  engagementId: number,
  milestoneId: number,
): Promise<{ ok: true; row: MilestoneRow } | { ok: false; error: string }> {
  const { data, error } = await s
    .from('engagement_milestone')
    .select('id, status, title, owner_id, deputy_id, due_on, accepted_at, accepted_by_contact_id, acceptance_evidence_id')
    .eq('id', milestoneId)
    .eq('engagement_id', engagementId)
    .maybeSingle()
  if (isMissingRelation(error)) return { ok: false, error: MISSING_MILESTONES }
  if (error) return { ok: false, error: dbErrorMessage('action.milestones', error) }
  if (!data) return { ok: false, error: NOT_FOUND_MILESTONE }
  return { ok: true, row: data as MilestoneRow }
}

// ---------------------------------------------------------------------------
// Milníky

export async function createMilestone(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = milestoneCreateSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const belongs = await engagementBelongs(s, accountId, engagementId)
  if (belongs !== true) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  const { error } = await s.from('engagement_milestone').insert({ ...parsed.data, engagement_id: engagementId })
  if (isMissingRelation(error)) return { success: false, error: MISSING_MILESTONES }
  if (error) return { success: false, error: dbErrorMessage('action.milestones', error) }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

type MilestonePatch = Partial<Pick<MilestoneRow, 'title' | 'owner_id' | 'deputy_id' | 'due_on'>>

/**
 * Úprava milníku: název, termín, vlastník a zástupce (stejná pravidla jako
 * při založení). Přijatý nebo uzavřený milník je zamčený — nese doklad
 * akceptace. Oprávnění jako u ostatních zápisů dodávky: interní role s AAL2
 * (tryRequireUser) a RLS člena týmu + AAL2 na engagement_milestone (0042).
 */
export async function updateMilestone(
  accountId: number,
  engagementId: number,
  milestoneId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, milestoneId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = milestoneUpdateSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  return writeMilestone(user.id, accountId, engagementId, milestoneId, parsed.data)
}

/**
 * Rychlé doplnění termínu (tlačítko „Doplnit termín" u milníku bez termínu,
 * typicky u milníků, které po vyhraném obchodu založil Cockpit sám, 0080).
 * Mění jen termín, nic jiného nepřepíše.
 */
export async function setMilestoneDue(
  accountId: number,
  engagementId: number,
  milestoneId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, milestoneId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = milestoneDueSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  return writeMilestone(user.id, accountId, engagementId, milestoneId, { due_on: parsed.data.due_on })
}

async function writeMilestone(
  userId: string,
  accountId: number,
  engagementId: number,
  milestoneId: number,
  patch: MilestonePatch,
): Promise<ActionResult> {
  const s = await createClient()
  const belongs = await engagementBelongs(s, accountId, engagementId)
  if (belongs !== true) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  const loaded = await loadMilestone(s, engagementId, milestoneId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const before = loaded.row
  if (isMilestoneLocked(before.status)) return { success: false, error: LOCKED }
  // Zástupce ≠ vlastník i po změně jen jednoho z nich (CHECK engagement_milestone_deputy_check).
  const owner = patch.owner_id !== undefined ? patch.owner_id : before.owner_id
  const deputy = patch.deputy_id !== undefined ? patch.deputy_id : before.deputy_id
  if (owner && deputy && owner === deputy) {
    return { success: false, fieldErrors: { deputy_id: 'Zástupce musí být jiný člověk než vlastník.' } }
  }
  // Zámek na původní stav: když milník mezitím někdo přijal, změna se nezapíše.
  const { data, error } = await s
    .from('engagement_milestone')
    .update(patch)
    .eq('id', milestoneId)
    .eq('engagement_id', engagementId)
    .eq('status', before.status)
    .select('id')
  if (isMissingRelation(error)) return { success: false, error: MISSING_MILESTONES }
  if (error) return { success: false, error: dbErrorMessage('action.milestones', error) }
  if (!data?.length) return { success: false, error: STALE }
  // Po migraci 0064 zapisuje změnu DB trigger (engagement_milestone.updated:
  // termín, vlastník a zástupce s hodnotou, název jen jménem sloupce); appka
  // jen do té doby a stejným tvarem (auditRowPayload), nikdy obojí.
  if (!(await dbAuditActive())) {
    const audit = auditRowPayload('engagement_milestone', 'UPDATE', { ...before }, { ...before, ...patch })
    if (audit) {
      await recordAudit('engagement_milestone', milestoneId, 'engagement_milestone.updated', audit.before, audit.after, {
        type: 'user',
        id: userId,
      })
    }
  }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

/**
 * Přechod stavu podle grafu v milestone.ts. Do 'prijato' touto cestou NEjde —
 * přijetí se zapisuje jen s dokladem přes acceptMilestone.
 */
export async function setMilestoneStatus(
  accountId: number,
  engagementId: number,
  milestoneId: number,
  to: string,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, milestoneId)) return { success: false, error: 'Neplatné ID.' }
  if (!isMilestoneStatus(to)) return { success: false, error: 'Neznámý stav milníku.' }
  if (to === 'prijato') {
    return { success: false, error: 'Přijetí se zapisuje s dokladem akceptace (dokument v SharePointu).' }
  }
  const s = await createClient()
  const loaded = await loadMilestone(s, engagementId, milestoneId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const from = loaded.row.status
  const t = transitionMilestone(from, to, {
    acceptedAt: loaded.row.accepted_at,
    acceptedByContactId: loaded.row.accepted_by_contact_id,
    acceptanceEvidenceId: loaded.row.acceptance_evidence_id,
  })
  if (!t.ok) return { success: false, error: t.reason }
  // Optimistický zámek na původní stav: souběžná změna se nepřepíše.
  const { data, error } = await s
    .from('engagement_milestone')
    .update({ status: to })
    .eq('id', milestoneId)
    .eq('engagement_id', engagementId)
    .eq('status', from)
    .select('id')
  if (isMissingRelation(error)) return { success: false, error: MISSING_MILESTONES }
  if (error) return { success: false, error: dbErrorMessage('action.milestones', error) }
  if (!data?.length) return { success: false, error: STALE }
  // Po migraci 0064 zapisuje změnu stavu DB trigger (engagement_milestone.updated);
  // appka jen do té doby, nikdy obojí.
  if (!(await dbAuditActive())) {
    await recordAudit('engagement_milestone', milestoneId, 'milestone.status', { status: from }, { status: to }, {
      type: 'user',
      id: user.id,
    })
  }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

/**
 * Čeká na schválení → Přijato. Vyžaduje doklad: vybraný dokument dodávky nebo
 * nový odkaz do SharePointu. Doklad se zapíše jako evidence (service role)
 * a milník dostane accepted_at + acceptance_evidence_id (CHECK v 0042).
 */
export async function acceptMilestone(
  accountId: number,
  engagementId: number,
  milestoneId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, milestoneId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = milestoneAcceptSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const input = parsed.data
  if (input.accepted_on > pragueToday()) {
    return { success: false, fieldErrors: { accepted_on: 'Datum akceptace nesmí být v budoucnosti.' } }
  }

  const s = await createClient()
  const belongs = await engagementBelongs(s, accountId, engagementId)
  if (belongs !== true) return { success: false, error: NOT_FOUND_ENGAGEMENT }

  const loaded = await loadMilestone(s, engagementId, milestoneId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const from = loaded.row.status
  if (!nextMilestoneStatuses(from).includes('prijato')) {
    return { success: false, error: 'Přijmout lze jen milník, který čeká na schválení klientem.' }
  }

  if (input.accepted_by_contact_id !== null && !(await contactBelongs(s, accountId, input.accepted_by_contact_id))) {
    return { success: false, fieldErrors: { accepted_by_contact_id: 'Kontakt nepatří k této firmě.' } }
  }

  // Dokument: existující (musí patřit k dodávce) nebo nově založený.
  let doc: { id: number; url: string; milestone_id: number | null; status?: string | null; approved_version_id?: number | null }
  if (input.document_id !== null) {
    const readDoc = (columns: string) => s
      .from('engagement_document')
      .select(columns)
      .eq('id', input.document_id)
      .eq('engagement_id', engagementId)
      .maybeSingle()
    let res = await readDoc('id, url, milestone_id, status, approved_version_id')
    // Migrace 0094 ještě neběžela: dokument bez stavu a verze (jako dřív).
    if (isMissingDocumentColumn(res.error)) res = await readDoc('id, url, milestone_id')
    const { data, error } = res
    if (isMissingRelation(error)) return { success: false, error: 'Dokumenty ještě nejsou dostupné — čekají na migraci 0051.' }
    if (error) return { success: false, error: dbErrorMessage('action.milestones', error) }
    if (!data) return { success: false, fieldErrors: { document_id: 'Dokument nepatří k této dodávce.' } }
    doc = data as unknown as typeof doc
    // Schválený dokument, který se od schválení změnil, akceptovat nejde.
    if (doc.status && doc.status !== 'draft' && (await hasOpenFinding(s, doc.id, 'changed'))) {
      return {
        success: false,
        fieldErrors: { document_id: 'Dokument se od schválení změnil — nejdřív ho v záložce Dokumenty znovu schval, nebo vrať do konceptu.' },
      }
    }
  } else {
    const { data, error } = await s
      .from('engagement_document')
      .insert({
        engagement_id: engagementId,
        milestone_id: milestoneId,
        title: input.new_title,
        url: input.new_url,
        kind: 'vystup',
        created_by: user.id,
      })
      .select('id, url, milestone_id')
      .single()
    if (isMissingRelation(error)) return { success: false, error: 'Dokumenty ještě nejsou dostupné — čekají na migraci 0051.' }
    if (error || !data) return { success: false, error: dbErrorMessage('action.milestones', error) }
    doc = data as typeof doc
  }
  // Obrana do hloubky: evidence smí ukazovat jen do SharePointu.
  if (!SHAREPOINT_URL_RE.test(doc.url)) {
    return { success: false, error: 'Doklad akceptace musí být odkaz do SharePointu.' }
  }

  // Verze, kterou klient přijímá: schválená (připíchnutá) verze dokumentu; koncept
  // ani dokument bez zaznamenané verze žádnou nenese.
  const versionId = doc.status && doc.status !== 'draft' && typeof doc.approved_version_id === 'number' ? doc.approved_version_id : null
  const evidence = await recordEvidence(
    createAdminClient(),
    {
      kind: 'file',
      sourceId: versionId !== null ? `engagement_document:${doc.id}@v${versionId}` : `engagement_document:${doc.id}`,
      webLink: doc.url,
    },
    `user:${user.id}`,
  )
  if (!evidence.ok) return { success: false, error: 'Doklad akceptace se nepodařilo zapsat. Zkuste to prosím znovu.' }

  const acceptedAt = `${input.accepted_on}T12:00:00Z`
  const t = transitionMilestone(from, 'prijato', {
    acceptedAt,
    acceptedByContactId: input.accepted_by_contact_id,
    acceptanceEvidenceId: evidence.id,
  })
  if (!t.ok) return { success: false, error: t.reason }

  const after = {
    status: 'prijato' as const,
    accepted_at: acceptedAt,
    accepted_by_contact_id: input.accepted_by_contact_id,
    acceptance_evidence_id: evidence.id,
    // Jen když verzi známe (znamená to, že 0094 běží); jinak sloupec vůbec neposíláme.
    ...(versionId !== null ? { acceptance_document_version_id: versionId } : {}),
  }
  const { data: updated, error } = await s
    .from('engagement_milestone')
    .update(after)
    .eq('id', milestoneId)
    .eq('engagement_id', engagementId)
    .eq('status', from)
    .select('id')
  if (isMissingRelation(error)) return { success: false, error: MISSING_MILESTONES }
  if (error) return { success: false, error: dbErrorMessage('action.milestones', error) }
  if (!updated?.length) return { success: false, error: STALE }

  // Navázat dokument na milník, pokud ještě nikam navázaný není (best-effort:
  // akceptace už je zapsaná, chybějící vazba je jen pohodlí v přehledu).
  if (doc.milestone_id === null) {
    await s
      .from('engagement_document')
      .update({ milestone_id: milestoneId })
      .eq('id', doc.id)
      .eq('engagement_id', engagementId)
      .is('milestone_id', null)
  }
  // Odeslaný dokument je teď přijatý klientem (DB to dovolí jen u dokumentu
  // navázaného na přijatý milník s dokladem — proto až po zápisu milníku a
  // vazby). Best-effort: akceptace je zapsaná, stav dokumentu je pohodlí.
  if (doc.status === 'sent') {
    const { error: docError } = await s
      .from('engagement_document')
      .update({ status: 'accepted' })
      .eq('id', doc.id)
      .eq('engagement_id', engagementId)
      .eq('status', 'sent')
    if (docError) dbErrorMessage('action.milestones.documentAccepted', docError)
  }

  // Po migraci 0064 zapisuje akceptaci DB trigger (engagement_milestone.updated
  // s evidence_id z acceptance_evidence_id a human_confirmed); appka jen do té
  // doby, nikdy obojí.
  if (!(await dbAuditActive())) {
    await recordAudit(
      'engagement_milestone',
      milestoneId,
      'milestone.accepted',
      { status: from },
      after,
      { type: 'user', id: user.id },
      { evidenceId: evidence.id, infoState: 'human_confirmed' },
    )
  }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

/** Smazat jde jen nepřijatý milník — přijatý nese doklad akceptace. */
export async function deleteMilestone(
  accountId: number,
  engagementId: number,
  milestoneId: number,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, milestoneId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadMilestone(s, engagementId, milestoneId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const status = loaded.row.status
  if (status === 'prijato' || status === 'uzavreno') {
    return { success: false, error: 'Přijatý milník nejde smazat — nese doklad akceptace.' }
  }
  const { data, error } = await s
    .from('engagement_milestone')
    .delete()
    .eq('id', milestoneId)
    .eq('engagement_id', engagementId)
    .eq('status', status)
    .select('id')
  if (isMissingRelation(error)) return { success: false, error: MISSING_MILESTONES }
  if (error) return { success: false, error: dbErrorMessage('action.milestones', error) }
  if (!data?.length) return { success: false, error: STALE }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

// ---------------------------------------------------------------------------
// Předávací balíček

export async function saveHandoff(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = handoffSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const belongs = await engagementBelongs(s, accountId, engagementId)
  if (belongs !== true) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  // Obchod se ověřuje přes deal_public (0058): projekťák na tabulku deal
  // nevidí, ale schválenou nabídku k předání vybrat musí.
  const dealId = parsed.data.deal_id
  if (dealId !== null) {
    const deal = await findDealPublic(s, accountId, dealId)
    if (!deal.ok) return { success: false, error: dbErrorMessage('action.handoff', deal.error) }
    if (!deal.row) return { success: false, fieldErrors: { deal_id: 'Obchod nepatří k této firmě.' } }
  }
  const sponsor = parsed.data.client_sponsor_contact_id
  if (sponsor !== null && !(await contactBelongs(s, accountId, sponsor))) {
    return { success: false, fieldErrors: { client_sponsor_contact_id: 'Kontakt nepatří k této firmě.' } }
  }
  const { data, error } = await s
    .from('engagement')
    .update(parsed.data)
    .eq('id', engagementId)
    .eq('account_id', accountId)
    .select('id')
  if (isMissingColumnError(error)) return { success: false, error: MISSING_HANDOFF }
  if ((error as { code?: string } | null)?.code === '23514') {
    return {
      success: false,
      error: 'Předaná dodávka musí mít vyplněný cíl, rozsah, finanční rámec a rizika (nebo „žádná rizika").',
    }
  }
  if (error) return { success: false, error: dbErrorMessage('action.handoff', error) }
  if (!data?.length) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}

type HandoffEngagementRow = {
  account_id: number
  kind: string
  deal_id: number | null
  started_on: string | null
  due_on: string | null
  baseline_adoption_pct: number | string | null
  goal: string | null
  scope: string | null
  client_sponsor_contact_id: number | null
  financial_frame: string | null
  risks: string[] | null
  handoff_completed_at: string | null
}

/**
 * „Předat do realizace": zapíše handoff_completed_at jen když validateHandoff
 * nehlásí nic chybějícího. Opakované předání nic nepřepíše.
 */
export async function completeHandoff(
  accountId: number,
  engagementId: number,
): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const { data: eng, error: engErr } = await s
    .from('engagement')
    .select(
      'account_id, kind, deal_id, started_on, due_on, baseline_adoption_pct, goal, scope, client_sponsor_contact_id, financial_frame, risks, handoff_completed_at',
    )
    .eq('id', engagementId)
    .maybeSingle()
  if (isMissingColumnError(engErr)) return { success: false, error: MISSING_HANDOFF }
  if (engErr) return { success: false, error: dbErrorMessage('action.handoff', engErr) }
  const row = eng as HandoffEngagementRow | null
  if (!row || row.account_id !== accountId) return { success: false, error: NOT_FOUND_ENGAGEMENT }
  if (row.handoff_completed_at) return { success: false, error: 'Dodávka už je předaná do realizace.' }

  // Podklady a vlastník žijí v jiných tabulkách; chybějící tabulka = 0
  // (validateHandoff pak položku ohlásí jako chybějící, nic se nepředá).
  const docs = await s.from('engagement_document').select('id').eq('engagement_id', engagementId).limit(1)
  if (docs.error && !isMissingRelation(docs.error)) {
    return { success: false, error: dbErrorMessage('action.handoff', docs.error) }
  }
  const ms = await s.from('engagement_milestone').select('owner_id').eq('engagement_id', engagementId)
  if (ms.error && !isMissingRelation(ms.error)) {
    return { success: false, error: dbErrorMessage('action.handoff', ms.error) }
  }
  // „Vyhráno" z deal_public (0058) — fázi ani částky dodávka nepotřebuje.
  // Obchod musí patřit k firmě dodávky; cizí se nepočítá jako schválená nabídka.
  let dealIsWon = false
  if (row.deal_id !== null) {
    const deal = await findDealPublic(s, accountId, row.deal_id)
    if (!deal.ok) return { success: false, error: dbErrorMessage('action.handoff', deal.error) }
    dealIsWon = deal.row?.is_won ?? false
  }
  const documentCount = docs.error ? 0 : (docs.data ?? []).length
  const milestoneOwnerCount = ms.error
    ? 0
    : ((ms.data ?? []) as { owner_id: string | null }[]).filter((m) => m.owner_id !== null).length

  // Výchozí metrika (0088): výchozí měření hlavní metriky nebo doložené
  // „nelze měřit". Bez 0088 (chybí sloupce) platí staré pravidlo.
  const settingsRes = await s.from('engagement').select(IMPACT_SETTINGS_COLUMNS).eq('id', engagementId).maybeSingle()
  if (settingsRes.error && !isMissingColumnError(settingsRes.error as { code?: string })) {
    return { success: false, error: dbErrorMessage('action.handoff', settingsRes.error) }
  }
  const settings = settingsRes.error ? null : ((settingsRes.data ?? {}) as ImpactSettings)
  const obsQuery = (cols: string) => s.from('metric_observation').select(cols).eq('engagement_id', engagementId)
  let obsRes = await obsQuery('id, metric_key, baseline, actual, observed_on')
  if (isMissingColumnError(obsRes.error as { code?: string } | null)) obsRes = await obsQuery('id, baseline, actual, observed_on')
  if (obsRes.error && !isMissingRelation(obsRes.error)) {
    return { success: false, error: dbErrorMessage('action.handoff', obsRes.error) }
  }
  type ObsRow = { id: number; metric_key?: string | null; baseline: number | string | null; actual: number | string | null; observed_on: string }
  const observations = obsRes.error
    ? null
    : ((obsRes.data ?? []) as unknown as ObsRow[]).map((o) => ({
        id: o.id,
        metric_key: o.metric_key ?? null,
        baseline: o.baseline === null ? null : Number(o.baseline),
        actual: o.actual === null ? null : Number(o.actual),
        observed_on: o.observed_on,
      }))
  const baselineOk = baselineMetricOk({
    kind: row.kind,
    settings,
    observations,
    baselineAdoptionPct: row.baseline_adoption_pct,
  })

  const v = buildHandoffPackage({ ...row, baseline_ok: baselineOk, deal_is_won: dealIsWon, documentCount, milestoneOwnerCount })
  const check = validateHandoff(v)
  if (!check.ok) {
    return {
      success: false,
      error: `Předávací balíček není úplný — chybí: ${check.missing.map(handoffLabel).join(', ')}.`,
    }
  }

  const completedAt = new Date().toISOString()
  const { data, error } = await s
    .from('engagement')
    .update({ handoff_completed_at: completedAt, handoff_by: user.id })
    .eq('id', engagementId)
    .eq('account_id', accountId)
    .is('handoff_completed_at', null)
    .select('id')
  if (isMissingColumnError(error)) return { success: false, error: MISSING_HANDOFF }
  if (error) return { success: false, error: dbErrorMessage('action.handoff', error) }
  if (!data?.length) return { success: false, error: 'Dodávka už je předaná do realizace.' }
  // Po migraci 0064 zapisuje předání DB trigger (engagement.updated,
  // handoff_completed_at + handoff_by, human_confirmed); appka jen do té doby.
  if (!(await dbAuditActive())) {
    await recordAudit(
      'engagement',
      engagementId,
      'engagement.handoff_completed',
      { handoff_completed_at: null },
      { handoff_completed_at: completedAt },
      { type: 'user', id: user.id },
      { infoState: 'human_confirmed' },
    )
  }
  revalidatePath(editPath(accountId, engagementId))
  return { success: true }
}
