import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// connectors/graph/client.ts — síťové pomocníky proti mockovanému fetch.
// Žádné volání Microsoftu; kontroluje se, co by se odeslalo a jak se čte odpověď.

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { logError } from '@/lib/log'
import {
  allDayEventForDate, createCalendarEvent, createMeetingEvent, deleteCalendarEvent,
  exchangeCodeForToken, getMe, isValidTenantId, msConfigured, refreshAccessToken, updateCalendarEvent,
} from '@/connectors/graph'

const fetchMock = vi.fn()
const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit]
const formOf = (init: RequestInit) => new URLSearchParams(String(init.body))

const ENV_KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(logError).mockClear()
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.MS_CLIENT_ID = 'client-id'
  process.env.MS_CLIENT_SECRET = 'secret'
  delete process.env.MS_TENANT_ID
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

test('msConfigured vyžaduje client id i secret', () => {
  expect(msConfigured()).toBe(true)
  delete process.env.MS_CLIENT_SECRET
  expect(msConfigured()).toBe(false)
  process.env.MS_CLIENT_SECRET = 'secret'
  process.env.MS_CLIENT_ID = ''
  expect(msConfigured()).toBe(false)
})

describe('exchangeCodeForToken', () => {
  test('pošle kód, verifier a tenant; vrátí tokeny i udělený scope', async () => {
    process.env.MS_TENANT_ID = 'mummiesdaddies.com'
    fetchMock.mockResolvedValue(json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'Mail.Read' }))
    const r = await exchangeCodeForToken('the-code', 'https://app/cb', 'verifier')
    expect(r).toEqual({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'Mail.Read' })
    const [url, init] = lastCall()
    expect(url).toBe('https://login.microsoftonline.com/mummiesdaddies.com/oauth2/v2.0/token')
    const form = formOf(init)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('the-code')
    expect(form.get('code_verifier')).toBe('verifier')
    expect(form.get('redirect_uri')).toBe('https://app/cb')
  })

  test('bez verifieru ho neposílá; tenant výchozí common; scope jen když je string', async () => {
    fetchMock.mockResolvedValue(json(200, { access_token: 'a', refresh_token: 'r', expires_in: 1, scope: 42 }))
    const r = await exchangeCodeForToken('c', 'https://app/cb')
    expect(r).toEqual({ access_token: 'a', refresh_token: 'r', expires_in: 1 })
    const [url, init] = lastCall()
    expect(url).toContain('/common/oauth2/v2.0/token')
    expect(formOf(init).has('code_verifier')).toBe(false)
  })

  test('chybějící refresh token nebo HTTP chyba → null', async () => {
    fetchMock.mockResolvedValue(json(200, { access_token: 'a' }))
    expect(await exchangeCodeForToken('c', 'u')).toBeNull()
    fetchMock.mockResolvedValue(json(400, { error: 'invalid_grant' }))
    expect(await exchangeCodeForToken('c', 'u')).toBeNull()
  })

  test('síťová výjimka → null a zalogovaná chyba', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    expect(await exchangeCodeForToken('c', 'u')).toBeNull()
    expect(logError).toHaveBeenCalledWith('graph.exchangeCodeForToken', expect.any(Error))
  })
})

describe('refreshAccessToken', () => {
  test('Microsoft token nerotoval → zůstane starý refresh token', async () => {
    fetchMock.mockResolvedValue(json(200, { access_token: 'new', expires_in: 10 }))
    expect(await refreshAccessToken('old')).toEqual({ access_token: 'new', refresh_token: 'old', expires_in: 10 })
    const form = formOf(lastCall()[1])
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('old')
  })

  test('rotovaný refresh token se použije', async () => {
    fetchMock.mockResolvedValue(json(200, { access_token: 'new', refresh_token: 'rotated', expires_in: 10 }))
    expect((await refreshAccessToken('old'))?.refresh_token).toBe('rotated')
  })

  test('bez access tokenu, HTTP chyba i výjimka → null', async () => {
    fetchMock.mockResolvedValue(json(200, {}))
    expect(await refreshAccessToken('old')).toBeNull()
    fetchMock.mockResolvedValue(json(401, {}))
    expect(await refreshAccessToken('old')).toBeNull()
    fetchMock.mockRejectedValue(new Error('x'))
    expect(await refreshAccessToken('old')).toBeNull()
  })
})

