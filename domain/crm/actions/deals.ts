'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { dealSchema, categoryForLine, areEntityIds } from '@/lib/validation/schemas'
import { czkPerEur } from '@/connectors/cnb'
import { shouldFreezeRate } from '@/domain/finance/fx'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'
import { writeDealTolerant } from '@/domain/crm/dealWrite'
import { dealTransitionDbMessage, transitionFieldErrors, transitionIssues } from '@/domain/crm/dealTransition'
import { DEFAULT_DEAL_STAGE } from '@/lib/domain'
import { pragueToday } from '@/lib/pragueDate'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'

const SALES_ACCESS_ERROR = 'Nemáš přístup k sales CRM.'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '_')
    if (!out[key]) out[key] = issue.message
  }
  return out
}

// amount_one_time je vždy kanonicky v Kč. Když je měna EUR, přepočítá se ze
// zadané originální EUR částky živým kurzem ČNB — nikdy nedůvěřujeme
// klientem/formulářem dopočítané hodnotě v Kč pro EUR vstup.
type ResolvedAmount = { amount_one_time: number | null; amount_one_time_original: number | null; fx_rate: number | null }

type FrozenDeal = {
  stage: string
  currency: string
  amount_one_time: number | string | null
  amount_one_time_original: number | string | null
  fx_rate: number | string | null
} | null

async function resolveAmount(
  data: { currency: 'CZK' | 'EUR'; amount_one_time: number | null; amount_one_time_original: number | null },
  existing: FrozenDeal = null,
): Promise<ResolvedAmount> {
  if (data.currency === 'CZK') {
    return { amount_one_time: data.amount_one_time, amount_one_time_original: null, fx_rate: null }
  }
  if (data.amount_one_time_original == null) {
    return { amount_one_time: null, amount_one_time_original: null, fx_rate: null }
  }
  // Kurz se zmrazí, jakmile je obchod uzavřený. Dřív se přepočítával při
  // KAŽDÉM uložení dnešním kurzem — takže úprava poznámky u vyhraného
  // obchodu z loňska tiše posunula vykázanou tržbu za dávno uzavřený
  // měsíc, a nikde po tom nezůstala stopa. Historická hodnota se měnit
  // nemá; pokud ji někdo potřebuje přepočítat, změní částku v EUR.
  if (shouldFreezeRate(existing, data) && existing?.fx_rate != null && existing?.amount_one_time != null) {
    return {
      amount_one_time: Number(existing.amount_one_time),
      amount_one_time_original: data.amount_one_time_original,
      fx_rate: Number(existing.fx_rate),
    }
  }

  const rate = await czkPerEur()
  return {
    amount_one_time: Math.round(data.amount_one_time_original * rate),
    amount_one_time_original: data.amount_one_time_original,
    fx_rate: rate,
  }
}

async function contactBelongsToAccount(
  s: Awaited<ReturnType<typeof createClient>>,
  contactId: number | null,
  accountId: number,
): Promise<boolean> {
  if (!contactId) return true
  const { data } = await s.from('contact').select('account_id').eq('id', contactId).maybeSingle()
  return data?.account_id === accountId
}

function refreshDealPaths(accountId: number) {
  revalidatePath(`/cockpit/clients/${accountId}`)
  revalidatePath('/cockpit/clients')
  revalidatePath('/cockpit/pipeline')
  revalidatePath('/cockpit/sales')
}

export async function createDeal(accountId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId)) return { success: false, error: 'Neplatné ID.' }
  if (!memberSeesSales((await getCurrentMember()).member)) return { success: false, error: SALES_ACCESS_ERROR }
  const parsed = dealSchema.safeParse({ ...Object.fromEntries(formData.entries()), account_id: accountId })
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  // Nový obchod rovnou v „rozhodování" / „prohráno" = přechod do té fáze.
  const createIssues = transitionIssues({ ...parsed.data, stage: null }, parsed.data.stage ?? DEFAULT_DEAL_STAGE)
  if (createIssues.length) return { success: false, fieldErrors: transitionFieldErrors(createIssues) }
  let amounts
  try {
    amounts = await resolveAmount(parsed.data)
  } catch (e) {
    return { success: false, error: `Přepočet kurzu selhal: ${(e as Error).message}` }
  }
  const s = await createClient()
  if (!await contactBelongsToAccount(s, parsed.data.primary_contact_id, accountId)) {
    return { success: false, fieldErrors: { primary_contact_id: 'Kontakt nepatří tomuto klientovi.' } }
  }
  let ownerId = parsed.data.owner_id
  if (!ownerId) {
    const [{ data: account }, { data: { user } }] = await Promise.all([
      s.from('account').select('owner_id').eq('id', accountId).maybeSingle(),
      s.auth.getUser(),
    ])
    ownerId = account?.owner_id ?? user?.id ?? null
  }
  // closed_at/won_at jsou DATE — pražský kalendářní den, ne UTC.
  const today = pragueToday()
  const isClosed = parsed.data.stage === 'vyhráno' || parsed.data.stage === 'prohráno'
  const row = {
    ...parsed.data,
    ...amounts,
    revenue_category: categoryForLine[parsed.data.revenue_line],
    stage: parsed.data.stage ?? DEFAULT_DEAL_STAGE,
    owner_id: ownerId,
    closed_at: isClosed ? today : null,
    won_at: parsed.data.stage === 'vyhráno' ? (parsed.data.won_at ?? today) : parsed.data.won_at,
    forecast_category: isClosed ? 'closed' : parsed.data.forecast_category,
  }
  const { error } = await writeDealTolerant(row, (r) => s.from('deal').insert(r))
  if (error) return { success: false, error: dealTransitionDbMessage(error) ?? dbErrorMessage('action.deals', error) }
  refreshDealPaths(accountId)
  redirect(`/cockpit/clients/${accountId}?view=business`)
}

