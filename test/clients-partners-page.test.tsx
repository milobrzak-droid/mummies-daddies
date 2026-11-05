import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import PartnersPage from '@/app/cockpit/partners/page'
import { listPartners, listRegistrations } from '@/domain/crm/queries/partners'

// /partners: jedna hlavní akce, řádek partnera je celý odkazem na kartu
// partnera, prázdná evidence nabídne založení.

vi.mock('@/domain/crm/queries/partners', () => ({ listPartners: vi.fn(), listRegistrations: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/partners' }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

beforeEach(() => vi.clearAllMocks())

describe('/cockpit/partners', () => {
  test('seznam: jeden odkaz na řádek roztažený přes celý řádek, jedna hlavní akce', async () => {
    vi.mocked(listPartners).mockResolvedValue([
      { id: 4, name: 'Microsoft', kind: 'IT', is_referrer: true, roles: ['referrer'], via_partner_id: null, created_at: '2026-01-01', via: null },
    ] as never)
    vi.mocked(listRegistrations).mockResolvedValue([])
    const html = renderToStaticMarkup(await PartnersPage())
    expect(html).toMatch(/<tr class="relative[^"]*"/)
    expect(html).toMatch(/<a href="\/cockpit\/partners\/4\/edit" class="[^"]*after:absolute after:inset-0/)
    expect(html.match(/btn-primary/g)).toHaveLength(1)
    expect(html).toContain('href="/cockpit/partners/new"')
    expect(html).toContain('Zatím žádné registrace v programech.')
  })

  test('prázdná evidence: prázdný stav s akcí Založit partnera', async () => {
    vi.mocked(listPartners).mockResolvedValue([])
    vi.mocked(listRegistrations).mockResolvedValue([])
    const html = renderToStaticMarkup(await PartnersPage())
    expect(html).toContain('Zatím žádní partneři.')
    expect(html).toMatch(/<a href="\/cockpit\/partners\/new" class="btn btn-outline[^"]*">Založit partnera<\/a>/)
  })
})
