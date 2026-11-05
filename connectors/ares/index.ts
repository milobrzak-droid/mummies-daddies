// ARES — oficiální registr firem (ares.gov.cz), veřejné REST API bez klíče.
// Zdroj pravdy o firmách: obchodní jméno, IČO, sídlo (kraj/obec), NACE, vznik.

const BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty'

export type AresCompany = {
  ico: string
  legalName: string
  city: string | null
  region: string | null
  address: string | null
  founded: string | null
  nace: string[]
  industry: string | null // hrubý sektor z primárního NACE (best-effort)
  /** Kód právní formy (číselník ČSÚ; 101–108 = fyzická osoba podnikající). */
  legalFormCode?: string | null
}

type AresRaw = {
  ico?: string
  obchodniJmeno?: string
  datumVzniku?: string
  czNace2008?: string[]
  pravniForma?: string
  sidlo?: { nazevObce?: string; nazevKraje?: string; textovaAdresa?: string }
}

// Hrubý sektor podle NACE divize (první 2 číslice) nebo sekce (písmeno).
function sectorFor(code: string): string | null {
  const letter = code[0]
  if (letter && letter >= 'A' && letter <= 'Z') {
    const S: Record<string, string> = {
      A: 'Zemědělství a lesnictví', B: 'Těžba', C: 'Zpracovatelský průmysl', D: 'Energetika',
      E: 'Vodárenství a odpady', F: 'Stavebnictví', G: 'Obchod', H: 'Doprava a skladování',
      I: 'Ubytování a stravování', J: 'IT a komunikace', K: 'Finance a pojišťovnictví',
      L: 'Reality', M: 'Profesní a vědecké služby', N: 'Administrativní služby',
      O: 'Veřejná správa', P: 'Vzdělávání', Q: 'Zdravotní a sociální péče',
      R: 'Kultura a sport', S: 'Ostatní služby',
    }
    return S[letter] ?? null
  }
  const div = parseInt(code.slice(0, 2), 10)
  if (Number.isNaN(div)) return null
  if (div <= 3) return 'Zemědělství a lesnictví'
  if (div <= 9) return 'Těžba'
  if (div <= 33) return 'Zpracovatelský průmysl'
  if (div === 35) return 'Energetika'
  if (div <= 39) return 'Vodárenství a odpady'
  if (div <= 43) return 'Stavebnictví'
  if (div <= 47) return 'Obchod'
  if (div <= 53) return 'Doprava a skladování'
  if (div <= 56) return 'Ubytování a stravování'
  if (div <= 63) return 'IT a komunikace'
  if (div <= 66) return 'Finance a pojišťovnictví'
  if (div === 68) return 'Reality'
  if (div <= 75) return 'Profesní a vědecké služby'
  if (div <= 82) return 'Administrativní služby'
  if (div === 84) return 'Veřejná správa'
  if (div === 85) return 'Vzdělávání'
  if (div <= 88) return 'Zdravotní a sociální péče'
  if (div <= 93) return 'Kultura a sport'
  return 'Ostatní služby'
}

/**
 * Hodnota pro account.region z ARESu. Pole je v aplikaci „Region / sídlo"
 * a všechny dosavadní zápisy z ARESu (formulář klienta, import prospektů,
 * scripts/fill-ico.mjs, plánování schůzky, import nabídky, dávkové
 * doplňování v domain/crm/aresEnrich.ts, ruční stránka
 * /clients/doplnit-ico) do něj dávají OBEC sídla (sidlo.nazevObce), ne
 * kraj — seznam klientů se podle toho filtruje a řadí. Kraj jen tam, kde
 * ARES obec neuvádí.
 */
export function aresRegionValue(company: Pick<AresCompany, 'city' | 'region'>): string | null {
  const v = (company.city ?? company.region ?? '').trim()
  return v || null
}

