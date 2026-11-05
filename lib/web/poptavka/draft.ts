/**
 * Stav průvodce poptávkou (/poptavka) a jeho převod na WebInquiry z kontraktu
 * lib/web/api.ts. Kroky: typ akce → hosté → datum → místo → styl a dieta →
 * kontakt a segment → souhrn. Bez závislostí na serveru → bezpečné pro klienta.
 */
import type { InquiryField, InquirySource, WebInquiry } from '../api'
import {
  segmentOf,
  type CustomerKind, type Diet, type Drink, type EventType, type Extra, type ServiceFormat, type ServiceLevel,
} from '../options'

/** Formulářový stav: textová pole jako řetězce (tak, jak je uživatel píše). */
export interface InquiryDraft {
  eventType: EventType | null
  guests: string
  eventDate: string
  timeFrom: string
  timeTo: string
  address: string
  needsVenue: boolean
  venueSlug: string | null
  serviceFormat: ServiceFormat | null
  budget: string
  diets: Diet[]
  dietNote: string
  serviceLevel: ServiceLevel | null
  drinks: Drink[]
  extras: Extra[]
  customerKind: CustomerKind | null
  companyName: string
  companyIco: string
  name: string
  email: string
  phone: string
  note: string
  consent: boolean
  source: InquirySource
}

export const STEP_IDS = ['typ', 'hoste', 'datum', 'misto', 'styl', 'kontakt', 'souhrn'] as const
export type StepId = (typeof STEP_IDS)[number]

/** Která pole kontraktu patří ke kterému kroku (chyby ze serveru → správný krok). */
export const STEP_FIELDS: Record<StepId, InquiryField[]> = {
  typ: ['eventType'],
  hoste: ['guests'],
  datum: ['eventDate'],
  misto: ['venue.address'],
  styl: ['serviceFormat', 'budgetPerPerson'],
  kontakt: ['customerKind', 'company.name', 'company.ico', 'contact.name', 'contact.email', 'contact.phone'],
  souhrn: ['consent'],
}

/** id prvku, na který se při chybě přesune fokus. */
export const FIELD_DOM_ID: Record<InquiryField, string> = {
  eventType: 'pop-typ',
  guests: 'pop-osob',
  eventDate: 'pop-datum',
  'venue.address': 'pop-adresa',
  serviceFormat: 'pop-format',
  budgetPerPerson: 'pop-rozpocet',
  customerKind: 'pop-segment',
  'company.name': 'pop-firma',
  'company.ico': 'pop-ico',
  'contact.name': 'pop-jmeno',
  'contact.email': 'pop-email',
  'contact.phone': 'pop-telefon',
  consent: 'pop-souhlas',
}

export function stepOfField(field: string): StepId {
  for (const id of STEP_IDS) if ((STEP_FIELDS[id] as string[]).includes(field)) return id
  return 'souhrn'
}

/** Firma / agentura = B2B → zobrazí se název firmy a IČO. */
export function isBusiness(kind: CustomerKind | null): boolean {
  return !!kind && segmentOf(kind) === 'b2b'
}

export function emptyDraft(source: InquirySource = { channel: 'formular', page: null, ref: null }): InquiryDraft {
  return {
    eventType: null,
    guests: '',
    eventDate: '',
    timeFrom: '',
    timeTo: '',
    address: '',
    needsVenue: false,
    venueSlug: null,
    serviceFormat: null,
    budget: '',
    diets: [],
    dietNote: '',
    serviceLevel: null,
    drinks: [],
    extras: [],
    customerKind: null,
    companyName: '',
    companyIco: '',
    name: '',
    email: '',
    phone: '',
    note: '',
    consent: false,
    source,
  }
}

/** Předvyplnění z odkazu (parseInquiryParams) → stav průvodce. */
export function draftFromPrefill(p: Partial<WebInquiry>): InquiryDraft {
  const d = emptyDraft(p.source ?? undefined)
  if (p.eventType) d.eventType = p.eventType
  if (p.customerKind) d.customerKind = p.customerKind
  if (p.guests) d.guests = String(p.guests)
  if (p.eventDate) d.eventDate = p.eventDate
  if (p.extras?.length) d.extras = [...p.extras]
  if (p.venue?.venueSlug) d.venueSlug = p.venue.venueSlug
  return d
}

/** Kde průvodce začne: první z kroků typ → hosté → datum, který odkaz nevyplnil. */
export function initialStep(prefilled: readonly string[]): StepId {
  if (!prefilled.includes('eventType')) return 'typ'
  if (!prefilled.includes('guests')) return 'hoste'
  if (!prefilled.includes('eventDate')) return 'datum'
  return 'misto'
}

const toInt = (v: string): number | null => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) && v.trim() !== '' ? Math.floor(n) : null
}
const orNull = (v: string): string | null => (v.trim() ? v.trim() : null)

export function guestsOf(d: Pick<InquiryDraft, 'guests'>): number | null {
  const n = toInt(d.guests)
  return n && n > 0 ? n : null
}

/** Stav průvodce → WebInquiry pro submitInquiry (kontrakt lib/web/api.ts). */
export function toWebInquiry(d: InquiryDraft): WebInquiry {
  const customerKind = d.customerKind ?? 'soukrome'
  const business = isBusiness(customerKind)
  const budget = toInt(d.budget)
  return {
    eventType: d.eventType ?? 'nevim',
    customerKind,
    segment: segmentOf(customerKind),
    company: business && (d.companyName.trim() || d.companyIco.trim())
      ? { name: d.companyName.trim(), ico: orNull(d.companyIco.replace(/\s/g, '')) }
      : null,
    eventDate: orNull(d.eventDate),
    timeFrom: orNull(d.timeFrom),
    timeTo: orNull(d.timeTo),
    venue: { address: orNull(d.address), needsVenue: d.needsVenue, venueSlug: d.venueSlug },
    guests: guestsOf(d) ?? 0,
    serviceFormat: d.serviceFormat,
    budgetPerPerson: budget && budget > 0 ? budget : null,
    diets: [...d.diets],
    dietNote: orNull(d.dietNote),
    serviceLevel: d.serviceLevel,
    drinks: [...d.drinks],
    extras: [...d.extras],
    note: orNull(d.note),
    contact: { name: d.name.trim(), email: d.email.trim(), phone: orNull(d.phone) },
    consent: d.consent,
    source: d.source,
  }
}

/** Přepne hodnotu v poli (checkboxy diet, nápojů, doplňků). */
export function toggleValue<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}
