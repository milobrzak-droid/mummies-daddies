/**
 * Validace poptávky a objednávky + výpočet ceny košíku. Čisté funkce bez
 * závislostí (bezpečné pro klienta i server); stejná pravidla používá mock
 * v lib/web/api.ts, takže formulář a „server“ hlásí totéž.
 *
 * Chybové texty jsou doslova z mikrotextů copy.json (CHYBA — …, KOŠÍK — chyba …).
 */
import type { CheesecakeOrder, FieldErrors, InquiryField, OrderField, WebInquiry } from './api'
import {
  CHEESECAKES, DELIVERY_METHODS, EVENT_TYPES, INSCRIPTION_MAX, MINI_FLAVORS, MINI_PIECES, ORDER_LEAD_DAYS,
  minimumGuests,
  type DeliveryMethod,
} from './options'
import { formatDate, isoDate } from './format'

export const MESSAGES = {
  required: 'Tohle pole potřebujeme vyplnit.',
  email: 'Tenhle e-mail nevypadá správně. Zkontrolujte ho, prosím.',
  phone: 'Zadejte telefon včetně předvolby, třeba +420 737 000 000.',
  pastDate: 'Tohle datum už proběhlo. Vyberte, prosím, budoucí termín.',
  belowMinimum: (minimum: number) =>
    `Tenhle formát připravujeme od ${minimum} osob. Zkuste jiný formát, nebo napište do poznámky, poradíme.`,
  ico: 'IČO má 8 číslic. Zkontrolujte ho, prosím.',
  consent: 'Bez souhlasu vám nabídku bohužel poslat nemůžeme.',
  submitFailed: 'Něco se pokazilo a poptávka neodešla. Zkuste to znovu, nebo zavolejte Monice na +420 737 818 694.',
  offline: 'Ztratili jsme spojení. Vaše údaje jsme si uložili, stačí kliknout znovu na Odeslat.',
  inscription: 'Nápis může mít nejvýš 25 znaků.',
  miniFlavors: 'Vyberte prosím všech 10 mini cheesecaků.',
  orderDate: (earliest: string) => `Tenhle termín už nestihneme upéct. Nejbližší možný je ${formatDate(earliest)}.`,
  /** Text pro e-shop; souhlas s obchodními podmínkami (KOŠÍK — souhlas). */
  orderConsent: 'Bez souhlasu s obchodními podmínkami objednávku odeslat nemůžeme.',
} as const

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
/** Telefon s předvolbou: +420 737 818 694, 00420…, mezery a pomlčky povoleny. */
export const PHONE_RE = /^(\+|00)\d{1,3}[\s-]?\d{2,4}([\s-]?\d{2,4}){1,4}$/
export const ICO_RE = /^\d{8}$/

export function isEmail(v: string): boolean {
  return EMAIL_RE.test(v.trim())
}
export function isPhone(v: string): boolean {
  return PHONE_RE.test(v.trim())
}
export function isIco(v: string): boolean {
  return ICO_RE.test(v.replace(/\s/g, ''))
}

/**
 * Validace poptávky. Vrací mapu pole → chybová hláška (prázdná = v pořádku).
 * `today` = YYYY-MM-DD (kvůli testům), výchozí dnešek.
 * Povinné: typ akce, segment, počet osob, kontakt (jméno, e-mail), souhlas.
 * Datum je nepovinné (přibližný termín jde do poznámky), ale nesmí být v minulosti.
 */
export function validateInquiry(x: Partial<WebInquiry>, today = isoDate()): FieldErrors<InquiryField> {
  const e: FieldErrors<InquiryField> = {}
  if (!x.eventType || !EVENT_TYPES.some((t) => t.value === x.eventType)) e.eventType = MESSAGES.required
  if (!x.customerKind) e.customerKind = MESSAGES.required
  if (x.eventDate && x.eventDate < today) e.eventDate = MESSAGES.pastDate
  if (x.eventType !== 'konzultace') {
    if (!x.guests || !Number.isFinite(x.guests) || x.guests < 1) e.guests = MESSAGES.required
    else if (x.eventType) {
      const min = minimumGuests(x.eventType)
      if (min && x.guests < min) e.guests = MESSAGES.belowMinimum(min)
    }
  }
  if (x.company?.ico && !isIco(x.company.ico)) e['company.ico'] = MESSAGES.ico
  if (!x.contact?.name?.trim()) e['contact.name'] = MESSAGES.required
  if (!x.contact?.email?.trim()) e['contact.email'] = MESSAGES.required
  else if (!isEmail(x.contact.email)) e['contact.email'] = MESSAGES.email
  if (x.contact?.phone && x.contact.phone.trim() && !isPhone(x.contact.phone)) e['contact.phone'] = MESSAGES.phone
  if (x.consent !== true) e.consent = MESSAGES.consent
  return e
}

