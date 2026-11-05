import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { getDeliveryPortfolio } from '@/domain/delivery/queries/portfolio'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { PortfolioKeys } from '@/components/DeliveryPortfolio'
import { DeliveryPortfolioPanel } from '@/components/DeliveryPortfolioPanel'
import { summarizePortfolio, type PortfolioItem } from '@/domain/delivery/portfolio'

// /dodavky (vlna 2): souhrn → segmenty → karty, prázdné stavy s cestou dál,
// ?kdo= a ?stav= jako segmenty s aria-current, jedna h1.

vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<typeof import('@/lib/pragueDate')>()), pragueToday: () => '2026-09-29' }))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/dodavky', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/domain/delivery/queries/portfolio', () => ({ getDeliveryPortfolio: vi.fn() }))
vi.mock('@/lib/queries/currentMember', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))

const ME = 'u1'

function item(p: Partial<PortfolioItem> & { id: number }): PortfolioItem {
  return {
    accountId: 1, accountName: 'ALFATECH', dealId: null, title: `Dodávka ${p.id}`, kindLabel: 'Akce', phase: 'pilot', phaseLabel: 'Pilot',
    href: `/cockpit/clients/1/engagements/${p.id}/edit`, milestonesHref: `/cockpit/clients/1/engagements/${p.id}/edit?zalozka=milniky`,
    ownerId: ME, ownerName: 'Viktor Kovář', deputyId: null, deputyName: null, involved: [ME],
    promised: { source: 'handoff', text: 'Zrychlit objednávky', caption: 'z předávacího balíčku' },
    nextMilestone: null, openMilestones: [], progress: { total: 0, accepted: 0, lastAcceptedOn: null }, handoff: 'done',
    dueOn: '2026-11-06', waits: { us: 0, client: 0, approval: 0, blockedTasks: 0 }, lastMove: { at: '2026-09-28', days: 1 },
    capacity: null, impact: null, reference: 'none', flags: { late: false, blocked: false, waitingClient: false, stale: false },
    state: 'ok', riskScore: 0, reasons: [], leadership: [], ...p,
  }
}

async function renderPage(sp: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/cockpit/dodavky/page')
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: ME } as never, member: { full_name: 'Viktor', is_admin: false, role: 'vedeni' } })
})

describe('stránka /dodavky', () => {
  test('souhrn, segmenty Moje × Celý tým a filtr stavu, jedna h1', async () => {
    vi.mocked(getDeliveryPortfolio).mockResolvedValue({ state: 'ok', items: [item({ id: 1, flags: { late: true, blocked: false, waitingClient: false, stale: false }, state: 'late' })], unavailable: [] })
    const html = await renderPage({ stav: 'po-terminu' })
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Čí dodávky"')
    expect(html).toContain('<a class="seg-item" aria-current="page" href="/cockpit/dodavky?stav=po-terminu">Celý tým')
    expect(html).toContain('<a class="seg-item" aria-current="page" href="/cockpit/dodavky?stav=po-terminu">Po termínu</a>')
    expect(html).not.toContain('pill-tab')
    expect(html).toContain('1 aktivní dodávka, 1 po termínu.')
    expect(html).toContain('Lidé, kapacita a dopad')
    expect(html).toContain('<details')
  })

  test('bez dodávek: prázdný stav s cestou ke klientům', async () => {
    vi.mocked(getDeliveryPortfolio).mockResolvedValue({ state: 'ok', items: [], unavailable: [] })
    const html = await renderPage()
    expect(html).toContain('Zatím žádná běžící dodávka')
    expect(html).toContain('href="/cockpit/clients"')
    expect(html).toContain('Vybrat klienta')
  })

  test('filtr bez výsledku nabídne zrušení filtru', async () => {
    vi.mocked(getDeliveryPortfolio).mockResolvedValue({ state: 'ok', items: [item({ id: 1 })], unavailable: [] })
    const html = await renderPage({ stav: 'blokovane' })
    expect(html).toContain('Žádná dodávka neodpovídá filtru')
    expect(html).toContain('Ukázat všechny')
  })

  test('chyba načtení: hláška a Zkusit znovu', async () => {
    vi.mocked(getDeliveryPortfolio).mockResolvedValue({ state: 'error' } as never)
    const html = await renderPage()
    expect(html).toContain('Dodávky se nepodařilo načíst')
    expect(html).toContain('Zkusit znovu')
  })
})

describe('klávesy souhrnu', () => {
  test('nula je klidná bílá dlaždice bez odkazu, číslo, které něco říká, je barevná klávesa', () => {
    const summary = summarizePortfolio([item({ id: 1, flags: { late: true, blocked: false, waitingClient: false, stale: false }, state: 'late' })])
    const html = renderToStaticMarkup(<PortfolioKeys summary={summary} />)
    expect(html).toMatch(/<a [^>]*aria-label="Po termínu: 1" class="keycap keycap-red/)
    expect(html).not.toContain('aria-label="Blokované: 0"')
    expect(html).toMatch(/<div class="tile tile-pink [^"]*"><span class="eyebrow">Blokované<\/span>/)
    expect(html).not.toContain('keycap-white')
  })
})

describe('panel Dodávky na Dnes', () => {
  test('karta s odkazem ↗ na portfolio, klidný stav bez rizika', () => {
    const html = renderToStaticMarkup(<DeliveryPortfolioPanel result={{ state: 'ok', items: [item({ id: 1 })], unavailable: [] }} />)
    expect(html).toContain('aria-label="Otevřít portfolio dodávek"')
    expect(html).toContain('Žádná dodávka nepotřebuje pozornost')
  })

  test('bez dodávek prázdný stav, chyba načtení neshodí kartu', () => {
    expect(renderToStaticMarkup(<DeliveryPortfolioPanel result={{ state: 'ok', items: [], unavailable: [] }} />)).toContain('Žádná aktivní dodávka')
    expect(renderToStaticMarkup(<DeliveryPortfolioPanel result={{ state: 'error' } as never} />)).toContain('Dodávky se nepodařilo načíst')
  })
})
