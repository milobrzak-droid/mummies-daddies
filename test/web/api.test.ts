import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWebApiFake } from '../helpers/webApiFake'
import { estimatePrice, submitInquiry, submitOrder, type CheesecakeOrder, type WebInquiry } from '@/lib/web/api'
import { emptyInquiry, inquiryHref, parseInquiryParams } from '@/lib/web/inquiry-link'
import { isoDate } from '@/lib/web/format'
import { computeOrderTotals, earliestOrderDate, validateInquiry } from '@/lib/web/validation'

const valid = (patch: Partial<WebInquiry> = {}): WebInquiry => ({
  ...emptyInquiry(),
  eventType: 'firemni',
  customerKind: 'firma',
  segment: 'b2b',
  eventDate: isoDate(30),
  guests: 20,
  contact: { name: 'Jan Novák', email: 'jan@firma-alfa.cz', phone: '+420 737 000 000' },
  consent: true,
  ...patch,
})

// Napojení na systém (P6): fetch jde do serverových funkcí se Supabase mockem.
beforeEach(() => { installWebApiFake() })
afterEach(() => { vi.unstubAllGlobals() })

describe('api – poptávka', () => {
  it('validace: povinná pole, minimum osob, souhlas, IČO', () => {
    const e = validateInquiry({ ...emptyInquiry(), eventType: 'coffee-break', guests: 5, company: { name: 'Firma Alfa', ico: '123' } })
    expect(e.guests).toContain('od 15 osob')
    expect(e['contact.email']).toBeDefined()
    expect(e.consent).toBeDefined()
    expect(e['company.ico']).toBe('IČO má 8 číslic. Zkontrolujte ho, prosím.')
    expect(validateInquiry({ ...valid(), eventDate: '2000-01-01' }).eventDate).toContain('proběhlo')
  })

  it('submitInquiry vrací outcome podle pravidel (mapa zatím neschválená)', async () => {
    const std = await submitInquiry(valid())
    expect(std).toMatchObject({ ok: true, outcome: 'ceka-na-cenik' })
    if (std.ok) expect(std.estimate).toMatchObject({ od: 300, do: 2000, total: { od: 6000, do: 40000 }, basis: 'obvykle-rozpeti' })
    expect(await submitInquiry(valid({ customerKind: 'agentura' }))).toMatchObject({ ok: true, outcome: 'na-miru' })
    expect(await submitInquiry(valid({ eventType: 'konzultace', guests: 0 }))).toMatchObject({ ok: true, outcome: 'konzultace', estimate: null })
    expect(await submitInquiry(valid({ consent: false }))).toMatchObject({ ok: false, reason: 'validation' })
  })

  it('estimatePrice: null pro konzultaci a „ještě nevím“', async () => {
    expect(await estimatePrice({ eventType: 'nevim' })).toBeNull()
    expect(await estimatePrice({ eventType: 'svatba' })).toMatchObject({ od: 300, do: 2000, total: null, binding: false })
  })
})

describe('odkazy na poptávku', () => {
  it('inquiryHref ↔ parseInquiryParams', () => {
    const href = inquiryHref({ typ: 'svatba', osob: 80, zdroj: '/catering/svatby', doplnek: ['cheesecaky', 'sladky-bar'] })
    const parsed = parseInquiryParams(new URLSearchParams(href.split('?')[1]))
    expect(parsed).toMatchObject({ eventType: 'svatba', guests: 80, extras: ['cheesecaky', 'sladky-bar'], source: { page: '/catering/svatby' } })
    expect(parsed.prefilled).toEqual(['eventType', 'guests', 'extras'])
  })

  it('neznámé hodnoty zahodí', () => {
    const p = parseInquiryParams({ typ: 'hack', osob: '-5', segment: 'firma', zdroj: 'javascript:x' })
    expect(p.eventType).toBeUndefined()
    expect(p.guests).toBeUndefined()
    expect(p.customerKind).toBe('firma')
    expect(p.segment).toBe('b2b')
    expect(p.source?.page).toBeNull()
  })
})

describe('api – objednávka cheesecaků', () => {
  const order = (patch: Partial<CheesecakeOrder> = {}): CheesecakeOrder => ({
    items: [{ slug: 'daddy-vanilkovy', quantity: 2, inscription: 'Všechno nejlepší' }, { slug: 'mini-cheesecaky-10-ks', quantity: 1, miniFlavors: Array(10).fill('jahoda') }],
    fulfillment: { method: 'praha', address: 'Ulice 1, Praha', date: earliestOrderDate(), note: null },
    customer: { name: 'Jana Nováková', email: 'jana@example.cz', phone: '+420 737 000 000' },
    company: null,
    payment: 'prevod',
    note: null,
    consent: true,
    ...patch,
  })

  it('přepočítá cenu a vrátí instrukce k převodu', async () => {
    expect(computeOrderTotals(order().items, 'praha')).toEqual({ subtotal: 2 * 790 + 575, delivery: 300, total: 2 * 790 + 575 + 300 })
    const r = await submitOrder(order())
    expect(r.ok).toBe(true)
    if (r.ok && r.payment.method === 'prevod') expect(r.payment.amount).toBe(2455)
  })

  it('odmítne dlouhý nápis, neúplné mini a dnešní termín', async () => {
    const r = await submitOrder(order({
      items: [{ slug: 'daddy-vanilkovy', quantity: 1, inscription: 'x'.repeat(26) }, { slug: 'mini-cheesecaky-10-ks', quantity: 1, miniFlavors: ['jahoda'] }],
      fulfillment: { method: 'praha', address: 'x', date: isoDate(0), note: null },
    }))
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'validation') {
      expect(r.fieldErrors['items.0.inscription']).toBe('Nápis může mít nejvýš 25 znaků.')
      expect(r.fieldErrors['items.1.miniFlavors']).toBeDefined()
      expect(r.fieldErrors['fulfillment.date']).toContain('nestihneme')
    }
  })
})
