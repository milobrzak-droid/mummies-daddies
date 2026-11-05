import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveVisitWindow, weekWindow } from '@/domain/crm/changes'

// Obrazovky Dnes a Týden se zamockovanými dotazy: ranní přehled „Co se
// změnilo“, karta „Čeká na klienta“, zápis času návštěvy jen když tabulka
// existuje, obchodní věci jen pro obchodní role a odolnost proti chybám.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  redirect: (to: string) => { throw new Error(`redirect:${to}`) },
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }))
vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<typeof import('@/lib/pragueDate')>()), pragueToday: () => '2026-09-29' }))

const state = vi.hoisted(() => ({ role: 'obchodnik' as string, view: { state: 'ok', row: { baseline_at: null, last_open_at: '2026-09-28T13:00:00Z' } } as unknown, changesFail: false, waitingFail: false }))

vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(async () => ({ user: { id: 'u1' }, member: { full_name: 'Viktor', is_admin: false, role: state.role } })),
  memberSeesSales: (m: { role: string } | null) => m?.role === 'obchodnik' || m?.role === 'vedeni',
}))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => state.role === 'obchodnik' || state.role === 'vedeni') }))
vi.mock('@/lib/queries/team', () => ({ listTeamMembers: vi.fn(async () => [{ id: 'u1', full_name: 'Viktor Kovář', email: 'm@x.cz', role: state.role, is_admin: false, created_at: '' }]) }))
vi.mock('@/lib/queries/dashboard', () => ({ getDeliveryProjects: vi.fn(async () => []), getContractedOverTime: vi.fn(async () => []) }))
vi.mock('@/domain/crm/queries/calendar', () => ({ getMyCalendarConnection: vi.fn(async () => ({ connected: true, email: 'm@x.cz', grantedScopes: null })) }))
vi.mock('@/domain/crm/queries/sales', () => ({ getSalesDeals: vi.fn(async () => []), getSalesActivities: vi.fn(async () => []) }))
vi.mock('@/domain/crm/queries/todayMeetings', () => ({ getMeetingsOnDay: vi.fn(async () => []) }))
vi.mock('@/domain/crm/queries/tasks', () => ({ getMyTasks: vi.fn(async () => []) }))
vi.mock('@/domain/crm/queries/meetingNotes', () => ({ getLastSkillMeetingNoteAt: vi.fn(async () => null) }))
vi.mock('@/core/loopQueries', () => ({ getDecisionInbox: vi.fn(async () => ({ state: 'ok', approvals: [], decisions: [] })), getLoopNodes: vi.fn(async () => []), isMissingRelation: () => false }))
vi.mock('@/core/connectorState', () => ({ getConnectorState: vi.fn(async () => null), isStale: () => false }))
vi.mock('@/domain/crm/mailSyncService', () => ({
  loadMailSourcesStatus: vi.fn(async () => ({ syncEnabled: false, inbox: null, sent: null, webhook: { enabled: false, broken: false, problems: [], expiresAt: null } })),
}))
vi.mock('@/domain/crm/queries/digest', () => {
  const digest = {
    headline: 'Nic k řešení', sections: [], isEmpty: true, generatedAt: new Date('2026-09-29T06:30:00Z'),
    sources: { title: 'Stav zdrojů', lines: [] }, sourceAlerts: 0,
  }
  return {
    getTodaysDigest: vi.fn(async () => digest),
    getTodaysDigestWithSource: vi.fn(async () => ({ digest, source: { followUps: [], outreach: [], blockedDeals: [] } })),
  }
})
// Provozní přehled se skládá skutečnou buildOpsReport ze změn, které stránka
// předá; ostatní zdroje (dodávky, čekání, kapacity…) jsou tu prázdné.
vi.mock('@/domain/crm/queries/opsReport', async () => {
  const { buildOpsReport } = await import('@/domain/crm/opsReport')
  const { weekWindow } = await import('@/domain/crm/changes')
  type Ctx = Parameters<typeof import('@/domain/crm/queries/opsReport').loadOpsReport>[0]
  return {
    loadOpsReport: vi.fn(async (ctx: Ctx) => buildOpsReport({
      today: ctx.today!, generatedAt: ctx.now, window: weekWindow(ctx.today!, ctx.week), week: ctx.week, canSeeSales: ctx.canSeeSales,
      changes: ctx.changes ?? null, digest: ctx.digest,
      portfolio: { state: 'ok', items: [], unavailable: [] }, waiting: { state: 'ok', items: [] },
      capacity: { state: 'ok', members: [], allocations: [] }, inbox: { state: 'ok', approvals: [], decisions: [] },
      pendingProposals: 0, unmatchedNotes: 0,
    })),
  }
})
vi.mock('@/domain/crm/queries/changes', async () => {
  const c = await import('@/domain/crm/changes')
  return {
    getChangesView: vi.fn(async () => state.view),
    loadChanges: vi.fn(async (input: { canSeeSales: boolean }) => {
      if (state.changesFail) throw new Error('boom')
      const sections = c.buildChangeSections(
        [{ key: 'work-1', kind: 'work', at: '2026-09-29T05:00:00Z', title: 'Poslat podklady', detail: 'Nový úkol', href: '/cockpit/tasks', proof: 'Úkol č. 1, založeno 29. 9. 07:00' }],
        { canSeeSales: input.canSeeSales },
      )
      return { sections, unavailable: [] }
    }),
  }
})
vi.mock('@/domain/delivery/queries/waiting', () => ({
  getWaitingItems: vi.fn(async () => {
    if (state.waitingFail) throw new Error('boom')
    return { state: 'ok', items: [] }
  }),
}))
// Klientská komponenta se v SSR nespustí; značka ukáže, že by se na stránce objevila.
vi.mock('@/components/ui/ChangesSeen', () => ({ ChangesSeen: () => <i data-changes-seen="" /> }))

