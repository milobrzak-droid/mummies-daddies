import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Záložka Týden s provozním přehledem: klávesy se souhrnem (odkazy na sekce),
// karty sekcí s odkazem a důkazem u každé položky, klidné prázdné stavy,
// Stav zdrojů, záznam změn a náhled e-mailu jen pro vedení. Dotazy jsou
// zamockované; přehled se skládá skutečnou buildOpsReport z přípravku.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/cockpit/prehled-tydne',
  redirect: (to: string) => { throw new Error(`redirect:${to}`) },
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<typeof import('@/lib/pragueDate')>()), pragueToday: () => '2026-10-05' }))

const state = vi.hoisted(() => ({ role: 'vedeni' as string, digestFail: false, empty: false }))

vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(async () => ({ user: { id: 'u1' }, member: { full_name: 'Viktor', is_admin: false, role: state.role } })),
  memberSeesSales: (m: { role: string } | null) => m?.role === 'obchodnik' || m?.role === 'vedeni',
}))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => state.role === 'obchodnik' || state.role === 'vedeni') }))
vi.mock('@/lib/queries/team', () => ({ listTeamMembers: vi.fn(async () => [{ id: 'u1', full_name: 'Viktor Kovář', email: 'm@x.cz', role: state.role, is_admin: false, created_at: '' }]) }))
vi.mock('@/domain/crm/queries/changes', async () => {
  const c = await import('@/domain/crm/changes')
  const f = await import('./helpers/opsReportFixture')
  return {
    loadChanges: vi.fn(async (input: { canSeeSales: boolean }) => ({
      sections: c.buildChangeSections(state.empty ? [] : f.changeItems(), { canSeeSales: input.canSeeSales, perSection: 100 }),
      unavailable: [],
    })),
  }
})
vi.mock('@/domain/crm/queries/digest', async () => {
  const d = await import('@/domain/crm/digest')
  const f = await import('./helpers/opsReportFixture')
  return {
    getTodaysDigestWithSource: vi.fn(async () => {
      if (state.digestFail) throw new Error('boom')
      const di = state.empty ? { ...f.digestInput(), followUps: [], outreach: [], blockedDeals: [] } : f.digestInput()
      return { digest: d.buildDigest(di), source: di }
    }),
  }
})
vi.mock('@/domain/crm/queries/opsReport', async () => {
  const f = await import('./helpers/opsReportFixture')
  const c = await import('@/domain/crm/changes')
  type Ctx = Parameters<typeof import('@/domain/crm/queries/opsReport').loadOpsReport>[0]
  return {
    loadOpsReport: vi.fn(async (ctx: Ctx) => f.opsReport({
      today: ctx.today, generatedAt: ctx.now, week: ctx.week, window: c.weekWindow(ctx.today!, ctx.week), canSeeSales: ctx.canSeeSales,
      changes: ctx.changes ?? null, digest: ctx.digest,
      ...(state.empty ? {
        portfolio: { state: 'ok' as const, items: [], unavailable: [] },
        waiting: { state: 'ok' as const, items: [] },
        capacity: { state: 'ok' as const, members: [], allocations: [] },
        inbox: { state: 'ok' as const, approvals: [], decisions: [] },
        pendingProposals: 0,
        unmatchedNotes: 0,
      } : {}),
    })),
  }
})

import { loadChanges } from '@/domain/crm/queries/changes'
import { loadOpsReport } from '@/domain/crm/queries/opsReport'
import { weekWindow } from '@/domain/crm/changes'

beforeEach(() => {
  vi.clearAllMocks()
  state.role = 'vedeni'
  state.digestFail = false
  state.empty = false
})
afterEach(() => vi.unstubAllEnvs())

async function page(sp: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/cockpit/prehled-tydne/page')
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }))
}

const SECTION_IDS = ['obchody', 'dodavky', 'na-nas', 'na-klienta', 'ke-schvaleni', 'riziko', 'neovereno']

