/**
 * KONTRAKT webu ↔ systém (agent poptávek, Cockpit objednávek).
 *
 * Formuláře a košík volají VÝHRADNĚ tyto tři funkce:
 *   submitInquiry(inquiry)  → poptávka cateringu (později: AI agent → lead v CRM)
 *   estimatePrice(params)   → orientační rozpětí ceny na osobu, nebo null
 *   submitOrder(order)      → objednávka cheesecaků (později: Cockpit › objednávky)
 *
 * Teď je to MOCK: nic se neposílá na internet, data zůstávají v paměti procesu
 * (a v konzoli). Napojení na agenta vymění jen těla funkcí; typy a návratové
 * hodnoty zůstanou. Proto tento soubor exportuje jen TYPY a ASYNC funkce –
 * později z něj může být 'use server' modul (Server Actions) beze změny volajících.
 * Číselníky jsou v lib/web/options.ts, validace v lib/web/validation.ts.
 *
 * Funkce jsou izomorfní (žádné node:fs) → klientská komponenta je smí volat přímo.
 */
import type {
  CheesecakeSlug, CustomerKind, DeliveryMethod, Diet, Drink, EventType, Extra, MiniFlavor,
  PaymentMethod, Segment, ServiceFormat, ServiceLevel,
} from './options'
import { segmentOf, TYPICAL_PRICE_PER_PERSON } from './options'
import { computeOrderTotals, earliestOrderDate, hasErrors, validateInquiry, validateOrder } from './validation'
import { validateVoucher } from './eshop/voucher'

export type { CheesecakeSlug, CustomerKind, DeliveryMethod, Diet, Drink, EventType, Extra, MiniFlavor, PaymentMethod, Segment, ServiceFormat, ServiceLevel }

// ── společné ────────────────────────────────────────────────────────────────

/** Mapa „cesta pole“ → chybová hláška (česky, z mikrotextů). */
export type FieldErrors<F extends string = string> = Partial<Record<F, string>>

export type FailureReason = 'validation' | 'network' | 'server'

// ── poptávka cateringu ──────────────────────────────────────────────────────

/** Odkud poptávka přišla (agent se pak neptá na to, co už ví). */
export interface InquirySource {
  /** formular = /poptavka, chat = asistent, rychly-start = karta na úvodu. */
  channel: 'formular' | 'chat' | 'rychly-start'
  /** Stránka, ze které návštěvník přišel (?zdroj=…), např. "/catering/svatby". */
  page: string | null
  /** Vzorová reference (?vzor=svatba-katka-a-jirka) nebo prostor (?prostor=…). */
  ref: string | null
}

export interface WebInquiry {
  /** Typ akce (?typ=). */
  eventType: EventType
  /** Za firmu / soukromě / agentura (?segment=firma|soukrome|agentura). */
  customerKind: CustomerKind
  /** B2B / B2C – odvozeno z customerKind (segmentOf), posílá se kvůli agentovi. */
  segment: Segment
  /** Firma u B2B (nepovinné; z IČO doplní fakturační údaje systém). */
  company: { name: string; ico: string | null } | null
  /** Datum akce YYYY-MM-DD, nebo null (přibližný termín → note). */
  eventDate: string | null
  /** Čas „od–do“ (HH:MM), nepovinné. */
  timeFrom: string | null
  timeTo: string | null
  /** Místo: adresa/PSČ; needsVenue = „Hledám prostor, poraďte mi“; venueSlug z ?prostor=. */
  venue: { address: string | null; needsVenue: boolean; venueSlug: string | null }
  /** Počet hostů (odhad stačí). U konzultace může být 0. */
  guests: number
  serviceFormat: ServiceFormat | null
  /** Rozpočet na osobu v Kč (nepovinné). */
  budgetPerPerson: number | null
  diets: Diet[]
  /** Upřesnění diet („3× bezlepkové“). */
  dietNote: string | null
  serviceLevel: ServiceLevel | null
  drinks: Drink[]
  /** Doplňky (?doplnek=cheesecaky|mini-cheesecaky|sladky-bar|fresh-bar). */
  extras: Extra[]
  note: string | null
  contact: { name: string; email: string; phone: string | null }
  /** Souhlas se zpracováním osobních údajů (musí být true). */
  consent: boolean
  source: InquirySource
}

