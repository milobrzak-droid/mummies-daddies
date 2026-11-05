/**
 * Číselníky webu (typy akcí, segmenty, formáty, diety, doplňky, cheesecaky,
 * doprava). Klíče = hodnoty v URL (?typ=…) i v kontraktu lib/web/api.ts.
 * Popisky jsou doslova z mikrotextů (copy.json), ceny a minima z ověřených
 * podkladů (copy.json / audit). Nic tu není vymyšlené: co klient nedodal, je null.
 *
 * Bez závislostí → bezpečné pro klientské komponenty.
 */

export interface Option<V extends string = string> {
  value: V
  label: string
}

// ── poptávka cateringu ──────────────────────────────────────────────────────

export const EVENT_TYPES = [
  { value: 'firemni', label: 'Firemní catering', minGuests: 4, page: '/catering/firemni' },
  { value: 'snidane', label: 'Snídaně', minGuests: 2, page: '/catering/snidane' },
  { value: 'coffee-break', label: 'Coffee break', minGuests: 15, page: '/catering/coffee-break' },
  { value: 'obed', label: 'Oběd', minGuests: null, page: '/catering/obedy' },
  { value: 'vecere', label: 'Večeře a banket', minGuests: 8, page: '/catering/vecere-a-bankety' },
  { value: 'spolecenska-akce', label: 'Společenská akce', minGuests: 15, page: '/catering/spolecenske-akce' },
  { value: 'teambuilding', label: 'Teambuilding', minGuests: 8, page: '/catering/teambuilding' },
  { value: 'svatba', label: 'Svatba', minGuests: null, page: '/catering/svatby' },
  { value: 'oslava', label: 'Oslava a piknik', minGuests: 2, page: '/catering/oslavy-a-piknik' },
  { value: 'konzultace', label: 'Konzultace nebo ochutnávka', minGuests: null, page: null },
  { value: 'nevim', label: 'Ještě nevím', minGuests: null, page: null },
  // Jen z odkazu /vanoce (?typ=vanocni-vecirek); ve výběru formuláře se nezobrazuje.
  { value: 'vanocni-vecirek', label: 'Vánoční večírek', minGuests: null, page: '/vanoce', hidden: true },
] as const satisfies readonly (Option & { minGuests: number | null; page: string | null; hidden?: boolean })[]

export type EventType = (typeof EVENT_TYPES)[number]['value']

/** Typy akcí pro výběr ve formuláři (bez skrytých). Pořadí = mikrotext „možnosti typu akce“. */
export const EVENT_TYPE_OPTIONS = EVENT_TYPES.filter((e) => !('hidden' in e && e.hidden))

/** Rychlý start na úvodu nemá „Konzultace nebo ochutnávka“ (copy home › rychly-start). */
export const QUICK_START_EVENT_TYPES = EVENT_TYPE_OPTIONS.filter((e) => e.value !== 'konzultace')

export function eventTypeOf(value: string | null | undefined) {
  return EVENT_TYPES.find((e) => e.value === value)
}

/** Minimum osob pro typ akce (null = bez pevného minima / doplní klient). */
export function minimumGuests(type: EventType): number | null {
  return eventTypeOf(type)?.minGuests ?? null
}

export const CUSTOMER_KINDS = [
  { value: 'firma', label: 'Za firmu', segment: 'b2b' },
  { value: 'soukrome', label: 'Soukromě', segment: 'b2c' },
  { value: 'agentura', label: 'Jsem eventová agentura', segment: 'b2b' },
] as const satisfies readonly (Option & { segment: 'b2b' | 'b2c' })[]

export type CustomerKind = (typeof CUSTOMER_KINDS)[number]['value']
export type Segment = 'b2b' | 'b2c'

export function segmentOf(kind: CustomerKind): Segment {
  return CUSTOMER_KINDS.find((k) => k.value === kind)?.segment ?? 'b2c'
}

export const SERVICE_FORMATS = [
  { value: 'bufet', label: 'Bufet' },
  { value: 'raut', label: 'Raut' },
  { value: 'banket', label: 'Banket u stolu' },
  { value: 'sharing-table', label: 'Sharing table' },
  { value: 'finger-food', label: 'Finger food a jednohubky' },
  { value: 'bbq-live-cooking', label: 'BBQ a live cooking' },
  { value: 'piknikovy-kos', label: 'Piknikový koš' },
  { value: 'poradte', label: 'Poraďte mi' },
] as const satisfies readonly Option[]
export type ServiceFormat = (typeof SERVICE_FORMATS)[number]['value']

export const DIETS = [
  { value: 'vegetarianske', label: 'Vegetariánské' },
  { value: 'bezlepkove', label: 'Bezlepkové' },
  { value: 'bez-laktozy', label: 'Bez laktózy' },
  { value: 'vegan', label: 'Vegan' },
  { value: 'jine', label: 'Jiné (napište do poznámky)' },
] as const satisfies readonly Option[]
export type Diet = (typeof DIETS)[number]['value']

