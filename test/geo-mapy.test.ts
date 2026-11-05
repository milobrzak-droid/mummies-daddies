// Konektor geokódování (Mapy.cz, P2): přepínač, nejednoznačné místo = null,
// délka trasy, chyby API. Bez sítě (fetch podvržený).
import { describe, expect, it, vi } from 'vitest'
import { createDistanceResolver, geocodePlace, geoEnabled, haversineKm, routeKm } from '@/connectors/geo'

const ENV = { GEO_ENABLED: 'true', MAPY_API_KEY: 'klic' }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const item = (lon: number, lat: number, type = 'regional.address') => ({ position: { lon, lat }, type, regionalStructure: [{ type: 'regional.country', isoCode: 'CZ' }] })

describe('přepínač', () => {
  it('bez GEO_ENABLED=true nebo bez klíče se nevolá nic', async () => {
    expect(geoEnabled({})).toBe(false)
    expect(geoEnabled({ GEO_ENABLED: 'true' })).toBe(false)
    expect(geoEnabled({ GEO_ENABLED: '1', MAPY_API_KEY: 'k' })).toBe(false)
    const fetchImpl = vi.fn()
    expect(await geocodePlace('Praha 2', { env: { MAPY_API_KEY: 'k' }, fetchImpl })).toBeNull()
    expect(await createDistanceResolver('Varšavská 715, Praha', { env: {}, fetchImpl })('Brno')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('geokódování', () => {
  it('jeden kandidát → bod; klíč jde v hlavičce, ne v URL; posílá se jen text místa', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [item(14.43, 50.07)] }))
    expect(await geocodePlace('  Náměstí Míru 1,   Praha ', { env: ENV, fetchImpl })).toEqual({ lon: 14.43, lat: 50.07 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('query=N%C3%A1m%C4%9Bst%C3%AD+M%C3%ADru+1%2C+Praha')
    expect(url).not.toContain('klic')
    expect((init.headers as Record<string, string>)['X-Mapy-Api-Key']).toBe('klic')
  })

  it('kandidáti daleko od sebe = nejednoznačné → null', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [item(14.43, 50.07), item(16.6, 49.19)] }))
    expect(await geocodePlace('Nádražní 1', { env: ENV, fetchImpl })).toBeNull()
  })

  it('blízcí kandidáti (stejné místo) → první', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [item(14.43, 50.07), item(14.431, 50.071, 'poi')] }))
    expect(await geocodePlace('Vinohrady', { env: ENV, fetchImpl })).toEqual({ lon: 14.43, lat: 50.07 })
  })

  it('nic nenalezeno, mimo ČR, 403 a 429 → null', async () => {
    const env = ENV
    expect(await geocodePlace('xyz', { env, fetchImpl: vi.fn(async () => json(200, { items: [] })) })).toBeNull()
    const foreign = { position: { lon: 13.4, lat: 52.5 }, regionalStructure: [{ type: 'regional.country', isoCode: 'DE' }] }
    expect(await geocodePlace('Berlin', { env, fetchImpl: vi.fn(async () => json(200, { items: [foreign] })) })).toBeNull()
    expect(await geocodePlace('Praha', { env, fetchImpl: vi.fn(async () => json(403, { message: 'bad key' })) })).toBeNull()
    expect(await geocodePlace('Praha', { env, fetchImpl: vi.fn(async () => json(429, {})) })).toBeNull()
  })
})

describe('trasa a vzdálenost', () => {
  it('délka trasy v km na desetiny; nesmysl → null', async () => {
    expect(await routeKm({ lon: 14, lat: 50 }, { lon: 14.1, lat: 50.1 }, { env: ENV, fetchImpl: vi.fn(async () => json(200, { length: 12_345, duration: 900 })) })).toBe(12.3)
    expect(await routeKm({ lon: 14, lat: 50 }, { lon: 14.1, lat: 50.1 }, { env: ENV, fetchImpl: vi.fn(async () => json(200, {})) })).toBeNull()
  })

  it('resolver: provozovna se geokóduje jednou, pak místo a trasa', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/geocode') && url.includes('Var%C5%A1avsk%C3%A1')) return json(200, { items: [item(14.44, 50.07)] })
      if (url.includes('/geocode')) return json(200, { items: [item(14.5, 50.1)] })
      return json(200, { length: 8_000 })
    })
    const dist = createDistanceResolver('Varšavská 715, 120 00 Praha 2', { env: ENV, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await dist('Praha 9')).toBe(8)
    expect(await dist('Praha 10')).toBe(8)
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('Var%C5%A1avsk%C3%A1'))).toHaveLength(1)
    const route = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/routing/route'))
    expect(String(route?.[0])).toContain('start=14.44%2C50.07')
  })

  it('haversine Praha–Brno ≈ 185 km', () => {
    expect(Math.round(haversineKm({ lon: 14.42, lat: 50.08 }, { lon: 16.61, lat: 49.2 }))).toBeGreaterThan(180)
  })
})
