'use server'
// Zápisy cílových seznamů. Pravidlo z PLAN-PRESTAVBY kap. 4: první oslovení
// vytvoří aktivitu (sales_activity), NIKDY obchod — tenhle modul na tabulku
// deal nesahá (hlídá test/target-list.test.ts). Návrhy podle segmentu
// (suggestTargetListItems) potřebují vědět, kdo je klient — to čte
// domain/crm/queries/targetSegments.ts (z deal jen account_id a fázi).
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import {
  planStatusChange,
  targetEntityId,
  targetListItemSchema,
  targetListSchema,
  targetStatusSchema,
  type TargetStatus,
} from '@/domain/crm/targetLists'
import {
  planSegmentSuggestions,
  segmentRuleFor,
  suggestSummary,
  type SuggestResult,
} from '@/domain/crm/targetSegments'
import { loadSegmentCandidates } from '@/domain/crm/queries/targetSegments'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { accountFullyOptedOut, outreachGate, type OptOutFields } from '@/domain/crm/outreachContacts'
import { loadAccountOptOut } from '@/domain/crm/queries/outreachOptOut'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import type { ZodError } from 'zod'

const MISSING_MIGRATION_MESSAGE = 'Cílové seznamy čekají na migraci 0048 — návrhy půjdou spustit po jejím nasazení.'

type Client = Awaited<ReturnType<typeof createClient>>

// Kontakt pro kontrolu nesouhlasu s oslovením: políčko (0087) a poznámka.
// Bez migrace sloupec chybí → jen poznámka.
async function readContactForOutreach(s: Client, contactId: number): Promise<(OptOutFields & { account_id: number | null }) | null> {
  const read = (optOut: boolean) => s.from('contact')
    .select(optOut ? 'account_id, notes, do_not_contact' : 'account_id, notes').eq('id', contactId).maybeSingle()
  const first = await read(true)
  const res = isMissingColumn(first.error) ? await read(false) : first
  if (res.error) throw res.error
  return (res.data as (OptOutFields & { account_id: number | null }) | null) ?? null
}

// Nesouhlas u firmy a hlavního kontaktu (outreachGate). Vrací chybu pro
// formulář, nebo null, když se oslovit smí.
async function outreachBlocked(s: Client, accountId: number, contact: OptOutFields | null) {
  const byAccount = await loadAccountOptOut(s, [accountId])
  return outreachGate({ contact, account: byAccount.get(accountId) ?? null })
}

function fieldErrorsOf(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_')
    if (!out[key]) out[key] = issue.message
  }
  return out
}

export async function createTargetList(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = targetListSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const { error } = await s.from('target_list').insert({ ...parsed.data, owner_id: user.id, created_by: user.id })
  if (error) return { success: false, error: dbErrorMessage('action.targetList', error) }
  revalidatePath('/cockpit/cilove-seznamy')
  return { success: true }
}

export async function addTargetListItem(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = targetListItemSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  let contact: OptOutFields | null = null
  try {
    if (parsed.data.contact_id) {
      const c = await readContactForOutreach(s, parsed.data.contact_id)
      if (c?.account_id !== parsed.data.account_id) {
        return { success: false, fieldErrors: { contact_id: 'Kontakt nepatří vybrané firmě.' } }
      }
      contact = c
    }
    // Kdo nesouhlasí s oslovením (0087 / poznámka), do seznamu k oslovení nepatří.
    const blocked = await outreachBlocked(s, parsed.data.account_id, contact)
    if (blocked) return { success: false, fieldErrors: { [blocked.field]: blocked.message } }
  } catch (e) {
    return { success: false, error: dbErrorMessage('action.targetListItem', e) }
  }
  const { error } = await s.from('target_list_item').insert({ ...parsed.data, created_by: user.id })
  if (error?.code === '23505') return { success: false, fieldErrors: { account_id: 'Firma už v seznamu je.' } }
  if (error) return { success: false, error: dbErrorMessage('action.targetListItem', error) }
  revalidatePath(`/cockpit/cilove-seznamy/${parsed.data.list_id}`)
  revalidatePath('/cockpit/cilove-seznamy')
  return { success: true }
}