/** Cesty polí pro FieldErrors poptávky. */
export type InquiryField =
  | 'eventType' | 'customerKind' | 'eventDate' | 'guests' | 'venue.address' | 'serviceFormat'
  | 'budgetPerPerson' | 'company.name' | 'company.ico' | 'contact.name' | 'contact.email'
  | 'contact.phone' | 'consent'

/**
 * Jak bude poptávka zpracována → který text potvrzení ukázat (mikrotexty POTVRZENÍ — …):
 *   standard      → „standard, nadpis/text“ (nabídka do pár minut)
 *   na-miru       → „na míru, nadpis/text“ (Monika osobně)
 *   ceka-na-cenik → „varianta do schválení ceníku“ (mapa ještě není schválená)
 *   konzultace    → „konzultace“
 */
export type InquiryOutcome = 'standard' | 'na-miru' | 'ceka-na-cenik' | 'konzultace'

export type SubmitInquiryResult =
  | { ok: true; inquiryId: string; outcome: InquiryOutcome; estimate: PriceEstimate | null; receivedAt: string }
  | { ok: false; reason: 'validation'; fieldErrors: FieldErrors<InquiryField> }
  | { ok: false; reason: 'network' | 'server'; message: string }

// ── odhad ceny ──────────────────────────────────────────────────────────────

export interface EstimateParams {
  eventType: EventType
  guests?: number | null
  serviceFormat?: ServiceFormat | null
  customerKind?: CustomerKind | null
}

/**
 * Orientační (nezávazné) rozpětí ceny. `od`/`do` jsou Kč NA OSOBU (vč. DPH);
 * `total` = od/do × hosté, když je počet znám.
 * basis: 'obvykle-rozpeti' = obecné rozpětí 300–2 000 Kč/os. (dokud klient
 * neschválí cateringovou mapu), 'cateringova-mapa' = podle schválené mapy.
 */
export interface PriceEstimate {
  od: number
  do: number
  unit: 'osoba'
  total: { od: number; do: number } | null
  basis: 'obvykle-rozpeti' | 'cateringova-mapa'
  /** Verze cateringové mapy (null = žádná schválená). */
  mapVersion: string | null
  binding: false
}

// ── objednávka cheesecaků ───────────────────────────────────────────────────

export interface CartItem {
  slug: CheesecakeSlug
  /** Počet kusů (celé číslo ≥ 1). */
  quantity: number
  /** Nápis (jen Daddy vanilkový), max. 25 znaků. */
  inscription?: string | null
  /** Jen „Mini cheesecaky mix, 10 ks“: přesně 10 příchutí (mohou se opakovat). */
  miniFlavors?: MiniFlavor[] | null
}

export interface CheesecakeOrder {
  items: CartItem[]
  fulfillment: {
    method: DeliveryMethod
    /** Doručovací adresa (u vyzvednutí null). */
    address: string | null
    /** Termín YYYY-MM-DD (≥ earliestOrderDate()). */
    date: string
    note: string | null
  }
  customer: { name: string; email: string; phone: string }
  /** „Nakupuji na firmu“ → fakturační údaje, jinak null. */
  company: { name: string; ico: string; dic: string | null } | null
  payment: PaymentMethod
  note: string | null
  /** Souhlas s obchodními podmínkami a zpracováním údajů. */
  consent: boolean
}

export type OrderField =
  | 'items' | `items.${number}` | `items.${number}.inscription` | `items.${number}.miniFlavors`
  | 'fulfillment.method' | 'fulfillment.address' | 'fulfillment.date'
  | 'customer.name' | 'customer.email' | 'customer.phone'
  | 'company.name' | 'company.ico' | 'payment' | 'consent'

