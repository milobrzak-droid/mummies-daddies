import { describe, expect, it, vi } from 'vitest'
import {
  createIdokladClient,
  fetchCurrencies,
  fetchInvoiceByDocumentNumber,
  fetchInvoicesByIds,
  fetchIssuedInvoices,
  fetchIssuedPayments,
  IdokladError,
  idokladCredentialsFromEnv,
  idokladMissingEnv,
  idokladSyncEnabledFromEnv,
  normalizeInvoice,
  normalizePayment,
} from '@/connectors/idoklad'

// Konektor iDokladu: podvržené odpovědi ve tvaru z oficiální dokumentace
// (https://api.idoklad.cz/Help/v3/en/). Žádná síť, žádná tajemství.

const CREDS = { clientId: 'cid-123', clientSecret: 'super-secret-value' }

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

const TOKEN = () => json({ access_token: 'tok-abc', expires_in: 3600, token_type: 'Bearer' })

const invoiceRaw = (over: Record<string, unknown> = {}) => ({
  Id: 16,
  CurrencyId: 1,
  DateOfIssue: '2026-09-16T00:00:00',
  DateOfMaturity: '2026-09-30T00:00:00',
  DateOfPayment: null,
  DocumentNumber: '20260016',
  VariableSymbol: '20260016',
  PaymentStatus: 0,
  PartnerId: 5,
  PartnerAddress: { IdentificationNumber: '12345678', NickName: 'Alfa s.r.o.' },
  Prices: { TotalWithoutVat: 10000, TotalWithVat: 12100, TotalPaid: 0 },
  ...over,
})

/** fetch podvržený podle URL: token, číselník měn, faktury, úhrady. */
function fakeFetch(routes: { invoices?: unknown[]; payments?: unknown[]; failInvoices?: number[] } = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  let invoiceAttempts = 0
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.startsWith('https://identity.idoklad.cz/server/connect/token')) return TOKEN()
    if (url.includes('/Currencies')) return json({ Data: { Items: [{ Id: 1, Code: 'CZK' }, { Id: 2, Code: 'EUR' }], TotalItems: 2, TotalPages: 1 } })
    if (url.includes('/IssuedInvoices')) {
      const fail = routes.failInvoices?.[invoiceAttempts++]
      if (fail) return new Response('nope', { status: fail, headers: { 'retry-after': '0' } })
      return json({ Data: { Items: routes.invoices ?? [], TotalItems: (routes.invoices ?? []).length, TotalPages: 1 } })
    }
    if (url.includes('/IssuedDocumentPayments')) return json({ Data: { Items: routes.payments ?? [], TotalItems: (routes.payments ?? []).length, TotalPages: 1 } })
    return new Response('not found', { status: 404 })
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

const failure = async (p: Promise<unknown>): Promise<IdokladError> => (await p.then(() => null, (e: unknown) => e)) as IdokladError

const client = (f: typeof fetch) => createIdokladClient(CREDS, { fetch: f, sleep: async () => undefined })

describe('přepínač a přihlašovací údaje', () => {
  it('zapíná jen přesně true', () => {
    expect(idokladSyncEnabledFromEnv({ IDOKLAD_SYNC_ENABLED: 'true' })).toBe(true)
    expect(idokladSyncEnabledFromEnv({ IDOKLAD_SYNC_ENABLED: '1' })).toBe(false)
    expect(idokladSyncEnabledFromEnv({ IDOKLAD_SYNC_ENABLED: 'TRUE' })).toBe(false)
    expect(idokladSyncEnabledFromEnv({})).toBe(false)
  })
  it('údaje jen když jsou obě proměnné vyplněné; chybějící se jen pojmenují', () => {
    expect(idokladCredentialsFromEnv({ IDOKLAD_CLIENT_ID: 'a', IDOKLAD_CLIENT_SECRET: 'b' })).toEqual({ clientId: 'a', clientSecret: 'b' })
    expect(idokladCredentialsFromEnv({ IDOKLAD_CLIENT_ID: 'a' })).toBeNull()
    expect(idokladCredentialsFromEnv({ IDOKLAD_CLIENT_ID: ' ', IDOKLAD_CLIENT_SECRET: 'b' })).toBeNull()
    expect(idokladMissingEnv({ IDOKLAD_CLIENT_ID: 'a' })).toEqual(['IDOKLAD_CLIENT_SECRET'])
    expect(idokladMissingEnv({})).toEqual(['IDOKLAD_CLIENT_ID', 'IDOKLAD_CLIENT_SECRET'])
  })
})

