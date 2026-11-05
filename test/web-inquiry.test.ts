// Kontrakt webového formuláře poptávky (core/webInquiry.ts): ověření polí,
// payload pro RPC web_inquiry_submit a cesta do výpočtu z mapy BEZ modelu.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { evaluateStandardOffer } from '@/core/standardOffer'
import { WEB_OTHER, webInquiryPayload, webInquirySchema, webInquiryToOfferInquiry, type WebInquiryInput } from '@/core/webInquiry'

const OFFER = COMPANY.capabilities.standardOffer
const TODAY = '2026-11-10'

const base = (over: Partial<WebInquiryInput> = {}): WebInquiryInput => ({
  clientToken: '7d2b7a4e-2f7a-4a59-9a8e-3f1b6f1c2d3e',
  segment: 'b2b', eventType: 'coffee_break', eventDate: '2026-12-02', guests: 40, venue: 'Praha 2',
  specialRequests: null,
  customer: { name: '  Karel Ukázkový ', email: 'Karel@Alfa.Example', phone: '', companyName: 'Firma Alfa s.r.o.', ico: '123 45 678' },
  consent: { processing: true },
  ...over,
})

describe('webInquirySchema', () => {
  test('normalizuje kontakt a doplní výchozí hodnoty', () => {
    const w = webInquirySchema.parse(base())
    expect(w.customer).toEqual({ name: 'Karel Ukázkový', email: 'karel@alfa.example', phone: null, companyName: 'Firma Alfa s.r.o.', ico: '12345678' })
    expect(w).toMatchObject({ packageKey: null, startTime: null, durationHours: null, extras: [], dietary: [], sourcePage: '/' })
    expect(w.consent).toEqual({ processing: true, marketing: false })
  })

  test('bez souhlasu se zpracováním, s neplatným e-mailem nebo tokenem neprojde', () => {
    expect(webInquirySchema.safeParse(base({ consent: { processing: false as never } })).success).toBe(false)
    expect(webInquirySchema.safeParse(base({ customer: { ...base().customer, email: 'neni-email' } })).success).toBe(false)
    expect(webInquirySchema.safeParse(base({ clientToken: 'abc' })).success).toBe(false)
    expect(webInquirySchema.safeParse(base({ sourcePage: 'https://cizi.example' })).success).toBe(false)
  })

  test('payload pro RPC: kontakt zvlášť, pole akce v inquiry', () => {
    const p = webInquiryPayload(webInquirySchema.parse(base()))
    expect(p).toMatchObject({ client_token: base().clientToken, email: 'karel@alfa.example', segment: 'b2b', guests: 40 })
    expect(p.inquiry).toMatchObject({ event_type: 'coffee_break', venue: 'Praha 2', special_requests: null })
    expect(JSON.stringify(p.inquiry)).not.toContain('karel@alfa.example')
  })
})

describe('poptávka z webu → výpočet z mapy (bez modelu)', () => {
  const evaluate = (over: Partial<WebInquiryInput> = {}, extra: { distanceKm: number | null; vipContact: boolean } = { distanceKm: 5, vipContact: false }) =>
    evaluateStandardOffer(OFFER, webInquiryToOfferInquiry(webInquirySchema.parse(base(over)), extra), TODAY)

  test('standardní firemní coffee break spočítá nabídku z mapy firmy', () => {
    const r = evaluate()
    expect(r.kind).toBe('standard')
    if (r.kind !== 'standard') return
    expect(r.quote.mapVersion).toBe(OFFER.priceMap.version)
    expect(r.quote.guests).toBe(40)
    expect(r.quote.total).toBeGreaterThan(0)
  })

  test('zvláštní přání, neznámý typ akce a VIP vedou na eskalaci', () => {
    expect(evaluate({ specialRequests: 'Chceme ohňostroj' }).kind).toBe('escalate')
    expect(evaluate({ eventType: WEB_OTHER }).kind).toBe('escalate')
    expect(evaluate({}, { distanceKm: 5, vipContact: true }).kind).toBe('escalate')
  })

  test('chybí počet hostů nebo vzdálenost → doptat', () => {
    const r = evaluate({ guests: null }, { distanceKm: null, vipContact: false })
    expect(r).toMatchObject({ kind: 'needs_info' })
  })
})
