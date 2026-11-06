// Brána s heslem pro uzavřený náhled (lib/previewGate.ts).
import { describe, expect, test } from 'vitest'
import { NextRequest } from 'next/server'
import { previewCredentials, previewGate } from '@/lib/previewGate'

const req = (auth?: string) =>
  new NextRequest('https://nahled.example/cockpit', { headers: auth ? { authorization: auth } : {} })
const basic = (s: string) => 'Basic ' + Buffer.from(s, 'utf8').toString('base64')

describe('previewGate', () => {
  test('bez proměnné je vypnutá', () => {
    expect(previewGate(req(), '')).toBeNull()
    expect(previewCredentials('')).toBeNull()
  })
  test('bez hesla nebo se špatným heslem vrací 401 s výzvou prohlížeče', () => {
    for (const r of [req(), req(basic('nahled:spatne')), req('Bearer x'), req('Basic !!!')]) {
      const res = previewGate(r, 'nahled:tajne')
      expect(res?.status).toBe(401)
      expect(res?.headers.get('www-authenticate')).toMatch(/^Basic realm=/)
      expect(res?.headers.get('cache-control')).toBe('no-store')
    }
  })
  test('správné heslo projde, i s diakritikou', () => {
    expect(previewGate(req(basic('nahled:tajne')), 'nahled:tajne')).toBeNull()
    expect(previewGate(req(basic('náhled:žluťoučký')), 'náhled:žluťoučký')).toBeNull()
  })
  test('neplatný tvar proměnné zavře bránu pro všechny', () => {
    expect(previewGate(req(basic('bezdvojtecky')), 'bezdvojtecky')?.status).toBe(401)
    expect(previewGate(req(basic('x:')), 'x:')?.status).toBe(401)
  })
})

describe('previewGate – hlavička', () => {
  test('WWW-Authenticate je jen Latin-1 (jinak Vercel vrátí 500)', () => {
    const res = previewGate(new NextRequest('https://x.test/'), 'a:b')
    expect(res?.status).toBe(401)
    expect(/^[\x20-\xff]*$/.test(res?.headers.get('www-authenticate') ?? '')).toBe(true)
  })
})
