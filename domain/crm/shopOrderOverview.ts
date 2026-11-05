// Přehled objednávek cheesecaků z webu (P5) — čistá logika. Objednávky
// zapisuje web (P6, RPC shop_order_submit do tabulky shop_order z 0102);
// tady se jen počítají a řadí pro kartu na stránce agenta. Bez jména,
// e-mailu, telefonu, adresy, věnování i poznámky: jen číslo objednávky,
// den předání, způsob, položky, cena a stav. Detail a změnu stavu má
// stránka /cockpit/objednavky (P6).
import { SHOP_ORDER_STATUS_LABELS, type ShopOrderStatus } from '@/core/cheesecakeOrder'
import { pragueDayOf } from '@/lib/pragueDate'

export type ShopOrderItemRow = { product_key?: string; label?: string; quantity?: number }

export type ShopOrderOverviewRow = {
  id: number
  received_at: string
  status: string
  fulfilment_date: string
  fulfilment: string
  items: readonly ShopOrderItemRow[] | null
  total_czk: number | string
}

/** Stavy, u kterých objednávka ještě čeká na předání. */
export const OPEN_SHOP_STATUSES: readonly ShopOrderStatus[] = ['new', 'confirmed', 'ready']

export function shopStatusLabel(status: string): string {
  return SHOP_ORDER_STATUS_LABELS[status as ShopOrderStatus] ?? status
}

export function fulfilmentLabel(f: string): string {
  return f === 'delivery' ? 'Doručení' : f === 'pickup' ? 'Vyzvednutí' : f
}

/** „2× Daddy vanilkový, 1× Mini cheesecaky mix". */
export function itemsSummary(items: readonly ShopOrderItemRow[] | null | undefined): string {
  return (items ?? [])
    .map((i) => `${Number(i.quantity ?? 0)}× ${i.label ?? i.product_key ?? '?'}`)
    .join(', ')
}

export type ShopOrderUpcoming = {
  id: number
  day: string
  fulfilmentLabel: string
  items: string
  totalCzk: number
  status: string
  statusLabel: string
}

export type ShopOrderOverview = {
  /** Přijaté v období (bez ohledu na stav). */
  received: number
  /** Tržba přijatých v období bez zrušených (Kč vč. DPH). */
  revenueCzk: number
  cancelled: number
  /** Nové, které ještě nikdo nepotvrdil (celkem, ne jen v období). */
  awaitingConfirmation: number
  byStatus: { key: string; label: string; count: number }[]
  /** Nepředané objednávky s dnem předání dnes a později, nejbližší nahoře. */
  upcoming: ShopOrderUpcoming[]
}

export function buildShopOrderOverview(args: {
  from: string
  to: string
  today: string
  /** Objednávky přijaté v období. */
  received: readonly ShopOrderOverviewRow[]
  /** Nepředané objednávky s předáním od dneška (může se s `received` překrývat). */
  upcoming: readonly ShopOrderOverviewRow[]
  upcomingLimit?: number
}): ShopOrderOverview {
  const inPeriod = args.received.filter((o) => {
    const d = pragueDayOf(o.received_at)
    return d >= args.from && d <= args.to
  })
  const statusCounts = new Map<string, number>()
  for (const o of inPeriod) statusCounts.set(o.status, (statusCounts.get(o.status) ?? 0) + 1)
  const order = ['new', 'confirmed', 'ready', 'handed_over', 'cancelled']
  const byStatus = [...statusCounts.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([key, count]) => ({ key, label: shopStatusLabel(key), count }))

  const open = new Map<number, ShopOrderOverviewRow>()
  for (const o of [...args.upcoming, ...args.received]) {
    if ((OPEN_SHOP_STATUSES as readonly string[]).includes(o.status) && o.fulfilment_date >= args.today) open.set(o.id, o)
  }
  const upcoming = [...open.values()]
    .sort((a, b) => a.fulfilment_date.localeCompare(b.fulfilment_date) || a.id - b.id)
    .slice(0, args.upcomingLimit ?? 10)
    .map((o) => ({
      id: o.id,
      day: o.fulfilment_date,
      fulfilmentLabel: fulfilmentLabel(o.fulfilment),
      items: itemsSummary(o.items),
      totalCzk: Number(o.total_czk) || 0,
      status: o.status,
      statusLabel: shopStatusLabel(o.status),
    }))

  return {
    received: inPeriod.length,
    revenueCzk: inPeriod.filter((o) => o.status !== 'cancelled').reduce((n, o) => n + (Number(o.total_czk) || 0), 0),
    cancelled: inPeriod.filter((o) => o.status === 'cancelled').length,
    awaitingConfirmation: [...open.values()].filter((o) => o.status === 'new').length,
    byStatus,
    upcoming,
  }
}
