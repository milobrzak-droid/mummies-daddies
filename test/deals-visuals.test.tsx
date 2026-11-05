import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DealsSegmentedBar, DealsStageRing, DealsStageStrip, DealsValueHatch, moneyParts,
} from '@/components/DealsVisuals'
import { DealsOfferCard, scopeLines } from '@/components/DealsOfferCard'
import { DealsDetailTabs } from '@/components/DealsDetailTabs'
import type { ScopeVersionRow } from '@/domain/crm/scopeVersion'

// Grafické prvky sekce Obchody: každý graf má role="img" + popisek se
// stejnou informací jako vizuál, prázdný stav je klidná věta.

const version = (p: Partial<ScopeVersionRow>): ScopeVersionRow => ({
  id: 1, deal_id: 1, version: 1, scope: 'A', amount_one_time: 1000, expected_mrr: 0, currency: 'CZK',
  status: 'draft', sent_at: null, decided_at: null, evidence_id: null, created_by: null, created_at: '2026-09-01T08:00:00Z', ...p,
})

describe('moneyParts', () => {
  test('miliony jako 2,67 mil. Kč, menší částky celé v Kč', () => {
    expect(moneyParts(2_670_000)).toEqual({ num: '2,67', unit: 'mil. Kč' })
    expect(moneyParts(414_000).unit).toBe('Kč')
    expect(moneyParts(0)).toEqual({ num: '0', unit: 'Kč' })
  })
})

describe('DealsStageRing', () => {
  test('popisek shrnuje počty a částky po fázích', () => {
    const html = renderToStaticMarkup(
      <DealsStageRing slices={[
        { key: 'diagnostika', label: 'Upřesnění', count: 1, amount: 414_000 },
        { key: 'rozsah_nabidka', label: 'Nabídka odeslána', count: 2, amount: 1_000_000 },
      ]} />,
    )
    expect(html).toContain('role="img"')
    expect(html).toContain('Podle fází: 3 obchody')
    expect(html).toContain('Upřesnění 1')
  })
  test('bez obchodů: klidný popisek, žádný oblouk', () => {
    const html = renderToStaticMarkup(<DealsStageRing slices={[{ key: 'kvalifikace', label: 'Poptávka', count: 0, amount: 0 }]} />)
    expect(html).toContain('žádný otevřený obchod')
    expect(html).toContain('žádný obchod')
  })
})

describe('DealsStageStrip', () => {
  test('hotové, aktuální a další fáze v popisku', () => {
    const html = renderToStaticMarkup(<DealsStageStrip stage="rozsah_nabidka" />)
    expect(html).toContain('Poptávka hotovo')
    expect(html).toContain('Upřesnění hotovo')
    expect(html).toContain('Nabídka odeslána právě teď')
    expect(html).toContain('Zákazník rozhoduje další')
  })
  test('vyhráno = všechny hotové, prohráno = žádná neprobíhá', () => {
    expect(renderToStaticMarkup(<DealsStageStrip stage="vyhráno" />)).not.toContain('právě teď')
    expect(renderToStaticMarkup(<DealsStageStrip stage="prohráno" />)).toContain('neprobíhá')
  })
})

describe('DealsValueHatch', () => {
  test('prázdný stav bez fiktivních čísel', () => {
    expect(renderToStaticMarkup(<DealsValueHatch items={[]} />)).toContain('Zatím tu není žádný otevřený obchod s částkou.')
  })
  test('popisek nese hodnotu i šanci', () => {
    const html = renderToStaticMarkup(<DealsValueHatch items={[{ id: 1, label: 'ALFATECH', amount: 1_635_300, weighted: 817_650, probability: 50 }]} />)
    expect(html).toContain('ALFATECH')
    expect(html).toContain('šance 50 %')
  })
})

describe('DealsSegmentedBar', () => {
  test('prázdný seznam má popisek, ne prázdný pruh', () => {
    expect(renderToStaticMarkup(<DealsSegmentedBar parts={[{ label: 'Navrženo', value: 0, color: '#000' }]} />)).toContain('seznam je zatím prázdný')
  })
})

describe('nabídka: co je v nabídce', () => {
  test('scopeLines dělí po řádcích a odřezává odrážky', () => {
    expect(scopeLines('- Čtení e-mailů\n\n• Zápis do systému\r\nKontrola skladu')).toEqual(['Čtení e-mailů', 'Zápis do systému', 'Kontrola skladu'])
    expect(scopeLines(null)).toEqual([])
  })
  test('nový řádek oproti předchozí verzi je označený, cena ukazuje změnu', () => {
    const html = renderToStaticMarkup(
      <DealsOfferCard
        previous={version({ version: 1, scope: 'Čtení e-mailů', amount_one_time: 1000 })}
        latest={version({ id: 2, version: 2, scope: 'Čtení e-mailů\nKontrola skladu', amount_one_time: 1100 })}
      />,
    )
    expect(html).toContain('nové')
    expect(html).toContain('Verze v2')
    expect(html).toContain('10 % oproti v1')
  })
  test('bez verze: klidná věta', () => {
    expect(renderToStaticMarkup(<DealsOfferCard latest={null} previous={null} />)).toContain('Zatím žádná verze nabídky')
  })
})

describe('DealsDetailTabs', () => {
  test('aktivní záložka má aria-current', () => {
    const html = renderToStaticMarkup(<DealsDetailTabs base="/cockpit/clients/1/deals/2" active="nabidky" tabs={[{ key: 'prilezitost', label: 'Příležitost' }, { key: 'nabidky', label: 'Nabídky' }]} />)
    expect(html.match(/aria-current="page"/g)?.length).toBe(1)
    expect(html).toContain('/cockpit/clients/1/deals/2?tab=nabidky')
  })
})
