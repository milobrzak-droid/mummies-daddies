// Poptávka z webového formuláře (lib/web/api.ts#WebInquiry, slovník webu)
// → kontrakt agenta (core/webInquiry.ts#WebInquiry, klíče cenové mapy).
//
// Web mluví řečí návštěvníka (typ akce „Večeře a banket", formát „Raut",
// úroveň servisu…), mapa firmy řečí výpočtu (typ akce, balíček, doplněk,
// dieta s počtem osob). Co do mapy přesně nepasuje, NEPŘEVÁDÍ se odhadem:
// zapíše se do specialRequests, a poptávka tím jde k člověku (eskalace
// v evaluateStandardOffer). Agent tak nikdy nepošle standardní nabídku na
// něco, co zákazník nechtěl.
//
// Čisté funkce bez sítě a databáze; volá je route POST /api/web/poptavka.
import { z } from 'zod'
import { COMPANY } from '@/config'
import { evaluateStandardOffer, type OfferResult } from '@/core/standardOffer'
import { WEB_OTHER, webInquirySchema, webInquiryToOfferInquiry, type WebInquiry as AgentWebInquiry } from '@/core/webInquiry'
import type { FieldErrors, InquiryField, InquiryOutcome, WebInquiry as FormInquiry } from '@/lib/web/api'
import {
  CUSTOMER_KINDS, DIETS, DRINKS, EVENT_TYPES, EXTRAS, SERVICE_FORMATS, SERVICE_LEVELS,
  type EventType, type ServiceFormat,
} from '@/lib/web/options'
import { hasErrors, MESSAGES, validateInquiry } from '@/lib/web/validation'
import { WEB_CONSENT_VERSION } from './consent'
import { isIllustrativeMap } from './priceGuide'

// --- Tvar požadavku (server nevěří prohlížeči ani v typech) -------------------

const values = <T extends readonly { value: string }[]>(xs: T) =>
  xs.map((x) => x.value) as unknown as [T[number]['value'], ...T[number]['value'][]]

const text = (max: number) => z.string().max(max).nullable()
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable()

