// Rychlé opravy viditelné v produkci (audit UI 1. 10.): sdílená hláška
// „Tahle část se připravuje“, žargon, cíle kláves, mřížka dlaždic, kontrast,
// dotykové cíle, loading stavy a světlý color-scheme.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FEATURE_PENDING_TITLE, FeaturePending, FeaturePendingDetailProvider } from '@/components/ui/FeaturePending'
import { KIND_HREF } from '@/components/ui/ChangesCard'
import { nodeTileCols } from '@/components/WorkCaseBoard'
import KapacityLoading from '@/app/cockpit/kapacity/loading'
import ImportLoading from '@/app/cockpit/import/zakazky/loading'
import CaseLoading from '@/app/cockpit/pripady/[id]/loading'
import TargetListLoading from '@/app/cockpit/cilove-seznamy/[id]/loading'

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p))
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}
const UI_FILES = [...tsxFiles('app'), ...tsxFiles('components')]

describe('FeaturePending', () => {
  test('lidská věta, bez čísla migrace pro běžného člena', () => {
    const html = renderToStaticMarkup(<FeaturePending migration="0062">Pak tu půjde plánovat.</FeaturePending>)
    expect(html).toContain(FEATURE_PENDING_TITLE)
    expect(html).toContain('Pak tu půjde plánovat.')
    expect(html).not.toContain('0062')
    expect(html).not.toMatch(/migrac/i)
  })

  test('vedení a správce vidí číslo migrace jako drobný detail', () => {
    const html = renderToStaticMarkup(
      <FeaturePendingDetailProvider show><FeaturePending migration="0062" /></FeaturePendingDetailProvider>,
    )
    expect(html).toContain('chybí migrace 0062')
    expect(html).toContain('text-footnote text-muted')
  })

  test('volitelná akce, karta a varianta v textu', () => {
    const card = renderToStaticMarkup(<FeaturePending card action={{ href: '/cockpit/tasks', label: 'Otevřít úkoly' }} />)
    expect(card).toContain('rounded-card')
    expect(card).toContain('href="/cockpit/tasks"')
    const inline = renderToStaticMarkup(<p><FeaturePending variant="inline" migration="0063" title="Finanční záznamy se připravují." /></p>)
    expect(inline).toBe('<p><span class="">Finanční záznamy se připravují.</span></p>')
  })

  test('žádná obrazovka neříká uživateli „čeká na migraci“', () => {
    const bad: string[] = []
    for (const f of UI_FILES) {
      const src = stripComments(readFileSync(f, 'utf8'))
      if (/(čeká|čekají) na migrac|chybí migrace \d|migrace (je |bude )?aplikovaná|databáze ji ještě nemá/i.test(src)) bad.push(f)
    }
    expect(bad).toEqual([])
  })
})

describe('žargon v textech pro uživatele', () => {
  test('bez anglických a interních výrazů z auditu', () => {
    const banned = ['Deliverable pack', 'Follow-up checkpoint', 'EDS §', 'Přinesl lead', 'NNPSA target', 'MRR', 'eyebrow="CRM"', 'eyebrow="Portfolio"', 'v CRM neexistoval', 'do úrovně 4', 'work-first', 'Peer learning']
    const hits: string[] = []
    for (const f of [...UI_FILES, 'domain/delivery/deliveryGates.ts']) {
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const b of banned) if (src.includes(b)) hits.push(`${f}: ${b}`)
    }
    expect(hits).toEqual([])
  })
})

describe('Co se změnilo: klávesy vedou na seznam daného druhu', () => {
  test('dodávky, milníky a dokumenty → Dodávky; e-maily → klienti podle poslední aktivity', () => {
    expect(KIND_HREF.delivery).toBe('/cockpit/dodavky')
    expect(KIND_HREF.milestone).toBe('/cockpit/dodavky')
    expect(KIND_HREF.document).toBe('/cockpit/dodavky')
    expect(KIND_HREF.email).toBe('/cockpit/clients?sort=aktivita')
    expect(KIND_HREF.decision).toBe('/cockpit/rozhodnuti')
    expect(KIND_HREF.money).toBe('/cockpit/finance')
    expect(Object.values(KIND_HREF).some((h) => h.includes('stav=aktivni'))).toBe(false)
  })
})

describe('Případy: dlaždice oblastí', () => {
  test('počet sloupců sedí s počtem dlaždic (žádná poloprázdná řada)', () => {
    expect(nodeTileCols(5)).toBe('lg:grid-cols-5')
    expect(nodeTileCols(4)).toBe('lg:grid-cols-4')
    expect(nodeTileCols(6)).toBe('sm:grid-cols-3 xl:grid-cols-6')
  })
})

describe('kontrast a dotykové cíle', () => {
  test('WorkGantt: číslo dne bílé na tokenu --t-red (≥ 4,5 : 1), aspoň 11 px', () => {
    const src = readFileSync('components/WorkGantt.tsx', 'utf8')
    expect(src).toContain('bg-[color:var(--t-red)] text-white text-[11px]')
    expect(src).not.toMatch(/#C58A17|rgba\(47,140,245/)
  })

  test('Toast: zavírací tlačítko má 44 px', () => {
    expect(readFileSync('components/ui/Toast.tsx', 'utf8')).toMatch(/h-11 w-11[^"]*"\s*>\s*<svg/)
  })

  test('Sidebar: položky menu nemají na tabletu méně než 44 px, spodní odkazy na dotyku 44 px', () => {
    const src = readFileSync('components/Sidebar.tsx', 'utf8')
    expect(src).not.toContain('md:min-h-0')
    expect(src.match(/\[@media\(pointer:coarse\)\]:min-h-\[44px\]/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('loading stavy a color-scheme', () => {
  test.each([
    ['app/cockpit/kapacity/loading.tsx', KapacityLoading],
    ['app/cockpit/import/zakazky/loading.tsx', ImportLoading],
    ['app/cockpit/pripady/[id]/loading.tsx', CaseLoading],
    ['app/cockpit/cilove-seznamy/[id]/loading.tsx', TargetListLoading],
  ] as const)('%s existuje a hlásí načítání', (path, Loading) => {
    expect(existsSync(path)).toBe(true)
    const html = renderToStaticMarkup(<Loading />)
    expect(html).toContain('role="status"')
    expect(html).toMatch(/rounded-(card|full|btn|tile)/)
  })

  test(':root má color-scheme: light (tmavý režim zatím neděláme)', () => {
    const css = readFileSync('app/globals.css', 'utf8')
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
    expect(root).toContain('color-scheme: light;')
  })
})
