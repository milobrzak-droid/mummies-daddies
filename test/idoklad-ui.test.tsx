import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FinanceDiscrepancies } from '@/components/FinanceDiscrepancies'
import { FinanceRecordsTable } from '@/components/FinanceRecordsTable'
import { idokladNote } from '@/domain/finance/idokladStatus'
import type { DiscrepancyRow, IdokladStatus } from '@/domain/finance/queries/idoklad'
import type { FinancialRecordRow } from '@/domain/finance/records'

// Stránka Finance: „Rozdíly k vyřešení" z iDokladu, věta o stavu napojení
// a splatnost z iDokladu v tabulce záznamů.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }))
vi.mock('@/domain/finance/actions/idoklad', () => ({ applyDiscrepancy: vi.fn(), dismissDiscrepancy: vi.fn(), cancelRecordOfDiscrepancy: vi.fn() }))
vi.mock('@/domain/finance/actions/records', () => ({ createFinancialRecord: vi.fn(), updateFinancialRecord: vi.fn(), cancelFinancialRecord: vi.fn() }))

const row = (p: Partial<DiscrepancyRow>): DiscrepancyRow => ({
  id: 1, kind: 'amount_mismatch', reason: 'Faktura 20260001 má v iDokladu jinou částku nebo měnu než záznam v Cockpitu.',
  idoklad_kind: 'invoice', idoklad_id: 7, document_number: '20260001', account_id: 1, account_name: 'Alfa s.r.o.', record_id: 20,
  currency: 'CZK', idoklad_amount: 10000, record_amount: 9000, first_seen_at: '2026-09-29T04:00:00Z', last_seen_at: '2026-09-30T04:00:00Z', ...p,
})
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')
const render = (rows: DiscrepancyRow[]) => nbsp(renderToStaticMarkup(<FinanceDiscrepancies rows={rows} total={rows.length} accounts={[{ id: 1, name: 'Alfa s.r.o.' }, { id: 2, name: 'Beta a.s.' }]} />))

describe('Rozdíly k vyřešení', () => {
  test('karta říká, co je jinak: druh, číslo dokladu, firma, věta, částky obou stran', () => {
    const html = render([row({})])
    expect(html).toContain('Rozdíly k vyřešení')
    expect(html).toContain('Jiná částka')
    expect(html).toContain('20260001')
    expect(html).toContain('Alfa s.r.o.')
    expect(html).toContain('jinou částku nebo měnu')
    expect(html).toContain('iDoklad:')
    expect(html).toContain('10 000,00 Kč')
    expect(html).toContain('9 000,00 Kč')
    expect(html).toContain('Nic se do iDokladu nezapisuje')
  })

  test('jiná částka: „Převzít z iDokladu“ a „Označit jako vyřešené“, ne zakládání záznamu', () => {
    const html = render([row({})])
    expect(html).toContain('Převzít z iDokladu')
    expect(html).toContain('Označit jako vyřešené')
    expect(html).not.toContain('Založit záznam z faktury')
    expect(html).not.toContain('Zrušit záznam')
  })

  test('faktura bez záznamu: výběr firmy a „Založit záznam z faktury“; s cizím záznamem jen vyřešit', () => {
    const html = render([row({ id: 2, kind: 'invoice_without_record', record_id: null, account_id: null, account_name: null, record_amount: null })])
    expect(html).toContain('Založit záznam z faktury')
    expect(html).toContain('Firma, které faktura patří')
    expect(html).toContain('Beta a.s.')
    expect(html).not.toContain('Převzít z iDokladu')
    const other = render([row({ id: 3, kind: 'invoice_without_record', record_id: 20 })])
    expect(other).not.toContain('Založit záznam z faktury')
    expect(other).toContain('Označit jako vyřešené')
  })

  test('záznam bez faktury: zrušení záznamu; úhrada: jen vyřešit; každé tlačítko má popisek s dokladem', () => {
    const noInv = render([row({ id: 4, kind: 'record_without_invoice', idoklad_kind: null, idoklad_id: null, idoklad_amount: null })])
    expect(noInv).toContain('Zrušit záznam')
    expect(noInv).toContain('aria-label="Zrušit záznam — Záznam bez faktury 20260001"')
    const pay = render([row({ id: 5, kind: 'payment_mismatch', record_id: null })])
    expect(pay).toContain('Jiná úhrada')
    expect(pay).not.toContain('Převzít z iDokladu')
    expect(pay).not.toContain('Zrušit záznam')
    expect(pay).toContain('aria-label="Označit jako vyřešené: Jiná úhrada 20260001"')
  })

  test('nikdy součet přes rozdíly ani „celkem“; počet je jen odznak; ořez se přizná', () => {
    const html = renderToStaticMarkup(<FinanceDiscrepancies rows={[row({})]} total={7} accounts={[]} />)
    expect(html).not.toMatch(/celkem/i)
    expect(html).toContain('Zobrazeno 1 nejstarších z 7')
    expect(html).toContain('Otevřených: </span>7')
  })

  test('cizí měna se ukáže s kódem, ne jako koruny', () => {
    const html = render([row({ currency: 'USD', idoklad_amount: 100, record_amount: null })])
    expect(html).toContain('100 USD')
  })
})

