/**
 * Kontextové odkazy na poptávku (strategy.conversion: „Všechna CTA nesou
 * kontext“). Stavba odkazu i čtení parametrů na /poptavka na jednom místě.
 *
 *   inquiryHref({ typ: 'svatba', osob: 80, zdroj: '/catering/svatby' })
 *     → "/poptavka?typ=svatba&osob=80&zdroj=%2Fcatering%2Fsvatby"
 *   parseInquiryParams(await searchParams) → Partial<WebInquiry> pro předvyplnění
 *
 * Parametry: typ, segment (firma|soukrome|agentura), osob, datum (YYYY-MM-DD),
 * zdroj, vzor (slug reference), prostor (slug prostoru), doplnek (lze opakovat
 * nebo oddělit čárkou). Bez závislostí → bezpečné pro klienta.
 */
import type { WebInquiry } from './api'
import { CUSTOMER_KINDS, EVENT_TYPES, EXTRAS, segmentOf, type CustomerKind, type EventType, type Extra } from './options'

export const INQUIRY_PATH = '/poptavka'

export interface InquiryLinkParams {
  typ?: EventType
  segment?: CustomerKind
  osob?: number
  datum?: string
  zdroj?: string
  vzor?: string
  prostor?: string
  doplnek?: Extra | Extra[]
}

export function inquiryHref(p: InquiryLinkParams = {}): string {
  const q = new URLSearchParams()
  if (p.typ) q.set('typ', p.typ)
  if (p.segment) q.set('segment', p.segment)
  if (p.osob && p.osob > 0) q.set('osob', String(Math.floor(p.osob)))
  if (p.datum) q.set('datum', p.datum)
  if (p.zdroj) q.set('zdroj', p.zdroj)
  if (p.vzor) q.set('vzor', p.vzor)
  if (p.prostor) q.set('prostor', p.prostor)
  for (const d of ([] as Extra[]).concat(p.doplnek ?? [])) q.append('doplnek', d)
  const s = q.toString()
  return s ? `${INQUIRY_PATH}?${s}` : INQUIRY_PATH
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>

function all(params: Params, key: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(key)
  const v = params[key]
  return v === undefined ? [] : Array.isArray(v) ? v : [v]
}

const SLUG = /^[a-z0-9-]{1,80}$/

/** Bezpečně přečte parametry (neznámé hodnoty zahodí). Vrací jen to, co v URL bylo. */
export function parseInquiryParams(params: Params): Partial<WebInquiry> & { prefilled: (keyof WebInquiry)[] } {
  const out: Partial<WebInquiry> = {}
  const prefilled: (keyof WebInquiry)[] = []
  const typ = all(params, 'typ')[0]
  if (typ && EVENT_TYPES.some((e) => e.value === typ)) {
    out.eventType = typ as EventType
    prefilled.push('eventType')
  }
  const seg = all(params, 'segment')[0]
  if (seg && CUSTOMER_KINDS.some((k) => k.value === seg)) {
    out.customerKind = seg as CustomerKind
    out.segment = segmentOf(seg as CustomerKind)
    prefilled.push('customerKind')
  }
  const osob = Number(all(params, 'osob')[0])
  if (Number.isFinite(osob) && osob >= 1 && osob <= 5000) {
    out.guests = Math.floor(osob)
    prefilled.push('guests')
  }
  const datum = all(params, 'datum')[0]
  if (datum && /^\d{4}-\d{2}-\d{2}$/.test(datum)) {
    out.eventDate = datum
    prefilled.push('eventDate')
  }
  const extras = all(params, 'doplnek').flatMap((v) => v.split(',')).filter((v): v is Extra => EXTRAS.some((e) => e.value === v))
  if (extras.length) {
    out.extras = [...new Set(extras)]
    prefilled.push('extras')
  }
  const prostor = all(params, 'prostor')[0]
  if (prostor && SLUG.test(prostor)) {
    out.venue = { address: null, needsVenue: false, venueSlug: prostor }
    prefilled.push('venue')
  }
  const zdroj = all(params, 'zdroj')[0]
  const vzor = all(params, 'vzor')[0]
  out.source = {
    channel: 'formular',
    page: zdroj && /^\/[a-z0-9/-]*$/.test(zdroj) ? zdroj : null,
    ref: vzor && SLUG.test(vzor) ? vzor : prostor && SLUG.test(prostor) ? `prostor:${prostor}` : null,
  }
  return { ...out, prefilled }
}

/** Prázdná poptávka s výchozími hodnotami (základ stavu formuláře). */
export function emptyInquiry(channel: WebInquiry['source']['channel'] = 'formular'): WebInquiry {
  return {
    eventType: 'nevim',
    customerKind: 'soukrome',
    segment: 'b2c',
    company: null,
    eventDate: null,
    timeFrom: null,
    timeTo: null,
    venue: { address: null, needsVenue: false, venueSlug: null },
    guests: 0,
    serviceFormat: null,
    budgetPerPerson: null,
    diets: [],
    dietNote: null,
    serviceLevel: null,
    drinks: [],
    extras: [],
    note: null,
    contact: { name: '', email: '', phone: null },
    consent: false,
    source: { channel, page: null, ref: null },
  }
}