export async function updateDeal(accountId: number, dealId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, dealId)) return { success: false, error: 'Neplatné ID.' }
  if (!memberSeesSales((await getCurrentMember()).member)) return { success: false, error: SALES_ACCESS_ERROR }
  const parsed = dealSchema.safeParse({ ...Object.fromEntries(formData.entries()), account_id: accountId })
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  // Uložený řádek se čte PŘED přepočtem kurzu — resolveAmount z něj pozná,
  // jestli jde o uzavřený obchod s nezměněnou částkou, a v tom případě
  // kurz nechá tak, jak byl v době uzavření.
  const s = await createClient()
  const { data: existing, error: readError } = await s.from('deal')
    .select('account_id, closed_at, won_at, stage, currency, amount_one_time, amount_one_time_original, fx_rate')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (readError || !existing) return { success: false, error: readError?.message ?? 'Obchod nebyl nalezen.' }
  // Povinná pole jen při PŘECHODU fáze — obchod, který už ve fázi je
  // (např. převedený migrací 0050), jde upravovat i bez nich.
  const updateIssues = transitionIssues(
    { ...parsed.data, stage: existing.stage },
    parsed.data.stage ?? DEFAULT_DEAL_STAGE,
  )
  if (updateIssues.length) return { success: false, fieldErrors: transitionFieldErrors(updateIssues) }

  let amounts
  try {
    amounts = await resolveAmount(parsed.data, existing)
  } catch (e) {
    return { success: false, error: `Přepočet kurzu selhal: ${(e as Error).message}` }
  }
  if (!await contactBelongsToAccount(s, parsed.data.primary_contact_id, accountId)) {
    return { success: false, fieldErrors: { primary_contact_id: 'Kontakt nepatří tomuto klientovi.' } }
  }
  // closed_at/won_at jsou DATE — pražský kalendářní den, ne UTC.
  const today = pragueToday()
  const isClosed = parsed.data.stage === 'vyhráno' || parsed.data.stage === 'prohráno'
  const row = {
    ...parsed.data,
    ...amounts,
    revenue_category: categoryForLine[parsed.data.revenue_line],
    stage: parsed.data.stage ?? DEFAULT_DEAL_STAGE,
    closed_at: isClosed ? (existing.closed_at ?? today) : null,
    won_at: parsed.data.stage === 'vyhráno'
      ? (parsed.data.won_at ?? existing.won_at ?? today)
      : null,
    forecast_category: isClosed ? 'closed' : parsed.data.forecast_category,
  }
  const { error } = await writeDealTolerant(row, (r) => s.from('deal').update(r).eq('id', dealId).eq('account_id', accountId))
  if (error) return { success: false, error: dealTransitionDbMessage(error) ?? dbErrorMessage('action.deals', error) }

  // Audit ceny/fáze obchodu (deal.amount_changed / deal.stage_changed) se
  // dřív zapisoval odsud (dealAuditDiff + recordAudit). Teď ho dělá DB
  // trigger deal_audit_price_stage_trigger (migrace 0034) přímo na
  // UPDATE ON deal — jediný zdroj, ne appková duplicita vedle něj. Důvod:
  // appka mluví s Postgresem přes PostgREST, kde je jeden `.update()` volání
  // = jedna transakce bez afinity mezi requesty, takže appka nemá jak
  // triggeru předem (ve stejné transakci) říct „tuhle změnu už zaznamenám
  // sama" — a trigger navíc při UPDATE běží dřív, než appka vůbec stihne
  // svoje recordAudit zavolat. Jediný spolehlivý návrh je mít zdroj jeden;
  // podrobné zdůvodnění je v komentáři migrace 0034. dealAuditDiff v
  // core/audit.ts zůstává (a je dál testovaná v test/audit.test.ts) — je to
  // čistá porovnávací funkce, kterou trigger po sloupcích replikuje 1:1.
  //
  // Pozor: updateDeal NENÍ jediná cesta, která mění `stage` (ani částku).
  // updateDealStage v domain/crm/actions/sales.ts (přetažení v pipeline)
  // mění `stage` taky, včetně probability_pct a closed_at. Právě proto je
  // audit v triggeru na tabulce, ne v téhle akci: zachytí obě cesty
  // (a jakoukoli budoucí) bez toho, aby se v každé musel volat recordAudit.

  refreshDealPaths(accountId)
  redirect(`/cockpit/clients/${accountId}?view=business`)
}
