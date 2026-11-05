import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryDb } from './helpers/memoryDb'

// Bezpečnostní revize S2: brzda hádání TOTP kódu musí platit i pro souběžné
// pokusy z jedné session. Pokus se zapíše dřív, než se ověřuje (insert-then-
// count), takže víc než MAX pokusů k ověření nedojde ani při desítkách
// paralelních požadavků.

let db: MemoryDb
class RedirectError extends Error { constructor(public url: string) { super(`redirect:${url}`) } }
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new RedirectError(url) }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers({ host: 'cockpit.example' })) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: 'u1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))

const challenge = vi.fn()
const verify = vi.fn()
const signOut = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { mfa: { challenge, verify }, signOut } }),
}))

import { verifyFactor } from '@/lib/actions/mfa'

const form = (code: string) => { const fd = new FormData(); fd.set('code', code); return fd }
const WRONG = 'Nesprávný kód. Zkus to znovu.'
const LOCKED = 'Příliš mnoho nesprávných kódů. Přihlas se znovu za 10 minut.'

beforeEach(() => {
  db = new MemoryDb({ defaults: { mfa_failure: () => ({ at: new Date().toISOString() }) } })
  challenge.mockReset().mockImplementation(async () => {
    // Skutečná síť dá ostatním požadavkům šanci se prokládat.
    await new Promise((r) => setTimeout(r, 1))
    return { data: { id: 'ch' }, error: null }
  })
  verify.mockReset().mockResolvedValue({ error: { message: 'invalid' } })
  signOut.mockClear()
})

describe('brzda 2FA', () => {
  it('sekvenčně: 5 chybných pokusů projde k ověření, šestý je zamčen a nevolá verify', async () => {
    for (let i = 0; i < 5; i++) expect(await verifyFactor('f', null, null, form('123456'))).toEqual({ success: false, error: WRONG })
    expect(await verifyFactor('f', null, null, form('123456'))).toEqual({ success: false, error: LOCKED })
    expect(verify).toHaveBeenCalledTimes(5)
    expect(signOut).toHaveBeenCalled()
  })

  it('souběh: 60 paralelních pokusů = nejvýš 5 volání verify, ostatní zamčené', async () => {
    const results = await Promise.all(Array.from({ length: 60 }, () => verifyFactor('f', null, null, form('123456'))))
    expect(verify.mock.calls.length).toBeLessThanOrEqual(5)
    expect(results.filter((r) => r && 'error' in r && r.error === WRONG).length).toBeLessThanOrEqual(5)
    expect(results.filter((r) => r && 'error' in r && r.error === LOCKED).length).toBeGreaterThanOrEqual(55)
  })

  it('zamítnuté pokusy zámek neprodlužují: v tabulce zůstanou jen pokusy, které došly k ověření', async () => {
    await Promise.all(Array.from({ length: 30 }, () => verifyFactor('f', null, null, form('123456'))))
    expect(db.rows('mfa_failure').length).toBeLessThanOrEqual(5)
  })

  it('jiný uživatel se nezamyká', async () => {
    for (let i = 0; i < 6; i++) await verifyFactor('f', null, null, form('123456'))
    db.seed('mfa_failure', [])
    const { tryRequireUser } = await import('@/lib/auth/requireUser')
    vi.mocked(tryRequireUser).mockResolvedValueOnce({ id: 'u2' } as never)
    expect(await verifyFactor('f', null, null, form('123456'))).toEqual({ success: false, error: WRONG })
  })

  it('úspěch smaže pokusy a přesměruje', async () => {
    for (let i = 0; i < 3; i++) await verifyFactor('f', null, null, form('123456'))
    verify.mockResolvedValue({ error: null })
    await expect(verifyFactor('f', null, null, form('123456'))).rejects.toBeInstanceOf(RedirectError)
    expect(db.rows('mfa_failure')).toHaveLength(0)
  })

  it('chyba výzvy pokus nepočítá', async () => {
    challenge.mockResolvedValue({ data: null, error: { message: 'Factor not found' } })
    for (let i = 0; i < 10; i++) expect(await verifyFactor('f', null, null, form('123456'))).toEqual({ success: false, error: 'Factor not found' })
    expect(db.rows('mfa_failure')).toHaveLength(0)
  })

  it('brzda selže zavřeně při chybě DB, ale toleruje chybějící tabulku (před 0069)', async () => {
    db = new MemoryDb({ fail: (t, op) => (t === 'mfa_failure' && op === 'insert' ? { code: '57P01', message: 'down' } : null) })
    expect(await verifyFactor('f', null, null, form('123456'))).toEqual({ success: false, error: expect.stringMatching(/nepodařilo provést/) })
    expect(verify).not.toHaveBeenCalled()

    db = new MemoryDb({ fail: (t, op) => (t === 'mfa_failure' && op === 'insert' ? { code: 'PGRST205', message: 'no table' } : null) })
    expect(await verifyFactor('f', null, null, form('123456'))).toEqual({ success: false, error: WRONG })
    expect(verify).toHaveBeenCalledTimes(1)
  })
})
