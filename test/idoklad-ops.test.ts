import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { buildOpsReport, financeDiffItems, opsReportItemCount, type OpsFinanceDiff } from '@/domain/crm/opsReport'
import { renderOpsReportEmail } from '@/domain/crm/opsReportEmail'
import { OpsKeys, OpsSectionCard } from '@/components/ui/OpsReport'
import { opsInput, opsReport, TODAY } from './helpers/opsReportFixture'

// Provozní přehled: sekce „Rozdíly v financích“ z iDokladu. Jen s napojením,
// jen obchodní role, nikdy částky; e-mail nese jen počet.

const diff = (o: Partial<OpsFinanceDiff> = {}): OpsFinanceDiff => ({
  id: 1, kind: 'amount_mismatch', document_number: '20260001', account_name: 'Alfa s.r.o.', first_seen_at: '2026-09-25T04:00:00Z', ...o,
})
const ok = (items: OpsFinanceDiff[], total = items.length) => ({ state: 'ok' as const, items, total })
const sec = (r: ReturnType<typeof opsReport>) => r.sections.find((s) => s.key === 'finance-rozdily')

describe('sekce Rozdíly v financích', () => {
  test('bez napojení na iDoklad se sekce neukáže vůbec (přehled je beze změny)', () => {
    expect(sec(opsReport())).toBeUndefined()
    expect(sec(opsReport({ financeDiffs: undefined }))).toBeUndefined()
  })

  test('s napojením: položky s odkazem na Finance, druhem rozdílu, číslem dokladu a firmou', () => {
    const r = opsReport({ financeDiffs: ok([diff(), diff({ id: 2, kind: 'record_without_invoice', document_number: null, account_name: null })]) })
    const s = sec(r)!
    expect(s.total).toBe(2)
    expect(s.items[0]).toMatchObject({ title: 'Alfa s.r.o. · 20260001', href: '/cockpit/finance#rozdily', tone: 'warn' })
    expect(s.items[0].detail).toBe('Jiná částka · čeká 10 dní')
    expect(s.items[0].proof).toMatch(/^Rozdíl z iDokladu č\. 1, nalezen /)
    expect(s.items[1].title).toBe('Firma neurčena · záznam bez čísla dokladu')
    expect(r.headline).toContain('Finance: 2')
    expect(r.attention).toBeGreaterThan(opsReport().attention)
    expect(r.isEmpty).toBe(false)
  })

  test('nejstarší rozdíl první; čerstvý je jen informace', () => {
    const items = financeDiffItems([diff({ id: 9, first_seen_at: '2026-10-04T04:00:00Z' }), diff({ id: 3, first_seen_at: '2026-09-01T04:00:00Z' })], TODAY)
    expect(items.map((i) => i.key)).toEqual(['finance-3', 'finance-9'])
    expect(items.map((i) => i.tone)).toEqual(['warn', 'info'])
  })

  test('bez rozdílů: klidná sekce, přehled zůstává prázdný', () => {
    const base = opsReport({ financeDiffs: ok([]) })
    expect(sec(base)).toMatchObject({ total: 0, items: [], unavailable: [] })
    expect(base.attention).toBe(opsReport().attention)
  })

  test('nenačtené rozdíly přizná (ne „0“) a přehled to hlásí', () => {
    const r = opsReport({ financeDiffs: { state: 'error' } })
    expect(sec(r)).toMatchObject({ total: 0, unavailable: ['rozdíly z iDokladu'] })
    expect(r.unavailable).toContain('rozdíly z iDokladu')
  })

  test('bez oprávnění k obchodu se sekce nikdy neukáže, ani když ji volající předá', () => {
    const r = buildOpsReport(opsInput({ canSeeSales: false, financeDiffs: ok([diff()]) }))
    expect(r.sections.find((s) => s.key === 'finance-rozdily')).toBeUndefined()
  })

  test('položky ani sekce nenesou částku ani volný text důvodu', () => {
    const r = opsReport({ financeDiffs: ok([diff(), diff({ id: 2, kind: 'payment_mismatch' })]) })
    const json = JSON.stringify(sec(r))
    expect(json).not.toMatch(/Kč|CZK|EUR|\d[  ]?\d{3}[,.]\d{2}/)
    expect(opsReportItemCount(r)).toBe(opsReportItemCount(opsReport()) + 2)
  })
})

describe('e-mail: rozdíly z iDokladu jen jako počet', () => {
  const email = (r = opsReport({ financeDiffs: ok([diff({ document_number: 'TAJNE-CISLO-77', account_name: 'Tajná firma' }), diff({ id: 2 })]) })) =>
    renderOpsReportEmail(r, { appUrl: 'https://cockpit.example.cz', generatedAtLabel: 'pondělí 5. 10. 2026' })

  test('nadpis sekce a věta s počtem; číslo dokladu ani firma v e-mailu nejsou', () => {
    const { html, text } = email()
    expect(html).toContain('>Rozdíly v financích (2)<')
    expect(html).toContain('2 rozdíly čekají na vyřešení — detail jen v Cockpitu')
    expect(text).toContain('## Rozdíly v financích (2)')
    expect(html + text).not.toMatch(/TAJNE-CISLO-77|Tajná firma|20260001/)
  })

  test('bez rozdílů je sekce mezi „Bez položek“, bez napojení se v e-mailu neobjeví', () => {
    expect(email(opsReport({ financeDiffs: ok([]) })).html).toContain('Rozdíly v financích')
    expect(email(opsReport()).html).not.toContain('Rozdíly v financích')
  })
})

describe('stránka Týden: klávesy a karta', () => {
  test('osm sekcí = čtyři sloupce; nová dlaždice má vlastní odkaz na kartu sekce', () => {
    const r = opsReport({ financeDiffs: ok([diff()]) })
    const html = renderToStaticMarkup(createElement(OpsKeys, { report: r }))
    expect(html).toContain('xl:grid-cols-4')
    expect(html).toContain('href="#finance-rozdily"')
    expect(html).toContain('aria-label="Rozdíly v financích: 1"')
    expect(renderToStaticMarkup(createElement(OpsKeys, { report: opsReport() }))).toContain('xl:grid-cols-7')
  })

  test('karta sekce vede na Finance', () => {
    const s = sec(opsReport({ financeDiffs: ok([diff()]) }))!
    const html = renderToStaticMarkup(createElement(OpsSectionCard, { section: s }))
    expect(html).toContain('href="/cockpit/finance#rozdily"')
    expect(html).toContain('Alfa s.r.o. · 20260001')
  })
})