export type SubmitOrderResult =
  | {
      ok: true
      /** Číslo objednávky = variabilní symbol u převodu. */
      orderNumber: string
      subtotal: number
      delivery: number
      total: number
      bakeDate: string
      /** Další krok platby: karta = přesměrování na bránu (zatím null), převod = instrukce. */
      payment: { method: 'karta'; redirectUrl: string | null } | { method: 'prevod'; account: string | null; variableSymbol: string; amount: number }
    }
  | { ok: false; reason: 'validation'; fieldErrors: FieldErrors<OrderField> }
  | { ok: false; reason: 'network' | 'server'; message: string }

// ── MOCK implementace ───────────────────────────────────────────────────────

/** Schválená verze cateringové mapy. Dokud klient mapu neschválí, je null. */
const APPROVED_MAP_VERSION: string | null = null

const mockInquiries: (WebInquiry & { id: string; receivedAt: string })[] = []
const mockOrders: (CheesecakeOrder & { orderNumber: string })[] = []

function delay(ms = 350): Promise<void> {
  if (process.env.NODE_ENV === 'test') return Promise.resolve()
  return new Promise((r) => setTimeout(r, ms))
}

function mockId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${rand}`
}

function outcomeFor(x: WebInquiry): InquiryOutcome {
  if (x.eventType === 'konzultace') return 'konzultace'
  // Cesty 2 a 3 ze strategie: agentura, velké akce (nad 50 os.), svatby a nejasné zadání → člověk.
  if (x.customerKind === 'agentura' || x.guests > 50 || x.eventType === 'svatba' || x.eventType === 'nevim') return 'na-miru'
  return APPROVED_MAP_VERSION ? 'standard' : 'ceka-na-cenik'
}

/**
 * Odešle poptávku. Nevalidní vstup → { ok: false, reason: 'validation', fieldErrors }.
 * Mock: uloží do paměti, vrátí id a outcome podle pravidel výše.
 */
export async function submitInquiry(inquiry: WebInquiry): Promise<SubmitInquiryResult> {
  await delay()
  const fieldErrors = validateInquiry(inquiry)
  if (hasErrors(fieldErrors)) return { ok: false, reason: 'validation', fieldErrors }
  const normalized: WebInquiry = { ...inquiry, segment: segmentOf(inquiry.customerKind) }
  const id = mockId('POP')
  const receivedAt = new Date().toISOString()
  mockInquiries.push({ ...normalized, id, receivedAt })
  if (process.env.NODE_ENV !== 'test') console.info('[md-web mock] submitInquiry', id, normalized.eventType, normalized.guests)
  const outcome = outcomeFor(normalized)
  const estimate = outcome === 'konzultace' ? null : await estimatePrice({
    eventType: normalized.eventType, guests: normalized.guests, serviceFormat: normalized.serviceFormat, customerKind: normalized.customerKind,
  })
  return { ok: true, inquiryId: id, outcome, estimate, receivedAt }
}

/**
 * Orientační rozpětí ceny na osobu, nebo null (konzultace, „ještě nevím“, chybí počet osob u celku).
 * Mock: dokud není schválená cateringová mapa, vrací obecné rozpětí 300–2 000 Kč/os.
 * (fakt z podkladů), NIKDY ne vymyšlenou cenu konkrétního balíčku.
 */
export async function estimatePrice(params: EstimateParams): Promise<PriceEstimate | null> {
  if (params.eventType === 'konzultace' || params.eventType === 'nevim') return null
  const { od, do: to } = TYPICAL_PRICE_PER_PERSON
  const guests = params.guests && params.guests > 0 ? Math.floor(params.guests) : null
  return {
    od,
    do: to,
    unit: 'osoba',
    total: guests ? { od: od * guests, do: to * guests } : null,
    basis: APPROVED_MAP_VERSION ? 'cateringova-mapa' : 'obvykle-rozpeti',
    mapVersion: APPROVED_MAP_VERSION,
    binding: false,
  }
}

/**
 * Odešle objednávku cheesecaků. Cenu přepočítá „server“ (klientským součtům se nevěří).
 * Mock: uloží do paměti, vrátí číslo objednávky; platba kartou zatím bez brány.
 */
export async function submitOrder(order: CheesecakeOrder): Promise<SubmitOrderResult> {
  await delay()
  const fieldErrors = validateOrder(order)
  if (hasErrors(fieldErrors)) return { ok: false, reason: 'validation', fieldErrors }
  const totals = computeOrderTotals(order.items, order.fulfillment.method)
  const orderNumber = String(Date.now()).slice(-8)
  mockOrders.push({ ...order, orderNumber })
  if (process.env.NODE_ENV !== 'test') console.info('[md-web mock] submitOrder', orderNumber, totals.total)
  return {
    ok: true,
    orderNumber,
    ...totals,
    bakeDate: order.fulfillment.date < earliestOrderDate() ? earliestOrderDate() : order.fulfillment.date,
    payment: order.payment === 'karta'
      ? { method: 'karta', redirectUrl: null }
      : { method: 'prevod', account: null, variableSymbol: orderNumber, amount: totals.total },
  }
}

// ── dárkový poukaz (doplnil e-shop; kontrakt neměl poukaz) ───────────────────

/**
 * Nákup dárkového poukazu (/darkovy-poukaz). Hodnota 1 000–5 000 Kč nebo vlastní
 * částka; poukaz se posílá e-mailem (tištěná varianta: [DOPLNÍ KLIENT]).
 * Na co poukaz platí a jak dlouho, zatím klient nedodal.
 */
export interface VoucherOrder {
  /** Hodnota poukazu v Kč (celé číslo). */
  amount: number
  /** Jméno obdarovaného (vytiskne se na poukaz). */
  recipientName: string
  /** Vzkaz pro obdarovaného, nepovinný. */
  message: string | null
  /** Kam poukaz poslat (e-mail obdarovaného, nebo kupujícího). */
  deliveryEmail: string
  payment: PaymentMethod
  /** Souhlas s obchodními podmínkami a zpracováním údajů. */
  consent: boolean
}

export type VoucherField = 'amount' | 'recipientName' | 'message' | 'deliveryEmail' | 'payment' | 'consent'

export type SubmitVoucherResult =
  | {
      ok: true
      /** Číslo objednávky poukazu = variabilní symbol u převodu. */
      orderNumber: string
      amount: number
      deliveryEmail: string
      payment: { method: 'karta'; redirectUrl: string | null } | { method: 'prevod'; account: string | null; variableSymbol: string; amount: number }
    }
  | { ok: false; reason: 'validation'; fieldErrors: FieldErrors<VoucherField> }
  | { ok: false; reason: 'network' | 'server'; message: string }

const mockVouchers: (VoucherOrder & { orderNumber: string })[] = []

/**
 * Odešle objednávku dárkového poukazu. Mock: ověří, uloží do paměti, vrátí číslo;
 * platba kartou zatím bez brány (redirectUrl null), převod s variabilním symbolem.
 */
export async function submitVoucherOrder(voucher: VoucherOrder): Promise<SubmitVoucherResult> {
  await delay()
  const fieldErrors = validateVoucher(voucher)
  if (hasErrors(fieldErrors)) return { ok: false, reason: 'validation', fieldErrors }
  const orderNumber = `P${String(Date.now()).slice(-7)}`
  mockVouchers.push({ ...voucher, orderNumber })
  if (process.env.NODE_ENV !== 'test') console.info('[md-web mock] submitVoucherOrder', orderNumber, voucher.amount)
  return {
    ok: true,
    orderNumber,
    amount: voucher.amount,
    deliveryEmail: voucher.deliveryEmail.trim(),
    payment: voucher.payment === 'karta'
      ? { method: 'karta', redirectUrl: null }
      : { method: 'prevod', account: null, variableSymbol: orderNumber, amount: voucher.amount },
  }
}