describe('záložka Týden: provozní přehled', () => {
  test('jedna h1, záložky, přepínač týdne a okno změn', async () => {
    const html = await page()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Přehled týdne')
    expect(html).toContain('href="/cockpit/prehled-tydne?tyden=tento"')
    expect(html).toContain('Obchody a posuny milníků za týden 40: po 28. 9. až ne 4. 10.')
    expect(vi.mocked(loadOpsReport).mock.calls[0][0]).toMatchObject({ week: 'minuly', today: '2026-10-05', canSeeSales: true })
  })

  test('klávesy se souhrnem jsou odkazy na sekce a každá sekce má kartu s kotvou', async () => {
    const html = await page()
    for (const id of SECTION_IDS) {
      expect(html, id).toContain(`href="#${id}"`)
      expect(html, id).toContain(`id="${id}"`)
    }
    // klávesa rizika je červená, na tahu jsme my = žlutá
    expect(html).toMatch(/<a href="#riziko" aria-label="Riziko termínů a kapacity: 6" class="keycap keycap-red /)
    expect(html).toMatch(/<a href="#na-nas" aria-label="Čeká na nás: 3" class="keycap keycap-yellow /)
  })

  test('nulová sekce je klidná dlaždice bez odkazu; přepínač týdne je segment; jedna hlavní akce', async () => {
    const { OpsKeys } = await import('@/components/ui/OpsReport')
    const f = await import('./helpers/opsReportFixture')
    const report = f.opsReport()
    const quiet = { ...report, sections: report.sections.map((s) => (s.key === 'neovereno' ? { ...s, items: [], total: 0, unavailable: [] } : s)) }
    const keys = renderToStaticMarkup(<OpsKeys report={quiet} />)
    expect(keys).not.toContain('href="#neovereno"')
    expect(keys).toMatch(/<div class="[^"]*bg-\[color:var\(--c-soft\)\][^"]*"><span class="eyebrow">/)
    expect(keys).toContain('href="#riziko"')

    const html = await page()
    expect(html).toMatch(/<nav aria-label="Který týden" class="seg /)
    expect(html).toMatch(/class="seg-item" aria-current="page"|aria-current="page" class="seg-item"/)
    expect(html.match(/btn-primary/g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(html).not.toMatch(/btn-coral|pill-tab/)
  })

  test('položky vedou na záznam a nesou důkaz; žádné citlivé údaje', async () => {
    const html = await page()
    expect(html).toContain('href="/cockpit/clients/20/engagements/2/edit?zalozka=milniky"')
    expect(html).toContain('href="/cockpit/pripady/4"')
    expect(html).toContain('Důkaz: Milník č. 21, čeká od 15. 9. 10:00')
    expect(html).toContain('Přetížení v T41 a T42')
    for (const leak of ['Tajný rozsah', 'Doba zpracování', 'Jana Klientová', 'jana@acme.cz']) expect(html).not.toContain(leak)
  })

  test('sekce s víc položkami, než se vejde, odkazuje na celý seznam; nenačtená sekce neukazuje nulu', async () => {
    const { OpsSectionCard, OpsKeys, PAGE_ITEMS_PER_SECTION } = await import('@/components/ui/OpsReport')
    const f = await import('./helpers/opsReportFixture')
    const report = f.opsReport()
    const risk = report.sections.find((s) => s.key === 'riziko')!
    const many = { ...risk, items: Array.from({ length: 10 }, (_, i) => ({ ...risk.items[0], key: `k${i}` })), total: 12 }
    const html = renderToStaticMarkup(<OpsSectionCard section={many} />)
    expect(html.match(/Důkaz:/g)).toHaveLength(PAGE_ITEMS_PER_SECTION)
    expect(html).toContain('href="/cockpit/dodavky?stav=po-terminu"')
    expect(html).toContain('Celý seznam v Cockpitu (ještě 4)')
    // Neověřené: 7 položek se na stránku vejdou celé
    expect(await page()).not.toContain('Celý seznam v Cockpitu (ještě')

    const broken = f.opsReport({ waiting: { state: 'error', message: 'x' } })
    const keys = renderToStaticMarkup(<OpsKeys report={broken} />)
    expect(keys).toContain('aria-label="Čeká na klienta: nepodařilo se načíst"')
    const card = renderToStaticMarkup(<OpsSectionCard section={broken.sections.find((s) => s.key === 'na-klienta')!} />)
    expect(card).toContain('Nepodařilo se načíst: čekání na klienta')
    expect(card).not.toContain('Nic nečeká na klienta.')
  })

  test('Stav zdrojů a celý záznam změn za týden zůstávají', async () => {
    const html = await page()
    expect(html).toContain('Stav zdrojů')
    expect(html).toContain('Co se změnilo')
    expect(html).toContain('Posun fáze obchodu')
    const input = vi.mocked(loadChanges).mock.calls[0][0]
    expect(input.window.since.toISOString()).toBe(weekWindow('2026-10-05', 'minuly').since.toISOString())
    expect(input.perSection).toBe(100)
  })

  test('?tyden=tento: přehled i změny za probíhající týden', async () => {
    await page({ tyden: 'tento' })
    expect(vi.mocked(loadOpsReport).mock.calls[0][0].week).toBe('tento')
    expect(vi.mocked(loadChanges).mock.calls[0][0].window.since.toISOString()).toBe(weekWindow('2026-10-05', 'tento').since.toISOString())
  })

  test('klidný týden: klidná věta nahoře i v sekcích', async () => {
    state.empty = true
    const html = await page()
    expect(html).toContain('Tento týden nic nečeká')
    expect(html).toContain('Nic nečeká na klienta.')
    expect(html).toContain('Nic nečeká na rozhodnutí.')
    expect(html).toContain('Nic není po termínu, nic neblokuje a nikdo není přetížený.')
  })

  test('týdenní přehled (digest) se nenačte: stránka žije a řekne to', async () => {
    state.digestFail = true
    const html = await page()
    expect(html).toContain('Stav zdrojů se nepodařilo načíst')
    expect(html).toContain('Nepodařilo se načíst: follow-upy, blokované obchody')
    expect(html).toContain('id="riziko"')
  })

  test('role bez obchodu jsou přesměrované a nic se nenačítá', async () => {
    state.role = 'projektak'
    await expect(page()).rejects.toThrow('redirect:/')
    expect(loadOpsReport).not.toHaveBeenCalled()
  })
})

describe('náhled e-mailu (jen vedení)', () => {
  test('vedení má odkaz na náhled pro zvolený týden', async () => {
    const html = await page({ tyden: 'tento' })
    expect(html).toContain('href="/cockpit/prehled-tydne?tyden=tento&amp;nahled=email"')
    expect(html).toContain('Náhled e-mailu')
  })

  test('?nahled=email: přesně HTML e-mailu v izolovaném rámu, předmět, textová verze, stav odesílání', async () => {
    const html = await page({ nahled: 'email' })
    expect(html).toContain('<iframe title="Náhled e-mailu s přehledem týdne" sandbox=""')
    const srcdoc = /srcDoc="([^"]*)"|srcdoc="([^"]*)"/.exec(html)
    expect(srcdoc).not.toBeNull()
    const doc = (srcdoc![1] ?? srcdoc![2]).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    expect(doc).toMatch(/^<!DOCTYPE html>/)
    expect(doc).toContain('Dodávky podle milníků (3)')
    expect(doc).toContain('https://www.mummiesdaddies.com/cockpit/prehled-tydne?tyden=minuly')
    // štítek data je okamžik zobrazení (náhled = kdyby odešel teď)
    expect(html).toMatch(/Předmět<\/dt><dd[^>]*>Přehled týdne [^<:]+ \d{4}: 22 položek \(Riziko: 6, Ke schválení: 2/)
    expect(html).toContain('Textová verze')
    expect(html).toContain('Vypnuté')
    expect(html).toContain('Zobrazení náhledu nic neodesílá.')
    // v náhledu nejsou karty přehledu, přepínač týdne náhled drží
    expect(html).not.toContain('id="riziko"')
    expect(html).toContain('href="/cockpit/prehled-tydne?tyden=tento&amp;nahled=email"')
    expect(html).toContain('Zpět na přehled')
  })

  test('náhled ukáže zapnuté odesílání a odkazy na APP_URL', async () => {
    vi.stubEnv('DIGEST_SEND_ENABLED', 'true')
    vi.stubEnv('APP_URL', 'https://cockpit.example.cz')
    const html = await page({ nahled: 'email' })
    expect(html).toContain('Zapnuté')
    expect(html).toContain('https://cockpit.example.cz/cockpit/prehled-tydne?tyden=minuly')
  })

  test('obchodník náhled nemá: bez odkazu a ?nahled=email ukáže běžný přehled', async () => {
    state.role = 'obchodnik'
    const html = await page({ nahled: 'email' })
    expect(html).not.toContain('Náhled e-mailu')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('id="riziko"')
  })
})