/** Změní stav položky. Přechod na „osloveno" zapíše aktivitu na firmu — obchod nevzniká. */
export async function setTargetItemStatus(itemId: number, to: TargetStatus): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!targetEntityId.safeParse(itemId).success || !targetStatusSchema.safeParse(to).success) {
    return { success: false, error: 'Neplatný požadavek.' }
  }
  const s = await createClient()
  const { data: item, error: readErr } = await s.from('target_list_item')
    .select('id, list_id, account_id, contact_id, reason, status, target_list(name)')
    .eq('id', itemId).maybeSingle()
  if (readErr) return { success: false, error: dbErrorMessage('action.targetItemStatus', readErr) }
  if (!item) return { success: false, error: 'Položka neexistuje.' }
  const listName = (item.target_list as unknown as { name: string } | null)?.name ?? ''
  const plan = planStatusChange(
    { account_id: item.account_id, contact_id: item.contact_id, reason: item.reason, status: item.status as TargetStatus },
    listName,
    to,
  )
  if (!plan.ok) return { success: false, error: plan.error }

  // Oslovit nejde firmu ani hlavní kontakt, kteří s oslovením nesouhlasí
  // (0087 / poznámka). Vyřadit nebo vrátit do návrhu jde vždy.
  if (to === 'osloveno') {
    try {
      const contact = item.contact_id ? await readContactForOutreach(s, item.contact_id) : null
      const blocked = await outreachBlocked(s, item.account_id, contact)
      if (blocked) return { success: false, error: blocked.message }
    } catch (e) {
      return { success: false, error: dbErrorMessage('action.targetItemStatus', e) }
    }
  }

  // Podmínka na původní stav: souběžná změna nepřepíše cizí přechod ani
  // nezapíše aktivitu dvakrát.
  const { data: updated, error: upErr } = await s.from('target_list_item')
    .update({ ...plan.itemUpdate, updated_at: new Date().toISOString() })
    .eq('id', itemId).eq('status', item.status).select('id')
  if (upErr) return { success: false, error: dbErrorMessage('action.targetItemStatus', upErr) }
  if (!updated?.length) return { success: false, error: 'Stav se mezitím změnil — obnov stránku.' }

  if (plan.activity) {
    const { error: actErr } = await s.from('sales_activity').insert({ ...plan.activity, created_by: user.id })
    // Stav položky je už uložený (update výš proběhl) — jen aktivita se nezapsala.
    // Detail chyby (název tabulky/constraintu) nepatří do UI, proto stejná
    // brána jako jinde (dbErrorMessage loguje detail a vrací obecnou českou hlášku).
    if (actErr) return { success: false, error: `Stav je uložený, ale aktivita ne: ${dbErrorMessage('action.targetOutreach', actErr)}` }
    revalidatePath('/cockpit/aktivity')
    revalidatePath(`/cockpit/clients/${item.account_id}`)
  }
  revalidatePath(`/cockpit/cilove-seznamy/${item.list_id}`)
  revalidatePath('/cockpit/cilove-seznamy')
  return { success: true }
}

/**
 * „Navrhnout firmy podle segmentu": vloží do seznamu firmy, které odpovídají
 * pravidlu segmentu (COMPANY.targetSegments), jako položky „navrzeno"
 * s důvodem z domain/crm/targetSegments.ts. Nejvýš SUGGEST_CAP na kliknutí.
 *
 * Idempotentní: firmy už v seznamu se přeskočí a vložení je
 * ON CONFLICT (list_id, account_id) DO NOTHING — položku v jiném stavu
 * (osloveno, vyřazeno …) nepřepíše ani souběžné kliknutí. Jen obchodní
 * role (vedení, obchodník) — stejně jako RLS can_see_sales() na
 * target_list; kontrola předem dává srozumitelnou hlášku místo prázdna.
 */
export async function suggestTargetListItems(listId: number): Promise<SuggestResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!targetEntityId.safeParse(listId).success) return { success: false, error: 'Neplatný požadavek.' }
  if (!(await canCurrentUserSeeSales())) {
    return { success: false, error: 'Návrhy do cílových seznamů může spouštět jen vedení nebo obchodník.' }
  }
  const s = await createClient()
  const { data: list, error: listErr } = await s.from('target_list')
    .select('id, segment').eq('id', listId).maybeSingle()
  if (isMissingRelation(listErr)) return { success: false, error: MISSING_MIGRATION_MESSAGE }
  if (listErr) return { success: false, error: dbErrorMessage('action.targetSuggest', listErr) }
  if (!list) return { success: false, error: 'Seznam neexistuje.' }
  const match = segmentRuleFor(list.segment as string)
  if (!match) {
    return {
      success: false,
      error: `Segment „${list.segment}" nemá pravidlo pro návrhy — doplň ho v config/mummiesDaddies.ts (COMPANY.targetSegments).`,
    }
  }

  const loaded = await loadSegmentCandidates(listId)
  if (loaded.state === 'missing_migration') return { success: false, error: MISSING_MIGRATION_MESSAGE }
  if (loaded.state === 'error') return { success: false, error: dbErrorMessage('action.targetSuggest', loaded.error) }

  const plan = planSegmentSuggestions(loaded.accounts, match.rule, loaded.existingAccountIds)
  if (!plan.rows.length) return { success: true, message: suggestSummary(plan, 0) }

  // Firmy, které s oslovením nesouhlasí (všichni lidé nebo poznámka firmy,
  // 0087), se nenavrhují.
  let optedOut = 0
  let rows = plan.rows
  try {
    const byAccount = await loadAccountOptOut(s, plan.rows.map((r) => r.account_id))
    rows = plan.rows.filter((r) => !accountFullyOptedOut(byAccount.get(r.account_id)))
    optedOut = plan.rows.length - rows.length
  } catch (e) {
    return { success: false, error: dbErrorMessage('action.targetSuggest', e) }
  }
  const optedOutText = optedOut > 0 ? ` Nesouhlasí s oslovením (nenavrženo): ${optedOut}.` : ''
  if (!rows.length) {
    return { success: true, message: `Nic nového — nové odpovídající firmy (${optedOut}) nesouhlasí s oslovením.` }
  }

  const { data: inserted, error: insErr } = await s.from('target_list_item')
    .upsert(
      rows.map((r) => ({ list_id: listId, account_id: r.account_id, reason: r.reason, status: 'navrzeno', created_by: user.id })),
      { onConflict: 'list_id,account_id', ignoreDuplicates: true },
    )
    .select('id')
  if (insErr) return { success: false, error: dbErrorMessage('action.targetSuggest', insErr) }
  revalidatePath(`/cockpit/cilove-seznamy/${listId}`)
  revalidatePath('/cockpit/cilove-seznamy')
  return { success: true, message: suggestSummary({ ...plan, rows }, inserted?.length ?? 0) + optedOutText }
}
