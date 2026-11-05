// Mapy.cz REST API (api.mapy.cz, klíč MAPY_API_KEY) — geokódování místa akce
// a délka trasy autem od provozovny.
//
// Za přepínačem: bez GEO_ENABLED === 'true' a bez MAPY_API_KEY se nevolá
// nic a výsledek je null. null znamená „vzdálenost nejde určit" a agent
// poptávku NEodešle sám (eskalace / dotaz na přesnou adresu).
//
// Posílá se jen text místa akce (adresa, obec, název prostoru) — nikdy jméno,
// e-mail ani nic jiného z poptávky. Nejednoznačný výsledek (víc kandidátů
// daleko od sebe, nic nenalezeno, mimo ČR) je null: raději se zeptat než
// spočítat dopravu do špatného města. Chyby nesou jen status.
//
// Endpointy (OVĚŘIT při zapnutí proti dokumentaci developer.mapy.com):
//   GET /v1/geocode?query=…&lang=cs&limit=5&type=…            → { items: [{ position: {lon, lat}, type, regionalStructure }] }
//   GET /v1/routing/route?start=lon,lat&end=lon,lat&routeType=car_fast → { length: metry, duration: sekundy }

export const MAPY_API = 'https://api.mapy.cz/v1'

/** Kandidáti dál než tohle od sebe = nejednoznačné místo. */
export const GEO_AMBIGUITY_KM = 5

const PLACE_TYPES = ['regional.address', 'regional.street', 'regional.municipality', 'regional.municipality_part', 'poi'] as const

type Env = Record<string, string | undefined>

export type GeoPoint = { lon: number; lat: number }

export type GeoDeps = { env?: Env; fetchImpl?: typeof fetch; timeoutMs?: number }

/** Je geokódování zapnuté a nastavené? */
export function geoEnabled(env: Env = process.env): boolean {
  return env.GEO_ENABLED === 'true' && Boolean(env.MAPY_API_KEY)
}

/** Vzdálenost dvou bodů vzdušnou čarou (km). */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

async function getJson(url: string, deps: GeoDeps): Promise<unknown | null> {
  const env = deps.env ?? process.env
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'GET',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      headers: { 'X-Mapy-Api-Key': env.MAPY_API_KEY ?? '', accept: 'application/json' },
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

type RawItem = { position?: { lon?: unknown; lat?: unknown }; type?: unknown; regionalStructure?: { type?: unknown; isoCode?: unknown }[] }

const inCzechia = (it: RawItem) => {
  const country = (it.regionalStructure ?? []).find((r) => r.type === 'regional.country')
  // Bez struktury nerozhodujeme (API ji u části typů nevrací); s ní jen CZ.
  return !country || country.isoCode === undefined || country.isoCode === 'CZ'
}

/** Text místa → jeden bod, nebo null (nenalezeno / nejednoznačné / vypnuto). */
export async function geocodePlace(place: string, deps: GeoDeps = {}): Promise<GeoPoint | null> {
  const env = deps.env ?? process.env
  if (!geoEnabled(env)) return null
  const query = place.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (query.length < 3) return null
  const q = new URLSearchParams({ query, lang: 'cs', limit: '5' })
  for (const t of PLACE_TYPES) q.append('type', t)
  const data = (await getJson(`${MAPY_API}/geocode?${q.toString()}`, deps)) as { items?: RawItem[] } | null
  const points = (data?.items ?? [])
    .filter(inCzechia)
    .map((it) => ({ lon: Number(it.position?.lon), lat: Number(it.position?.lat) }))
    .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
  if (points.length === 0) return null
  const first = points[0]
  if (points.slice(1).some((p) => haversineKm(first, p) > GEO_AMBIGUITY_KM)) return null
  return first
}

/** Délka trasy autem (km, jedna cesta), nebo null. */
export async function routeKm(from: GeoPoint, to: GeoPoint, deps: GeoDeps = {}): Promise<number | null> {
  if (!geoEnabled(deps.env ?? process.env)) return null
  const q = new URLSearchParams({ start: `${from.lon},${from.lat}`, end: `${to.lon},${to.lat}`, routeType: 'car_fast', lang: 'cs' })
  const data = (await getJson(`${MAPY_API}/routing/route?${q.toString()}`, deps)) as { length?: unknown } | null
  const m = typeof data?.length === 'number' ? data.length : NaN
  if (!Number.isFinite(m) || m < 0 || m > 2_000_000) return null
  return Math.round(m / 100) / 10
}

/**
 * Vzdálenost místa akce od provozovny (km po silnici, jedna cesta), nebo
 * null. Bod provozovny se geokóduje jednou za proces.
 */
export function createDistanceResolver(originAddress: string | null | undefined, deps: GeoDeps = {}): (venue: string) => Promise<number | null> {
  let origin: Promise<GeoPoint | null> | null = null
  return async (venue: string) => {
    if (!originAddress || !geoEnabled(deps.env ?? process.env)) return null
    origin ??= geocodePlace(originAddress, deps)
    const o = await origin
    if (!o) {
      origin = null // příště zkusit znovu
      return null
    }
    const v = await geocodePlace(venue, deps)
    if (!v) return null
    return routeKm(o, v, deps)
  }
}
