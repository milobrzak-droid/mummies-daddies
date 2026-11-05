import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CapacityGrid } from '@/components/CapacityGrid'
import { EngagementAllocations } from '@/components/EngagementAllocations'
import { capacityPlan, describeAllocations, weeksFrom, type AllocationLike } from '@/domain/delivery/capacity'
import { getCapacityOverview } from '@/domain/delivery/queries/capacity'
import { getCurrentMember } from '@/lib/queries/currentMember'
import type { AllocationRow } from '@/domain/delivery/queries/capacity'

// UI kapacit (kap. 10): mřížka plánu, sekce „Kdo na tom pracuje" a stránka
// /kapacity se zamockovanými dotazy. Přetížení je poznat i bez barvy,
// stavy před migrací mají klidnou hlášku, jedna h1.

vi.mock('@/lib/pragueDate', async (orig) => ({
  ...(await orig<typeof import('@/lib/pragueDate')>()),
  pragueToday: vi.fn(() => '2026-09-28'),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/kapacity', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/domain/delivery/queries/capacity', () => ({ getCapacityOverview: vi.fn() }))
vi.mock('@/lib/queries/currentMember', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

function row(p: Partial<AllocationRow> & { id: number; member_id: string }): AllocationRow {
  return {
    engagement_id: 3,
    work_case_id: null,
    hours_per_week: 10,
    starts_on: '2026-09-01',
    ends_on: null,
    substitute_id: null,
    note: null,
    created_at: '2026-09-01T08:00:00Z',
    ...p,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('CapacityGrid', () => {
  function render() {
    const weeks = weeksFrom('2026-09-28', 2)
    const allocations: AllocationLike[] = [
      { id: 1, member_id: A, hours_per_week: 45, starts_on: '2026-09-01', ends_on: '2026-10-04', substitute_id: null },
      { id: 2, member_id: B, hours_per_week: 7.5, starts_on: '2026-09-01', ends_on: null, substitute_id: A },
    ]
    const plan = capacityPlan([{ id: A }, { id: B, weekly_capacity_hours: 20 }], allocations, weeks)
    const rows = plan.map((p, i) => ({ id: p.member.id, name: ['Alena', 'Bořek'][i], capacity: p.capacity, weeks: p.weeks }))
    return renderToStaticMarkup(<CapacityGrid rows={rows} weeks={weeks} currentWeekKey={weeks[0].key} />)
  }

  test('přetížený týden nese text, ne jen barvu', () => {
    const html = render()
    expect(html).toContain('45 / 40 h')
    expect(html).toContain('přetížení +5 h')
    // jednou v tabulce (od md) a jednou v mobilním seznamu (pod md)
    const table = html.slice(html.indexOf('<table'))
    expect((table.match(/přetížení \+/g) ?? []).length).toBe(1)
    expect((html.slice(0, html.indexOf('<table')).match(/přetížení \+/g) ?? []).length).toBe(1)
    expect(html).toContain('7,5 / 20 h')
  })

  test('popisek tabulky, hlavičky a aktuální týden', () => {
    const html = render()
    expect(html).toContain('<caption class="sr-only">')
    expect(html).toContain('scope="row"')
    expect(html).toContain('scope="col"')
    expect(html).toContain('T40')
    expect(html).toContain('tento týden')
    expect(html).toContain('28. 9. – 4. 10.')
    expect(html).toContain('kapacita 20 h/týden')
  })

  test('prázdný tým → prázdný stav', () => {
    const html = renderToStaticMarkup(<CapacityGrid rows={[]} weeks={weeksFrom('2026-09-28', 1)} currentWeekKey="2026-W40" />)
    expect(html).toContain('V týmu zatím nikdo není')
    expect(html).toContain('href="/cockpit/tym"')
  })
})

describe('EngagementAllocations — „Kdo na tom pracuje"', () => {
  const members = [
    { id: A, full_name: 'Alena' },
    { id: B, full_name: 'Bořek' },
  ]
  const base = { accountId: 1, engagementId: 3, members, today: '2026-09-28', editId: null }

  test('před migrací klidná hláška', () => {
    const html = renderToStaticMarkup(<EngagementAllocations {...base} state="missing_migration" />)
    expect(html).toContain('Tahle část se připravuje.')
    expect(html).not.toMatch(/migrac|0062/)
  })

  test('souhrn lidí a hodin, zástup a formulář bez výběru cíle', () => {
    const rows = describeAllocations(
      [row({ id: 1, member_id: A, hours_per_week: 20, substitute_id: B }), row({ id: 2, member_id: B, hours_per_week: 12.5 })],
      new Map(members.map((m) => [m.id, m.full_name])),
      new Map([['engagement:3', { label: 'tato dodávka', href: null }]]),
      '2026-09-28',
    )
    const html = renderToStaticMarkup(<EngagementAllocations {...base} state="ok" allocations={rows} />)
    expect(html).toContain('Teď na dodávce pracují 2 lidé, celkem 32,5 h týdně.')
    expect(html).toContain('bez zástupu')
    expect(html).toContain('/cockpit/clients/1/engagements/3/edit?alokace=1#upravit-alokaci')
    expect(html).toContain('name="member_id"')
    expect(html).not.toContain('name="target"')
    expect(html).not.toContain('Upravit alokaci</h3>')
  })

  test('prázdný stav', () => {
    const html = renderToStaticMarkup(<EngagementAllocations {...base} state="ok" allocations={[]} />)
    expect(html).toContain('Na dodávce zatím nikdo není alokovaný.')
    expect(html).toContain('Teď na dodávce nikdo alokovaný není.')
  })
})

describe('stránka /kapacity', () => {
  async function renderPage(sp: Record<string, string> = {}) {
    const { default: Page } = await import('@/app/cockpit/kapacity/page')
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }))
  }

  beforeEach(() => {
    vi.mocked(getCurrentMember).mockResolvedValue({
      user: { id: B } as never,
      member: { full_name: 'Bořek', is_admin: false, role: 'projektak' },
    })
  })

  test('před migrací: jedna h1 a klidná hláška', async () => {
    vi.mocked(getCapacityOverview).mockResolvedValue({ state: 'missing_migration' })
    const html = await renderPage()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Tahle část se připravuje.')
    expect(html).not.toContain('0062')
  })

  test('plán, varování, alokace a kapacitu smí člověk měnit jen sobě', async () => {
    vi.mocked(getCapacityOverview).mockResolvedValue({
      state: 'ok',
      capacityColumn: true,
      members: [
        { id: A, full_name: 'Alena', weekly_capacity_hours: 40 },
        { id: B, full_name: 'Bořek', weekly_capacity_hours: 32 },
        { id: C, full_name: 'Cyril', weekly_capacity_hours: 20 },
      ],
      allocations: [
        row({ id: 1, member_id: A, hours_per_week: 45, substitute_id: B }),
        row({ id: 2, member_id: C, hours_per_week: 8, ends_on: '2026-09-10' }),
      ],
      endedCount: 1,
      targets: [{ key: 'engagement:3', kind: 'engagement', label: 'Gamaplast · Firemní akce', href: '/cockpit/clients/1/engagements/3/edit', active: true }],
    })
    const html = await renderPage()
    expect(vi.mocked(getCapacityOverview)).toHaveBeenLastCalledWith(expect.objectContaining({ includeEnded: false }))
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Přetížení')
    expect(html).toContain('Zástup bez rezervy')
    expect(html).toContain('Včetně skončených<span class="seg-count tabular-nums">1</span>')
    expect(html).not.toContain('pill-tab')
    expect(html).toContain('<details')
    // Skončená alokace Cyrila se v aktuálním výpisu neukazuje.
    expect(html).not.toContain('1. 9. 2026 – 10. 9. 2026')
    // Kapacitu mění jen sobě (Bořek, projektak) → formulář jen u něj (tabulka
    // je jednou jako karty pro mobil a jednou jako tabulka, proto 2 výskyty).
    expect(html.match(/name="weekly_capacity_hours"/g)).toHaveLength(2)
    expect(new Set([...html.matchAll(/aria-label="Uložit kapacitu — ([^"]+)"/g)].map((m) => m[1]))).toEqual(new Set(['Bořek']))
    expect(html).toContain('Uložit kapacitu — Bořek')
    expect(html).toContain('<optgroup label="Dodávky">')
  })

  test('?vse=1 ukáže i skončené alokace', async () => {
    vi.mocked(getCapacityOverview).mockResolvedValue({
      state: 'ok',
      capacityColumn: true,
      members: [{ id: C, full_name: 'Cyril', weekly_capacity_hours: 20 }],
      allocations: [row({ id: 2, member_id: C, hours_per_week: 8, ends_on: '2026-09-10' })],
      endedCount: 1,
      targets: [],
    })
    const html = await renderPage({ vse: '1' })
    expect(html).toContain('1. 9. 2026 – 10. 9. 2026')
    expect(html).toContain('Skončilo')
  })
})
