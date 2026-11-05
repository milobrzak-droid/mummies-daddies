import { beforeEach, describe, expect, test, vi } from 'vitest'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { approveOAuth } from '@/lib/actions/oauth'
import { updateMyPassword } from '@/lib/actions/security'
import { verifyFactor } from '@/lib/actions/mfa'
import { createSupabaseFake, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Server akce kolem přihlášení a OAuth: schválení připojení externí aplikace
// (jen admin s AAL2, klient a redirect_uri ověřené proti DB), změna hesla
// a ověření TOTP kódu. Supabase je fake, redirect vyhazuje jako v Next.

class RedirectError extends Error { constructor(public url: string) { super(`redirect:${url}`) } }

vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new RedirectError(url) }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers({ host: 'cockpit.example' })) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: 'admin-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))

const ok = (data: unknown): QueryResult => ({ data, error: null })
const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

describe('approveOAuth', () => {
  const OAUTH = { client_id: 'c1', redirect_uri: 'https://claude.ai/cb', code_challenge: 'ch', state: 'st-1' }
  let user: ReturnType<typeof createSupabaseFake>
  let admin: ReturnType<typeof createSupabaseFake>
  let isAdmin: boolean
  let role: string | null
  let clientRow: unknown
  let insertError: unknown

  beforeEach(() => {
    vi.clearAllMocks()
    isAdmin = true
    role = 'vedeni'
    clientRow = { client_id: 'c1', redirect_uris: ['https://claude.ai/cb'] }
    insertError = null
    user = createSupabaseFake({ resolve: () => ok({ is_admin: isAdmin, role }) })
    admin = createSupabaseFake({
      resolve: (c: QueryCall) => (c.table === 'oauth_client' ? ok(clientRow) : { data: null, error: insertError }),
    })
    vi.mocked(createClient).mockResolvedValue(user.client as never)
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
  })

  test('bez AAL2 přihlášení → přesměrování na login, nic se nevydá', async () => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    await expect(approveOAuth(form(OAUTH))).rejects.toThrow('redirect:/login')
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(admin.from).not.toHaveBeenCalled()
  })

  test('ne-admin nesmí schválit', async () => {
    isAdmin = false
    await expect(approveOAuth(form(OAUTH))).rejects.toThrow('Nemáš oprávnění')
    expect(admin.from).not.toHaveBeenCalled()
  })

  test.each(['client_id', 'redirect_uri', 'code_challenge'])('chybí %s → neplatný požadavek', async (field) => {
    await expect(approveOAuth(form({ ...OAUTH, [field]: '' }))).rejects.toThrow('Neplatný požadavek.')
    expect(admin.from).not.toHaveBeenCalled()
  })

  test('neznámý klient → chyba', async () => {
    clientRow = null
    await expect(approveOAuth(form(OAUTH))).rejects.toThrow('Neznámý klient.')
  })

  test('redirect_uri, které klient nezaregistroval → chyba, kód nevznikne', async () => {
    await expect(approveOAuth(form({ ...OAUTH, redirect_uri: 'https://evil.example/cb' }))).rejects.toThrow('Neznámý klient.')
    expect(admin.calls.some((c) => c.table === 'oauth_code')).toBe(false)
  })

  test('úspěch: jednorázový kód se schvalovatelem a krátkou platností, redirect s code a state', async () => {
    const before = Date.now()
    const err = await approveOAuth(form(OAUTH)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RedirectError)
    const target = new URL((err as RedirectError).url)
    expect(`${target.origin}${target.pathname}`).toBe('https://claude.ai/cb')
    expect(target.searchParams.get('state')).toBe('st-1')
    const code = target.searchParams.get('code')
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const insert = admin.calls.find((c) => c.table === 'oauth_code')!
    const row = opArgs(insert, 'insert')![0] as Record<string, unknown>
    expect(row).toMatchObject({ code, client_id: 'c1', redirect_uri: 'https://claude.ai/cb', code_challenge: 'ch', approved_by: 'admin-1' })
    const ttl = Date.parse(row.expires_at as string) - before
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(61_000)
  })

  const storedScope = (): unknown => {
    const insert = admin.calls.find((c) => c.table === 'oauth_code')!
    return (opArgs(insert, 'insert')![0] as Record<string, unknown>).scope
  }

  test('rozsah: bez volby se uloží read', async () => {
    await approveOAuth(form(OAUTH)).catch(() => undefined)
    expect(storedScope()).toBe('read')
  })

  test('rozsah full od schvalovatele s obchodní rolí se uloží do kódu', async () => {
    await approveOAuth(form({ ...OAUTH, scope: 'full' })).catch(() => undefined)
    expect(storedScope()).toBe('full')
  })

  test('rozsah full od admina bez obchodní role → chyba, kód nevznikne', async () => {
    role = 'lektor'
    await expect(approveOAuth(form({ ...OAUTH, scope: 'full' }))).rejects.toThrow('obchodní rolí')
    expect(admin.calls.some((c) => c.table === 'oauth_code')).toBe(false)
  })

  test('neznámá hodnota rozsahu se bere jako read', async () => {
    await approveOAuth(form({ ...OAUTH, scope: 'admin' })).catch(() => undefined)
    expect(storedScope()).toBe('read')
  })

  test('bez state se state do redirectu nepřidá', async () => {
    const err = await approveOAuth(form({ ...OAUTH, state: '' })).catch((e: unknown) => e) as RedirectError
    expect(new URL(err.url).searchParams.has('state')).toBe(false)
  })

  test('chyba zápisu kódu → obecná hláška, žádný redirect', async () => {
    insertError = { code: 'XX000', message: 'secret' }
    await expect(approveOAuth(form(OAUTH))).rejects.toThrow('Operace se nezdařila')
    expect(redirect).not.toHaveBeenCalled()
  })
})

