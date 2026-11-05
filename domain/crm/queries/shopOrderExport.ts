// Objednávky cheesecaků (shop_order, 0102) pro export. Stránka objednávek
// v Cockpitu je /cockpit/objednavky (P6); export čte stejnou tabulku přes RLS
// přihlášeného uživatele (tým s AAL2), nikdy přes service roli.
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import type { ShopOrderStatus } from '@/core/cheesecakeOrder'
import type { ShopOrderExportRow } from '@/domain/crm/exports'

const SHOP_ORDER_EXPORT_COLUMNS = [
  'id', 'received_at', 'status', 'fulfilment_date', 'fulfilment', 'delivery_address', 'dedication', 'note',
  'customer_name', 'email', 'phone', 'items', 'delivery_czk', 'total_czk',
].join(', ')

/** Objednávky podle termínu (nejbližší první); bez migrace 0102 prázdný seznam. */
export async function listShopOrdersForExport(status: ShopOrderStatus | readonly ShopOrderStatus[] | null = null): Promise<ShopOrderExportRow[]> {
  const s = await createClient()
  let query = s.from('shop_order').select(SHOP_ORDER_EXPORT_COLUMNS)
  if (typeof status === 'string') query = query.eq('status', status)
  else if (status?.length) query = query.in('status', [...status])
  const { data, error } = await query
    .order('fulfilment_date', { ascending: true })
    .order('received_at', { ascending: true })
    .limit(5000)
  if (isMissingRelation(error)) return []
  if (error) throw error
  return (data ?? []) as unknown as ShopOrderExportRow[]
}
