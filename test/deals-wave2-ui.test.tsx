import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DealsFilterBar, dealsFilterHref } from '@/components/DealsFilterBar'
import { DEALS_SECTION_TABS, isDealsTabActive } from '@/components/DealsSectionTabs'
import { DealsKpis } from '@/components/DealsKpis'
import { DealsNextStep, DealsNextStepButton } from '@/components/DealsNextStep'
import { DealsOwnerCard } from '@/components/DealsOwnerCard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => '/cockpit/pipeline' }))

// Vlna 2 designu, sekce Obchody: souhrn jako na Dnes, filtry v jednom řádku,
// Reporty ve vlastní záložce. Brána „jen obchodní role“ se nemění.

const root = join(__dirname, '..')
const src = (p: string) => readFileSync(join(root, p), 'utf8')

describe('Obchody – souhrn nahoře', () => {
  test('tři klidná čísla, pruh jen u „S pravděpodobností“', () => {
    const html = renderToStaticMarkup(<DealsKpis open={2_670_000} weighted={1_335_000} won={0} openCount={3} monthLabel="září 2026" />)
    expect(html).toContain('Otevřené obchody')
    expect(html).toContain('S pravděpodobností')
    expect(html).toContain('Vyhráno tento měsíc')
    expect(html).toContain('2,67')
    expect(html).toContain('</span> obchody · součet hodnot')
    expect(html).toContain('50 % otevřené hodnoty')
    expect(html).toContain('září 2026 · zatím nic uzavřeno')
    expect(html.match(/class="bar /g)?.length).toBe(1)
  })
  test('bez otevřených obchodů je podíl nula, ne NaN', () => {
    const html = renderToStaticMarkup(<DealsKpis open={0} weighted={0} won={0} openCount={0} monthLabel="září 2026" />)
    expect(html).toContain('0 % otevřené hodnoty')
    expect(html).not.toContain('NaN')
  })
})

describe('Obchody – filtry v jednom řádku', () => {
  test('segment stavu zachová hledání, obchodníka i typ; výchozí hodnoty do adresy nepíše', () => {
    expect(dealsFilterHref({ q: '', owner: 'all', state: 'open', kind: 'all' })).toBe('/cockpit/pipeline')
    expect(dealsFilterHref({ q: 'alfatech', owner: 'u1', state: 'vyhráno', kind: 'workshop' }))
      .toBe('/cockpit/pipeline?q=alfatech&owner=u1&state=vyhr%C3%A1no&kind=workshop')
  })
  test('aktivní segment má aria-current, hledání je GET formulář s role=search', () => {
    const html = renderToStaticMarkup(
      <DealsFilterBar values={{ q: 'kone', owner: 'all', state: 'prohráno', kind: 'all' }} owners={[{ id: 'u1', full_name: 'Viktor Kovář' }]} />,
    )
    expect(html.match(/aria-current="page"/g)?.length).toBe(1)
    expect(html).toMatch(/aria-current="page"[^>]*>Prohrané</)
    expect(html).toContain('role="search"')
    expect(html).toContain('name="state" value="prohráno"')
    expect(html).toContain('Viktor Kovář')
  })
})

describe('Obchody – záložky', () => {
  test('Reporty jsou vlastní záložka; Tabule na reportech aktivní není', () => {
    expect(DEALS_SECTION_TABS.map((t) => t.label)).toEqual(['Tabule', 'Reporty', 'Agent', 'Seznamy k oslovení', 'Oslovování'])
    expect(isDealsTabActive('/cockpit/pipeline', '/cockpit/pipeline')).toBe(true)
    expect(isDealsTabActive('/cockpit/pipeline/new', '/cockpit/pipeline')).toBe(true)
    expect(isDealsTabActive('/cockpit/pipeline/reporty', '/cockpit/pipeline')).toBe(false)
    expect(isDealsTabActive('/cockpit/pipeline/reporty', '/cockpit/pipeline/reporty')).toBe(true)
    expect(isDealsTabActive('/cockpit/cilove-seznamy/4', '/cockpit/cilove-seznamy')).toBe(true)
  })
})

describe('Obchody – brána jen pro obchodní role beze změny', () => {
  test.each([
    'app/cockpit/pipeline/page.tsx',
    'app/cockpit/pipeline/reporty/page.tsx',
    'app/cockpit/cilove-seznamy/page.tsx',
    'app/cockpit/cilove-seznamy/[id]/page.tsx',
    'app/cockpit/oslovovani/page.tsx',
  ])('%s přesměruje ne-obchodníky dřív, než načte data', (file) => {
    const code = src(file)
    const gate = code.indexOf("if (!await canCurrentUserSeeSales()) redirect('/cockpit')")
    expect(gate).toBeGreaterThan(-1)
    const firstQuery = code.search(/await (Promise\.all|get[A-Z])/)
    expect(firstQuery === -1 || firstQuery > gate).toBe(true)
  })
  test('tabule už nemá reporty pod sebou, jsou na /pipeline/reporty', () => {
    expect(src('app/cockpit/pipeline/page.tsx')).not.toContain('SalesLeaderboard')
    expect(src('app/cockpit/pipeline/reporty/page.tsx')).toContain('SalesLeaderboard')
  })
})

describe('Detail obchodu – jednotná hlavička a další krok na místě', () => {
  const noop = async () => ({ success: true as const })
  const base = {
    dealId: 1, nextStep: null, nextStepDue: null, dueLabel: '—',
    followUp: { label: 'Bez termínu', tone: 'neutral' as const }, overdue: false, updateNextStep: noop,
  }
  test('chybějící krok: výzva a úprava na místě, ne odkaz na /edit', () => {
    const html = renderToStaticMarkup(<DealsNextStep {...base} missing />)
    expect(html).toContain('Domluv konkrétní další krok a termín')
    expect(html).toContain('Doplnit krok')
    expect(html).toContain('id="dalsi-krok"')
    expect(html).not.toContain('/edit')
  })
  test('existující krok ukáže termín a stav slovem', () => {
    const html = renderToStaticMarkup(
      <DealsNextStep {...base} nextStep="Poslat nabídku v2" nextStepDue="2026-10-02" dueLabel="2. 10. 2026" followUp={{ label: 'V termínu', tone: 'pos' }} missing={false} />,
    )
    expect(html).toContain('Poslat nabídku v2')
    expect(html).toContain('Termín: 2. 10. 2026')
    expect(html).toContain('V termínu')
    expect(html).toContain('Upravit krok')
  })
  test('bez obchodní role jen ke čtení', () => {
    const html = renderToStaticMarkup(<DealsNextStep {...base} nextStep="Zavolat" nextStepDue="2026-10-02" missing={false} canEdit={false} />)
    expect(html).toContain('Zavolat')
    expect(html).not.toContain('Upravit krok')
  })
  test('hlavní akce hlavičky je jediné koralové tlačítko „Domluvit další krok“', () => {
    const html = renderToStaticMarkup(<DealsNextStepButton />)
    expect(html).toContain('Domluvit další krok')
    expect(html).toContain('btn-primary')
  })
  test('vlastník: klidná karta se jménem, bez vlastníka řečeno slovem', () => {
    expect(renderToStaticMarkup(<DealsOwnerCard name="Viktor Kovář" clientHref="/cockpit/clients/7" clientName="ALFATECH" />)).toContain('Viktor Kovář')
    expect(renderToStaticMarkup(<DealsOwnerCard name={null} clientHref="/cockpit/clients/7" clientName="ALFATECH" />)).toContain('Obchod zatím nikdo nevede.')
    // Tlačítko „Změnit vlastníka“ vkládá stránka jen tomu, kdo smí (0093).
    expect(renderToStaticMarkup(<DealsOwnerCard name="Viktor" clientHref="/cockpit/clients/7" clientName="ALFATECH" change={<button type="button">Změnit vlastníka</button>} />)).toContain('Změnit vlastníka')
    expect(renderToStaticMarkup(<DealsOwnerCard name="Viktor" clientHref="/cockpit/clients/7" clientName="ALFATECH" />)).not.toContain('Změnit vlastníka')
  })
  test('stránka: zpět na klienta, historie a partneři pod <details>, obchodní data jen pro obchodní role', () => {
    const code = src('app/cockpit/clients/[id]/deals/[dealId]/page.tsx')
    expect(code).toContain("back={{ href: `/cockpit/clients/${accountId}`, label: clientName }}")
    expect(code).toMatch(/<details id="partneri"/)
    expect(code).toMatch(/<details id="historie"/)
    expect(code).toContain('const [activities, scopeVersions] = canSeeSales')
    expect(code).toContain('{isOpen && canSeeSales && <DealsNextStepButton />}')
    expect(code).toContain('canEdit={canSeeSales && isOpen}')
    expect(code).toMatch(/\{canSeeSales && \(\s*<Card title="Poslední dění"/)
  })
})

describe('Seznamy k oslovení a Oslovování – klidné počty a prázdné stavy', () => {
  test('DealsStats: čísla a popisky bez barevných ploch', async () => {
    const { DealsStats } = await import('@/components/DealsKpis')
    const html = renderToStaticMarkup(<DealsStats label="Seznamy v číslech" stats={[{ label: 'Seznamy', value: 3 }, { label: 'Osloveno', value: 12, note: 'firem' }]} />)
    expect(html).toContain('aria-label="Seznamy v číslech"')
    expect(html).toContain('<dt class="eyebrow">Osloveno</dt>')
    expect(html).toContain('>12<')
    expect(html).not.toMatch(/tile-(peach|pink|sky|sun|mint|lav)/)
  })
  test('stránky používají EmptyState a záložky Obchodů, žádné ruční koralové třídy', () => {
    for (const file of ['app/cockpit/cilove-seznamy/page.tsx', 'app/cockpit/cilove-seznamy/[id]/page.tsx', 'app/cockpit/oslovovani/page.tsx', 'app/cockpit/pipeline/page.tsx']) {
      const code = src(file)
      expect(code).toContain('<DealsSectionTabs')
      expect(code).not.toContain('btn-coral')
    }
    expect(src('app/cockpit/oslovovani/page.tsx')).toContain('<EmptyState tone="calm"')
    expect(src('app/cockpit/cilove-seznamy/[id]/page.tsx')).toContain("back={BACK}")
  })
})