/** Zod schéma tvaru lib/web/api.ts#WebInquiry. Hodnoty číselníků z lib/web/options. */
export const formInquirySchema = z.object({
  eventType: z.enum(values(EVENT_TYPES)),
  customerKind: z.enum(values(CUSTOMER_KINDS)),
  segment: z.enum(['b2b', 'b2c']),
  company: z.object({ name: z.string().max(200), ico: text(20) }).nullable(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  timeFrom: hhmm,
  timeTo: hhmm,
  venue: z.object({ address: text(300), needsVenue: z.boolean(), venueSlug: z.string().regex(/^[a-z0-9-]{1,80}$/).nullable() }),
  guests: z.number().int().min(0).max(100_000),
  serviceFormat: z.enum(values(SERVICE_FORMATS)).nullable(),
  budgetPerPerson: z.number().int().min(0).max(1_000_000).nullable(),
  diets: z.array(z.enum(values(DIETS))).max(DIETS.length),
  dietNote: text(500),
  serviceLevel: z.enum(values(SERVICE_LEVELS)).nullable(),
  drinks: z.array(z.enum(values(DRINKS))).max(DRINKS.length),
  extras: z.array(z.enum(values(EXTRAS))).max(EXTRAS.length),
  note: text(2000),
  contact: z.object({ name: z.string().max(120), email: z.string().max(254), phone: text(40) }),
  consent: z.boolean(),
  source: z.object({
    channel: z.enum(['formular', 'chat', 'rychly-start']),
    page: z.string().max(200).regex(/^\//).nullable(),
    ref: z.string().regex(/^[a-z0-9-]{1,80}$/).nullable(),
  }),
}) satisfies z.ZodType<FormInquiry>

// --- Slovník webu → mapa firmy ---------------------------------------------

/**
 * Typ akce webu → typ akce mapy podle segmentu. null = mapa ho nezná
 * (WEB_OTHER → eskalace). Konzultace, „ještě nevím", teambuilding a vánoční
 * večírek řeší vždy člověk.
 */
const EVENT_TYPE_MAP: Readonly<Record<EventType, { b2b: string | null; b2c: string | null }>> = {
  firemni: { b2b: 'firemni_catering', b2c: null },
  snidane: { b2b: 'snidane', b2c: null },
  'coffee-break': { b2b: 'coffee_break', b2c: null },
  obed: { b2b: 'obed', b2c: null },
  vecere: { b2b: 'business_banket', b2c: null },
  'spolecenska-akce': { b2b: 'spolecenska_akce', b2c: null },
  teambuilding: { b2b: null, b2c: null },
  svatba: { b2b: null, b2c: 'svatba' },
  oslava: { b2b: null, b2c: 'oslava' },
  konzultace: { b2b: null, b2c: null },
  nevim: { b2b: null, b2c: null },
  'vanocni-vecirek': { b2b: null, b2c: null },
}

/** Formát obsluhy webu → balíčky mapy, které mu odpovídají (pořadí = přednost). */
const FORMAT_PACKAGES: Readonly<Record<ServiceFormat, readonly string[] | null>> = {
  bufet: ['snidane_bufet', 'obed_raut', 'oslava_raut'],
  raut: ['obed_raut', 'oslava_raut', 'svatebni_hostina'],
  banket: ['business_banket', 'sefkucharovo_menu', 'svatebni_hostina'],
  'sharing-table': [],
  'finger-food': ['koktejl'],
  'bbq-live-cooking': ['bbq_party'],
  'piknikovy-kos': ['piknikovy_kos'],
  // „Poraďte mi" = výchozí balíček typu akce.
  poradte: null,
}

/** Doplněk webu → doplněk mapy (null = mapa nezná → člověk). */
const EXTRA_MAP: Readonly<Record<string, string | null>> = {
  cheesecaky: 'cheesecake_dort',
  'mini-cheesecaky': null,
  'sladky-bar': null,
  'fresh-bar': null,
}

/** Nápoje, které jsou součástí balíčků mapy (ostatní řeší člověk). */
const DRINKS_IN_PACKAGES = new Set(['kava-caj', 'nealko', 'bez-napoju'])

const label = <T extends readonly { value: string; label: string }[]>(xs: T, v: string) =>
  xs.find((x) => x.value === v)?.label ?? v

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/**
 * Typ akce webu → klíč typu akce mapy (null = mapa ho nezná). Sdílí ho
 * převod poptávky i orientační ceník (domain/web/priceGuide.ts).
 */
export function mapEventTypeKey(webType: EventType, segment: 'b2b' | 'b2c', serviceFormat: ServiceFormat | null): string | null {
  // „Oslava a piknik" s piknikovým košem = piknik v mapě.
  if (webType === 'oslava' && serviceFormat === 'piknikovy-kos') return 'piknik'
  return EVENT_TYPE_MAP[webType][segment]
}

function mapEventType(f: FormInquiry, special: string[]): { eventType: string; packageKey: string | null } {
  const segmentKey = f.segment
  const eventType = mapEventTypeKey(f.eventType, segmentKey, f.serviceFormat)
  const map = COMPANY.capabilities.standardOffer?.priceMap
  const typeCfg = eventType
    ? map?.segments.find((s) => s.key === segmentKey)?.eventTypes.find((t) => t.key === eventType)
    : undefined
  if (!eventType || !typeCfg) {
    special.push(`Typ akce z webu: ${label(EVENT_TYPES, f.eventType)} (${f.customerKind === 'firma' || f.customerKind === 'agentura' ? 'firemní' : 'soukromá'}).`)
    return { eventType: WEB_OTHER, packageKey: null }
  }
  if (!f.serviceFormat || f.serviceFormat === 'poradte') return { eventType, packageKey: null }
  const candidates = FORMAT_PACKAGES[f.serviceFormat] ?? []
  const pkg = candidates.find((p) => (typeCfg.packages as readonly string[]).includes(p)) ?? null
  if (!pkg) special.push(`Požadovaný formát: ${label(SERVICE_FORMATS, f.serviceFormat)}.`)
  return { eventType, packageKey: pkg }
}

export type MappedInquiry = {
  inquiry: AgentWebInquiry
  /** Doplňující údaje z formuláře bez kontaktu (jdou do web_inquiry.inquiry.web_details). */
  webDetails: Record<string, unknown>
}

/**
 * Převod ověřeného formuláře na kontrakt agenta. `clientToken` dodá
 * prohlížeč (idempotence), `sourcePage` je cesta stránky, odkud poptávka přišla.
 */
export function toAgentInquiry(
  f: FormInquiry,
  clientToken: string,
): { ok: true; mapped: MappedInquiry } | { ok: false; fieldErrors: FieldErrors<InquiryField> } {
  const special: string[] = []
  const { eventType, packageKey } = mapEventType(f, special)

  if (f.customerKind === 'agentura') special.push('Poptává eventová agentura.')
  if (f.venue.needsVenue) special.push('Hledá prostor pro akci — poradit s výběrem.')
  if (f.venue.venueSlug) special.push(`Zájem o prostor: ${f.venue.venueSlug}.`)
  if (f.source.ref) special.push(`Inspirace referencí: ${f.source.ref}.`)

  if (f.serviceLevel === 'jen-dovoz' || f.serviceLevel === 'dovoz-a-priprava') {
    special.push(`Servis: ${label(SERVICE_LEVELS, f.serviceLevel)}.`)
  }

  const extras: string[] = []
  for (const e of f.extras) {
    const mapped = EXTRA_MAP[e] ?? null
    if (mapped) extras.push(mapped)
    else special.push(`Doplněk: ${label(EXTRAS, e)}.`)
  }
  const drinks = f.drinks.filter((d) => !DRINKS_IN_PACKAGES.has(d))
  if (drinks.length) special.push(`Nápoje: ${drinks.map((d) => label(DRINKS, d)).join(', ')}.`)

  // Diety bez počtu osob mapa spočítat neumí → člověk (počty doplní s klientem).
  if (f.diets.length) {
    special.push(`Diety: ${f.diets.map((d) => label(DIETS, d)).join(', ')}${f.dietNote?.trim() ? ` (${f.dietNote.trim()})` : ''}.`)
  }
  if (f.budgetPerPerson) special.push(`Rozpočet na osobu: ${f.budgetPerPerson} Kč.`)
  if (f.note?.trim()) special.push(`Poznámka: ${f.note.trim()}`)

  const durationHours = f.timeFrom && f.timeTo && minutes(f.timeTo) > minutes(f.timeFrom)
    ? Math.round(((minutes(f.timeTo) - minutes(f.timeFrom)) / 60) * 100) / 100
    : null

  const parsed = webInquirySchema.safeParse({
    clientToken,
    segment: f.segment,
    eventType,
    packageKey,
    eventDate: f.eventDate,
    startTime: f.timeFrom,
    durationHours,
    guests: f.guests > 0 ? f.guests : null,
    venue: f.venue.address,
    extras,
    dietary: [],
    specialRequests: special.length ? special.join('\n').slice(0, 2000) : null,
    customer: {
      name: f.contact.name,
      email: f.contact.email,
      phone: f.contact.phone,
      companyName: f.company?.name?.trim() || null,
      ico: f.company?.ico ?? null,
    },
    consent: { processing: true, marketing: false },
    sourcePage: f.source.page ?? '/poptavka',
  })
  if (!parsed.success) {
    // Přísnější pravidla kontraktu (např. tvar e-mailu) → chyba u pole formuláře.
    const fieldErrors: FieldErrors<InquiryField> = {}
    for (const issue of parsed.error.issues) {
      const field = ISSUE_FIELD[issue.path.join('.')] ?? 'contact.email'
      fieldErrors[field] ??= field === 'contact.email' ? MESSAGES.email : MESSAGES.required
    }
    return { ok: false, fieldErrors }
  }
  const inquiry = parsed.data

  const webDetails = {
    channel: f.source.channel,
    customer_kind: f.customerKind,
    web_event_type: f.eventType,
    service_format: f.serviceFormat,
    service_level: f.serviceLevel,
    drinks: f.drinks,
    web_extras: f.extras,
    diets: f.diets,
    budget_per_person: f.budgetPerPerson,
    time_to: f.timeTo,
    needs_venue: f.venue.needsVenue,
    venue_slug: f.venue.venueSlug,
    ref: f.source.ref,
  }
  return { ok: true, mapped: { inquiry, webDetails } }
}

/** Cesta chyby v kontraktu → pole formuláře. */
const ISSUE_FIELD: Readonly<Record<string, InquiryField>> = {
  'customer.name': 'contact.name',
  'customer.email': 'contact.email',
  'customer.phone': 'contact.phone',
  'customer.companyName': 'company.name',
  'customer.ico': 'company.ico',
  eventDate: 'eventDate',
  guests: 'guests',
  venue: 'venue.address',
}

/** Payload RPC web_inquiry_submit (kontrakt) + doplňky webu z migrace 0106. */
export function webInquiryRpcPayload(mapped: MappedInquiry, base: Record<string, unknown>): Record<string, unknown> {
  const inquiry = (base.inquiry ?? {}) as Record<string, unknown>
  return { ...base, inquiry: { ...inquiry, web_details: mapped.webDetails }, consent_version: WEB_CONSENT_VERSION }
}

// --- Kontrola formuláře na serveru -------------------------------------------

export type FormCheck =
  | { ok: true; form: FormInquiry }
  | { ok: false; fieldErrors: FieldErrors<InquiryField> }

/** Stejná pravidla jako formulář (lib/web/validation) + tvar ze zod. `today` v pásmu firmy. */
export function checkFormInquiry(raw: unknown, today: string): FormCheck | { ok: false; invalid: true } {
  const parsed = formInquirySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, invalid: true }
  const fieldErrors = validateInquiry(parsed.data, today)
  if (hasErrors(fieldErrors)) return { ok: false, fieldErrors }
  return { ok: true, form: parsed.data }
}

// --- Co zákazníkovi slíbit na potvrzovací stránce -----------------------------

/**
 * Výsledek pro text potvrzení. Rozhoduje stejný výpočet jako agent
 * (evaluateStandardOffer) — web nic neslibuje na vlastní pěst:
 *   konzultace    — zákazník chce konzultaci / ochutnávku
 *   na-miru       — poptávka jde k člověku (výjimka z mapy)
 *   ceka-na-cenik — standardní, ale samostatné odeslání ještě neběží
 *                   (mapa je ilustrační, nebo není zapnutý slib rychlé nabídky)
 *   standard      — standardní nabídka podle schválené mapy (do pár minut)
 * Vzdálenost místa akce web nezná (geokóduje agent), proto se počítá s nulou.
 */
export function predictOutcome(f: FormInquiry, mapped: MappedInquiry, today: string, opts: { instantOfferEnabled: boolean }): InquiryOutcome {
  if (f.eventType === 'konzultace') return 'konzultace'
  const cfg = COMPANY.capabilities.standardOffer
  if (!cfg) return 'na-miru'
  const result: OfferResult = evaluateStandardOffer(cfg, webInquiryToOfferInquiry(mapped.inquiry, { distanceKm: 0, vipContact: false }), today)
  if (result.kind === 'escalate') return 'na-miru'
  if (result.kind === 'needs_info') return 'na-miru'
  if (isIllustrativeMap(cfg.priceMap.version) || !opts.instantOfferEnabled) return 'ceka-na-cenik'
  return 'standard'
}
