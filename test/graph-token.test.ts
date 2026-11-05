import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { logError } from '@/lib/log'
import { graphTokenForCurrentUser, refreshAccessToken } from '@/connectors/graph'
import { createSupabaseFake, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
// token.ts bere refreshAccessToken z './client'; ostatní exporty klienta zůstávají skutečné.
vi.mock('@/connectors/graph/client', async importOriginal => ({
  ...(await importOriginal<typeof import('@/connectors/graph/client')>()),
  refreshAccessToken: vi.fn(),
}))

const NOW = new Date('2026-09-28T12:00:00.000Z')
const NEW_ACCESS = 'new-access-token-SECRET'
const NEW_REFRESH = 'new-refresh-token-SECRET'

function tokenRow(expiresAt: string | null) {
  return { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: expiresAt }
}

function setup(opts: { user?: { id: string } | null; rows?: unknown; update?: QueryResult } = {}) {
  const fake = createSupabaseFake({
    user: opts.user === undefined ? { id: 'member-1' } : opts.user,
    rpc: name => {
      if (name === 'calendar_token_get_decrypted') return { data: opts.rows ?? null, error: null }
      if (name === 'calendar_token_update_tokens') return opts.update ?? { data: null, error: null }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const updateCalls = (fake: ReturnType<typeof setup>) =>
  fake.rpc.mock.calls.filter(([name]) => name === 'calendar_token_update_tokens')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(refreshAccessToken).mockResolvedValue({
    access_token: NEW_ACCESS,
    refresh_token: NEW_REFRESH,
    expires_in: 3600,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('graphTokenForCurrentUser', () => {
  test('not logged in: failure, no RPC', async () => {
    const fake = setup({ user: null })
    const res = await graphTokenForCurrentUser()
    expect(res).toEqual({ ok: false, error: 'Nejsi přihlášený.' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test.each([
    ['no rows', null],
    ['empty rows', []],
    ['row without refresh token', [{ access_token: 'a', refresh_token: null, expires_at: null }]],
  ])('Outlook not connected (%s): failure without refresh', async (_label, rows) => {
    setup({ rows })
    const res = await graphTokenForCurrentUser()
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Outlook není připojený') })
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  test('unexpired token is returned as is, without refresh or write', async () => {
    const fake = setup({ rows: [tokenRow(new Date(NOW.getTime() + 60_000).toISOString())] })
    const res = await graphTokenForCurrentUser()
    expect(res).toEqual({ ok: true, accessToken: 'old-access' })
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(updateCalls(fake)).toHaveLength(0)
  })

  test('expired token whose refresh fails: failure, nothing is written', async () => {
    const fake = setup({ rows: [tokenRow(new Date(NOW.getTime() - 60_000).toISOString())] })
    vi.mocked(refreshAccessToken).mockResolvedValue(null)
    const res = await graphTokenForCurrentUser()
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('vypršelo') })
    expect(updateCalls(fake)).toHaveLength(0)
  })

  test('token without expires_at counts as expired and is refreshed', async () => {
    setup({ rows: [tokenRow(null)] })
    const res = await graphTokenForCurrentUser()
    expect(refreshAccessToken).toHaveBeenCalledWith('old-refresh')
    expect(res).toEqual({ ok: true, accessToken: NEW_ACCESS })
  })

  test('refresh + successful save: returns the new token and stores both tokens with a new expiry', async () => {
    const fake = setup({ rows: [tokenRow(new Date(NOW.getTime() - 1).toISOString())] })
    const res = await graphTokenForCurrentUser()
    expect(res).toEqual({ ok: true, accessToken: NEW_ACCESS })
    expect(updateCalls(fake)).toEqual([[
      'calendar_token_update_tokens',
      {
        p_member_id: 'member-1',
        p_access_token: NEW_ACCESS,
        p_refresh_token: NEW_REFRESH,
        p_expires_at: new Date(NOW.getTime() + 3600 * 1000).toISOString(),
      },
    ]])
    expect(logError).not.toHaveBeenCalled()
  })

  test('refresh ok but calendar_token_update_tokens errors: logs and returns failure, not the new token', async () => {
    const updateError = { message: 'vault key unavailable' }
    setup({
      rows: [tokenRow(new Date(NOW.getTime() - 1).toISOString())],
      update: { data: null, error: updateError },
    })
    const res = await graphTokenForCurrentUser()

    expect(res.ok).toBe(false)
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Nepodařilo se uložit') })
    // Nový (nepersistovaný) token nesmí uniknout ani ve formě chyby.
    expect(JSON.stringify(res)).not.toContain(NEW_ACCESS)
    expect(JSON.stringify(res)).not.toContain(NEW_REFRESH)
    expect(res).not.toHaveProperty('accessToken')
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('graph.tokenUpdate', updateError, { memberId: 'member-1' })
  })
})
