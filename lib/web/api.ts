/**
 * KONTRAKT webu ↔ systém (agent poptávek, Cockpit objednávek).
 *
 * Formuláře a košík volají VÝHRADNĚ tyto funkce:
 *   submitInquiry(inquiry)  → POST /api/web/poptavka → web_inquiry → agent poptávek (lead v CRM)
 *   estimatePrice(params)   → orientační rozpětí ceny na osobu z ceníku firmy, nebo null
 *   submitOrder(order)      → POST /api/web/objednavka → shop_order → Cockpit › Objednávky
 *
 * Napojení na systém (balík P6) vyměnilo jen těla funkcí; typy a návratové
 * hodnoty zůstaly. Server data znovu ověří (zod + stejná pravidla jako
 * formulář), cenu spočítá sám z ceníku firmy a chrání se Turnstile, limitem
 * a honeypotem. Formuláře NEPOUŽÍVAJÍ Server Actions: nepřihlášený smí volat
 * jen route handlery /api/web/** (lib/routes.ts).
 * Číselníky jsou v lib/web/options.ts, validace v lib/web/validation.ts.
 *
 * Funkce jsou izomorfní (žádné node:fs) → klientská komponenta je smí volat přímo.
 */
import type {
  CheesecakeSlug, CustomerKind, DeliveryMethod, Diet, Drink, EventType, Extra, MiniFlavor,
  PaymentMethod, Segment, ServiceFormat, ServiceLevel,
} from './options'
import { segmentOf } from './options'
import { hasErrors, validateInquiry, validateOrder } from './validation'
import { validateVoucher } from './eshop/voucher'
import { estimateFromGuide, getPriceGuide } from './priceGuide'
import { getTurnstileToken } from './turnstileClient'

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

// ── napojení na systém ──────────────────────────────────────────────────────

/** Cesty veřejných API webu (app/api/web/**). */
export const WEB_API = { inquiry: '/api/web/poptavka', order: '/api/web/objednavka' } as const

/** Čas načtení stránky (časová past proti robotům: příliš rychlé odeslání). */
const loadedAt = Date.now()

/**
 * Klíč idempotence: stejná data odeslaná znovu (dvojklik, opakování po
 * výpadku spojení) nesou stejný klíč → server je zapíše jen jednou.
 */
const tokens = new Map<string, string>()
function clientTokenFor(kind: string, data: unknown): string {
  const key = `${kind}:${JSON.stringify(data)}`
  let t = tokens.get(key)
  if (!t) {
    // Web běží jen přes https (bezpečný kontext) → randomUUID je vždy k dispozici.
    t = crypto.randomUUID()
    tokens.set(key, t)
  }
  return t
}

/** Hodnota honeypotu formuláře (skryté pole name="web"), pokud na stránce je. */
function honeypotValue(): string {
  if (typeof document === 'undefined') return ''
  return document.querySelector<HTMLInputElement>('input[name="web"]')?.value ?? ''
}

type Fail = { ok: false; reason: 'network' | 'server'; message: string }

/**
 * Odešle formulář na route handler webu. Výpadek spojení = 'network',
 * jakákoli jiná chyba (vypnutý příjem, limit, Turnstile, server) = 'server'.
 * Chyby validace vrací server ve stejném tvaru jako formulář (fieldErrors).
 */
async function postForm<T extends { ok: boolean }>(path: string, kind: string, data: unknown): Promise<T | Fail> {
  let res: Response
  try {
    const turnstileToken = await getTurnstileToken()
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({
        clientToken: clientTokenFor(kind, data),
        turnstileToken,
        hp: honeypotValue(),
        elapsedMs: Math.max(0, Date.now() - loadedAt),
        data,
      }),
    })
  } catch {
    return { ok: false, reason: 'network', message: 'offline' }
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const b = body as { ok?: unknown; reason?: unknown; message?: unknown } | null
  if (b && b.ok === true && res.ok) return b as T
  if (b && b.ok === false && b.reason === 'validation') return b as T
  return { ok: false, reason: 'server', message: typeof b?.message === 'string' ? b.message : `http_${res.status}` }
}

/**
 * Odešle poptávku. Nevalidní vstup → { ok: false, reason: 'validation', fieldErrors }
 * (nejdřív kontrola v prohlížeči, pak znovu na serveru). Výsledek `outcome`
 * určuje server stejným výpočtem jako agent poptávek.
 */
export async function submitInquiry(inquiry: WebInquiry): Promise<SubmitInquiryResult> {
  const fieldErrors = validateInquiry(inquiry)
  if (hasErrors(fieldErrors)) return { ok: false, reason: 'validation', fieldErrors }
  const normalized: WebInquiry = { ...inquiry, segment: segmentOf(inquiry.customerKind) }
  return postForm<SubmitInquiryResult>(WEB_API.inquiry, 'inquiry', normalized)
}

/**
 * Orientační rozpětí ceny na osobu, nebo null (konzultace, „ještě nevím“).
 * Rozpětí spočítal server z cenové mapy firmy (lib/web/priceGuide.ts); dokud
 * mapa není schválená, je to obecné rozpětí 300–2 000 Kč/os., NIKDY cena
 * konkrétního balíčku. Bez sítě (ceník je ve stránce).
 */
export async function estimatePrice(params: EstimateParams): Promise<PriceEstimate | null> {
  return estimateFromGuide(getPriceGuide(), params)
}

/**
 * Odešle objednávku cheesecaků. Cenu spočítá server z ceníku firmy
 * (klientským součtům se nevěří); číslo objednávky = číslo v Cockpitu.
 */
export async function submitOrder(order: CheesecakeOrder): Promise<SubmitOrderResult> {
  const fieldErrors = validateOrder(order)
  if (hasErrors(fieldErrors)) return { ok: false, reason: 'validation', fieldErrors }
  return postForm<SubmitOrderResult>(WEB_API.order, 'order', order)
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

/**
 * Odešle objednávku dárkového poukazu. Systém zatím poukazy neprodává
 * (chybí podmínky poukazu i platební brána, doplní klient): po kontrole
 * formuláře vrací chybu 'server' a formulář nabídne e-mail a telefon.
 * Nic se nezapisuje ani neodesílá.
 */
export async function submitVoucherOrder(voucher: VoucherOrder): Promise<SubmitVoucherResult> {
  const fieldErrors = validateVoucher(voucher)
  if (hasErrors(fieldErrors)) return { ok: false, reason: 'validation', fieldErrors }
  return { ok: false, reason: 'server', message: 'vouchers_unavailable' }
}
