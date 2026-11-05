import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AresUnavailableError, aresByIco, aresLookupByIco, aresSearch, aresSearchByName, cleanCompanyName } from '@/connectors/ares'

// connectors/ares — normalizace odpovědi ARESu a hrubý sektor z NACE.
// fetch je mockovaný, na ares.gov.cz se nevolá.

const fetchMock = vi.fn()
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const raw = (over: Record<string, unknown> = {}) => ({
  ico: '27082440',
  obchodniJmeno: 'Alza.cz a.s.',
  datumVzniku: '2003-08-26',
  czNace2008: ['47910'],
  sidlo: { nazevObce: 'Praha', nazevKraje: 'Hlavní město Praha', textovaAdresa: 'Jankovcova 1522/53, Praha 7' },
  ...over,
})

describe('aresByIco', () => {
  test('neplatné IČO → null bez síťového volání', async () => {
    for (const bad of ['', 'abc', '123456789', '12-34', '1.5']) {
      expect(await aresByIco(bad), bad).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('mezery se odstraní a IČO se doplní nulami na 8 číslic', async () => {
    fetchMock.mockResolvedValue(ok(raw()))
    await aresByIco(' 12 345 ')
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/ekonomicke-subjekty\/00012345$/)
  })

  test('normalizuje sídlo, vznik a sektor', async () => {
    fetchMock.mockResolvedValue(ok(raw()))
    expect(await aresByIco('27082440')).toEqual({
      ico: '27082440',
      legalName: 'Alza.cz a.s.',
      city: 'Praha',
      region: 'Hlavní město Praha',
      address: 'Jankovcova 1522/53, Praha 7',
      founded: '2003-08-26',
      nace: ['47910'],
      industry: 'Obchod',
    })
  })

  test('chybějící sídlo a NACE → null pole; kód 00 se zahodí', async () => {
    fetchMock.mockResolvedValue(ok(raw({ sidlo: undefined, datumVzniku: undefined, czNace2008: ['00', '', '62010'] })))
    const c = await aresByIco('1')
    expect(c).toMatchObject({ city: null, region: null, address: null, founded: null, nace: ['62010'], industry: 'IT a komunikace' })
    fetchMock.mockResolvedValue(ok(raw({ czNace2008: undefined })))
    expect(await aresByIco('1')).toMatchObject({ nace: [], industry: null })
  })

  test('HTTP chyba nebo odpověď bez IČO/jména → null', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }))
    expect(await aresByIco('1')).toBeNull()
    fetchMock.mockResolvedValue(ok(raw({ obchodniJmeno: undefined })))
    expect(await aresByIco('1')).toBeNull()
    fetchMock.mockResolvedValue(ok(raw({ ico: undefined })))
    expect(await aresByIco('1')).toBeNull()
  })

  test.each([
    ['01110', 'Zemědělství a lesnictví'],
    ['03000', 'Zemědělství a lesnictví'],
    ['05100', 'Těžba'],
    ['09', 'Těžba'],
    ['10', 'Zpracovatelský průmysl'],
    ['33', 'Zpracovatelský průmysl'],
    ['35110', 'Energetika'],
    ['36', 'Vodárenství a odpady'],
    ['41', 'Stavebnictví'],
    ['45', 'Obchod'],
    ['49', 'Doprava a skladování'],
    ['55', 'Ubytování a stravování'],
    ['58', 'IT a komunikace'],
    ['64', 'Finance a pojišťovnictví'],
    ['68', 'Reality'],
    ['69', 'Profesní a vědecké služby'],
    ['77', 'Administrativní služby'],
    ['84', 'Veřejná správa'],
    ['85', 'Vzdělávání'],
    ['86', 'Zdravotní a sociální péče'],
    ['90', 'Kultura a sport'],
    ['94', 'Ostatní služby'],
    ['99', 'Ostatní služby'],
    ['J', 'IT a komunikace'],
    ['S', 'Ostatní služby'],
    ['Z', null],
    ['xx', null],
  ])('NACE %s → %s', async (code, sector) => {
    fetchMock.mockResolvedValue(ok(raw({ czNace2008: [code] })))
    expect((await aresByIco('1'))?.industry).toBe(sector)
  })
})

describe('aresSearchByName', () => {
  test('pošle jméno a počet, zahodí neúplné subjekty', async () => {
    fetchMock.mockResolvedValue(ok({ ekonomickeSubjekty: [raw(), { ico: '1' }, raw({ ico: '2', obchodniJmeno: 'B s.r.o.' })] }))
    const list = await aresSearchByName('Alza', 3)
    expect(list.map((c) => c.ico)).toEqual(['27082440', '2'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/vyhledat$/)
    expect(JSON.parse(String(init.body))).toEqual({ obchodniJmeno: 'Alza', pocet: 3 })
  })

  test('HTTP chyba nebo prázdná odpověď → []', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    expect(await aresSearchByName('x')).toEqual([])
    fetchMock.mockResolvedValue(ok({}))
    expect(await aresSearchByName('x')).toEqual([])
  })
})

