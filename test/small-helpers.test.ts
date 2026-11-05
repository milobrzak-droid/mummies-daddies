import { afterEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { mfaEnforced } from '@/lib/auth/mfa'
import { clientIp, randomToken } from '@/lib/oauth'
import { pragueLocalString, pragueLocalToUtc } from '@/lib/pragueDate'
import { isServerActionRequest, matchesSegment } from '@/lib/supabase/middleware'
import { deliveryPhaseLabel, DELIVERY_PHASES, engagementKindLabel } from '@/lib/domain'
import { MAX_ERROR_LENGTH, shortError } from '@/worker/jobRunner'
import { domainOf } from '@/domain/crm/meetingMatch'
import { quoteOrValue } from '@/domain/crm/queries/search'
import { outlookMailSyncEnabledFromEnv } from '@/domain/crm/digest'
import { pragueWeekday } from '@/domain/crm/digestDelivery'

// Drobné čisté pomocníky s větvením, které dosud neměly přímý test.

describe('mfaEnforced (nouzový vypínač)', () => {
  const saved = process.env.MFA_ENFORCED
  afterEach(() => {
    if (saved === undefined) delete process.env.MFA_ENFORCED
    else process.env.MFA_ENFORCED = saved
    vi.restoreAllMocks()
  })
  test('výchozí = vynuceno; vypne jen přesně "false" a zaloguje varování', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.MFA_ENFORCED
    expect(mfaEnforced()).toBe(true)
    for (const v of ['0', 'no', 'FALSE', '', 'true']) {
      process.env.MFA_ENFORCED = v
      expect(mfaEnforced(), v).toBe(true)
    }
    expect(warn).not.toHaveBeenCalled()
    process.env.MFA_ENFORCED = 'false'
    expect(mfaEnforced()).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('lib/oauth', () => {
  test('randomToken: base64url dané entropie, pokaždé jiný', () => {
    const t = randomToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(randomToken()).not.toBe(t)
  })
  test('clientIp: první adresa z x-forwarded-for, pak x-real-ip, jinak unknown', () => {
    const r = (h: Record<string, string>) => new Request('http://x/', { headers: h })
    expect(clientIp(r({ 'x-forwarded-for': ' 1.2.3.4 , 10.0.0.1', 'x-real-ip': '9.9.9.9' }))).toBe('1.2.3.4')
    expect(clientIp(r({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9')
    expect(clientIp(r({ 'x-forwarded-for': ' , 10.0.0.1', 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9')
    expect(clientIp(r({}))).toBe('unknown')
  })
})

describe('pragueLocalString', () => {
  test('zima +1 h, léto +2 h, půlnoc jako 00 (ne 24)', () => {
    expect(pragueLocalString(new Date('2026-01-15T09:00:00Z'))).toBe('2026-01-15T10:00:00')
    expect(pragueLocalString(new Date('2026-07-15T08:30:15Z'))).toBe('2026-07-15T10:30:15')
    expect(pragueLocalString(new Date('2026-07-14T22:00:00Z'))).toBe('2026-07-15T00:00:00')
    expect(pragueLocalString(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01T00:30:00')
  })
  test('den změny času', () => {
    expect(pragueLocalString(new Date('2026-03-29T00:59:59Z'))).toBe('2026-03-29T01:59:59')
    expect(pragueLocalString(new Date('2026-03-29T01:00:00Z'))).toBe('2026-03-29T03:00:00')
    expect(pragueLocalString(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10-25T02:30:00')
    expect(pragueLocalString(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25T02:30:00')
  })
  test('je inverzní k pragueLocalToUtc mimo přechody', () => {
    for (const local of ['2026-02-01T08:15:00', '2026-08-31T23:59:59', '2027-06-01T00:00:00']) {
      expect(pragueLocalString(pragueLocalToUtc(local))).toBe(local)
    }
  })
})

describe('middleware: segmenty cest a detekce Server Action', () => {
  test('matchesSegment: celý segment, ne prefix', () => {
    expect(matchesSegment('/login', '/login')).toBe(true)
    expect(matchesSegment('/login/mfa', '/login')).toBe(true)
    expect(matchesSegment('/loginx', '/login')).toBe(false)
    expect(matchesSegment('/api', '/api/v1')).toBe(false)
    expect(matchesSegment('/', '/login')).toBe(false)
  })
  test('isServerActionRequest: POST na stránku ano, GET/HEAD a /api, /.well-known ne', () => {
    const req = (method: string, path: string) => new NextRequest(`http://localhost${path}`, { method })
    expect(isServerActionRequest(req('POST', '/cockpit/clients'))).toBe(true)
    expect(isServerActionRequest(req('post', '/auth/mfa'))).toBe(true)
    expect(isServerActionRequest(req('PUT', '/'))).toBe(true)
    expect(isServerActionRequest(req('POST', '/apix'))).toBe(true)
    expect(isServerActionRequest(req('GET', '/cockpit/clients'))).toBe(false)
    expect(isServerActionRequest(req('HEAD', '/cockpit/clients'))).toBe(false)
    expect(isServerActionRequest(req('POST', '/api/v1/tasks'))).toBe(false)
    expect(isServerActionRequest(req('POST', '/api'))).toBe(false)
    expect(isServerActionRequest(req('POST', '/.well-known/oauth-authorization-server'))).toBe(false)
  })
})

describe('popisky číselníků', () => {
  test('deliveryPhaseLabel: známá fáze, neznámý klíč, prázdno', () => {
    expect(deliveryPhaseLabel(DELIVERY_PHASES[0].key)).toBe(DELIVERY_PHASES[0].label)
    expect(deliveryPhaseLabel('stara_faze')).toBe('stara_faze')
    expect(deliveryPhaseLabel(null)).toBe('—')
    expect(deliveryPhaseLabel(undefined)).toBe('—')
  })
  test('engagementKindLabel', () => {
    expect(engagementKindLabel('edu')).toBe('Firemní akce')
    expect(engagementKindLabel('it')).toBe('Akce')
    expect(engagementKindLabel('platform')).toBe('Pravidelný catering')
    expect(engagementKindLabel('jiny')).toBe('jiny')
    expect(engagementKindLabel(null)).toBe('—')
  })
})

test('shortError: Error i ne-Error, ořez na limit', () => {
  expect(shortError(new Error('boom'))).toBe('boom')
  expect(shortError('text')).toBe('text')
  expect(shortError({ toString: () => 'obj' })).toBe('obj')
  expect(shortError(undefined)).toBe('undefined')
  expect(shortError(new Error('x'.repeat(MAX_ERROR_LENGTH)))).toHaveLength(MAX_ERROR_LENGTH)
  expect(shortError(new Error('x'.repeat(MAX_ERROR_LENGTH + 1)))).toBe('x'.repeat(MAX_ERROR_LENGTH))
})

test('domainOf: část za posledním @, malými písmeny', () => {
  expect(domainOf('Jan@Acme.CZ')).toBe('acme.cz')
  expect(domainOf('"a@b"@firma.cz')).toBe('firma.cz')
  expect(domainOf('bez-zavinace')).toBeNull()
  expect(domainOf('konci@')).toBe('')
})

test('quoteOrValue: hodnota v uvozovkách, escapované \\ a "', () => {
  expect(quoteOrValue('%acme%')).toBe('"%acme%"')
  expect(quoteOrValue('a,b)or(id.gt.0')).toBe('"a,b)or(id.gt.0"')
  expect(quoteOrValue('say "hi"')).toBe('"say \\"hi\\""')
  expect(quoteOrValue('back\\slash')).toBe('"back\\\\slash"')
  expect(quoteOrValue('\\"')).toBe('"\\\\\\""')
})

test('outlookMailSyncEnabledFromEnv: jen přesně "true"', () => {
  expect(outlookMailSyncEnabledFromEnv({ OUTLOOK_MAIL_SYNC_ENABLED: 'true' })).toBe(true)
  for (const v of ['1', 'TRUE', 'yes', '', undefined]) {
    expect(outlookMailSyncEnabledFromEnv({ OUTLOOK_MAIL_SYNC_ENABLED: v })).toBe(false)
  }
  expect(outlookMailSyncEnabledFromEnv({})).toBe(false)
})

test('pragueWeekday: den v týdnu podle pražského kalendáře, ne UTC', () => {
  // Neděle 27. 9. 2026 23:30 UTC = pondělí 28. 9. 01:30 v Praze.
  expect(pragueWeekday(new Date('2026-09-27T23:30:00Z'))).toBe(1)
  expect(pragueWeekday(new Date('2026-09-27T21:30:00Z'))).toBe(0)
  // Zima: 23:30 UTC v pátek = sobota 00:30 v Praze.
  expect(pragueWeekday(new Date('2026-12-04T23:30:00Z'))).toBe(6)
  expect(pragueWeekday(new Date('2026-12-04T22:30:00Z'))).toBe(5)
})