describe('věta o stavu napojení', () => {
  const st = (p: Partial<IdokladStatus>): IdokladStatus => ({ enabled: true, missing: [], days: 90, lastSuccessAt: null, lastError: null, consecutiveErrors: 0, ...p })
  const now = new Date('2026-09-30T10:00:00Z')
  test('vypnuto: klidně, s odkazem na návod; žádné hodnoty', () => {
    const n = idokladNote(st({ enabled: false }), now)
    expect(n.tone).toBe('calm')
    expect(n.text).toMatch(/vypnuté/)
    expect(n.text).toMatch(/PROVOZ\.md/)
  })
  test('zapnuto bez tajemství: problém a názvy proměnných (ne hodnoty)', () => {
    const n = idokladNote(st({ missing: ['IDOKLAD_CLIENT_ID', 'IDOKLAD_CLIENT_SECRET'] }), now)
    expect(n.tone).toBe('problem')
    expect(n.text).toContain('IDOKLAD_CLIENT_ID a IDOKLAD_CLIENT_SECRET')
  })
  test('selhání, první běh a úspěch', () => {
    expect(idokladNote(st({ consecutiveErrors: 2, lastError: 'Tarif iDokladu API nedovoluje.' }), now)).toEqual({ tone: 'problem', text: 'Poslední načtení z iDokladu selhalo: Tarif iDokladu API nedovoluje.' })
    expect(idokladNote(st({}), now).text).toMatch(/první načtení proběhne/)
    const ok = idokladNote(st({ lastSuccessAt: '2026-09-30T04:00:00Z', days: 30 }), now)
    expect(ok.tone).toBe('calm')
    expect(ok.text).toMatch(/poslední načtení dnes/)
    expect(ok.text).toMatch(/30 dní/)
    expect(ok.text).toMatch(/Nic se do iDokladu nezapisuje/)
  })
})

describe('tabulka záznamů: splatnost a zdroj z iDokladu', () => {
  const rec = (p: Partial<FinancialRecordRow>): FinancialRecordRow & { account_name: string | null } => ({
    id: 1, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'invoiced', amount: 10000, currency: 'CZK',
    period_month: '2026-09-01', status: 'confirmed', source: 'idoklad', evidence_id: null, external_ref: '20260001', note: null,
    created_at: '2026-09-01T00:00:00Z', account_name: 'Alfa', idoklad_kind: 'invoice', idoklad_id: 7, idoklad_due_on: '2026-09-30', ...p,
  })
  test('u faktury z iDokladu je vidět zdroj i splatnost', () => {
    const html = renderToStaticMarkup(<FinanceRecordsTable rows={[rec({})]} kind={null} showDrafts accountingSystem="iDoklad" />)
    expect(html).toContain('iDoklad (automaticky)')
    // Jedna splatnost (0090 × 0092): sloupec Splatnost čte due_on, záložně idoklad_due_on.
    expect(nbsp(html)).toContain('30. 9. 2026')
  })
  test('ruční splatnost due_on má přednost před splatností z iDokladu', () => {
    const html = renderToStaticMarkup(<FinanceRecordsTable rows={[rec({ due_on: '2026-10-15' })]} kind={null} showDrafts accountingSystem="iDoklad" />)
    expect(nbsp(html)).toContain('15. 10. 2026')
    expect(nbsp(html)).not.toContain('30. 9. 2026')
  })
  test('ruční záznam bez splatnosti se nezmění', () => {
    const html = renderToStaticMarkup(<FinanceRecordsTable rows={[rec({ source: 'rucne', idoklad_due_on: null, idoklad_id: null, idoklad_kind: null })]} kind={null} showDrafts accountingSystem="iDoklad" />)
    expect(html).not.toContain('splatnost')
  })
})