// ── objednávka cheesecaků ───────────────────────────────────────────────────

/** Nejbližší možný termín upečení (YYYY-MM-DD). Bez lhůty od klienta = zítřek. */
export function earliestOrderDate(today = isoDate()): string {
  const [y, m, d] = today.split('-').map(Number)
  return isoDate(ORDER_LEAD_DAYS ?? 1, new Date(y, m - 1, d))
}

export interface OrderTotals {
  subtotal: number
  delivery: number
  total: number
}

/** Mezisoučet, doprava a celkem (Kč vč. DPH) podle ceníku v options.ts. */
export function computeOrderTotals(items: CheesecakeOrder['items'], method: DeliveryMethod | null): OrderTotals {
  const subtotal = items.reduce((sum, it) => {
    const p = CHEESECAKES.find((c) => c.slug === it.slug)
    return sum + (p ? p.price * Math.max(0, Math.floor(it.quantity)) : 0)
  }, 0)
  const delivery = DELIVERY_METHODS.find((d) => d.value === method)?.price ?? 0
  return { subtotal, delivery, total: subtotal + delivery }
}

export function validateOrder(o: Partial<CheesecakeOrder>, today = isoDate()): FieldErrors<OrderField> {
  const e: FieldErrors<OrderField> = {}
  const items = o.items ?? []
  if (!items.length || items.every((i) => i.quantity < 1)) e.items = MESSAGES.required
  items.forEach((it, i) => {
    const p = CHEESECAKES.find((c) => c.slug === it.slug)
    if (!p || !Number.isInteger(it.quantity) || it.quantity < 1) e[`items.${i}`] = MESSAGES.required
    if (it.inscription && it.inscription.length > INSCRIPTION_MAX) e[`items.${i}.inscription`] = MESSAGES.inscription
    if (p?.line === 'mini') {
      const fl = it.miniFlavors ?? []
      if (fl.length !== MINI_PIECES || fl.some((f) => !(MINI_FLAVORS as readonly string[]).includes(f))) {
        e[`items.${i}.miniFlavors`] = MESSAGES.miniFlavors
      }
    }
  })
  const f = o.fulfillment
  if (!f?.method) e['fulfillment.method'] = MESSAGES.required
  if (f?.method && f.method !== 'vyzvednuti' && !f.address?.trim()) e['fulfillment.address'] = MESSAGES.required
  if (!f?.date) e['fulfillment.date'] = MESSAGES.required
  else {
    const earliest = earliestOrderDate(today)
    if (f.date < earliest) e['fulfillment.date'] = MESSAGES.orderDate(earliest)
  }
  if (!o.customer?.name?.trim()) e['customer.name'] = MESSAGES.required
  if (!o.customer?.email?.trim()) e['customer.email'] = MESSAGES.required
  else if (!isEmail(o.customer.email)) e['customer.email'] = MESSAGES.email
  if (!o.customer?.phone?.trim()) e['customer.phone'] = MESSAGES.required
  else if (!isPhone(o.customer.phone)) e['customer.phone'] = MESSAGES.phone
  if (o.company) {
    if (!o.company.name?.trim()) e['company.name'] = MESSAGES.required
    if (!o.company.ico || !isIco(o.company.ico)) e['company.ico'] = MESSAGES.ico
  }
  if (!o.payment) e.payment = MESSAGES.required
  if (o.consent !== true) e.consent = MESSAGES.orderConsent
  return e
}

export function hasErrors(e: Record<string, unknown>): boolean {
  return Object.keys(e).length > 0
}
