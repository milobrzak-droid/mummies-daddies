// Kontrakt veřejného webu (P6) a agenta (P2): nezávazná poptávka z webového
// formuláře. Formulář sbírá STRUKTUROVANÁ pole, takže poptávka z webu jde
// bez modelu rovnou do výpočtu z mapy (evaluateStandardOffer) — stejným
// rozhodnutím jako e-mail, jen bez kroku vytěžení.
//
// Tok: formulář (P6) → route handler POST /api/web/poptavka (P6, Turnstile,
// limit) → webInquirySchema.parse → RPC web_inquiry_submit(p jsonb)
// (migrace 0102, jen service_role) → řádek web_inquiry ve stavu 'new' →
// úloha inquiry-agent (P2) si ho vezme, zavolá webInquiryToOfferInquiry
// a evaluateStandardOffer, založí lead v CRM a odpoví přes agent_outbox (P3).
//
// Osobní údaje (jméno, e-mail, telefon, zpráva) se ukládají jen do
// web_inquiry; do auditu, logů ani job_run.stats nikdy nejdou.
import { z } from 'zod'
import type { OfferInquiryInput } from './standardOffer'

const key = z.string().trim().min(1).max(40)
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum ve tvaru YYYY-MM-DD.')
/** Nepovinný text: prázdný řetězec i chybějící pole = null. */
const optText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null))

/** Hodnota pole „typ akce", když zákazník nic z nabídky nevybral. */
export const WEB_OTHER = 'other'

export const webInquirySchema = z.object({
  /** Klíč idempotence z formuláře (uuid v4, vygeneruje ho prohlížeč); dvojí odeslání = jeden řádek. */
  clientToken: z.string().uuid(),
  /** Segment mapy ('b2b' = firemní akce, 'b2c' = soukromá oslava); null = nevybráno. */
  segment: key.nullable(),
  /** Typ akce z mapy (PriceMapEventType.key), nebo WEB_OTHER. */
  eventType: key.nullable(),
  /** Balíček z mapy (PriceMapPackage.key); null = výchozí balíček typu akce. */
  packageKey: key.nullable().default(null),
  eventDate: isoDate.nullable(),
  /** Začátek akce HH:MM (jen informace pro realizaci, výpočet ho nepoužívá). */
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
  durationHours: z.number().positive().max(24).nullable().default(null),
  guests: z.number().int().positive().max(100_000).nullable(),
  /** Místo akce (adresa / obec) — z něj P2 geokódováním určí vzdálenost. */
  venue: optText(300),
  extras: z.array(key).max(30).default([]),
  dietary: z.array(z.object({ key, guests: z.number().int().positive().max(100_000) })).max(20).default([]),
  /** Zvláštní přání mimo nabídku. Neprázdné = nestandardní poptávka (eskalace). */
  specialRequests: optText(2000),
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: optText(40),
    /** Název firmy u firemní akce (B2B). */
    companyName: optText(200),
    /** IČO firmy (8 číslic), nepovinné. */
    ico: z.string().nullable().optional()
      .transform((v) => (v ? v.replace(/\s/g, '') || null : null))
      .refine((v) => v === null || /^\d{8}$/.test(v), 'IČO má 8 číslic.'),
  }),
  consent: z.object({
    /** Souhlas se zpracováním osobních údajů pro vyřízení poptávky (povinný). */
    processing: z.literal(true),
    /** Souhlas s obchodními sděleními (nepovinný). */
    marketing: z.boolean().default(false),
  }),
  /** Odkud poptávka přišla (cesta stránky webu, např. '/catering/svatby'). */
  sourcePage: z.string().trim().max(200).regex(/^\//).default('/'),
})

export type WebInquiry = z.infer<typeof webInquirySchema>
export type WebInquiryInput = z.input<typeof webInquirySchema>

/** Stavy řádku web_inquiry (CHECK v migraci 0102). */
export const WEB_INQUIRY_STATUSES = ['new', 'processing', 'decided', 'failed', 'spam'] as const
export type WebInquiryStatus = (typeof WEB_INQUIRY_STATUSES)[number]

export const WEB_INQUIRY_SUBMIT_RPC = 'web_inquiry_submit'

/** Výsledek RPC web_inquiry_submit. */
export type WebInquirySubmitResult = { web_inquiry_id: number; duplicate: boolean }

/** Payload RPC web_inquiry_submit (snake_case, jak ho čte SQL). */
export function webInquiryPayload(w: WebInquiry): Record<string, unknown> {
  return {
    client_token: w.clientToken,
    segment: w.segment,
    event_type: w.eventType,
    event_date: w.eventDate,
    guests: w.guests,
    customer_name: w.customer.name,
    email: w.customer.email,
    phone: w.customer.phone,
    company_name: w.customer.companyName,
    ico: w.customer.ico,
    marketing_consent: w.consent.marketing,
    source_page: w.sourcePage,
    // Strukturovaná pole akce celá (bez kontaktu) — z nich P2 skládá vstup výpočtu.
    inquiry: {
      segment: w.segment,
      event_type: w.eventType,
      package_key: w.packageKey,
      event_date: w.eventDate,
      start_time: w.startTime,
      duration_hours: w.durationHours,
      guests: w.guests,
      venue: w.venue,
      extras: w.extras,
      dietary: w.dietary,
      special_requests: w.specialRequests,
    },
  }
}

/**
 * Vstup výpočtu nabídky z webové poptávky. Žádný model: pole jsou už
 * ověřená schématem. `distanceKm` doplní geokódování místa akce (P2),
 * `vipContact` CRM. Typ akce WEB_OTHER výpočet nezná → eskalace.
 */
export function webInquiryToOfferInquiry(
  w: Pick<WebInquiry, 'segment' | 'eventType' | 'packageKey' | 'eventDate' | 'guests' | 'durationHours' | 'extras' | 'dietary' | 'specialRequests'>,
  extra: { distanceKm: number | null; vipContact: boolean },
): OfferInquiryInput {
  return {
    segment: w.segment,
    eventType: w.eventType,
    eventDate: w.eventDate,
    guests: w.guests,
    packageKey: w.packageKey,
    durationHours: w.durationHours,
    distanceKm: extra.distanceKm,
    extras: [...w.extras],
    dietary: w.dietary.map((d) => ({ key: d.key, guests: d.guests })),
    specialRequests: w.specialRequests,
    vipContact: extra.vipContact,
  }
}
