'use server'
// Zápisy finančních záznamů (kap. 10, migrace 0063).
//
// Peníze vidí a zapisují jen obchodní role (rozhodnutí vlastníka; v DB
// RESTRICTIVE sales_only). Kontrola tady dává srozumitelnou hlášku dřív,
// než by zápis tiše skončil na RLS. Záznam se nemaže — ruší se (status
// 'cancelled'), historie zůstává. Faktura ani úhrada se neodvozují z pošty:
// vznikají ručně (číslo dokladu z účetnictví) nebo jako návrh z přijatého
// milníku.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import {
  checkUpdate,
  financialRecordCreateSchema,
  financialRecordUpdateSchema,
  DUE_ONLY_INVOICED,
  milestoneInvoiceSchema,
  periodOfDate,
  type FinancialKind,
  type FinancialStatus,
} from '@/domain/finance/records'
import type { ZodError } from 'zod'

const SALES_ACCESS_ERROR = 'Finanční záznamy může upravovat jen člen s přístupem k obchodu.'
const MISSING = 'Finanční záznamy ještě nejsou dostupné — čekají na migraci 0063.'
const NOT_FOUND = 'Finanční záznam nebyl nalezen.'
const DUE_MISSING = 'Splatnost ještě není dostupná — čeká na migraci 0090.'

/** Sloupec splatnosti chybí (před 0090): PostgREST PGRST204 nebo Postgres 42703. */
const isMissingDueColumn = (e: { code?: string | null; message?: string | null } | null): boolean =>
  !!e && (isMissingColumn(e) || e.code === 'PGRST204')

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

async function seesSales(): Promise<boolean> {
  return memberSeesSales((await getCurrentMember()).member)
}

type Db = Awaited<ReturnType<typeof createClient>>

async function belongs(s: Db, table: 'deal' | 'engagement', id: number | null, accountId: number): Promise<boolean> {
  if (id === null) return true
  const { data, error } = await s.from(table).select('account_id').eq('id', id).maybeSingle()
  return !error && (data as { account_id: number } | null)?.account_id === accountId
}

function revalidate(accountId: number) {
  revalidatePath('/cockpit/finance')
  revalidatePath(`/cockpit/clients/${accountId}`)
}

export async function createFinancialRecord(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = financialRecordCreateSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  if (!(await seesSales())) return { success: false, error: SALES_ACCESS_ERROR }
  const d = parsed.data
  const s = await createClient()
  if (!(await belongs(s, 'deal', d.deal_id, d.account_id))) {
    return { success: false, fieldErrors: { deal_id: 'Obchod nepatří této firmě.' } }
  }
  if (!(await belongs(s, 'engagement', d.engagement_id, d.account_id))) {
    return { success: false, fieldErrors: { engagement_id: 'Dodávka nepatří této firmě.' } }
  }
  // Splatnost se zapisuje jen s hodnotou: bez ní se sloupec nedotkne, takže zápis
  // funguje i před migrací 0090.
  const { due_on: dueOn, ...rest } = d
  const row: Record<string, unknown> = dueOn ? { ...rest, due_on: dueOn } : rest
  const { error } = await s.from('financial_record').insert(row)
  // Sloupec první: Postgres píše „column … of relation … does not exist“, což by isMissingRelation vzal za chybějící tabulku.
  if (isMissingDueColumn(error)) return { success: false, fieldErrors: { due_on: DUE_MISSING } }
  if (isMissingRelation(error)) return { success: false, error: MISSING }
  if (error) return { success: false, error: dbErrorMessage('action.financialRecords', error) }
  revalidate(d.account_id)
  return { success: true }
}

type Current = { id: number; account_id: number; kind: FinancialKind; status: FinancialStatus }

async function loadRecord(s: Db, id: number): Promise<{ ok: true; row: Current } | { ok: false; error: string }> {
  const { data, error } = await s
    .from('financial_record')
    .select('id, account_id, kind, status')
    .eq('id', id)
    .maybeSingle()
  if (isMissingRelation(error)) return { ok: false, error: MISSING }
  if (error) return { ok: false, error: dbErrorMessage('action.financialRecords', error) }
  if (!data) return { ok: false, error: NOT_FOUND }
  return { ok: true, row: data as Current }
}

