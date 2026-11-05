'use server'
// Záložní tlačítko „Založit dodávku" na detailu vyhraného obchodu (migrace
// 0080). Dodávka se po vyhrání zakládá sama (trigger v DB); tahle akce je jen
// pro případ, že k vyhranému obchodu z nějakého důvodu chybí (automatika
// selhala, dodávka byla smazána). Volá RPC ensure_deal_delivery, tedy stejné
// jádro jako trigger — stejné výchozí hodnoty, milníky a úkol — a je
// idempotentní: existuje-li dodávka, jen na ni odkáže. Práva a AAL2 hlídá
// RPC v databázi, tady je jen srozumitelná hláška předem.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { autoDeliveryDbMessage, parseEnsureResult } from '@/domain/delivery/autoDelivery'

const SALES_ACCESS_ERROR = 'Dodávku z obchodu zakládá jen člen s přístupem k obchodu.'
const DEAL_NOT_FOUND = 'Obchod nebyl nalezen.'

// Volá se z formuláře přes useActionState(….bind(null, accountId, dealId)) —
// stav a FormData, které React předá navíc, akce nepotřebuje.
export async function createDeliveryForDeal(accountId: number, dealId: number): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, dealId)) return { success: false, error: 'Neplatné ID.' }
  if (!memberSeesSales((await getCurrentMember()).member)) return { success: false, error: SALES_ACCESS_ERROR }

  const s = await createClient()
  const { data: deal } = await s.from('deal').select('id').eq('id', dealId).eq('account_id', accountId).maybeSingle()
  if (!deal) return { success: false, error: DEAL_NOT_FOUND }

  const { data, error } = await s.rpc('ensure_deal_delivery', { p_deal_id: dealId })
  if (error) return { success: false, error: autoDeliveryDbMessage(error) ?? dbErrorMessage('action.autoDelivery', error) }

  revalidatePath(`/cockpit/clients/${accountId}/deals/${dealId}`)
  revalidatePath(`/cockpit/clients/${accountId}`)
  revalidatePath('/cockpit/pipeline')
  const result = parseEnsureResult(data)
  if (result) redirect(`/cockpit/clients/${accountId}/engagements/${result.engagementId}/edit`)
  return { success: true }
}
