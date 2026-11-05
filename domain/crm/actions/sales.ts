'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { dealStage, salesActivitySchema, areEntityIds } from '@/lib/validation/schemas'
import { defaultProbabilityForStage, seesByznys } from '@/lib/domain'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { pragueToday } from '@/lib/pragueDate'
import { hasManualProbability } from '@/domain/crm/sales'
import type { ZodError } from 'zod'
import { DEAL_TRANSITION_MESSAGES, dealTransitionDbMessage, transitionIssues } from '@/domain/crm/dealTransition'
import { readActiveMember } from '@/lib/auth/activeMember'

function fieldErrorsOf(error: ZodError): Record<string, string> {
  const result: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_')
    if (!result[key]) result[key] = issue.message
  }
  return result
}

function refreshSalesPaths(accountId?: number) {
  revalidatePath('/cockpit/sales')
  revalidatePath('/cockpit/pipeline')
  revalidatePath('/cockpit/aktivity')
  revalidatePath('/cockpit/clients')
  if (accountId) revalidatePath(`/cockpit/clients/${accountId}`)
}

async function salesGate(s: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await s.auth.getUser()
  if (!user) return { ok: false as const, error: 'Neautentizováno.' }
  const { row: member } = await readActiveMember<{ role?: string | null }>(s, user.id, 'role')
  if (!seesByznys(member?.role)) return { ok: false as const, error: 'Nemáš přístup k sales CRM.' }
  return { ok: true as const, user }
}

export async function createSalesActivity(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = salesActivitySchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }

  const s = await createClient()
  const gate = await salesGate(s)
  if (!gate.ok) return { success: false, error: gate.error }

  // Obchod se váže jen na klienta — u partnerské aktivity se nevyplňuje.
  if (parsed.data.deal_id) {
    if (parsed.data.account_id == null) {
      return { success: false, fieldErrors: { deal_id: 'Obchod jde připojit jen k aktivitě u klienta.' } }
    }
    const { data: deal } = await s.from('deal').select('account_id').eq('id', parsed.data.deal_id).maybeSingle()
    if (!deal || deal.account_id !== parsed.data.account_id) {
      return { success: false, fieldErrors: { deal_id: 'Obchod nepatří vybranému klientovi.' } }
    }
  }
  // Kontakt musí patřit té straně, ke které se aktivita zapisuje — u partnera
  // tedy partnerovi, ne klientovi.
  if (parsed.data.contact_id) {
    const { data: contact } = await s.from('contact')
      .select('account_id, partner_id').eq('id', parsed.data.contact_id).maybeSingle()
    const sits = parsed.data.account_id != null
      ? contact?.account_id === parsed.data.account_id
      : contact?.partner_id === parsed.data.partner_id
    if (!sits) {
      return { success: false, fieldErrors: { contact_id: 'Kontakt nepatří vybrané firmě.' } }
    }
  }

  const { error } = await s.from('sales_activity').insert({
    ...parsed.data,
    created_by: gate.user.id,
  })
  if (error) return { success: false, error: dbErrorMessage('action.sales', error) }

  if (parsed.data.deal_id && parsed.data.follow_up_on) {
    const { error: followUpError } = await s.from('deal').update({
      next_step: parsed.data.subject,
      next_step_due: parsed.data.follow_up_on,
    }).eq('id', parsed.data.deal_id)
    if (followUpError) return { success: false, error: `Aktivita je uložená, ale follow-up ne: ${followUpError.message}` }
  }

  if (parsed.data.account_id != null) refreshSalesPaths(parsed.data.account_id)
  else if (parsed.data.partner_id != null) revalidatePath(`/cockpit/partners/${parsed.data.partner_id}/edit`)
  return { success: true }
}

export async function updateDealStage(
  dealId: number,
  stageValue: string,
  lostReason?: string,
): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(dealId)) return { success: false, error: 'Neplatné ID.' }
  const stage = dealStage.safeParse(stageValue)
  if (!stage.success) return { success: false, error: 'Neplatná fáze obchodu.' }
  if (stage.data === 'prohráno' && !lostReason?.trim()) {
    return { success: false, error: 'U prohraného obchodu je povinný důvod.' }
  }

  const s = await createClient()
  const gate = await salesGate(s)
  if (!gate.ok) return { success: false, error: gate.error }
  // select('*'): pole z 0052 (rozhodovatel, termín) před nasazením migrace
  // chybí → transitionIssues je nekontroluje (DB je taky ještě nevynucuje).
  const { data: deal, error: readError } = await s.from('deal')
    .select('*')
    .eq('id', dealId)
    .maybeSingle()
  if (readError || !deal) return { success: false, error: readError?.message ?? 'Obchod nenalezen.' }
  const issues = transitionIssues({ ...deal, lost_reason: lostReason ?? null }, stage.data)
  if (issues.length) return { success: false, error: issues.map((i) => DEAL_TRANSITION_MESSAGES[i]).join(' ') }

  // closed_at/won_at jsou DATE — pražský kalendářní den, ne UTC.
  const today = pragueToday()
  const closed = stage.data === 'vyhráno' || stage.data === 'prohráno'
  const update: Record<string, unknown> = {
    stage: stage.data,
    forecast_category: closed ? 'closed' : 'pipeline',
    closed_at: closed ? today : null,
    lost_reason: stage.data === 'prohráno' ? lostReason?.trim() : null,
  }
  // Pravděpodobnost se přepíše výchozí hodnotou nové fáze, jen když byla
  // prázdná nebo rovná výchozí hodnotě staré fáze — ručně nastavenou
  // hodnotu přetažení v pipeline nesmaže. Uzavření (vyhráno/prohráno)
  // pravděpodobnost vždy srovná na 100/0.
  if (closed || !hasManualProbability(deal)) update.probability_pct = defaultProbabilityForStage(stage.data)
  if (stage.data === 'vyhráno') update.won_at = today
  else if (deal.stage === 'vyhráno') update.won_at = null
  if (closed) {
    update.next_step = null
    update.next_step_due = null
  }

  const { error } = await s.from('deal').update(update).eq('id', dealId)
  if (error) return { success: false, error: dealTransitionDbMessage(error) ?? dbErrorMessage('action.sales', error) }
  refreshSalesPaths(deal.account_id)
  return { success: true }
}

export async function updateDealNextStep(
  dealId: number,
  nextStep: string,
  dueOn: string,
): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(dealId)) return { success: false, error: 'Neplatné ID.' }
  if (!nextStep.trim()) return { success: false, error: 'Doplň další krok.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return { success: false, error: 'Doplň platný termín.' }

  const s = await createClient()
  const gate = await salesGate(s)
  if (!gate.ok) return { success: false, error: gate.error }
  const { data: deal, error: readError } = await s.from('deal').select('account_id').eq('id', dealId).maybeSingle()
  if (readError || !deal) return { success: false, error: readError?.message ?? 'Obchod nenalezen.' }
  const { error } = await s.from('deal').update({ next_step: nextStep.trim(), next_step_due: dueOn }).eq('id', dealId)
  if (error) return { success: false, error: dbErrorMessage('action.sales', error) }
  refreshSalesPaths(deal.account_id)
  return { success: true }
}