describe('přihlášení a požadavky', () => {
  it('token: client credentials, scope idoklad_api, formulář na identity server; dál jen Bearer GET', async () => {
    const { fn, calls } = fakeFetch({ invoices: [invoiceRaw()] })
    const res = await fetchIssuedInvoices(client(fn), '2026-07-02')
    expect(res.items).toHaveLength(1)
    const tokenCall = calls[0]
    expect(tokenCall.url).toBe('https://identity.idoklad.cz/server/connect/token')
    expect(tokenCall.init?.method).toBe('POST')
    const form = new URLSearchParams(String(tokenCall.init?.body))
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('scope')).toBe('idoklad_api')
    expect(form.get('client_id')).toBe('cid-123')
    // Všechna ostatní volání jsou GET s Bearer tokenem na api.idoklad.cz/v3 — nic se nezapisuje.
    for (const c of calls.slice(1)) {
      expect(c.url.startsWith('https://api.idoklad.cz/v3/')).toBe(true)
      expect(c.init?.method).toBe('GET')
      expect((c.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-abc')
    }
    expect(calls.filter((c) => c.init?.method !== 'GET').length).toBe(1) // jen token
  })

  it('token se drží do vypršení, ne každý požadavek znovu', async () => {
    const { fn, calls } = fakeFetch()
    const c = client(fn)
    await fetchIssuedPayments(c, '2026-07-02')
    await fetchIssuedPayments(c, '2026-07-02')
    expect(calls.filter((x) => x.url.includes('identity.idoklad.cz')).length).toBe(1)
  })

  it('filtr faktur: vystavené NEBO změněné od data, stránkování po 200', async () => {
    const { fn, calls } = fakeFetch()
    await fetchIssuedInvoices(client(fn), '2026-07-02')
    const url = new URL(calls.find((c) => c.url.includes('/IssuedInvoices'))!.url)
    expect(url.searchParams.get('filter')).toBe('(DateOfIssue~gte~2026-07-02T00:00:00.000~or~DateLastChange~gte~2026-07-02T00:00:00.000)')
    expect(url.searchParams.get('pagesize')).toBe('200')
    expect(url.searchParams.get('page')).toBe('1')
  })

  it('faktury podle id (Id~ct~) a podle čísla dokladu (eq:base64)', async () => {
    const { fn, calls } = fakeFetch({ invoices: [invoiceRaw()] })
    const c = client(fn)
    await fetchInvoicesByIds(c, [16, 17])
    expect(new URL(calls.filter((x) => x.url.includes('/IssuedInvoices')).at(-1)!.url).searchParams.get('filter')).toBe('(Id~ct~16,17)')
    const found = await fetchInvoiceByDocumentNumber(c, '20260016')
    expect(found?.id).toBe(16)
    const f = new URL(calls.filter((x) => x.url.includes('/IssuedInvoices')).at(-1)!.url).searchParams.get('filter')
    expect(f).toBe(`(DocumentNumber~eq:base64~${Buffer.from('20260016').toString('base64')})`)
    expect(await fetchInvoiceByDocumentNumber(c, 'jine-cislo')).toBeNull()
  })

  it('stránkování: bere všechny stránky a hlásí ořez při přetečení maxPages', async () => {
    let page = 0
    const fn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('identity')) return TOKEN()
      if (url.includes('/Currencies')) return json({ Data: { Items: [{ Id: 1, Code: 'CZK' }], TotalPages: 1 } })
      page++
      return json({ Data: { Items: [invoiceRaw({ Id: page })], TotalItems: 5, TotalPages: 5 } })
    }) as unknown as typeof fetch
    const all = await fetchIssuedInvoices(client(fn), '2026-07-02', { maxPages: 10 })
    expect(all.items.map((i) => i.id)).toEqual([1, 2, 3, 4, 5])
    expect(all.truncated).toBe(false)
    page = 0
    const cut = await fetchIssuedInvoices(client(fn), '2026-07-02', { maxPages: 2 })
    expect(cut.items).toHaveLength(2)
    expect(cut.truncated).toBe(true)
  })

  it('měna z číselníku (CurrencyId → kód)', async () => {
    const { fn } = fakeFetch({ invoices: [invoiceRaw({ CurrencyId: 2 }), invoiceRaw({ Id: 17, CurrencyId: 9 })] })
    const res = await fetchIssuedInvoices(client(fn), '2026-07-02')
    expect(res.items.map((i) => i.currency)).toEqual(['EUR', null])
    expect([...(await fetchCurrencies(client(fn))).entries()]).toEqual([[1, 'CZK'], [2, 'EUR']])
  })

  it('429 a 5xx se zopakují (Retry-After), 401 obnoví token jednou', async () => {
    const { fn } = fakeFetch({ invoices: [invoiceRaw()], failInvoices: [429, 503] })
    const res = await fetchIssuedInvoices(client(fn), '2026-07-02')
    expect(res.items).toHaveLength(1)

    let calls401 = 0
    const f401 = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('identity')) return TOKEN()
      if (url.includes('/Currencies')) return json({ Data: { Items: [], TotalPages: 1 } })
      if (calls401++ === 0) return new Response('', { status: 401 })
      return json({ Data: { Items: [invoiceRaw()], TotalPages: 1 } })
    }) as unknown as typeof fetch
    expect((await fetchIssuedInvoices(client(f401), '2026-07-02')).items).toHaveLength(1)
    const tokenCalls = vi.mocked(f401).mock.calls.filter((c) => String(c[0]).includes('identity')).length
    expect(tokenCalls).toBe(2)
  })

  it('chyby nesou jen status, kód a českou větu — nikdy tajemství ani tělo odpovědi', async () => {
    const bad = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('identity')
        ? json({ error: 'invalid_client', error_description: 'secret super-secret-value leaked' }, { status: 400 })
        : new Response('tělo s tajemstvím', { status: 500 })) as unknown as typeof fetch
    const err = await failure(client(bad).get('IssuedInvoices'))
    expect(err).toBeInstanceOf(IdokladError)
    expect(err.status).toBe(400)
    expect(err.code).toBe('invalid_client')
    expect(JSON.stringify({ m: err.message, c: err.code })).not.toMatch(/super-secret|cid-123|tajemstv/)

    const noApi = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('identity') ? TOKEN() : new Response('x', { status: 402 })) as unknown as typeof fetch
    const e402 = await failure(client(noApi).get('IssuedInvoices'))
    expect(e402.status).toBe(402)
    expect(e402.message).toMatch(/tarif/i)
  })

  it('výpadek sítě je IdokladError network, bez detailu', async () => {
    const down = vi.fn(async () => { throw new Error('ECONNRESET secret=super-secret-value') }) as unknown as typeof fetch
    const err = await failure(client(down).get('IssuedInvoices'))
    expect(err.code).toBe('network')
    expect(err.message).not.toMatch(/super-secret/)
  })
})

