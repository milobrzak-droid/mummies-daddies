// Mobilní rozvržení (< md): spodní lišta s nejvýš pěti sekcemi + „Další“
// (bottom sheet s focus trapem a Esc), kartový režim tabulek (DataTable,
// ClientsTable, Finance, Kapacity) a kontrolní fronta importu jako karty.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

const pathname = vi.hoisted(() => ({ value: '/' }))
vi.mock('next/navigation', () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/app/login/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn(async () => ({ ok: true, options: [] })) }))

import { Sidebar, MOBILE_BAR_MAX } from '@/components/Sidebar'
import { DataTable } from '@/components/DataTable'
import { ClientsTable, ClientsRowLink } from '@/components/ui/ClientsTable'
import { CapacityGrid } from '@/components/CapacityGrid'
import { ImportReviewTable } from '@/components/ImportReviewTable'
import { capacityPlan, weeksFrom } from '@/domain/delivery/capacity'
import { rowFromCsv } from '@/domain/crm/bulkImportReview'
import { parseImportCsv } from '@/domain/crm/bulkImport'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.style.overflow = ''
  vi.unstubAllGlobals()
})

/** Odkazy hlavní navigace, které jsou vidět ve spodní liště (ne `hidden md:flex`). */
function barLinks(html: string) {
  const nav = html.slice(html.indexOf('aria-label="Hlavní navigace"'), html.indexOf('</nav>'))
  return [...nav.matchAll(/<a [^>]*class="([^"]*)"[^>]*>[\s\S]*?<\/a>/g)]
    .filter((m) => !/(^|\s)hidden(\s|$)/.test(m[1]))
    .map((m) => m[0])
}

