// Objednávka cheesecaků z košíku webu (lib/web/api.ts#CheesecakeOrder,
// slovník webu) → kontrakt objednávky (core/cheesecakeOrder.ts#ShopOrder,
// klíče ceníku firmy) → RPC shop_order_submit (0102 + doplňky z 0106).
//
// Cenu vždy počítá server z ceníku firmy (priceShopOrder); součty
// z prohlížeče se nečtou. Čisté funkce bez sítě a databáze; volá je route
// POST /api/web/objednavka.
import { z } from 'zod'
import { COMPANY } from '@/config'
import {
  inSeason, priceShopOrder, shopOrderPayload, shopOrderSchema,
  type ShopOrder, type ShopOrderPricing,
} from '@/core/cheesecakeOrder'
import type { ShopConfig } from '@/core/tenant'
import type { CheesecakeOrder, FieldErrors, OrderField } from '@/lib/web/api'
import { CHEESECAKES, DELIVERY_METHODS, MINI_FLAVORS, PAYMENT_METHODS, type CheesecakeSlug } from '@/lib/web/options'
import { hasErrors, MESSAGES, validateOrder } from '@/lib/web/validation'
import { WEB_CONSENT_VERSION } from './consent'

// --- Tvar požadavku ----------------------------------------------------------

const values = <T extends readonly { value: string }[]>(xs: T) =>
  xs.map((x) => x.value) as unknown as [T[number]['value'], ...T[number]['value'][]]

const text = (max: number) => z.string().max(max).nullable()

/** Zod schéma tvaru lib/web/api.ts#CheesecakeOrder. */
export const formOrderSchema = z.object({
  items: z.array(z.object({
    slug: z.enum(CHEESECAKES.map((c) => c.slug) as unknown as [CheesecakeSlug, ...CheesecakeSlug[]]),
    quantity: z.number().int().min(0).max(1000),
    inscription: text(100).optional(),
    miniFlavors: z.array(z.enum(MINI_FLAVORS)).max(20).nullable().optional(),
  })).min(1).max(20),
  fulfillment: z.object({
    method: z.enum(values(DELIVERY_METHODS)),
    address: text(300),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: text(1000),
  }),
  customer: z.object({ name: z.string().max(120), email: z.string().max(254), phone: z.string().max(40) }),
  company: z.object({ name: z.string().max(200), ico: z.string().max(20), dic: text(20) }).nullable(),
  payment: z.enum(values(PAYMENT_METHODS)),
  note: text(1000),
  consent: z.boolean(),
}) satisfies z.ZodType<CheesecakeOrder>

// --- Slovník webu → ceník firmy ---------------------------------------------

/** Produkt webu (slug) → klíč ceníku firmy (CompanyConfig.shop.products). */
export const SLUG_PRODUCT: Readonly<Record<CheesecakeSlug, string>> = {
  'daddy-vanilkovy': 'daddy_vanilka',
  'daddy-pistaciovo-malinovy': 'daddy_pistacie_malina',
  'daddy-cokoladovo-liskooriskovy': 'daddy_cokolada_liskovy_orech',
  'daddy-vanilkovo-karamelovy': 'daddy_vanilka_karamel',
  'mummy-vanilkovo-ovocny': 'mummy_vanilka_ovoce',
  'mummy-vanilkovo-pomerancovy-vanocni': 'mummy_vanilka_pomeranc_vanocni',
  'mini-cheesecaky-10-ks': 'mini_mix',
}

export const ORDER_MESSAGES = {
  unavailable: 'Tenhle cheesecake teď bohužel nepečeme. Vyberte, prosím, jiný.',
  outOfSeason: 'Tenhle cheesecake pečeme jen v sezóně. Vyberte, prosím, jiný termín nebo příchuť.',
  quantity: (max: number) => `Jednoho druhu přes web objednáte nejvýš ${max} kusů. Na větší množství nám napište.`,
  tooFar: (max: number) => `Objednávky přijímáme nejvýš ${max} dní dopředu.`,
  delivery: 'Tenhle způsob doručení teď nenabízíme. Vyberte, prosím, jiný.',
} as const

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10)
}

export type FormOrderCheck =
  | { ok: true; form: CheesecakeOrder }
  | { ok: false; fieldErrors: FieldErrors<OrderField> }
  | { ok: false; invalid: true }

/**
 * Kontrola košíku na serveru: tvar (zod), stejná pravidla jako formulář
 * (lib/web/validation) a pravidla ceníku firmy (předstih, sezóna, množství,
 * doručení) s hláškou u konkrétního pole. `today` = dnešní den v pásmu firmy.
 */
export function checkFormOrder(raw: unknown, today: string, shop: ShopConfig = COMPANY.shop): FormOrderCheck {
  const parsed = formOrderSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, invalid: true }
  const form = parsed.data
  const e: FieldErrors<OrderField> = validateOrder(form, today)

  const date = form.fulfillment.date
  const earliest = addDays(today, shop.minLeadDays)
  if (!e['fulfillment.date']) {
    if (date < earliest) e['fulfillment.date'] = MESSAGES.orderDate(earliest)
    else if (date > addDays(today, shop.maxLeadDays)) e['fulfillment.date'] = ORDER_MESSAGES.tooFar(shop.maxLeadDays)
  }
  form.items.forEach((it, i) => {
    if (e[`items.${i}`]) return
    const p = shop.products.find((x) => x.key === SLUG_PRODUCT[it.slug])
    if (!p || !p.active) e[`items.${i}`] = ORDER_MESSAGES.unavailable
    else if (!inSeason(p, date)) e[`items.${i}`] = ORDER_MESSAGES.outOfSeason
    else if (it.quantity > shop.maxQuantityPerItem) e[`items.${i}`] = ORDER_MESSAGES.quantity(shop.maxQuantityPerItem)
  })
  if (form.fulfillment.method !== 'vyzvednuti') {
    const zones = shop.delivery.zones
    if (!shop.delivery.enabled || (zones?.length && !zones.some((z) => z.key === form.fulfillment.method))) {
      e['fulfillment.method'] = ORDER_MESSAGES.delivery
    }
  }
  if (hasErrors(e)) return { ok: false, fieldErrors: e }
  return { ok: true, form }
}