import { loadChanges } from '@/domain/crm/queries/changes'
import { loadMailSourcesStatus } from '@/domain/crm/mailSyncService'
import { getDecisionInbox } from '@/core/loopQueries'

beforeEach(() => {
  vi.clearAllMocks()
  state.role = 'obchodnik'
  state.view = { state: 'ok', row: { baseline_at: null, last_open_at: '2026-09-28T13:00:00Z' } }
  state.changesFail = false
  state.waitingFail = false
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

async function today() {
  const { default: Page } = await import('@/app/cockpit/page')
  return renderToStaticMarkup(await Page())
}
async function week(sp: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/cockpit/prehled-tydne/page')
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }))
}

describe('obrazovka Dnes: obchodní role', () => {
  test('Ke schválení ukazuje čitelný druh činnosti, ne syrový action_kind', async () => {
    state.role = 'vedeni'
    vi.mocked(getDecisionInbox).mockResolvedValueOnce({
      state: 'ok',
      approvals: [{
        id: 7, requested_by: 'user:u2', requested_level: 'L1', case_node: null, action_type: null,
        action_kind: 'external_commitment', case_title: null, expired: false, ageDays: 1,
      }],
      decisions: [],
    } as unknown as Awaited<ReturnType<typeof getDecisionInbox>>)
    const html = await today()
    expect(html).toContain('Závazek vůči klientovi')
    expect(html).not.toContain('external_commitment')
  })

  test('pořadí podle priority: co udělat a Ke schválení nahoře, Stav zdrojů dole a sbalený', async () => {
    const html = await today()
    const at = (t: string) => html.indexOf(t)
    expect(at('Co dnes udělat')).toBeGreaterThan(-1)
    expect(at('Co dnes udělat')).toBeLessThan(at('Ke schválení'))
    expect(at('Ke schválení')).toBeLessThan(at('Po termínu'))
    expect(at('Po termínu')).toBeLessThan(at('Obchody v číslech'))
    expect(at('Obchody v číslech')).toBeLessThan(at('Co se změnilo'))
    expect(at('Co se změnilo')).toBeLessThan(at('Stav zdrojů dat'))
    // Bez poruchy (jen zdroje, které zatím nic nedodaly) → sbalené, bez atributu open.
    expect(html).toContain('Bez poruch · 2 zdroje zatím nemají data')
    expect(html).toMatch(/<details class="[^"]*"><summary[^>]*>.*Stav zdrojů dat/)
    // Hlavička: žádné vlastní hledání, jedna hlavní akce.
    expect(html).not.toContain('Hledat klienta')
    expect(html.match(/btn-primary/g)).toHaveLength(1)
  })

  test('Stav zdrojů dat se sám rozbalí, když zdroj nefunguje', async () => {
    vi.mocked(loadMailSourcesStatus).mockResolvedValueOnce({
      syncEnabled: false, inbox: null, sent: null, webhook: { enabled: true, broken: true, problems: ['vypršelo'], expiresAt: null },
    } as unknown as Awaited<ReturnType<typeof loadMailSourcesStatus>>)
    const html = await today()
    expect(html).toMatch(/<details open="" class="[^"]*"><summary/)
    expect(html).toContain('1 zdroj chce pozornost') // zdroje „Zatím nic“ poruchou nejsou
    expect(html).toContain('Okamžité upozornění na poštu nefunguje: vypršelo')
  })

  test('ranní přehled a karta Čeká na klienta, jedna h1', async () => {
    const html = await today()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('data-changes-seen') // tabulka existuje → návštěva se zapíše
    expect(html).toContain('Co se změnilo')
    expect(html).toContain('Poslat podklady')
    expect(html).toContain('Čeká na klienta')
    expect(html).toContain('Nic nečeká na klienta')
    expect(html.indexOf('Co se změnilo')).toBeLessThan(html.indexOf('Čeká na klienta'))
    // Obchodní druhy změn tu jsou (role je vidí).
    expect(html).toContain('Posun fáze obchodu')
    // Stará obrazovka zůstala: čísla obchodů i schvalování.
    expect(html).toContain('Ke schválení')
  })

  test('okno se počítá od poslední návštěvy a načítá se s obchodním oprávněním', async () => {
    await today()
    const input = vi.mocked(loadChanges).mock.calls[0][0]
    expect(input.canSeeSales).toBe(true)
    expect(input.meId).toBe('u1')
    const expected = resolveVisitWindow({ baseline_at: null, last_open_at: '2026-09-28T13:00:00Z' }, new Date())
    expect(input.window.kind).toBe(expected.kind)
  })

  test('chyba karty změn nesmí shodit obrazovku a říká to nahlas', async () => {
    state.changesFail = true
    const html = await today()
    expect(html).toContain('Nepodařilo se načíst')
    expect(html).not.toContain('Od poslední návštěvy se nic nezměnilo')
    expect(html).toContain('Schůzky dnes')
  })

  test('chyba hlídání čekání: karta se přizná, zbytek stránky funguje', async () => {
    state.waitingFail = true
    const html = await today()
    expect(html).toContain('Nepodařilo se načíst, co čeká na klienta')
    expect(html).toContain('Co se změnilo')
  })

  test('čas návštěvy se zapisuje jen když tabulka existuje (bez 0075 žádný zápis, okno na týden)', async () => {
    state.view = { state: 'missing_migration' }
    const html = await today()
    expect(html).toContain('Čas poslední návštěvy se zatím neukládá')
    expect(html).not.toContain('0075')
    expect(html).not.toContain('data-changes-seen')
    expect(vi.mocked(loadChanges).mock.calls[0][0].window.kind).toBe('first')
  })

  test('žádná návštěva zatím (řádek chybí): první návštěva, ukazuje týden', async () => {
    state.view = { state: 'ok', row: null }
    const html = await today()
    expect(html).toContain('první návštěva')
    expect(html).toContain('Co se změnilo')
  })
})

