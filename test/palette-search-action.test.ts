import { beforeEach, describe, expect, test, vi } from 'vitest'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { search, type SearchResult } from '@/domain/crm/queries/search'
import { searchPalette } from '@/domain/crm/actions/paletteSearch'

vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'Nejsi přihlášený.' }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/crm/queries/search', async (orig) => ({
  ...(await orig<typeof import('@/domain/crm/queries/search')>()),
  search: vi.fn(),
}))

const r = (kind: SearchResult['kind'], id: number): SearchResult => ({
  kind, id, title: `${kind} ${id}`, subtitle: null, href: `/x/${id}`,
})
const FOUND = {
  accounts: [1, 2, 3, 4, 5, 6].map((i) => r('account', i)),
  contacts: [r('contact', 1)],
  deals: [r('deal', 1)],
  partners: [r('partner', 1)],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(canCurrentUserSeeSales).mockResolvedValue(true)
  vi.mocked(search).mockResolvedValue(FOUND)
})

describe('searchPalette', () => {
  test('nepřihlášený nedostane nic a hledání se nespustí', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const res = await searchPalette('acme')
    expect(res).toEqual({ ok: false, error: 'Nejsi přihlášený.' })
    expect(search).not.toHaveBeenCalled()
  })

  test('vyžaduje AAL2', async () => {
    await searchPalette('acme')
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
  })

  test('krátký nebo nesmyslný dotaz nespouští hledání', async () => {
    expect(await searchPalette('a')).toEqual({ ok: true, items: [] })
    expect(await searchPalette(42)).toEqual({ ok: true, items: [] })
    expect(await searchPalette('x'.repeat(101))).toEqual({ ok: true, items: [] })
    expect(search).not.toHaveBeenCalled()
  })

  test('obchodní role dostane i obchody, skupiny jsou oříznuté', async () => {
    const res = await searchPalette('  acme ')
    expect(search).toHaveBeenCalledWith('acme', { includeDeals: true })
    expect(res.ok && res.items.filter((i) => i.kind === 'account')).toHaveLength(4)
    expect(res.ok && res.items.some((i) => i.kind === 'deal')).toBe(true)
  })

  test('bez obchodní role se obchody nehledají a nevrací', async () => {
    vi.mocked(canCurrentUserSeeSales).mockResolvedValue(false)
    // i kdyby hledání obchody omylem vrátilo, akce je zahodí
    const res = await searchPalette('acme')
    expect(search).toHaveBeenCalledWith('acme', { includeDeals: false })
    expect(res.ok && res.items.some((i) => i.kind === 'deal')).toBe(false)
  })

  test('chyba hledání se vrátí jako hláška, ne jako výjimka', async () => {
    vi.mocked(search).mockRejectedValue(new Error('db down'))
    const res = await searchPalette('acme')
    expect(res).toEqual({ ok: false, error: 'Hledání se nepovedlo. Zkus to znovu.' })
  })
})
