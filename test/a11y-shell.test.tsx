// A11y kostry aplikace: tabulka (sémantika), boční navigace (aria-current,
// mobilní panel „Další“) a odkaz „přeskočit na obsah“.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { DataTable } from '@/components/DataTable'

const pathname = vi.hoisted(() => ({ value: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }))
vi.mock('@/app/login/actions', () => ({ signOut: vi.fn() }))

import { Sidebar, isActivePath } from '@/components/Sidebar'

type Row = { name: string; city: string }
const columns = [
  { header: 'Firma', cell: (r: Row) => r.name },
  { header: 'Město', cell: (r: Row) => r.city },
]

describe('DataTable', () => {
  it('pojmenuje tabulku a posuvný obal jde fokusovat klávesnicí', () => {
    const html = renderToStaticMarkup(<DataTable label="Klienti" columns={columns} rows={[{ name: 'Acme', city: 'Brno' }]} />)
    expect(html).toContain('role="region" aria-label="Klienti" tabindex="0"')
    expect(html).toContain('<table aria-label="Klienti"')
  })

  it('záhlaví sloupců mají scope=col, první buňka řádku je th scope=row', () => {
    const html = renderToStaticMarkup(<DataTable label="Klienti" columns={columns} rows={[{ name: 'Acme', city: 'Brno' }]} />)
    expect(html.match(/<th scope="col"/g)).toHaveLength(2)
    expect(html).toMatch(/<th scope="row"[^>]*>Acme<\/th>/)
    expect(html).toMatch(/<td[^>]*>Brno<\/td>/)
  })

  it('prázdná tabulka ukáže prázdný stav, ne prázdnou mřížku', () => {
    const html = renderToStaticMarkup(<DataTable label="Klienti" columns={columns} rows={[]} empty="Žádní klienti." />)
    expect(html).toContain('Žádní klienti.')
    expect(html).not.toContain('<table')
  })
})

describe('Sidebar', () => {
  it('isActivePath: kořen jen přesně, sekce i s podstránkami, ne podle prefixu slova', () => {
    expect(isActivePath('/', '/')).toBe(true)
    expect(isActivePath('/cockpit/clients', '/')).toBe(false)
    expect(isActivePath('/cockpit/clients', '/cockpit/clients')).toBe(true)
    expect(isActivePath('/cockpit/clients/12/edit', '/cockpit/clients')).toBe(true)
    expect(isActivePath('/tasksx', '/cockpit/tasks')).toBe(false)
  })

  it('označí aktivní položku aria-current a navigace má název', () => {
    pathname.value = '/cockpit/clients/5'
    const html = renderToStaticMarkup(<Sidebar name="Viktor" />)
    expect(html).toContain('aria-label="Hlavní navigace"')
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/cockpit\/clients"|<a[^>]*href="\/cockpit\/clients"[^>]*aria-current="page"/)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('na mobilu je účet (a sekce mimo lištu) za tlačítkem „Další“ (zavřeno, aria-expanded=false)', () => {
    pathname.value = '/'
    const html = renderToStaticMarkup(<Sidebar name="Viktor" />)
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>[\s\S]*?Další<\/span><\/button>/)
  })

  it('ikony jsou skryté před čtečkou (text položky stačí)', () => {
    pathname.value = '/'
    const html = renderToStaticMarkup(<Sidebar name="Viktor" isAdmin canSeeSales />)
    const svgs = html.match(/<svg[^>]*>/g) ?? []
    expect(svgs.length).toBeGreaterThan(0)
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"')
  })
})

describe('layout aplikace', () => {
  it('má odkaz „Přeskočit na obsah“ na #main a main s id="main"', () => {
    const src = readFileSync('app/cockpit/layout.tsx', 'utf8')
    expect(src).toContain('href="#main"')
    expect(src).toContain('Přeskočit na obsah')
    expect(src).toMatch(/<main id="main" tabIndex=\{-1\}/)
    // skip link musí být v DOM před navigací, aby byl první na Tab
    expect(src.indexOf('href="#main"')).toBeLessThan(src.indexOf('<Sidebar'))
  })
})