export type MappedOrder = {
  order: ShopOrder
  pricing: Extract<ShopOrderPricing, { ok: true }>
  /** Doplňky položek, které ceník nezná (nápis, výběr mini příchutí) — podle productKey a pořadí. */
  itemDetails: { inscription: string | null; miniFlavors: string[] | null }[]
}

/** Nápisy na dort → věnování objednávky (kontrakt: max 80 znaků). */
function dedicationOf(form: CheesecakeOrder): string | null {
  const parts = form.items
    .filter((it) => it.quantity > 0 && it.inscription?.trim())
    .map((it) => it.inscription!.trim())
  return parts.length ? parts.join(' · ').slice(0, 80) : null
}

/** Ověřený košík → kontrakt objednávky + cena z ceníku firmy. */
export function toShopOrder(
  form: CheesecakeOrder,
  clientToken: string,
  today: string,
  shop: ShopConfig = COMPANY.shop,
): { ok: true; mapped: MappedOrder } | { ok: false; fieldErrors: FieldErrors<OrderField> } {
  const items = form.items.filter((it) => it.quantity > 0)
  const delivery = form.fulfillment.method !== 'vyzvednuti'
  const notes = [form.fulfillment.note?.trim(), form.note?.trim()].filter(Boolean)
  const parsed = shopOrderSchema.safeParse({
    clientToken,
    items: items.map((it) => ({ productKey: SLUG_PRODUCT[it.slug], quantity: it.quantity })),
    fulfilmentDate: form.fulfillment.date,
    fulfilment: delivery ? 'delivery' : 'pickup',
    deliveryAddress: delivery ? form.fulfillment.address : null,
    deliveryZone: delivery ? form.fulfillment.method : null,
    dedication: dedicationOf(form),
    note: notes.length ? notes.join('\n').slice(0, 1000) : null,
    customer: form.customer,
    consent: { processing: true, marketing: false },
  })
  if (!parsed.success) {
    const fieldErrors: FieldErrors<OrderField> = {}
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      const field: OrderField = path.startsWith('customer.email') ? 'customer.email'
        : path.startsWith('customer.phone') ? 'customer.phone'
          : path.startsWith('customer.name') ? 'customer.name'
            : path.startsWith('deliveryAddress') ? 'fulfillment.address'
              : path.startsWith('fulfilmentDate') ? 'fulfillment.date'
                : 'items'
      fieldErrors[field] ??= field === 'customer.email' ? MESSAGES.email : MESSAGES.required
    }
    return { ok: false, fieldErrors }
  }
  const order = parsed.data
  const pricing = priceShopOrder(shop, order, today)
  if (!pricing.ok) {
    // Pravidla ceníku hlídá už checkFormOrder; sem se dostane jen souběh se změnou ceníku.
    const fieldErrors: FieldErrors<OrderField> = {}
    for (const p of pricing.problems) {
      if (p === 'date_too_soon') fieldErrors['fulfillment.date'] = MESSAGES.orderDate(addDays(today, shop.minLeadDays))
      else if (p === 'date_too_far') fieldErrors['fulfillment.date'] = ORDER_MESSAGES.tooFar(shop.maxLeadDays)
      else if (p === 'delivery_unavailable') fieldErrors['fulfillment.method'] = ORDER_MESSAGES.delivery
      else fieldErrors.items = ORDER_MESSAGES.unavailable
    }
    return { ok: false, fieldErrors }
  }
  return {
    ok: true,
    mapped: {
      order,
      pricing,
      itemDetails: items.map((it) => ({ inscription: it.inscription?.trim() || null, miniFlavors: it.miniFlavors?.length ? [...it.miniFlavors] : null })),
    },
  }
}

/** Payload RPC shop_order_submit: kontrakt (shopOrderPayload) + doplňky webu z migrace 0106. */
export function orderRpcPayload(mapped: MappedOrder, form: CheesecakeOrder): Record<string, unknown> {
  const base = shopOrderPayload(mapped.order, mapped.pricing)
  const items = (base.items as Record<string, unknown>[]).map((line, i) => {
    const d = mapped.itemDetails[i]
    return {
      ...line,
      ...(d?.inscription ? { inscription: d.inscription } : {}),
      ...(d?.miniFlavors ? { mini_flavors: d.miniFlavors } : {}),
    }
  })
  return {
    ...base,
    items,
    delivery_zone: mapped.order.deliveryZone,
    payment_method: form.payment,
    company_name: form.company?.name?.trim() || null,
    ico: form.company?.ico ? form.company.ico.replace(/\s/g, '') : null,
    dic: form.company?.dic?.trim() || null,
    source_page: '/kosik',
    consent_version: WEB_CONSENT_VERSION,
  }
}