describe('obrazovka Dnes: role bez obchodu', () => {
  beforeEach(() => { state.role = 'projektak' })

  test('vidí změny a čekání, ale žádné obchodní druhy, a načítá se bez obchodního oprávnění', async () => {
    const html = await today()
    expect(html).toContain('Co se změnilo')
    expect(html).toContain('Čeká na klienta')
    expect(html).toContain('Milníky dodávek')
    for (const hidden of ['Nové e-maily od klientů', 'Posun fáze obchodu', 'Faktury a platby']) expect(html).not.toContain(hidden)
    expect(vi.mocked(loadChanges).mock.calls[0][0].canSeeSales).toBe(false)
    const { getSalesDeals } = await import('@/domain/crm/queries/sales')
    expect(getSalesDeals).not.toHaveBeenCalled()
  })

  test('pořadí podle priority: co udělat a po termínu nad čísly a ranním přehledem, fáze dole', async () => {
    const html = await today()
    const at = (t: string) => html.indexOf(t)
    expect(at('Co dnes udělat')).toBeGreaterThan(-1)
    expect(at('Co dnes udělat')).toBeLessThan(at('Dodávky v číslech'))
    expect(at('Po termínu')).toBeLessThan(at('Dodávky v číslech'))
    expect(at('Dodávky v číslech')).toBeLessThan(at('Co se změnilo'))
    expect(at('Čeká na klienta')).toBeLessThan(at('Dodávky podle fáze'))
    expect(html.match(/<h1/g)).toHaveLength(1)
  })
})

describe('záložka Týden', () => {
  test('výchozí týden podle dne (úterý → minulý Po–Ne), přepínač, karta se všemi sekcemi', async () => {
    const html = await week()
    expect(html).toContain('Minulý týden (Po–Ne)')
    expect(html).toContain('Tento týden')
    expect(html).toContain('za týden 39: po 21. 9. až ne 27. 9.')
    expect(html).toContain('href="/cockpit/prehled-tydne?tyden=tento"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('Co se změnilo')
    expect(html).toContain('Poslat podklady')
    // Provozní přehled nahoře, Stav zdrojů zůstal.
    expect(html).toContain('Riziko termínů a kapacity')
    expect(html).toContain('Stav zdrojů')
    const input = vi.mocked(loadChanges).mock.calls[0][0]
    expect(input.window.since.toISOString()).toBe(weekWindow('2026-09-29', 'minuly').since.toISOString())
    expect(input.canSeeSales).toBe(true)
  })

  test('?tyden=tento posune okno na letošní pondělí', async () => {
    await week({ tyden: 'tento' })
    const input = vi.mocked(loadChanges).mock.calls[0][0]
    expect(input.window.since.toISOString()).toBe(weekWindow('2026-09-29', 'tento').since.toISOString())
  })

  test('role bez obchodu jsou přesměrované a nic se nenačítá', async () => {
    state.role = 'projektak'
    await expect(week()).rejects.toThrow('redirect:/')
    expect(loadChanges).not.toHaveBeenCalled()
  })

  test('chyba čtení změn nezboří týdenní přehled', async () => {
    state.changesFail = true
    const html = await week()
    expect(html).toContain('Nepodařilo se načíst')
    expect(html).toContain('Nové a změněné obchody')
    expect(html).toContain('Stav zdrojů')
  })
})