export const SERVICE_LEVELS = [
  { value: 'jen-dovoz', label: 'Jen dovoz' },
  { value: 'dovoz-a-priprava', label: 'Dovoz a příprava na místě' },
  { value: 'plny-servis', label: 'Plný servis s obsluhou' },
  { value: 'nevim', label: 'Nevím, poraďte' },
] as const satisfies readonly Option[]
export type ServiceLevel = (typeof SERVICE_LEVELS)[number]['value']

export const DRINKS = [
  { value: 'kava-caj', label: 'Káva a čaj' },
  { value: 'nealko', label: 'Nealko' },
  { value: 'welcome-drink', label: 'Welcome drink nebo přípitek' },
  { value: 'mobilni-bar', label: 'Mobilní bar' },
  { value: 'bez-napoju', label: 'Bez nápojů' },
] as const satisfies readonly Option[]
export type Drink = (typeof DRINKS)[number]['value']

export const EXTRAS = [
  { value: 'sladky-bar', label: 'Sladký bar' },
  { value: 'mini-cheesecaky', label: 'Mini cheesecaky' },
  { value: 'cheesecaky', label: 'Cheesecake nebo dort' },
  { value: 'fresh-bar', label: 'Fresh a smoothie bar' },
] as const satisfies readonly Option[]
export type Extra = (typeof EXTRAS)[number]['value']

/** Obvyklé rozpětí ceny cateringu na osobu (copy: „Obvykle 300 až 2 000 Kč na osobu“). */
export const TYPICAL_PRICE_PER_PERSON = { od: 300, do: 2000 } as const

// ── cheesecaky (e-shop) ─────────────────────────────────────────────────────

export const CHEESECAKES = [
  { slug: 'daddy-vanilkovy', name: 'Daddy vanilkový', line: 'daddy', price: 790, inscription: true, seasonal: false, priceConfirmed: true },
  { slug: 'daddy-pistaciovo-malinovy', name: 'Daddy pistáciovo-malinový', line: 'daddy', price: 1290, inscription: false, seasonal: false, priceConfirmed: true },
  { slug: 'daddy-cokoladovo-liskooriskovy', name: 'Daddy čokoládovo-lískooříškový', line: 'daddy', price: 1290, inscription: false, seasonal: false, priceConfirmed: true },
  // copy: „1 290 Kč [DOPLNÍ KLIENT: potvrdit cenu]“
  { slug: 'daddy-vanilkovo-karamelovy', name: 'Daddy krémový vanilkovo-karamelový', line: 'daddy', price: 1290, inscription: false, seasonal: false, priceConfirmed: false },
  { slug: 'mummy-vanilkovo-ovocny', name: 'Mummy vanilkovo-ovocný', line: 'mummy', price: 1090, inscription: false, seasonal: false, priceConfirmed: true },
  { slug: 'mummy-vanilkovo-pomerancovy-vanocni', name: 'Mummy vanilkovo-pomerančový vánoční', line: 'mummy', price: 1290, inscription: false, seasonal: true, priceConfirmed: true },
  { slug: 'mini-cheesecaky-10-ks', name: 'Mini cheesecaky mix, 10 ks', line: 'mini', price: 575, inscription: false, seasonal: false, priceConfirmed: true },
] as const

export type CheesecakeSlug = (typeof CHEESECAKES)[number]['slug']
export type Cheesecake = (typeof CHEESECAKES)[number]

export function cheesecakeOf(slug: string): Cheesecake | undefined {
  return CHEESECAKES.find((c) => c.slug === slug)
}

/** Příchutě mini cheesecaků (copy /cheesecaky › mini). */
export const MINI_FLAVORS = [
  'jahoda', 'pomeranč-vanilka', 'pistácie', 'čokoláda', 'karamel', 'čokoláda-oříšek', 'borůvka',
] as const
export type MiniFlavor = (typeof MINI_FLAVORS)[number]
export const MINI_PIECES = 10
export const INSCRIPTION_MAX = 25

export const DELIVERY_METHODS = [
  { value: 'praha', label: 'Praha', price: 300 },
  { value: 'praha-30', label: 'Praha + 30 km', price: 550 },
  { value: 'praha-70', label: 'Praha + 70 km', price: 750 },
  // adresa výdejního místa: [DOPLNÍ KLIENT]
  { value: 'vyzvednuti', label: 'Osobní vyzvednutí', price: 0 },
] as const satisfies readonly (Option & { price: number })[]
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number]['value']

/** Způsoby platby – klient je ještě nepotvrdil ([DOPLNÍ KLIENT: Kartou online · Převodem]). */
export const PAYMENT_METHODS = [
  { value: 'karta', label: 'Kartou online' },
  { value: 'prevod', label: 'Převodem' },
] as const satisfies readonly Option[]
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]['value']

/**
 * Objednací lhůta cheesecaků ve dnech. MUSÍ sedět s ceníkem firmy
 * (config/mummiesDaddies.ts, shop.minLeadDays — server podle něj objednávku
 * přijme, hlídá test/web-intake-routes.test.ts). Klient ji zatím nepotvrdil
 * ([DOPLNÍ KLIENT: objednací lhůta]); null = validace odmítá jen dnešek a minulost.
 */
export const ORDER_LEAD_DAYS: number | null = 2