describe('spodní lišta na mobilu', () => {
  test('obchodní role: pět sekcí v liště; Finance (vypnutý modul firmy) v navigaci není', () => {
    pathname.value = '/cockpit'
    const html = renderToStaticMarkup(<Sidebar name="Viktor" canSeeSales isAdmin />)
    const links = barLinks(html)
    expect(links).toHaveLength(MOBILE_BAR_MAX)
    expect(html).not.toContain('href="/cockpit/finance"')
    expect(html).toMatch(/<a [^>]*class="hidden md:flex[^"]*"[^>]*href="\/cockpit\/tym"|href="\/cockpit\/tym"[^>]*class="hidden md:flex/)
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>[\s\S]*?Další<\/span><\/button>/)
  })

  test('role bez obchodu: čtyři sekce + Další, nic skrytého navíc', () => {
    pathname.value = '/'
    const html = renderToStaticMarkup(<Sidebar name="Eva" />)
    expect(barLinks(html)).toHaveLength(4)
    expect(html).not.toContain('href="/cockpit/finance"')
    expect(html).not.toContain('href="/cockpit/pipeline"')
  })

  test('lišta se neposouvá do strany, popisky 11 px, cíle aspoň 44 px', () => {
    pathname.value = '/'
    const html = renderToStaticMarkup(<Sidebar name="Viktor" canSeeSales isAdmin />)
    const nav = html.slice(html.indexOf('aria-label="Hlavní navigace"'), html.indexOf('</nav>'))
    expect(nav).not.toContain('overflow-x-auto')
    expect(nav).toContain('grid-flow-col')
    for (const a of barLinks(html)) {
      expect(a).toContain('text-[11px]')
      expect(a).toContain('min-h-[48px]')
    }
    // dlouhý popisek má na mobilu kratší variantu, na počítači plnou
    expect(html).toContain('Schválení')
    expect(html).toContain('Ke schválení')
  })

  test('„Další“ otevře dialog: fokus uvnitř, sekce mimo lištu, hledání a účet; Esc zavře a vrátí fokus', async () => {
    pathname.value = '/cockpit/tym'
    await act(async () => root.render(<Sidebar name="Viktor" canSeeSales isAdmin />))
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Další')!
    expect(more).toBeTruthy()
    // aktivní sekce je schovaná v „Další“ → tlačítko je zvýrazněné
    expect(more.className).toContain('bg-cta-bg')

    await act(async () => { more.click() })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(more.getAttribute('aria-controls')).toBe(dialog.id)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')

    const team = dialog.querySelector('a[href="/cockpit/tym"]')!
    expect(team.getAttribute('aria-current')).toBe('page')
    expect(dialog.querySelector('a[href="/cockpit/nastaveni"]')).not.toBeNull()
    expect(dialog.querySelector('a[href="/auth/mfa/enroll"]')).not.toBeNull()
    expect(dialog.textContent).toContain('Hledat')
    expect(dialog.textContent).toContain('Odhlásit')
    expect(dialog.querySelector('button[aria-label="Zavřít"]')).not.toBeNull()

    // Tab z posledního prvku skočí na první (fokus nevyleze z panelu)
    const focusables = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
    focusables[focusables.length - 1].focus()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(document.activeElement).toBe(focusables[0])

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
  })

  test('tlačítko Zavřít panel zavře', async () => {
    pathname.value = '/'
    await act(async () => root.render(<Sidebar name="Viktor" />))
    const more = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Další')!
    await act(async () => { more.click() })
    // role bez obchodu a bez adminu: v panelu nejsou žádné další sekce, jen hledání a účet
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('nav[aria-label="Další sekce"]')).toBeNull()
    await act(async () => { (dialog.querySelector('button[aria-label="Zavřít"]') as HTMLButtonElement).click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

type Row = { name: string; city: string }
const columns = [
  { header: 'Firma', cell: (r: Row) => r.name },
  { header: 'Město', cell: (r: Row) => r.city },
  { header: 'Interní', cell: () => 'skryté', hideOnCard: true },
]

describe('DataTable mobile="cards"', () => {
  test('pod md karty (seznam s dvojicemi popisek–hodnota), tabulka až od md', () => {
    const html = renderToStaticMarkup(<DataTable mobile="cards" label="Klienti" columns={columns} rows={[{ name: 'Acme', city: 'Brno' }]} />)
    expect(html).toMatch(/<ul aria-label="Klienti" class="[^"]*md:hidden/)
    expect(html).toMatch(/<dt[^>]*>Město<\/dt><dd[^>]*>Brno<\/dd>/)
    // první sloupec je nadpis karty, ne dvojice
    expect(html).not.toMatch(/<dt[^>]*>Firma<\/dt>/)
    // sloupec hideOnCard na kartě není, v tabulce ano
    expect(html).not.toMatch(/<dt[^>]*>Interní<\/dt>/)
    expect(html).toMatch(/<div role="region" aria-label="Klienti" tabindex="0" class="[^"]*hidden md:block/)
    expect(html).toContain('<th scope="col" class="eyebrow')
  })

  test('výchozí režim zůstává posuvná tabulka bez karet', () => {
    const html = renderToStaticMarkup(<DataTable label="Klienti" columns={columns} rows={[{ name: 'Acme', city: 'Brno' }]} />)
    expect(html).not.toContain('<ul')
    expect(html).not.toContain('hidden md:block')
  })

  test('prázdná tabulka v kartovém režimu ukáže prázdný stav', () => {
    const html = renderToStaticMarkup(<DataTable mobile="cards" label="Klienti" columns={columns} rows={[]} empty="Nic tu není." />)
    expect(html).toContain('Nic tu není.')
    expect(html).not.toContain('<ul')
  })

  test('ClientsTable: karta je celá odkazem (relative + roztažený odkaz)', () => {
    const html = renderToStaticMarkup(
      <ClientsTable mobile="cards" label="Partneři" rowKey={(r: Row) => r.name} rows={[{ name: 'Acme', city: 'Brno' }]}
        columns={[{ header: 'Název', cell: (r: Row) => <ClientsRowLink href="/cockpit/partners/1/edit">{r.name}</ClientsRowLink> }, { header: 'Město', cell: (r: Row) => r.city }]} />,
    )
    expect(html).toMatch(/<ul aria-label="Partneři"[^>]*><li class="[^"]*relative/)
    expect(html).toContain('after:absolute')
  })
})