describe('updateMyPassword', () => {
  let s: ReturnType<typeof createSupabaseFake> & { updateUser: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    vi.clearAllMocks()
    const f = createSupabaseFake()
    const updateUser = vi.fn(async () => ({ error: null as unknown }))
    Object.assign(f.client.auth, { updateUser })
    s = Object.assign(f, { updateUser })
    vi.mocked(createClient).mockResolvedValue(f.client as never)
  })

  test('bez AAL2 → auth chyba', async () => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    expect(await updateMyPassword(null, form({ password: 'dlouhéheslo', confirm: 'dlouhéheslo' }))).toEqual({ success: false, error: 'auth' })
    expect(s.updateUser).not.toHaveBeenCalled()
  })
  test('krátké heslo a neshoda', async () => {
    expect((await updateMyPassword(null, form({ password: '1234567', confirm: '1234567' }))).error).toMatch(/8 znaků/)
    expect((await updateMyPassword(null, form({ password: '12345678', confirm: '12345679' }))).error).toBe('Hesla se neshodují.')
    expect(s.updateUser).not.toHaveBeenCalled()
  })
  test('úspěch předá heslo Supabase Auth', async () => {
    expect(await updateMyPassword(null, form({ password: '12345678', confirm: '12345678' }))).toEqual({ success: true })
    expect(s.updateUser).toHaveBeenCalledWith({ password: '12345678' })
  })
  test('chyba Auth → obecná hláška', async () => {
    s.updateUser.mockResolvedValueOnce({ error: { message: 'Password is known to be weak' } })
    expect(await updateMyPassword(null, form({ password: '12345678', confirm: '12345678' }))).toEqual({ success: false, error: expect.stringMatching(/nezdařila/) })
  })
})

describe('verifyFactor', () => {
  const challenge = vi.fn()
  const verify = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    challenge.mockResolvedValue({ data: { id: 'ch-1' }, error: null })
    verify.mockResolvedValue({ error: null })
    vi.mocked(createClient).mockResolvedValue({ auth: { mfa: { challenge, verify } } } as never)
    // Brzda (insert-then-count): zápis pokusu vrátí id, počet pokusů v okně = 1.
    vi.mocked(createAdminClient).mockReturnValue(
      createSupabaseFake({ resolve: () => ({ data: { id: 1 }, error: null, count: 1 }) }).client as never,
    )
  })

  test('stačí AAL1 přihlášení (AAL2 z něj teprve vzniká)', async () => {
    await verifyFactor('f1', null, null, form({ code: '123456' })).catch(() => {})
    // allowExternal (0082): Partner si k datům přístup nezíská, ale 2FA si nastavit musí.
    expect(tryRequireUser).toHaveBeenCalledWith({ allowExternal: true })
  })
  test('kód jen 6 číslic', async () => {
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      expect(await verifyFactor('f1', null, null, form({ code }))).toEqual({ success: false, error: 'Zadej 6místný kód z aplikace.' })
    }
    expect(challenge).not.toHaveBeenCalled()
  })
  test('nesprávný kód → hláška, žádný redirect', async () => {
    verify.mockResolvedValueOnce({ error: { message: 'invalid' } })
    expect(await verifyFactor('f1', null, null, form({ code: ' 123456 ' }))).toEqual({ success: false, error: 'Nesprávný kód. Zkus to znovu.' })
    expect(verify).toHaveBeenCalledWith({ factorId: 'f1', challengeId: 'ch-1', code: '123456' })
  })
  test('úspěch přesměruje na bezpečné next, cizí doména se zahodí', async () => {
    await expect(verifyFactor('f1', '/api/oauth/authorize?client_id=c1', null, form({ code: '123456' })))
      .rejects.toThrow('redirect:/api/oauth/authorize?client_id=c1')
    const err = await verifyFactor('f1', 'https://evil.example/x', null, form({ code: '123456' })).catch((e: unknown) => e) as RedirectError
    expect(err.url).not.toContain('evil.example')
  })
  test('selhání výzvy → hláška', async () => {
    challenge.mockResolvedValueOnce({ data: null, error: { message: 'Factor not found' } })
    expect(await verifyFactor('f1', null, null, form({ code: '123456' }))).toEqual({ success: false, error: 'Factor not found' })
  })
})
