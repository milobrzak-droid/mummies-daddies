// Prezentace hlavní metriky dopadu (0088) a formuláře „Předat práci":
// jen skutečná data (žádná vymyšlená nula), stav „zatím nelze měřit",
// výběr druhů práce s počty a zamčené druhy bez migrace.
import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EngagementImpactSummary } from '@/components/EngagementImpactSummary'
import { ImpactPrimaryMetric } from '@/components/ImpactPrimaryMetric'
import { MemberHandoverForm } from '@/components/MemberHandoverForm'
import { primaryImpact } from '@/domain/delivery/impactMetric'
import type { MetricObservation } from '@/domain/delivery/queries/impact'

vi.mock('@/domain/delivery/actions/impact', () => ({ recordPrimaryObservation: vi.fn(), saveImpactSettings: vi.fn() }))
vi.mock('@/lib/actions/team', () => ({ transferMemberWork: vi.fn() }))

// Značka <input …> s daným value (pořadí atributů v HTML není dané).
const inputFor = (html: string, value: string) => new RegExp(`<input[^>]*value="${value}"[^>]*/>`).exec(html)?.[0] ?? ''

const obs = (p: Partial<MetricObservation> & { id: number }): MetricObservation => ({
  engagement_id: 1, metric_key: 'cas_na_ukon', metric: 'Čas výdeje', unit: 'min', baseline: null, actual: null,
  observed_on: '2026-09-01', evidence_id: null, note: null, created_at: '2026-09-01T08:00:00Z', evidence_link: null, ...p,
})

describe('EngagementImpactSummary s hlavní metrikou', () => {
  test('chybí výchozí stav: výzva, žádná čísla ani „adopce"', () => {
    const p = primaryImpact({ kind: 'it' }, [obs({ id: 1, metric_key: 'adopce', metric: 'Opakované objednávky', unit: '%', baseline: 0 })])
    const html = renderToStaticMarkup(<EngagementImpactSummary observations={[]} state="ok" primary={p} tabHref="/x" />)
    expect(html).toContain('Chybí výchozí stav metriky „Čas výdeje“')
    expect(html).not.toContain('big-num')
  })

  test('jen výchozí stav: před s hodnotou, po „zatím nezměřeno", změna až po výsledku', () => {
    const p = primaryImpact({ kind: 'it' }, [obs({ id: 1, baseline: 18 })])
    const html = renderToStaticMarkup(<EngagementImpactSummary observations={[obs({ id: 1, baseline: 18 })]} state="ok" primary={p} />)
    expect(html).toContain('18<small')
    expect(html).toContain('zatím nezměřeno')
    expect(html).toContain('až po výsledku')
    expect(html).toContain('Výchozí stav 1. 9. 2026')
  })

  test('před i po: změna a zlepšení podle směru metriky', () => {
    const list = [obs({ id: 1, baseline: 18 }), obs({ id: 2, actual: 4, observed_on: '2026-09-20' })]
    const html = renderToStaticMarkup(<EngagementImpactSummary observations={list} state="ok" primary={primaryImpact({ kind: 'it' }, list)} />)
    expect(html).toContain('−77,8 %')
    expect(html).toContain('zlepšení')
  })

  test('zatím nelze měřit: důvod místo čísel', () => {
    const p = primaryImpact({ kind: 'it', impact_unmeasurable_reason: 'Klient dodá data v listopadu.' }, [])
    const html = renderToStaticMarkup(<EngagementImpactSummary observations={[]} state="ok" primary={p} />)
    expect(html).toContain('Zatím nelze měřit: Čas výdeje')
    expect(html).toContain('Klient dodá data v listopadu.')
  })
})

describe('ImpactPrimaryMetric', () => {
  test('metrika, původ (výchozí pro druh), zápis měření a volba metriky', () => {
    const p = primaryImpact({ kind: 'it' }, [])
    const html = renderToStaticMarkup(
      <ImpactPrimaryMetric accountId={1} engagementId={2} primary={p} kindLabel="Akce" defaultKey="cas_na_ukon"
        documents={[{ id: 5, title: 'Měření ERP' }]} today="2026-09-29" unmeasurableByName={null} />,
    )
    expect(html).toContain('Hlavní metrika dodávky')
    expect(html).toContain('výchozí pro druh „Akce“')
    expect(html).toContain('lepší je méně')
    expect(html).toContain('Hodnota (min)')
    expect(inputFor(html, 'baseline')).toContain('checked')
    expect(inputFor(html, 'actual')).not.toContain('checked')
    expect(html).toContain('Chybí výchozí stav')
    for (const label of ['Čas výdeje', 'Počet obsloužených hostů', 'Reklamace', 'Opakované objednávky', 'Úspora hodin', 'Vlastní metrika']) {
      expect(html).toContain(label)
    }
  })

  test('doložené „nelze měřit" ukáže kdo a kdy', () => {
    const p = primaryImpact({ kind: 'it', impact_unmeasurable_reason: 'Data z ERP až v listopadu.', impact_unmeasurable_at: '2026-09-29T10:00:00Z', impact_unmeasurable_by: 'u1' }, [])
    const html = renderToStaticMarkup(
      <ImpactPrimaryMetric accountId={1} engagementId={2} primary={p} kindLabel="Akce" defaultKey="cas_na_ukon"
        documents={[]} today="2026-09-29" unmeasurableByName="Lenka" />,
    )
    expect(html).toContain('Data z ERP až v listopadu.')
    expect(html).toContain('Doloženo · Lenka · 29. 9. 2026')
  })
})

describe('MemberHandoverForm', () => {
  test('druhy s počty, předvybrané jen neprázdné, bez migrace zamčené', () => {
    const html = renderToStaticMarkup(
      <MemberHandoverForm
        fromId="f" fromName="Petr"
        targets={[{ id: 't', name: 'Lenka', roleLabel: 'Vedení' }]}
        counts={{ klienti: 0, obchody: 2, seznamy: 1, dodavky: 1, milniky: 0, ukoly: 3, pripady: 0, alokace: 0, oblasti: 0 }}
        unavailable={['alokace']}
      />,
    )
    expect(html).toContain('Lenka · Vedení')
    expect(html).toContain('2 obchody')
    expect(inputFor(html, 'obchody')).toContain('checked')
    expect(inputFor(html, 'klienti')).not.toContain('checked')
    expect(html).toContain('1 seznam')
    expect(inputFor(html, 'seznamy')).toContain('checked')
    expect(inputFor(html, 'alokace')).toContain('disabled')
    expect(html).toContain('připravuje se')
    expect(html).not.toContain('migraci')
  })

  test('bez kandidátů klidná věta místo formuláře', () => {
    const html = renderToStaticMarkup(
      <MemberHandoverForm fromId="f" fromName="Petr" targets={[]} counts={{ klienti: 0, obchody: 0, seznamy: 0, dodavky: 0, milniky: 0, ukoly: 0, pripady: 0, alokace: 0, oblasti: 0 }} unavailable={[]} />,
    )
    expect(html).toContain('není nikdo další aktivní')
    expect(html).not.toContain('<form')
  })
})
