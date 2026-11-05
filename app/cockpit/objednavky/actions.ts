'use server'
// Změna stavu objednávky cheesecaků z Cockpitu. Zápis dělá databázová
// funkce shop_order_set_status (0106) klientem přihlášeného člověka: sama
// ověří člena týmu a AAL2, povolený přechod a souběh (očekávaný stav),
// a zapíše kdo a kdy. Tady jen AAL2 přihlášení a tvar vstupu.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { logWarn } from '@/lib/log'
import { createClient } from '@/lib/supabase/server'
import { SHOP_ORDER_SET_STATUS_RPC, SHOP_ORDER_STATUSES, shopOrderErrorCode } from '@/domain/web/shopOrders'

const PATH = '/cockpit/objednavky'

const inputSchema = z.object({
  order_id: z.coerce.number().int().positive(),
  status: z.enum(SHOP_ORDER_STATUSES),
  expected_status: z.enum(SHOP_ORDER_STATUSES),
  back: z.string().regex(/^\?stav=[a-z_]{1,20}$/).optional().catch(undefined),
})

export async function setShopOrderStatus(formData: FormData): Promise<void> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) redirect(`${PATH}?chyba=SO011`)
  const parsed = inputSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) redirect(`${PATH}?chyba=unknown`)
  const v = parsed.data
  const supabase = await createClient()
  const { error } = await supabase.rpc(SHOP_ORDER_SET_STATUS_RPC, {
    p_order_id: v.order_id, p_status: v.status, p_expected_status: v.expected_status,
  })
  const code = shopOrderErrorCode(error)
  if (code) {
    logWarn('cockpit.shop_order', 'set_status_failed', { code })
    redirect(`${PATH}${v.back ?? '?stav=aktivni'}&chyba=${code}`)
  }
  revalidatePath(PATH)
  redirect(`${PATH}${v.back ?? ''}`)
}
