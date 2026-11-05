import { beforeEach, describe, expect, test, vi } from 'vitest'
import { exportContactData } from '@/domain/crm/actions/gdprExport'
import { GET as exportGET } from '@/app/cockpit/kontakty/[id]/export/route'

// app/cockpit/kontakty/[id]/export/route.ts — GET s vedlejším účinkem (audit
// řádek contact.exported) je jinak vyvolatelná i cross-site (prostý odkaz,
// <img>, fetch z cizí stránky — cookie session jde s requestem). Route teď
// odmítá požadavky, jejichž Sec-Fetch-Site hlavička říká, že nejde o
// same-origin/přímou navigaci ("none"), dřív než se vůbec zavolá
// exportContactData (mockovaná tady — pagination je testovaná v
// test/review-fixes.test.ts proti skutečné implementaci).

vi.mock('@/domain/crm/actions/gdprExport', () => ({ exportContactData: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

// `Sec-Fetch-*` je na fetch()/Request-konstruktoru zakázaná hlavička (forbidden
// request header), takže `new Request(url, { headers: {...} })` by ji tiše
// zahodilo — je potřeba ji nastavit až na hotovém Headers objektu (guard se
// aplikuje jen při vytváření, ne při .set()). Skutečné příchozí požadavky
// tomuhle omezení nepodléhají — to platí jen pro odchozí fetch() volání z JS.
function req(id: string, secFetchSite?: string) {
  const request = new Request('http://x')
  if (secFetchSite) request.headers.set('sec-fetch-site', secFetchSite)
  return exportGET(request, { params: Promise.resolve({ id }) })
}

describe('GET export — Sec-Fetch-Site chrání proti cross-site vyvolání', () => {
  test.each(['cross-site', 'same-site'])('Sec-Fetch-Site: %s → 403, exportContactData se nevolá', async (value) => {
    const res = await req('7', value)
    expect(res.status).toBe(403)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(exportContactData).not.toHaveBeenCalled()
  })

  test.each(['same-origin', 'none'])('Sec-Fetch-Site: %s → pokračuje k exportContactData', async (value) => {
    vi.mocked(exportContactData).mockResolvedValue({ ok: false, status: 401, error: 'auth' })
    await req('7', value)
    expect(exportContactData).toHaveBeenCalledWith(7)
  })

  test('chybějící hlavička (starší/nestandardní klient) pokračuje k exportContactData', async () => {
    vi.mocked(exportContactData).mockResolvedValue({ ok: false, status: 401, error: 'auth' })
    await req('7')
    expect(exportContactData).toHaveBeenCalledWith(7)
  })
})
