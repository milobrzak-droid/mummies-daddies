'use server'
// Rozhodnutí o „Rozdílech k vyřešení" z iDokladu (0092). Jen obchodní role
// (v DB sales_only). Nikdy nic nezapisuje do iDokladu — faktura se jen znovu
// PŘEČTE (aktuální stav), aby se do Cockpitu opsala přesně, ne ze staré kopie.
//
//  * dismissDiscrepancy — „vyřešeno jinak": rozdíl se uzavře (poznámka volitelná).
//    Vrací se jen když se změní otisk (např. jiná částka v iDokladu).
//  * applyDiscrepancy   — převzít z iDokladu: částka/měna/doklad/splatnost do
//    záznamu (jiná částka), nebo nový záznam z faktury pro zvolenou firmu.
//  * cancelRecordOfDiscrepancy — záznam bez faktury: zrušit záznam.
// Zápisy do financial_record jdou servisním klíčem s hlavičkou aktéra
// (user:<id>, stav údaje human_confirmed) — strážce 0092 dovolí sloupce
// z iDokladu měnit jen bez přihlášeného uživatele. Rozhodnutí o rozdílu píše
// člověk pod svou session (RLS + strážce, resolved_by = auth.uid()).
import { revalidatePath } from 'next/cache'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { createAuditedAdminClient } from '@/core/auditDb'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { createIdokladClient, fetchInvoicesByIds, idokladCredentialsFromEnv, IdokladError } from '@/connectors/idoklad'
import { invoiceApplyPatch, newRecordFromInvoice, SUPPORTED_CURRENCIES } from '@/domain/finance/idoklad'
import type { Currency } from '@/domain/finance/records'

const SALES_ACCESS_ERROR = 'Rozdíly z iDokladu může řešit jen člen s přístupem k obchodu.'
const MISSING = 'Rozdíly z iDokladu ještě nejsou dostupné — čekají na migraci 0092.'
const NOT_FOUND = 'Rozdíl nebyl nalezen nebo už je vyřešený.'
const NO_CREDENTIALS = 'Chybí přihlašovací údaje k iDokladu (IDOKLAD_CLIENT_ID a IDOKLAD_CLIENT_SECRET).'

type Db = Awaited<ReturnType<typeof createClient>>
type Loaded = {
  id: number
  kind: string
  idoklad_kind: string | null
  idoklad_id: number | null
  account_id: number | null
  record_id: number | null
}

async function guard(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false, error: AUTH_ERROR_MESSAGE }
  const { member } = await getCurrentMember()
  if (!memberSeesSales(member)) return { ok: false, error: SALES_ACCESS_ERROR }
  return { ok: true, userId: user.id }
}

async function loadOpen(s: Db, id: number): Promise<{ ok: true; row: Loaded } | { ok: false; error: string }> {
  const { data, error } = await s
    .from('idoklad_discrepancy')
    .select('id, kind, idoklad_kind, idoklad_id, account_id, record_id')
    .eq('id', id)
    .eq('status', 'open')
    .maybeSingle()
  if (isMissingRelation(error) || isMissingColumn(error)) return { ok: false, error: MISSING }
  if (error) return { ok: false, error: dbErrorMessage('action.idokladDiscrepancy', error) }
  if (!data) return { ok: false, error: NOT_FOUND }
  return { ok: true, row: data as Loaded }
}

const noteOf = (formData: FormData): string | null => {
  const v = formData.get('note')
  const t = typeof v === 'string' ? v.trim() : ''
  return t === '' ? null : t.slice(0, 500)
}

async function close(s: Db, id: number, resolution: 'applied' | 'dismissed', note: string | null): Promise<ActionResult> {
  const { data, error } = await s
    .from('idoklad_discrepancy')
    .update({ status: resolution === 'applied' ? 'resolved' : 'dismissed', resolution, resolution_note: note })
    .eq('id', id)
    .eq('status', 'open')
    .select('id')
  if (error) return { success: false, error: dbErrorMessage('action.idokladDiscrepancy', error) }
  if (!data || (data as unknown[]).length === 0) return { success: false, error: 'Rozdíl se mezitím změnil. Načtěte prosím stránku znovu.' }
  revalidatePath('/cockpit/finance')
  revalidatePath('/cockpit/prehled-tydne')
  return { success: true }
}