describe('Kapacity na mobilu', () => {
  test('lidé pod sebou, týdny jako dlaždice; přetížení slovem i tady', () => {
    const weeks = weeksFrom('2026-09-28', 2)
    const plan = capacityPlan([{ id: 'a' }], [{ id: 1, member_id: 'a', hours_per_week: 45, starts_on: '2026-09-01', ends_on: null, substitute_id: null }], weeks)
    const html = renderToStaticMarkup(
      <CapacityGrid rows={plan.map((p) => ({ id: p.member.id, name: 'Alena', capacity: p.capacity, weeks: p.weeks }))} weeks={weeks} currentWeekKey={weeks[0].key} />,
    )
    const mobile = html.slice(0, html.indexOf('<table'))
    expect(mobile).toMatch(/<ul aria-label="Vytížení lidí po týdnech" class="[^"]*md:hidden/)
    expect(mobile).toContain('Alena')
    expect(mobile).toContain('přetížení +5 h')
    expect(mobile).toContain('tento týden')
    expect(html).toMatch(/class="[^"]*hidden overflow-x-auto md:block/)
  })
})

describe('Import zakázek: řádky jako karty pod md', () => {
  const ME = '11111111-1111-4111-8111-111111111111'
  const MEMBERS = [{ id: ME, email: 'viktor@mummiesdaddies.com', name: 'Viktor' }]
  function reviewRows() {
    const r = parseImportCsv(['klient;název zakázky;cena;stav', 'Sigmaform;Web;1000;vyhráno a běží', 'Neznámá;Audit;500;nabídka odeslána'].join('\n'), MEMBERS)
    if (!r.ok) throw new Error(r.error)
    return [
      rowFromCsv({ row: r.rows[0], match: { kind: 'matched', accountId: 5, name: 'Sigmaform s.r.o.', by: 'name' }, alreadyImported: false, sameTitleDeal: null }),
      rowFromCsv({ row: r.rows[1], match: { kind: 'none' }, alreadyImported: false, sameTitleDeal: null }),
    ]
  }
  function stubNarrow(narrow: boolean) {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: !narrow, media: q, addEventListener: () => {}, removeEventListener: () => {},
    }))
  }

  test('telefon: karty s popisky a všemi poli, Potvrdit/Podrobnosti/Zamítnout; žádná tabulka ani karta v kartě', async () => {
    stubNarrow(true)
    const onPatch = vi.fn()
    const rows = reviewRows()
    await act(async () => root.render(
      <ImportReviewTable rows={rows} members={MEMBERS} meId={ME} busy={false} onPatch={onPatch} onConfirm={() => {}} onReject={() => {}} />,
    ))
    expect(host.querySelector('table')).toBeNull()
    const list = host.querySelector('ul[aria-label="Zakázky k potvrzení"]')!
    expect(list).not.toBeNull()
    expect(list.className).not.toContain('rounded-card')
    expect(list.querySelectorAll(':scope > li')).toHaveLength(2)

    const first = rows[0]
    // pole s viditelným popiskem a jedinečným id
    for (const id of [`title-${first.id}`, `amount-${first.id}`, `cur-${first.id}`, `stage-${first.id}`]) {
      expect(host.querySelectorAll(`#${CSS.escape(id)}`)).toHaveLength(1)
      expect(host.querySelector(`label[for="${id}"]`)).not.toBeNull()
    }
    expect(host.querySelector(`label[for="title-${first.id}"]`)!.className).not.toContain('sr-only')

    // blokované řádky nejdou potvrdit (logika blockers beze změny)
    const confirms = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Potvrdit zakázku"]')]
    expect(confirms.map((b) => b.disabled)).toEqual([false, true])
    expect(host.querySelectorAll('button[aria-label^="Zamítnout zakázku"]')).toHaveLength(2)

    // změna pole jde přes onPatch
    const title = host.querySelector(`#${CSS.escape(`title-${first.id}`)}`) as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(title, 'Web nový')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onPatch).toHaveBeenCalledWith(first.id, { title: 'Web nový' })

    // Podrobnosti rozbalí další pole
    const details = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Podrobnosti')!
    expect(details.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { details.click() })
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(host.textContent).toContain('Začátek zakázky')
  })

  test('počítač: tabulka jako dosud, bez vlastní zaoblené karty', async () => {
    stubNarrow(false)
    await act(async () => root.render(
      <ImportReviewTable rows={reviewRows()} members={MEMBERS} meId={ME} busy={false} onPatch={() => {}} onConfirm={() => {}} onReject={() => {}} />,
    ))
    expect(host.querySelector('table')).not.toBeNull()
    const region = host.querySelector('[role="region"]')!
    expect(region.className).not.toContain('rounded-card')
  })
})
