import { afterEach, expect, test } from 'vitest'
import {
  codeChallengeS256,
  exchangeCodeForToken,
  generateCodeVerifier,
  generateNonce,
  getAuthUrl,
  safeEqual,
} from '@/connectors/graph'

test('S256 challenge matches the RFC 7636 appendix B test vector', () => {
  expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
    .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('nonce is 64 hex chars and differs between calls', () => {
  const a = generateNonce()
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(generateNonce()).not.toBe(a)
})

test('code verifier is 43 base64url chars (RFC 7636 unreserved set) and differs between calls', () => {
  const v = generateCodeVerifier()
  expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(generateCodeVerifier()).not.toBe(v)
})

test('challenge of a generated verifier has no padding and is 43 chars', () => {
  expect(codeChallengeS256(generateCodeVerifier())).toMatch(/^[A-Za-z0-9_-]{43}$/)
})

test('safeEqual accepts equal strings and rejects different ones', () => {
  expect(safeEqual('abc', 'abc')).toBe(true)
  expect(safeEqual('abc', 'abd')).toBe(false)
})

test('safeEqual does not throw on different lengths', () => {
  expect(safeEqual('abc', 'abcd')).toBe(false)
})

test('safeEqual never matches missing or empty values', () => {
  expect(safeEqual(undefined, undefined)).toBe(false)
  expect(safeEqual(null, 'x')).toBe(false)
  expect(safeEqual('', '')).toBe(false)
})

const OLD_ENV = { ...process.env }
afterEach(() => { process.env = { ...OLD_ENV }; })

test('getAuthUrl adds S256 challenge only when given', () => {
  process.env.MS_CLIENT_ID = 'cid'
  const withPkce = new URL(getAuthUrl('http://x/cb', 'st', 'chal'))
  expect(withPkce.searchParams.get('code_challenge')).toBe('chal')
  expect(withPkce.searchParams.get('code_challenge_method')).toBe('S256')
  expect(withPkce.searchParams.get('state')).toBe('st')
  const without = new URL(getAuthUrl('http://x/cb', 'st'))
  expect(without.searchParams.has('code_challenge')).toBe(false)
})

test('exchangeCodeForToken sends code_verifier in the token request', async () => {
  const realFetch = globalThis.fetch
  let sent = ''
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = String(init?.body)
    return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 })
  }) as typeof fetch
  try {
    await exchangeCodeForToken('code', 'http://x/cb', 'verif')
    expect(new URLSearchParams(sent).get('code_verifier')).toBe('verif')
    await exchangeCodeForToken('code', 'http://x/cb')
    expect(new URLSearchParams(sent).has('code_verifier')).toBe(false)
  } finally {
    globalThis.fetch = realFetch
  }
})
