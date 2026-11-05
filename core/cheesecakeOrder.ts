// Kontrakt e-shopu (P6) a Cockpitu: objednávka cheesecaků z webu. Web
// objednávku zapíše (RPC shop_order_submit, migrace 0102, jen service_role),
// Cockpit ji zobrazí a obsluha ji potvrdí a předá. Platba online není:
// objednávka je závazná až po potvrzení obsluhou (stav 'confirmed').
//
// Cenu počítá server z ceníku firmy (CompanyConfig.shop) funkcí
// priceShopOrder — nikdy se nepřebírá z prohlížeče.
import { z } from 'zod'
import type { ShopConfig, ShopProductConfig } from './tenant'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum ve tvaru YYYY-MM-DD.')
/** Nepovinný text: prázdný řetězec i chybějící pole = null. */
const optText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null))

export const shopOrderSchema = z.object({
  /** Klíč idempotence z formuláře (uuid); dvojí odeslání = jedna objednávka. */
  clientToken: z.string().uuid(),
  items: z.array(z.object({
    productKey: z.string().trim().min(1).max(40),
    quantity: z.number().int().positive().max(100),
  })).min(1).max(20),
  /** Den vyzvednutí / doručení. */
  fulfilmentDate: isoDate,
  fulfilment: z.enum(['pickup', 'delivery']),
  /** Adresa doručení (povinná u 'delivery'). */
  deliveryAddress: optText(300),
  /** Pásmo doručení (ShopConfig.delivery.zones); null = bez pásem / vyzvednutí. */
  deliveryZone: z.string().trim().min(1).max(40).nullable().default(null),
  /** Věnování / přání k dortu (krátký text na dort, ne zvláštní požadavky). */
  dedication: optText(80),
  note: optText(1000),
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().min(6).max(40),
  }),
  consent: z.object({ processing: z.literal(true), marketing: z.boolean().default(false) }),
}).refine((o) => o.fulfilment !== 'delivery' || !!o.deliveryAddress, { message: 'Chybí adresa doručení.', path: ['deliveryAddress'] })

export type ShopOrder = z.infer<typeof shopOrderSchema>
export type ShopOrderInput = z.input<typeof shopOrderSchema>

/** Stavy objednávky (CHECK v migraci 0102). */
export const SHOP_ORDER_STATUSES = ['new', 'confirmed', 'ready', 'handed_over', 'cancelled'] as const
export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number]

export const SHOP_ORDER_STATUS_LABELS: Readonly<Record<ShopOrderStatus, string>> = {
  new: 'Nová',
  confirmed: 'Potvrzená',
  ready: 'Připravená',
  handed_over: 'Předaná',
  cancelled: 'Zrušená',
}

export const SHOP_ORDER_SUBMIT_RPC = 'shop_order_submit'
export type ShopOrderSubmitResult = { shop_order_id: number; duplicate: boolean }

export type ShopOrderLine = { productKey: string; label: string; quantity: number; unitPriceCzk: number; totalCzk: number }

export type ShopOrderProblem =
  | 'unknown_product'
  | 'inactive_product'
  | 'out_of_season'
  | 'quantity_over_limit'
  | 'date_too_soon'
  | 'date_too_far'
  | 'delivery_unavailable'

export type ShopOrderPricing =
  | { ok: true; lines: ShopOrderLine[]; deliveryCzk: number; totalCzk: number }
  | { ok: false; problems: ShopOrderProblem[] }

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** Je produkt k mání v daný den (MM-DD sezóna, i přes přelom roku)? */
export function inSeason(p: Pick<ShopProductConfig, 'season'>, isoDay: string): boolean {
  if (!p.season) return true
  const md = isoDay.slice(5)
  const { from, to } = p.season
  return from <= to ? md >= from && md <= to : md >= from || md <= to
}

/**
 * Cena objednávky z ceníku (celé Kč vč. DPH). `today` = dnešní den v pásmu
 * firmy (YYYY-MM-DD). Čistá funkce: stejný vstup = stejný výsledek.
 */
export function priceShopOrder(
  shop: ShopConfig,
  order: Pick<ShopOrder, 'items' | 'fulfilmentDate' | 'fulfilment'> & { deliveryZone?: string | null },
  today: string,
): ShopOrderPricing {
  const problems = new Set<ShopOrderProblem>()
  const lead = dayNumber(order.fulfilmentDate) - dayNumber(today)
  if (lead < shop.minLeadDays) problems.add('date_too_soon')
  if (lead > shop.maxLeadDays) problems.add('date_too_far')
  if (order.fulfilment === 'delivery' && !shop.delivery.enabled) problems.add('delivery_unavailable')
  // Pásma doručení: s pásmy musí objednávka nést známé pásmo, cena je cena pásma.
  const zones = shop.delivery.zones
  const zone = zones?.length ? zones.find((x) => x.key === order.deliveryZone) : undefined
  if (order.fulfilment === 'delivery' && zones?.length && !zone) problems.add('delivery_unavailable')

  const lines: ShopOrderLine[] = []
  for (const it of order.items) {
    const p = shop.products.find((x) => x.key === it.productKey)
    if (!p) { problems.add('unknown_product'); continue }
    if (!p.active) problems.add('inactive_product')
    if (!inSeason(p, order.fulfilmentDate)) problems.add('out_of_season')
    if (it.quantity > shop.maxQuantityPerItem) problems.add('quantity_over_limit')
    lines.push({ productKey: p.key, label: p.label, quantity: it.quantity, unitPriceCzk: p.priceCzk, totalCzk: p.priceCzk * it.quantity })
  }
  if (problems.size) return { ok: false, problems: [...problems] }
  const deliveryCzk = order.fulfilment === 'delivery' ? (zone ? zone.priceCzk : shop.delivery.priceCzk) : 0
  return { ok: true, lines, deliveryCzk, totalCzk: lines.reduce((s, l) => s + l.totalCzk, 0) + deliveryCzk }
}

/** Payload RPC shop_order_submit (snake_case). Částky spočítá server přes priceShopOrder. */
export function shopOrderPayload(o: ShopOrder, pricing: Extract<ShopOrderPricing, { ok: true }>): Record<string, unknown> {
  return {
    client_token: o.clientToken,
    fulfilment_date: o.fulfilmentDate,
    fulfilment: o.fulfilment,
    delivery_address: o.deliveryAddress,
    dedication: o.dedication,
    note: o.note,
    customer_name: o.customer.name,
    email: o.customer.email,
    phone: o.customer.phone,
    marketing_consent: o.consent.marketing,
    items: pricing.lines.map((l) => ({ product_key: l.productKey, label: l.label, quantity: l.quantity, unit_price_czk: l.unitPriceCzk, total_czk: l.totalCzk })),
    delivery_czk: pricing.deliveryCzk,
    total_czk: pricing.totalCzk,
  }
}