export async function updateFinancialRecord(
  recordId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(recordId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = financialRecordUpdateSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  if (!(await seesSales())) return { success: false, error: SALES_ACCESS_ERROR }
  const s = await createClient()
  const loaded = await loadRecord(s, recordId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const problem = checkUpdate(loaded.row, parsed.data)
  if (problem) {
    if (problem.includes('číslo dokladu')) return { success: false, fieldErrors: { external_ref: problem } }
    if (problem === DUE_ONLY_INVOICED) return { success: false, fieldErrors: { due_on: problem } }
    return { success: false, error: problem }
  }
  // Splatnost se mění jen u vyfakturovaného (prázdné pole ji smaže). U ostatních
  // druhů se do zápisu nedostane; před 0090 se prázdná splatnost vynechá.
  const { due_on: dueOn, ...rest } = parsed.data
  const run = (patch: Record<string, unknown>) => s
    .from('financial_record')
    .update(patch)
    .eq('id', recordId)
    .eq('status', loaded.row.status)
    .select('id')
  const withDue = loaded.row.kind === 'invoiced'
  let { data, error } = await run(withDue ? { ...rest, due_on: dueOn } : rest)
  if (withDue && isMissingDueColumn(error)) {
    if (dueOn) return { success: false, fieldErrors: { due_on: DUE_MISSING } }
    ;({ data, error } = await run(rest))
  }
  if (error) return { success: false, error: dbErrorMessage('action.financialRecords', error) }
  if (!data || (data as unknown[]).length === 0) {
    return { success: false, error: 'Záznam se mezitím změnil. Načtěte prosím stránku znovu.' }
  }
  revalidate(loaded.row.account_id)
  return { success: true }
}

export async function cancelFinancialRecord(recordId: number): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(recordId)) return { success: false, error: 'Neplatné ID.' }
  if (!(await seesSales())) return { success: false, error: SALES_ACCESS_ERROR }
  const s = await createClient()
  const loaded = await loadRecord(s, recordId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  if (loaded.row.status === 'cancelled') return { success: true }
  const { error } = await s
    .from('financial_record')
    .update({ status: 'cancelled' })
    .eq('id', recordId)
    .neq('status', 'cancelled')
  if (error) return { success: false, error: dbErrorMessage('action.financialRecords', error) }
  revalidate(loaded.row.account_id)
  return { success: true }
}

/**
 * „Přijatý milník vytvoří návrh fakturačních podkladů" (kap. 10). Založí
 * návrh kind = 'invoiced', source = 'milnik' napojený na milník, dodávku,
 * obchod dodávky a doklad akceptace. Idempotentní: nezrušený podklad
 * k milníku může být jen jeden (i částečný UNIQUE index v 0063).
 */
export async function createMilestoneInvoiceDraft(
  accountId: number,
  engagementId: number,
  milestoneId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, milestoneId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = milestoneInvoiceSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  if (!(await seesSales())) return { success: false, error: SALES_ACCESS_ERROR }
  const s = await createClient()

  const { data: eng, error: engErr } = await s
    .from('engagement')
    .select('id, account_id, deal_id')
    .eq('id', engagementId)
    .maybeSingle()
  if (engErr) return { success: false, error: dbErrorMessage('action.financialRecords', engErr) }
  const e = eng as { account_id: number; deal_id: number | null } | null
  if (!e || e.account_id !== accountId) return { success: false, error: 'Dodávka nebyla nalezena.' }

  const { data: ms, error: msErr } = await s
    .from('engagement_milestone')
    .select('id, status, accepted_at, acceptance_evidence_id')
    .eq('id', milestoneId)
    .eq('engagement_id', engagementId)
    .maybeSingle()
  if (isMissingRelation(msErr)) return { success: false, error: 'Milníky ještě nejsou dostupné — čekají na migraci 0042.' }
  if (msErr) return { success: false, error: dbErrorMessage('action.financialRecords', msErr) }
  const m = ms as { status: string; accepted_at: string | null; acceptance_evidence_id: number | null } | null
  if (!m) return { success: false, error: 'Milník nebyl nalezen.' }
  if ((m.status !== 'prijato' && m.status !== 'uzavreno') || !m.accepted_at) {
    return { success: false, error: 'Podklad k fakturaci vzniká jen z přijatého milníku.' }
  }

  const { data: existing, error: exErr } = await s
    .from('financial_record')
    .select('id')
    .eq('milestone_id', milestoneId)
    .eq('kind', 'invoiced')
    .neq('status', 'cancelled')
    .limit(1)
  if (isMissingRelation(exErr)) return { success: false, error: MISSING }
  if (exErr) return { success: false, error: dbErrorMessage('action.financialRecords', exErr) }
  const path = `/cockpit/clients/${accountId}/engagements/${engagementId}/edit`
  if (existing && (existing as unknown[]).length > 0) {
    revalidatePath(path)
    return { success: true }
  }

  const { error } = await s.from('financial_record').insert({
    account_id: accountId,
    deal_id: e.deal_id,
    engagement_id: engagementId,
    milestone_id: milestoneId,
    kind: 'invoiced',
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    period_month: periodOfDate(m.accepted_at),
    status: 'draft',
    source: 'milnik',
    evidence_id: m.acceptance_evidence_id,
    note: parsed.data.note,
  })
  // Souběžné kliknutí: UNIQUE index vrátí 23505 — podklad už existuje.
  const code = (error as { code?: string } | null)?.code
  if (error && code !== '23505') {
    if (isMissingRelation(error)) return { success: false, error: MISSING }
    return { success: false, error: dbErrorMessage('action.financialRecords', error) }
  }
  revalidatePath(path)
  revalidate(accountId)
  return { success: true }
}