function normalize(s: AresRaw): AresCompany | null {
  if (!s?.ico || !s?.obchodniJmeno) return null
  const sidlo = s.sidlo ?? {}
  const nace = (s.czNace2008 ?? []).filter((c) => c && c !== '00')
  return {
    ico: s.ico,
    legalName: s.obchodniJmeno,
    city: sidlo.nazevObce ?? null,
    region: sidlo.nazevKraje ?? null,
    address: sidlo.textovaAdresa ?? null,
    founded: s.datumVzniku ?? null,
    nace,
    industry: nace[0] ? sectorFor(nace[0]) : null,
    ...(s.pravniForma ? { legalFormCode: s.pravniForma } : {}),
  }
}

// Jeden subjekt podle IČO (jednoznačné).
export async function aresByIco(ico: string): Promise<AresCompany | null> {
  const clean = ico.replace(/\s/g, '')
  if (!/^\d{1,8}$/.test(clean)) return null
  const res = await fetch(`${BASE}/${clean.padStart(8, '0')}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) return null
  return normalize((await res.json()) as AresRaw)
}

// Kandidáti podle obchodního jména (k výběru — jmen bývá víc).
export async function aresSearchByName(name: string, count = 5): Promise<AresCompany[]> {
  const res = await fetch(`${BASE}/vyhledat`, { signal: AbortSignal.timeout(10_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ obchodniJmeno: name, pocet: count }),
    cache: 'no-store',
  })
  if (!res.ok) return []
  const data = (await res.json()) as { ekonomickeSubjekty?: AresRaw[] }
  return (data.ekonomickeSubjekty ?? []).map(normalize).filter((c): c is AresCompany => c !== null)
}

// ---------------------------------------------------------------- dávky
// Varianty pro dávkové zpracování (automat doplňování IČO a stránka
// /clients/doplnit-ico). Oproti aresByIco/aresSearchByName výše:
//   * vždy s timeoutem na jeden požadavek (výchozí 8 s),
//   * rozlišují „ARES nic nezná" (null / prázdný seznam — definitivní
//     odpověď) od „ARES teď neodpověděl" (AresUnavailableError — síť,
//     timeout, 429, 5xx). Automat první případ zapíše jako výsledek, druhý
//     jako chybu a zkusí to příště; kdyby oba splynuly, dočasný výpadek
//     nebo limit ARESu by firmy natrvalo označil „nenalezeno".
//   * hledání vrací i celkový počet shod (pocetCelkem), který potřebuje
//     pickAresMatch pro pravidlo „jediný výsledek".

export const ARES_DEFAULT_TIMEOUT_MS = 8_000

export class AresUnavailableError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'AresUnavailableError'
  }
}

type AresRequestOptions = { timeoutMs?: number }

// ARES odmítne hledání se víc než 1000 shodami (HTTP 400, kod CHYBA_VSTUPU,
// subKod VYSTUP_PRILIS_MNOHO_VYSLEDKU). To NENÍ „nic nenašel" — je to
// „příliš mnoho firem toho jména", rozhodnout musí člověk.
const TOO_MANY_RESULTS = Symbol('ARES: příliš mnoho výsledků')

// null = definitivní „nic" (404 nenalezeno, 400 ARES dotaz odmítl — stejný
// dotaz by to odmítl i příště). Všechno ostatní mimo 2xx je dočasné.
async function aresFetchJson(
  url: string, init: RequestInit, timeoutMs: number,
): Promise<unknown | null | typeof TOO_MANY_RESULTS> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new AresUnavailableError(timedOut ? `ARES neodpověděl do ${timeoutMs} ms` : 'ARES je nedostupný')
  }
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as { subKod?: unknown } | null
    return body?.subKod === 'VYSTUP_PRILIS_MNOHO_VYSLEDKU' ? TOO_MANY_RESULTS : null
  }
  if (res.status === 404) return null
  if (!res.ok) throw new AresUnavailableError(`ARES vrátil HTTP ${res.status}`, res.status)
  try {
    return await res.json()
  } catch {
    throw new AresUnavailableError('ARES vrátil nečitelnou odpověď', res.status)
  }
}

/** Jeden subjekt podle IČO; null = ARES ho nezná (nebo IČO nemá tvar čísla). */
export async function aresLookupByIco(ico: string, opts: AresRequestOptions = {}): Promise<AresCompany | null> {
  const clean = ico.replace(/\s/g, '')
  if (!/^\d{1,8}$/.test(clean)) return null
  const data = await aresFetchJson(
    `${BASE}/${clean.padStart(8, '0')}`,
    { headers: { Accept: 'application/json' } },
    opts.timeoutMs ?? ARES_DEFAULT_TIMEOUT_MS,
  )
  return data && data !== TOO_MANY_RESULTS ? normalize(data as AresRaw) : null
}

/**
 * `tooMany` = ARES hledání odmítl, protože shod je přes 1000 (total je pak
 * Infinity). Prázdné `candidates` tedy neznamená „nic nenašel".
 */
export type AresSearchResult = { candidates: AresCompany[]; total: number; tooMany?: boolean }

/** Kandidáti podle obchodního jména + celkový počet shod v rejstříku. */
export async function aresSearch(
  name: string,
  opts: AresRequestOptions & { count?: number } = {},
): Promise<AresSearchResult> {
  const q = name.trim()
  if (!q) return { candidates: [], total: 0 }
  const raw = await aresFetchJson(
    `${BASE}/vyhledat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ obchodniJmeno: q, pocet: opts.count ?? 20 }),
    },
    opts.timeoutMs ?? ARES_DEFAULT_TIMEOUT_MS,
  )
  if (raw === TOO_MANY_RESULTS) return { candidates: [], total: Infinity, tooMany: true }
  const data = raw as { pocetCelkem?: number; ekonomickeSubjekty?: AresRaw[] } | null
  const candidates = (data?.ekonomickeSubjekty ?? []).map(normalize).filter((c): c is AresCompany => c !== null)
  const total = typeof data?.pocetCelkem === 'number' ? data.pocetCelkem : candidates.length
  return { candidates, total }
}