export async function dismissDiscrepancy(discrepancyId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }
  if (!areEntityIds(discrepancyId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadOpen(s, discrepancyId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  return close(s, discrepancyId, 'dismissed', noteOf(formData))
}

/** Znovu přečte fakturu z iDokladu (jen GET). */
async function readInvoice(idokladId: number) {
  const creds = idokladCredentialsFromEnv(process.env)
  if (!creds) return { ok: false as const, error: NO_CREDENTIALS }
  try {
    const found = await fetchInvoicesByIds(createIdokladClient(creds), [idokladId])
    const inv = found.find((i) => i.id === idokladId)
    if (!inv) return { ok: false as const, error: 'Faktura už v iDokladu není. Označ rozdíl jako vyřešený.' }
    return { ok: true as const, invoice: inv }
  } catch (e) {
    return { ok: false as const, error: e instanceof IdokladError ? e.message : 'iDoklad teď neodpovídá. Zkus to prosím za chvíli.' }
  }
}

const supported = (c: string | null): c is Currency => c !== null && (SUPPORTED_CURRENCIES as readonly string[]).includes(c)

export async function applyDiscrepancy(discrepancyId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }
  if (!areEntityIds(discrepancyId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadOpen(s, discrepancyId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const d = loaded.row
  if (d.idoklad_kind !== 'invoice' || d.idoklad_id === null || (d.kind !== 'amount_mismatch' && d.kind !== 'invoice_without_record')) {
    return { success: false, error: 'Tenhle rozdíl se nedá převzít automaticky. Uprav záznam ručně, nebo ho označ jako vyřešený.' }
  }
  const read = await readInvoice(d.idoklad_id)
  if (!read.ok) return { success: false, error: read.error }
  const inv = read.invoice
  if (!supported(inv.currency)) return { success: false, error: `Faktura je v měně ${inv.currency ?? 'neznámé'}, kterou Cockpit u finančních záznamů nepodporuje.` }
  if (inv.totalNet <= 0) return { success: false, error: 'Faktura má nulovou částku, nemá se co převzít.' }

  const admin = createAuditedAdminClient({ actor: { type: 'user', id: g.userId }, infoState: 'human_confirmed' })
  if (d.kind === 'amount_mismatch') {
    if (d.record_id === null) return { success: false, error: 'K rozdílu chybí záznam v Cockpitu.' }
    const { data: rec, error: recErr } = await admin
      .from('financial_record').select('id, status, external_ref, idoklad_id, account_id').eq('id', d.record_id).maybeSingle()
    if (recErr) return { success: false, error: dbErrorMessage('action.idokladApply', recErr) }
    const r = rec as { id: number; status: string; external_ref: string | null; idoklad_id: number | null; account_id: number } | null
    if (!r || r.status === 'cancelled') return { success: false, error: 'Záznam už neexistuje nebo je zrušený. Označ rozdíl jako vyřešený.' }
    if (r.idoklad_id !== null && r.idoklad_id !== inv.id) return { success: false, error: 'Záznam je spárovaný s jinou fakturou.' }
    const patch = invoiceApplyPatch({ status: r.status as 'draft' | 'confirmed', external_ref: r.external_ref, idoklad_id: r.idoklad_id }, inv, inv.currency)
    const { error } = await admin.from('financial_record').update(patch).eq('id', r.id).neq('status', 'cancelled')
    if (error) return { success: false, error: dbErrorMessage('action.idokladApply', error) }
    revalidatePath(`/cockpit/clients/${r.account_id}`)
  } else {
    if (d.record_id !== null) return { success: false, error: 'Číslo dokladu sedí se záznamem u jiné firmy. Oprav záznam ručně, nebo rozdíl označ jako vyřešený.' }
    const accountId = Number(formData.get('account_id') ?? d.account_id)
    if (!areEntityIds(accountId)) return { success: false, error: 'Zvol firmu, které faktura patří.' }
    const { data: acc } = await s.from('account').select('id').eq('id', accountId).maybeSingle()
    if (!acc) return { success: false, error: 'Zvolená firma neexistuje.' }
    const { error } = await admin.from('financial_record').insert(newRecordFromInvoice(accountId, inv, inv.currency))
    if (error) {
      const code = (error as { code?: string }).code
      return { success: false, error: code === '23505' ? 'K této faktuře už záznam v Cockpitu existuje.' : dbErrorMessage('action.idokladApply', error) }
    }
    revalidatePath(`/cockpit/clients/${accountId}`)
  }
  return close(s, discrepancyId, 'applied', noteOf(formData))
}

/** Záznam bez faktury: zrušit záznam (nevratné, historie zůstává) a uzavřít rozdíl. */
export async function cancelRecordOfDiscrepancy(discrepancyId: number): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }
  if (!areEntityIds(discrepancyId)) return { success: false, error: 'Neplatné ID.' }
  const s = await createClient()
  const loaded = await loadOpen(s, discrepancyId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const d = loaded.row
  if (d.kind !== 'record_without_invoice' || d.record_id === null) {
    return { success: false, error: 'Tenhle rozdíl se týká jiné situace, záznam se tu zrušit nedá.' }
  }
  const { data, error } = await s
    .from('financial_record').update({ status: 'cancelled' }).eq('id', d.record_id).neq('status', 'cancelled').select('account_id')
  if (error) return { success: false, error: dbErrorMessage('action.idokladCancel', error) }
  const accountId = (data as { account_id: number }[] | null)?.[0]?.account_id
  if (accountId) revalidatePath(`/cockpit/clients/${accountId}`)
  return close(s, discrepancyId, 'applied', null)
}