test('cleanCompanyName odstraní závorková upřesnění', () => {
  expect(cleanCompanyName('Mova Plus (Linsan24h)')).toBe('Mova Plus')
  expect(cleanCompanyName('A (x) B (y)')).toBe('A B')
  expect(cleanCompanyName('  Bez závorek ')).toBe('Bez závorek')
  expect(cleanCompanyName('(jen závorka)')).toBe('')
})

// connectors/ares — dávkové varianty (aresSearch, aresLookupByIco). fetch je
// vždy podvržený: testy nesmí sahat na skutečný ARES.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('aresSearch', () => {
  test('vrací kandidáty i celkový počet shod, s timeoutem na požadavek', async () => {
    const fetchMock = stubFetch(async () => json({
      pocetCelkem: 56,
      ekonomickeSubjekty: [
        { ico: '25092677', obchodniJmeno: 'ALFATECH, s.r.o.', sidlo: { nazevObce: 'Praha', nazevKraje: 'Hlavní město Praha' } },
        { obchodniJmeno: 'bez IČO se zahodí' },
      ],
    }))
    const r = await aresSearch('  ALFATECH ', { count: 20, timeoutMs: 5000 })
    expect(r.total).toBe(56)
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0]).toMatchObject({ ico: '25092677', city: 'Praha', region: 'Hlavní město Praha' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/ekonomicke-subjekty\/vyhledat$/)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ obchodniJmeno: 'ALFATECH', pocet: 20 })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  test('bez pocetCelkem bere počet kandidátů', async () => {
    stubFetch(async () => json({ ekonomickeSubjekty: [{ ico: '1', obchodniJmeno: 'A' }] }))
    expect((await aresSearch('A')).total).toBe(1)
  })

  test('404 a jiná 400 = definitivně nic (ne chyba)', async () => {
    stubFetch(async () => json({ kod: 'NENALEZENO' }, 404))
    expect(await aresSearch('Nic')).toEqual({ candidates: [], total: 0 })
    stubFetch(async () => json({ kod: 'CHYBA_VSTUPU' }, 400))
    expect(await aresSearch('?')).toEqual({ candidates: [], total: 0 })
  })

  test('400 „příliš mnoho výsledků" není „nic", ale tooMany', async () => {
    stubFetch(async () => json({ kod: 'CHYBA_VSTUPU', subKod: 'VYSTUP_PRILIS_MNOHO_VYSLEDKU' }, 400))
    expect(await aresSearch('Agro')).toEqual({ candidates: [], total: Infinity, tooMany: true })
  })

  test('429 a 5xx = ARES nedostupný (zkusit příště)', async () => {
    stubFetch(async () => json({}, 429))
    await expect(aresSearch('ALFATECH')).rejects.toMatchObject({ name: 'AresUnavailableError', status: 429 })
    stubFetch(async () => json({}, 503))
    await expect(aresSearch('ALFATECH')).rejects.toBeInstanceOf(AresUnavailableError)
  })

  test('timeout a síťová chyba = ARES nedostupný', async () => {
    stubFetch(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    await expect(aresSearch('ALFATECH', { timeoutMs: 10 })).rejects.toThrow('ARES neodpověděl do 10 ms')
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(aresSearch('ALFATECH')).rejects.toThrow('ARES je nedostupný')
  })

  test('prázdné jméno se ARESu vůbec neposílá', async () => {
    const fetchMock = stubFetch(async () => json({}))
    expect(await aresSearch('   ')).toEqual({ candidates: [], total: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('aresLookupByIco', () => {
  test('doplní IČO nulami na 8 číslic', async () => {
    const fetchMock = stubFetch(async () => json({ ico: '00537837', obchodniJmeno: 'Mova Plus s.r.o.', datumVzniku: '1995-01-01' }))
    const c = await aresLookupByIco('537 837')
    expect(c).toMatchObject({ ico: '00537837', founded: '1995-01-01' })
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/ekonomicke-subjekty\/00537837$/)
  })

  test('neznámé IČO = null, výpadek = chyba, nesmysl se neposílá', async () => {
    stubFetch(async () => json({}, 404))
    expect(await aresLookupByIco('12345678')).toBeNull()
    stubFetch(async () => json({}, 500))
    await expect(aresLookupByIco('12345678')).rejects.toBeInstanceOf(AresUnavailableError)
    const fetchMock = stubFetch(async () => json({}))
    expect(await aresLookupByIco('CZ123')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
