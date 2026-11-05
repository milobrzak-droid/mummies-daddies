import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { isAllowedRedirectUri, verifyPkceS256, checkRegisterRate, REGISTER_LIMIT, baseUrlFrom } from '@/lib/oauth'

describe('isAllowedRedirectUri', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'http://localhost:6274/callback',
    'http://127.0.0.1:33418/cb',
  ])('povolí %s', (u) => expect(isAllowedRedirectUri(u)).toBe(true))

  it.each([
    'http://evil.example.com/cb',
    'javascript:alert(1)',
    'data:text/html,x',
    'myapp://callback',
    'http://localhost.evil.com/cb',
    'https://claude.ai/cb#frag',
    'not a url',
  ])('odmítne %s', (u) => expect(isAllowedRedirectUri(u)).toBe(false))
})

describe('verifyPkceS256', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  it('správný verifier projde', () => expect(verifyPkceS256(verifier, challenge)).toBe(true))
  it('špatný verifier neprojde', () => expect(verifyPkceS256('x' + verifier, challenge)).toBe(false))
  it('jiná délka challenge neprojde (a nehodí výjimku)', () => {
    expect(verifyPkceS256(verifier, challenge.slice(1))).toBe(false)
    expect(verifyPkceS256(verifier, '')).toBe(false)
  })
})

describe('checkRegisterRate', () => {
  it('pustí REGISTER_LIMIT registrací z IP, pak odmítne; jiná IP nezávisle', () => {
    const now = 1_000_000
    for (let i = 0; i < REGISTER_LIMIT; i++) expect(checkRegisterRate('1.2.3.4', now)).toBe(true)
    expect(checkRegisterRate('1.2.3.4', now)).toBe(false)
    expect(checkRegisterRate('5.6.7.8', now)).toBe(true)
    // Po uplynutí okna znovu povoleno.
    expect(checkRegisterRate('1.2.3.4', now + 60 * 60_000 + 1)).toBe(true)
  })
})

describe('baseUrlFrom', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('APP_URL má přednost před x-forwarded-host', () => {
    vi.stubEnv('APP_URL', 'https://cockpit.example.cz/')
    const req = new Request('http://internal/x', { headers: { 'x-forwarded-host': 'evil.com' } })
    expect(baseUrlFrom(req)).toBe('https://cockpit.example.cz')
  })
  it('bez APP_URL se odvodí z požadavku', () => {
    vi.stubEnv('APP_URL', '')
    const req = new Request('http://internal/x', { headers: { 'x-forwarded-host': 'a.cz', 'x-forwarded-proto': 'https' } })
    expect(baseUrlFrom(req)).toBe('https://a.cz')
  })
})