// ---------------------------------------------------------------- automat
// Rozhodnutí, jestli se kandidát z ARESu smí přiřadit bez člověka.
// Oddělené od síťového volání, aby se dalo otestovat — spletli jsme se tu
// už třikrát: „Magna" vrací vinařský spolek, „K2" sportovní klub a „CCH"
// vzduchotechniku. Cizí IČO v CRM je horší než prázdné pole.
export type AresPick = { company: AresCompany; how: 'přesná shoda' | 'jediný výsledek' } | null

const LEGAL_FORM = /\b(s\.?\s?r\.?\s?o\.?|a\.?\s?s\.?|spol\.?|z\.?\s?s\.?|k\.?\s?s\.?|v\.?\s?o\.?\s?s\.?|se|ltd|gmbh|inc)\b/g

export function normalizeCompanyName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(LEGAL_FORM, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
}

// Závorkové upřesnění („Mova Plus (Linsan24h)") ARES nezná.
export function cleanCompanyName(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
}

export function pickAresMatch(rawName: string, candidates: AresCompany[], totalCount: number): AresPick {
  // Otazník v názvu = nejistý byl už ten, kdo klienta zakládal.
  if (rawName.includes('?')) return null
  const q = cleanCompanyName(rawName)
  if (!q) return null

  const exact = candidates.find((c) => normalizeCompanyName(c.legalName) === normalizeCompanyName(q))
  if (exact) return { company: exact, how: 'přesná shoda' }

  // Jediný subjekt toho jména v celém rejstříku — není co splést. Neplatí
  // pro zkratky: „CCH" má taky jediný výsledek, ale je to vzduchotechnika.
  if (q.length >= 6 && totalCount === 1 && candidates.length === 1) {
    return { company: candidates[0], how: 'jediný výsledek' }
  }
  return null
}
