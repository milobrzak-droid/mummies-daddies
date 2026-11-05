import { PDFDocument } from 'pdf-lib'
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { evaluateStandardOffer, type OfferQuote } from '@/core/standardOffer'
import {
  czDay, formatMoney, offerDisclaimer, offerDocumentFromQuote, offerFooterText, offerPdfFileName, renderOfferDocumentPdf,
  renderOfferPdf, unitLabel,
} from '@/core/offerPdf'
import { canPrintScopeVersion, offerDocumentFromScopeVersion, type ScopeVersionForPdf } from '@/domain/crm/offerPdfSource'
import { A4_PORTRAIT } from '@/lib/export/pdfKit'
import { FIXTURE_OFFER } from './helpers/priceMapFixture'

// core/offerPdf.ts: PDF nabídky pro zákazníka nad OfferQuote (agent ho může
// přiložit k e-mailu) a nad verzí nabídky obchodu (domain/crm/offerPdfSource.ts).

function quote(): OfferQuote {
  const r = evaluateStandardOffer(FIXTURE_OFFER, {
    segment: 'b2b', eventType: 'raut', eventDate: '2026-12-12', guests: 80, distanceKm: 32,
    extras: [], dietary: [],
  }, '2026-11-05')
  const q = r.kind === 'standard' ? r.quote : r.kind === 'escalate' ? r.draft : null
  if (!q) throw new Error(`fixture nabídky nejde spočítat: ${JSON.stringify(r)}`)
  return q
}

describe('dokument nabídky z OfferQuote', () => {
  test('položky, součty a platnost přesně z nabídky (nic se nepřepočítává)', () => {
    const q = quote()
    const d = offerDocumentFromQuote(q, { customerName: 'Účetní kancelář Šťastná s.r.o.' })
    expect(d.lines.map((l) => l.total)).toEqual(q.lines.map((l) => l.total))
    expect(d.subtotal).toBe(q.subtotal)
    expect(d.vat).toBe(q.vat)
    expect(d.total).toBe(q.total)
    expect(d.vatRate).toBe(0.12)
    expect(d.validUntil).toBe(q.validUntil)
    expect(d.includes).toEqual(q.package.includes)
    expect(d.subtitle).toBe(`${q.eventTypeLabel} · 12. 12. 2026 · 80 hostů`)
    expect(d.customer.name).toBe('Účetní kancelář Šťastná s.r.o.')
  })

  test('texty: částky, data, jednotky, upozornění „nezávazná kalkulace"', () => {
    expect(formatMoney(108360, 'CZK')).toBe('108 360 Kč')
    expect(formatMoney(3500.5, 'EUR')).toBe('3 500,5 EUR')
    expect(czDay('2026-12-02')).toBe('2. 12. 2026')
    expect([1, 3, 80].map((n) => unitLabel('host', n))).toEqual(['host', 'hosté', 'hostů'])
    expect(unitLabel('km', 34)).toBe('km')
    expect(offerDisclaimer(COMPANY.name)).toBe('Nezávazná kalkulace, smlouva vzniká až písemným potvrzením Mummies and Daddies.')
    expect(offerPdfFileName({ eventDate: '2026-12-12', issuedAt: '2026-11-05' }, '12-v2')).toBe('nabidka-2026-12-12-12-v2.pdf')
  })

  test('údaje firmy v hlavičce a patičce z konfigurace', () => {
    const legal = COMPANY.legalEntity!
    expect(legal).toMatchObject({ name: 'Mummies and Daddies s.r.o.', street: 'Varšavská 715', ico: '17957524', dic: 'CZ17957524' })
    expect(legal.city).toMatch(/Praha 2$/)
    expect(offerFooterText(COMPANY.name, legal)).toBe('Mummies and Daddies s.r.o. · IČO 17957524 · info@mummiesdaddies.com · +420 737 818 694')
    expect(offerFooterText('Firma', null)).toBe('Firma')
  })

  test('renderOfferPdf: jedna stránka A4 na výšku s metadaty', async () => {
    const pdf = await PDFDocument.load(await renderOfferPdf(quote(), { customerName: 'Účetní kancelář Šťastná s.r.o.' }))
    expect(pdf.getPageCount()).toBe(1)
    expect(Object.values(pdf.getPage(0).getSize())).toEqual(A4_PORTRAIT)
    expect(pdf.getTitle()).toBe('Nabídka cateringu — Mummies and Daddies')
    expect(pdf.getAuthor()).toBe('Mummies and Daddies s.r.o.')
  })

  test('hodně položek se zalomí na další stránku', async () => {
    const d = offerDocumentFromQuote(quote())
    const many = { ...d, lines: Array.from({ length: 60 }, (_, i) => ({ ...d.lines[0], label: `Položka ${i} — šťavnaté jídlo` })) }
    const pdf = await PDFDocument.load(await renderOfferDocumentPdf(many, { legal: null, signature: null }))
    expect(pdf.getPageCount()).toBeGreaterThan(1)
  })
})

describe('dokument nabídky z verze nabídky obchodu', () => {
  const version: ScopeVersionForPdf = {
    id: 55, deal_id: 12, version: 2, scope: 'Svatební hostina pro 120 hostů, obsluha a inventář.',
    amount_one_time: '245500.00', expected_mrr: '0', currency: 'CZK', status: 'sent',
    sent_at: '2026-11-03T09:00:00Z', created_at: '2026-11-02T09:00:00Z',
    deal: { id: 12, title: 'Svatební hostina Novákovi', account: { id: 3, name: 'Kateřina Nováková' }, primary_contact: { id: 9, full_name: 'Kateřina Nováková' } },
  }

  test('částka bez DPH, DPH sazbou mapy, platnost od odeslání', () => {
    const d = offerDocumentFromScopeVersion(version, { today: '2026-11-05', vatRate: 0.12, validityDays: 14 })
    expect(d.subtotal).toBe(245500)
    expect(d.vat).toBe(29460)
    expect(d.total).toBe(274960)
    expect(d.issuedAt).toBe('2026-11-03')
    expect(d.validUntil).toBe('2026-11-17')
    expect(d.reference).toBe('12-2')
    expect(d.customer).toEqual({ name: 'Kateřina Nováková', contact: null }) // stejný člověk se netiskne dvakrát
    expect(d.lines).toHaveLength(1)
    expect(d.scopeText).toBe(version.scope)
  })

  test('měsíční částka jde do popisu, ne do součtu; koncept má platnost od dneška', () => {
    const d = offerDocumentFromScopeVersion({ ...version, status: 'draft', sent_at: null, expected_mrr: 12000 }, { today: '2026-11-05', vatRate: 0.12, validityDays: 14 })
    expect(d.issuedAt).toBe('2026-11-05')
    expect(d.subtotal).toBe(245500)
    expect(d.scopeText).toContain('Pravidelná dodávka: 12 000 Kč měsíčně bez DPH')
  })

  test('nahrazenou a odmítnutou verzi zákazníkovi netiskneme', () => {
    expect(['draft', 'sent', 'accepted', 'rejected', 'superseded'].filter((s) => canPrintScopeVersion({ status: s as never })))
      .toEqual(['draft', 'sent', 'accepted'])
  })
})