describe('getMe', () => {
  test('pošle Bearer token a vrátí profil', async () => {
    fetchMock.mockResolvedValue(json(200, { mail: 'viktor@mummiesdaddies.com' }))
    expect(await getMe('tok')).toEqual({ mail: 'viktor@mummiesdaddies.com' })
    expect((lastCall()[1].headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })
  test('403 i výjimka → null', async () => {
    fetchMock.mockResolvedValue(json(403, {}))
    expect(await getMe('tok')).toBeNull()
    fetchMock.mockRejectedValue(new Error('x'))
    expect(await getMe('tok')).toBeNull()
  })
})

const EVENT = allDayEventForDate('Úkol', '2026-09-30')

describe('události kalendáře', () => {
  test('createMeetingEvent vrací id a Teams odkaz, bez odkazu null', async () => {
    fetchMock.mockResolvedValue(json(201, { id: 'ev1', onlineMeeting: { joinUrl: 'https://teams/x' } }))
    expect(await createMeetingEvent('t', EVENT)).toEqual({ id: 'ev1', joinUrl: 'https://teams/x' })
    fetchMock.mockResolvedValue(json(201, { id: 'ev2' }))
    expect(await createMeetingEvent('t', EVENT)).toEqual({ id: 'ev2', joinUrl: null })
  })

  test('createMeetingEvent: odpověď bez id, HTTP chyba i výjimka → null', async () => {
    fetchMock.mockResolvedValue(json(201, {}))
    expect(await createMeetingEvent('t', EVENT)).toBeNull()
    fetchMock.mockResolvedValue(json(500, {}))
    expect(await createMeetingEvent('t', EVENT)).toBeNull()
    fetchMock.mockRejectedValue(new Error('timeout'))
    expect(await createMeetingEvent('t', EVENT)).toBeNull()
  })

  test('createCalendarEvent posílá JSON tělo a vrací id', async () => {
    fetchMock.mockResolvedValue(json(201, { id: 'ev3' }))
    expect(await createCalendarEvent('t', EVENT)).toBe('ev3')
    const [url, init] = lastCall()
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(EVENT)
    fetchMock.mockResolvedValue(json(201, {}))
    expect(await createCalendarEvent('t', EVENT)).toBeNull()
    fetchMock.mockResolvedValue(json(400, {}))
    expect(await createCalendarEvent('t', EVENT)).toBeNull()
  })

  test('updateCalendarEvent escapuje id v cestě', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    expect(await updateCalendarEvent('t', 'AAMk/../x?y=1', { subject: 'Nový' })).toBe(true)
    const [url, init] = lastCall()
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/events/AAMk%2F..%2Fx%3Fy%3D1')
    expect(init.method).toBe('PATCH')
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    expect(await updateCalendarEvent('t', 'id', {})).toBe(false)
    fetchMock.mockRejectedValue(new Error('x'))
    expect(await updateCalendarEvent('t', 'id', {})).toBe(false)
  })

  test('deleteCalendarEvent: 204 i 404 (už smazaná) = úspěch, jinak false', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    expect(await deleteCalendarEvent('t', 'id')).toBe(true)
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    expect(await deleteCalendarEvent('t', 'id')).toBe(true)
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }))
    expect(await deleteCalendarEvent('t', 'id')).toBe(false)
    fetchMock.mockRejectedValue(new Error('x'))
    expect(await deleteCalendarEvent('t', 'id')).toBe(false)
  })
})

describe('allDayEventForDate', () => {
  test('celý den od půlnoci do půlnoci dalšího dne v pásmu firmy', () => {
    expect(EVENT).toEqual({
      subject: 'Úkol',
      start: { dateTime: '2026-09-30T00:00:00', timeZone: 'Europe/Prague' },
      end: { dateTime: '2026-10-01T00:00:00', timeZone: 'Europe/Prague' },
      isAllDay: true,
    })
  })
  test('přelom roku, přestupný rok a den změny času', () => {
    expect(allDayEventForDate('x', '2026-12-31').end.dateTime).toBe('2027-01-01T00:00:00')
    expect(allDayEventForDate('x', '2028-02-28').end.dateTime).toBe('2028-02-29T00:00:00')
    expect(allDayEventForDate('x', '2026-10-25').end.dateTime).toBe('2026-10-26T00:00:00')
  })
  test('tělo jen když je neprázdné', () => {
    expect(allDayEventForDate('x', '2026-01-01', 'Poznámka').body).toEqual({ contentType: 'text', content: 'Poznámka' })
    expect('body' in allDayEventForDate('x', '2026-01-01', '')).toBe(false)
  })
})

describe('isValidTenantId (app-only odesílání)', () => {
  test('GUID a doménová jména projdou', () => {
    expect(isValidTenantId('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0')).toBe(true)
    expect(isValidTenantId('mummiesdaddies.com')).toBe(true)
    expect(isValidTenantId('enter.onmicrosoft.com')).toBe(true)
  })
  test('common/organizations, prázdné a cesty neprojdou', () => {
    for (const bad of ['common', 'organizations', '', 'mummiesdaddies.com/../x', 'a b.cz', '-bad.cz', 'mummiesdaddies.', '0f1e2d3c-4b5a-6978-8796']) {
      expect(isValidTenantId(bad), bad).toBe(false)
    }
  })
})
