// Objednávky cheesecaků v Cockpitu (/cockpit/objednavky): čtení seznamu
// (RLS 0102: celý tým s AAL2) a pravidla změny stavu (RPC
// shop_order_set_status, migrace 0106). Přechody MUSÍ sedět s SQL funkcí.
import { SHOP_ORDER_STATUS_LABELS, SHOP_ORDER_STATUSES, type ShopOrderStatus } from '@/core/cheesecakeOrder'

export { SHOP_ORDER_STATUS_LABELS, SHOP_ORDER_STATUSES, type ShopOrderStatus }

export const SHOP_ORDER_SET_STATUS_RPC = 'shop_order_set_status'

/** Povolené přechody stavu (0106 shop_order_set_status). handed_over je konečný. */
export const SHOP_ORDER_TRANSITIONS: Readonly<Record<ShopOrderStatus, readonly ShopOrderStatus[]>> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['ready', 'cancelled', 'new'],
  ready: ['handed_over', 'cancelled', 'confirmed'],
  handed_over: [],
  cancelled: ['new'],
}

/** Text tlačítka pro přechod do stavu. */
export const SHOP_ORDER_ACTION_LABELS: Readonly<Record<ShopOrderStatus, string>> = {
  new: 'Vrátit mezi nové',
  confirmed: 'Potvrdit',
  ready: 'Připraveno k předání',
  handed_over: 'Předáno',
  cancelled: 'Zrušit',
}

export function canTransition(from: ShopOrderStatus, to: ShopOrderStatus): boolean {
  return SHOP_ORDER_TRANSITIONS[from].includes(to)
}

/** Kódy chyb RPC (0106) → hláška pro obsluhu. */
export const SHOP_ORDER_ERRORS: Readonly<Record<string, string>> = {
  SO010: 'Stav objednávky smí měnit jen člen týmu.',
  SO011: 'Změna stavu vyžaduje přihlášení dvěma faktory.',
  SO012: 'Objednávka už neexistuje.',
  SO013: 'Objednávku mezitím změnil někdo jiný. Obnov stránku a zkus to znovu.',
  SO014: 'Tenhle přechod stavu není povolený.',
  missing: 'Změna stavu ještě není v databázi (chybí migrace 0106).',
}

export function shopOrderErrorCode(err: { code?: string; message?: string } | null): string | null {
  if (!err) return null
  if (err.code === 'PGRST202' || err.code === '42883') return 'missing'
  return /\b(SO01\d)\b/.exec(err.message ?? '')?.[1] ?? 'unknown'
}

/** Filtr seznamu (?stav=). „aktivni" = nové, potvrzené a připravené. */
export const SHOP_ORDER_FILTERS = ['aktivni', 'vse', ...SHOP_ORDER_STATUSES] as const
export type ShopOrderFilter = (typeof SHOP_ORDER_FILTERS)[number]
export const SHOP_ORDER_FILTER_LABELS: Readonly<Record<ShopOrderFilter, string>> = {
  aktivni: 'K vyřízení',
  vse: 'Vše',
  ...SHOP_ORDER_STATUS_LABELS,
}
export const ACTIVE_SHOP_ORDER_STATUSES: readonly ShopOrderStatus[] = ['new', 'confirmed', 'ready']

export function parseShopOrderFilter(raw: unknown): ShopOrderFilter {
  const v = Array.isArray(raw) ? raw[0] : raw
  return (SHOP_ORDER_FILTERS as readonly string[]).includes(String(v)) ? (v as ShopOrderFilter) : 'aktivni'
}

export type ShopOrderItem = {
  product_key: string
  label: string
  quantity: number
  unit_price_czk: number
  total_czk: number
  inscription?: string
  mini_flavors?: string[]
}

export type ShopOrderRow = {
  id: number
  received_at: string
  status: ShopOrderStatus
  fulfilment_date: string
  fulfilment: 'pickup' | 'delivery'
  delivery_address: string | null
  delivery_zone: string | null
  dedication: string | null
  note: string | null
  customer_name: string
  email: string
  phone: string
  company_name: string | null
  ico: string | null
  payment_method: string | null
  items: ShopOrderItem[]
  delivery_czk: number
  total_czk: number
  status_changed_at: string | null
}

const COLUMNS_0102 = 'id, received_at, status, fulfilment_date, fulfilment, delivery_address, dedication, note, customer_name, email, phone, items, delivery_czk, total_czk, status_changed_at'
const COLUMNS_0106 = `${COLUMNS_0102}, delivery_zone, company_name, ico, payment_method`

type Query = {
  select: (cols: string) => Query
  in: (col: string, values: readonly string[]) => Query
  order: (col: string, opts: { ascending: boolean }) => Query
  limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>
}
export type ShopOrderReader = { from: (table: 'shop_order') => Query }

export type ShopOrderList = { state: 'ok'; rows: ShopOrderRow[]; truncated: boolean } | { state: 'error' }

export const SHOP_ORDER_LIST_LIMIT = 200

/**
 * Objednávky podle filtru, nejbližší předání nahoře. Bez sloupců z 0106
 * (migrace ještě neproběhla) se čte jen základ z 0102.
 */
export async function listShopOrders(db: ShopOrderReader, filter: ShopOrderFilter): Promise<ShopOrderList> {
  const statuses = filter === 'vse' ? null : filter === 'aktivni' ? ACTIVE_SHOP_ORDER_STATUSES : [filter]
  const run = (cols: string) => {
    let q = db.from('shop_order').select(cols)
    if (statuses) q = q.in('status', statuses)
    return q.order('fulfilment_date', { ascending: filter !== 'handed_over' && filter !== 'cancelled' && filter !== 'vse' })
      .order('id', { ascending: true })
      .limit(SHOP_ORDER_LIST_LIMIT + 1)
  }
  let res = await run(COLUMNS_0106)
  if (res.error?.code === '42703') res = await run(COLUMNS_0102)
  if (res.error) return { state: 'error' }
  const rows = (res.data ?? []) as Partial<ShopOrderRow>[]
  const normalized = rows.map((r) => ({
    delivery_zone: null, company_name: null, ico: null, payment_method: null,
    ...r,
    items: Array.isArray(r.items) ? r.items : [],
  })) as ShopOrderRow[]
  return { state: 'ok', rows: normalized.slice(0, SHOP_ORDER_LIST_LIMIT), truncated: normalized.length > SHOP_ORDER_LIST_LIMIT }
}

/** Souhrn pro hlavičku: kolik objednávek čeká na potvrzení a kolik je na dnešek. */
export function summarizeShopOrders(rows: readonly ShopOrderRow[], today: string): { waiting: number; today: number } {
  return {
    waiting: rows.filter((r) => r.status === 'new').length,
    today: rows.filter((r) => r.fulfilment_date === today && r.status !== 'cancelled' && r.status !== 'handed_over').length,
  }
}