describe('normalizace odpovědí', () => {
  it('faktura: datumy bez času, základ a s DPH, IČO a název z PartnerAddress', () => {
    const inv = normalizeInvoice(invoiceRaw({ PaymentStatus: 2, Prices: { TotalWithoutVat: 100, TotalWithVat: 121, TotalPaid: 60.5 } }))
    expect(inv).toMatchObject({
      id: 16, documentNumber: '20260016', variableSymbol: '20260016', issuedOn: '2026-09-16', dueOn: '2026-09-30',
      totalNet: 100, totalGross: 121, totalPaid: 60.5, paymentStatus: 'partial', partnerIco: '12345678', partnerName: 'Alfa s.r.o.',
    })
  })
  it('osoba místo firmy: jméno z Firstname a Surname; chybějící ceny = 0', () => {
    const inv = normalizeInvoice(invoiceRaw({ PartnerAddress: { Firstname: 'Jan', Surname: 'Novák' }, Prices: {} }))
    expect(inv?.partnerName).toBe('Jan Novák')
    expect(inv?.partnerIco).toBeNull()
    expect(inv?.totalNet).toBe(0)
  })
  it('stav úhrady: číselný i textový, neznámý zůstane neznámý', () => {
    expect(normalizeInvoice(invoiceRaw({ PaymentStatus: 1 }))?.paymentStatus).toBe('paid')
    expect(normalizeInvoice(invoiceRaw({ PaymentStatus: 3 }))?.paymentStatus).toBe('overpaid')
    expect(normalizeInvoice(invoiceRaw({ PaymentStatus: 'PartialPaid' }))?.paymentStatus).toBe('partial')
    expect(normalizeInvoice(invoiceRaw({ PaymentStatus: 42 }))?.paymentStatus).toBe('unknown')
  })
  it('vadná položka se zahodí (bez id, čísla nebo data)', () => {
    expect(normalizeInvoice({ Id: 1 })).toBeNull()
    expect(normalizeInvoice(invoiceRaw({ DocumentNumber: '' }))).toBeNull()
    expect(normalizeInvoice(invoiceRaw({ DateOfIssue: 'včera' }))).toBeNull()
    expect(normalizeInvoice('x')).toBeNull()
  })
  it('úhrada: částka z Prices.PaymentAmount, datum bez času', () => {
    expect(normalizePayment({ Id: 7, InvoiceId: 16, InvoiceDocumentNumber: '20260016', DateOfPayment: '2026-09-20T00:00:00', CurrencyId: 1, Prices: { PaymentAmount: 12100 } }))
      .toEqual({ id: 7, invoiceId: 16, documentNumber: '20260016', paidOn: '2026-09-20', amount: 12100, currencyId: 1 })
    expect(normalizePayment({ Id: 7, InvoiceId: 16, DateOfPayment: '2026-09-20' })).toBeNull()
  })
})
