// Záložky sekcí (Práce, Dnes/Týden, Klienti) podle role: člověk bez obchodu
// nesmí vidět záložku do sekce, kterou mu server stejně nepustí (přesměruje).
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const pathname = vi.hoisted(() => ({ value: '/cockpit/tasks' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }))
vi.mock('@/app/login/actions', () => ({ signOut: vi.fn() }))

import {
  SectionTabs, visibleSectionTabs, WORK_TABS, TODAY_TABS, CLIENT_TABS, DEAL_TABS, type SectionTab,
} from '@/components/SectionTabs'
import { AccessProvider } from '@/components/AccessContext'
import { COMPANY } from '@/config'
import { isModuleOn } from '@/core/modules'

const ROOT = join(__dirname, '..')

function render(tabs: SectionTab[], canSeeSales: boolean | null) {
  const el = <SectionTabs tabs={tabs} label="Práce" />
  if (canSeeSales === null) return renderToStaticMarkup(el)
  return renderToStaticMarkup(<AccessProvider value={{ canSeeSales, isAdmin: false, showTechDetail: false }}>{el}</AccessProvider>)
}

describe('SectionTabs: záložky podle role', () => {
  it('role bez obchodu nevidí Schůzky ani Aktivity v Práci', () => {
    const html = render(WORK_TABS, false)
    expect(html).toContain('href="/cockpit/tasks"')
    expect(html).toContain('href="/cockpit/dodavky"')
    expect(html).not.toContain('href="/cockpit/schuzky"')
    expect(html).not.toContain('href="/cockpit/aktivity"')
  })

  it('obchodní role vidí všechny záložky Práce zapnutých modulů', () => {
    const html = render(WORK_TABS, true)
    for (const t of WORK_TABS) {
      if (t.module && !isModuleOn(COMPANY.modules, t.module)) expect(html).not.toContain(`href="${t.href}"`)
      else expect(html).toContain(`href="${t.href}"`)
    }
  })

  it('vypnutý modul firmy (Partneři, Kapacity, Schůzky) záložku nemá', () => {
    expect(render(CLIENT_TABS, true)).not.toContain('href="/cockpit/partners"')
    expect(render(WORK_TABS, true)).not.toContain('href="/cockpit/kapacity"')
    expect(render(WORK_TABS, true)).not.toContain('href="/cockpit/schuzky"')
  })

  it('mimo provider se obchodní záložky neukážou (bezpečná výchozí hodnota)', () => {
    const html = render(WORK_TABS, null)
    expect(html).not.toContain('href="/cockpit/schuzky"')
  })

  it('zbyde-li jediná záložka, přepínač se nezobrazí', () => {
    expect(render(TODAY_TABS, false)).toBe('')
    expect(render(TODAY_TABS, true)).toContain('href="/cockpit/prehled-tydne"')
  })

  it('visibleSectionTabs zachová pořadí', () => {
    expect(visibleSectionTabs(WORK_TABS, { canSeeSales: false }).map((t) => t.label))
      .toEqual(['Úkoly', 'Případy', 'Dodávky', 'Objednávky'])
  })
})

// Příznak salesOnly musí sedět se stránkou, kam záložka vede: stránka, která
// roli bez obchodu přesměruje, má záložku salesOnly, a naopak.
describe('SectionTabs: příznak salesOnly odpovídá ochraně stránky', () => {
  const pageFile = (href: string) => join(ROOT, 'app', href, 'page.tsx')
  // Stránky /cockpit/agent (P5) a /cockpit/objednavky (P6) dodají paralelní balíky.
  const PENDING = new Set(['/cockpit/agent', '/cockpit/objednavky'])
  const guarded = (src: string) => /if \(!await canCurrentUserSeeSales\(\)\) redirect\(/.test(src)

  for (const tab of [...WORK_TABS, ...TODAY_TABS, ...CLIENT_TABS, ...DEAL_TABS]) {
    if (tab.href === '/cockpit') continue // Dnes má vlastní větev pro role bez obchodu
    if (PENDING.has(tab.href)) continue
    it(`${tab.href}: salesOnly=${!!tab.salesOnly}`, () => {
      const file = pageFile(tab.href)
      expect(existsSync(file)).toBe(true)
      expect(guarded(readFileSync(file, 'utf8'))).toBe(!!tab.salesOnly)
    })
  }
})
