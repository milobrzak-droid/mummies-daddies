// iDoklad — účetní systém (idoklad.cz), REST API v3. POUZE ČTENÍ.
//
// Ověřeno proti oficiální dokumentaci (https://api.idoklad.cz/Help/v3/en/,
// stav 30. 9. 2026):
//   * Přihlášení: OAuth2 „client credentials flow". POST na
//     https://identity.idoklad.cz/server/connect/token (formulář:
//     grant_type=client_credentials, client_id, client_secret,
//     scope=idoklad_api). Odpověď nese access_token a expires_in. Každý
//     požadavek pak nese `Authorization: Bearer <token>`.
//     Client ID a Client Secret vzniknou v iDokladu: Nastavení → Aplikace →
//     záložka API → „Generovat" (viz docs/PROVOZ.md).
//   * Vydané faktury: GET https://api.idoklad.cz/v3/IssuedInvoices
//     (filtr, řazení, stránkování; PartnerAddress nese IČO a název partnera,
//     Prices.TotalWithoutVat / TotalWithVat / TotalPaid, DateOfIssue,
//     DateOfMaturity, DateOfPayment, PaymentStatus, VariableSymbol,
//     DocumentNumber, CurrencyId).
//   * Úhrady faktur: GET /v3/IssuedDocumentPayments (InvoiceId,
//     InvoiceDocumentNumber, DateOfPayment, Prices.PaymentAmount, CurrencyId).
//   * Měny: GET /v3/Currencies (Id, Code) — číselník, čte se jednou za běh.
//   * Stránkování: pagesize nejvýš 200 (výchozí 20). Filtr:
//     `(Sloupec~operátor~hodnota~and~…)`, operátory lt/lte/gt/gte/eq/!eq/ct;
//     textové hodnoty kódovat base64 (`eq:base64`). Limity: 200 požadavků za
//     minutu (HTTP 429), měsíční limit podle tarifu (Popular 7 500,
//     Premium 75 000). HTTP 402 = tarif neumožňuje API.
//
// Co dokumentace neříká přesně (zapsáno jako „ověř na účtu" v docs/PROVOZ.md
// a hlídají to podvržené odpovědi v testech):
//   * jestli vaše agenda vrací PartnerAddress.NickName jako název firmy
//     (dokumentace ho uvádí u výběru sloupců, ale nepopisuje význam);
//   * které z volitelných polí (DateOfPayment, TotalPaid) jsou u vaší agendy
//     vyplněná — parser je proto tolerantní a chybějící číslo bere jako 0.
//
// NIKDY nezapisuje: konektor umí jen GET (plus jediný POST na token endpoint).
// Tajemství (client secret, access token) se nikdy nelogují ani nevracejí;
// chyby nesou jen HTTP status a krátký kód, nikdy tělo odpovědi.

export const IDOKLAD_API_BASE = 'https://api.idoklad.cz/v3'
export const IDOKLAD_TOKEN_URL = 'https://identity.idoklad.cz/server/connect/token'
export const IDOKLAD_SCOPE = 'idoklad_api'
/** Nejvyšší velikost stránky, kterou API dovolí. */
export const IDOKLAD_MAX_PAGE_SIZE = 200

export const IDOKLAD_ENV = {
  enabled: 'IDOKLAD_SYNC_ENABLED',
  clientId: 'IDOKLAD_CLIENT_ID',
  clientSecret: 'IDOKLAD_CLIENT_SECRET',
} as const

type Env = Record<string, string | undefined>

/** Přepínač platí jen s hodnotou přesně `true`; cokoli jiného = vypnuto. */
export function idokladSyncEnabledFromEnv(env: Env): boolean {
  return env[IDOKLAD_ENV.enabled] === 'true'
}

export type IdokladCredentials = { clientId: string; clientSecret: string }

export function idokladCredentialsFromEnv(env: Env): IdokladCredentials | null {
  const clientId = env[IDOKLAD_ENV.clientId]?.trim()
  const clientSecret = env[IDOKLAD_ENV.clientSecret]?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** Názvy chybějících proměnných (bez hodnot) — UI z nich řekne, co doplnit. */
export function idokladMissingEnv(env: Env): string[] {
  return [IDOKLAD_ENV.clientId, IDOKLAD_ENV.clientSecret].filter((k) => !env[k]?.trim())
}

/** Chyba iDokladu: jen HTTP status a krátký kód, nikdy tělo odpovědi ani tajemství. */
export class IdokladError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'IdokladError'
    this.status = status
    this.code = code
  }
}

function messageFor(status: number): string {
  if (status === 401) return 'iDoklad odmítl přihlášení (zkontrolujte Client ID a Client Secret).'
  if (status === 402 || status === 403) return 'Tarif iDokladu API nedovoluje (potřebný je placený tarif s API).'
  if (status === 429) return 'iDoklad vrátil limit požadavků (429), zkusí se to při dalším běhu.'
  if (status >= 500) return `iDoklad teď neodpovídá (HTTP ${status}).`
  return `iDoklad vrátil chybu (HTTP ${status}).`
}

export type IdokladClientOptions = {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  /** Kolikrát se zopakuje 429 / 5xx (výchozí 3). */
  retries?: number
}

export interface IdokladClient {
  /** GET na cestu pod /v3 (např. `IssuedInvoices`) s parametry dotazu. Vrací rozbalený obsah `Data`. */
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function createIdokladClient(creds: IdokladCredentials, opts: IdokladClientOptions = {}): IdokladClient {
  const doFetch = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const timeoutMs = opts.timeoutMs ?? 15_000
  const retries = opts.retries ?? 3
  let token: { value: string; expiresAt: number } | null = null

  async function fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      scope: IDOKLAD_SCOPE,
    })
    let res: Response
    try {
      res = await doFetch(IDOKLAD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      })
    } catch {
      throw new IdokladError(0, 'network', 'iDoklad (přihlášení) neodpovídá.')
    }
    if (!res.ok) {
      // Chybový kód OAuth (invalid_client, …) je bezpečný; zbytek těla ne.
      let code = `http_${res.status}`
      try {
        const j = (await res.json()) as { error?: unknown }
        if (typeof j.error === 'string' && /^[a-z_]{1,40}$/.test(j.error)) code = j.error
      } catch {
        /* tělo není JSON */
      }
      throw new IdokladError(res.status, code, res.status === 400 || res.status === 401
        ? 'iDoklad odmítl přihlášení (zkontrolujte Client ID a Client Secret).'
        : messageFor(res.status))
    }
    const j = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof j.access_token !== 'string' || !j.access_token) {
      throw new IdokladError(res.status, 'no_token', 'iDoklad nevrátil přístupový token.')
    }
    const ttl = typeof j.expires_in === 'number' && j.expires_in > 0 ? j.expires_in : 3600
    token = { value: j.access_token, expiresAt: now() + ttl * 1000 }
    return token.value
  }

  async function bearer(force = false): Promise<string> {
    if (!force && token && token.expiresAt - 60_000 > now()) return token.value
    return fetchToken()
  }

  function url(path: string, query: Record<string, string | number | undefined>): string {
    const u = new URL(`${IDOKLAD_API_BASE}/${path.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v))
    return u.toString()
  }

  return {
    async get(path, query = {}) {
      const target = url(path, query)
      let refreshed = false
      for (let attempt = 0; ; attempt++) {
        const accessToken = await bearer()
        let res: Response
        try {
          res = await doFetch(target, {
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(timeoutMs),
            cache: 'no-store',
          })
        } catch {
          if (attempt < retries) {
            await sleep(500 * (attempt + 1))
            continue
          }
          throw new IdokladError(0, 'network', 'iDoklad neodpovídá.')
        }
        if (res.ok) {
          const json = (await res.json()) as { Data?: unknown } | null
          return json && typeof json === 'object' && 'Data' in json ? json.Data : json
        }
        if (res.status === 401 && !refreshed) {
          refreshed = true
          token = null
          await bearer(true)
          continue
        }
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt
          await sleep(wait)
          continue
        }
        throw new IdokladError(res.status, `http_${res.status}`, messageFor(res.status))
      }
    },
  }
}

// ---------------------------------------------------------------- normalizace

export type IdokladPaymentStatus = 'unpaid' | 'paid' | 'partial' | 'overpaid' | 'unknown'

export type IdokladInvoice = {
  id: number
  documentNumber: string
  variableSymbol: string | null
  /** Datum vystavení (YYYY-MM-DD). */
  issuedOn: string
  /** Splatnost (YYYY-MM-DD) nebo null. */
  dueOn: string | null
  paidOn: string | null
  currencyId: number | null
  /** Kód měny (CZK, EUR, …) po přiřazení z číselníku; null = neznámá. */
  currency: string | null
  totalNet: number
  totalGross: number
  /** Zaplaceno celkem (s DPH, v měně faktury). */
  totalPaid: number
  paymentStatus: IdokladPaymentStatus
  partnerId: number | null
  partnerIco: string | null
  partnerName: string | null
}

export type IdokladPayment = {
  id: number
  invoiceId: number
  documentNumber: string | null
  /** Datum úhrady (YYYY-MM-DD). */
  paidOn: string
  /** Částka úhrady (s DPH, v měně faktury). */
  amount: number
  currencyId: number | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const id = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
/** '2026-09-16T00:00:00' → '2026-09-16'; jinak null. */
const day = (v: unknown): string | null => {
  const s = str(v)
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null
  return m ? m[1] : null
}

const PAYMENT_STATUS: Record<number, IdokladPaymentStatus> = { 0: 'unpaid', 1: 'paid', 2: 'partial', 3: 'overpaid' }
const PAYMENT_STATUS_BY_NAME: Record<string, IdokladPaymentStatus> = {
  unpaid: 'unpaid', paid: 'paid', partialpaid: 'partial', overpaid: 'overpaid',
}

function statusOf(v: unknown): IdokladPaymentStatus {
  if (typeof v === 'number') return PAYMENT_STATUS[v] ?? 'unknown'
  if (typeof v === 'string') return PAYMENT_STATUS_BY_NAME[v.toLowerCase()] ?? 'unknown'
  return 'unknown'
}

/** Vydaná faktura z odpovědi API; položka bez id, čísla nebo data vystavení se zahodí (null). */
export function normalizeInvoice(raw: unknown): IdokladInvoice | null {
  if (!isRecord(raw)) return null
  const invoiceId = id(raw.Id)
  const documentNumber = str(raw.DocumentNumber)
  const issuedOn = day(raw.DateOfIssue)
  if (invoiceId === null || documentNumber === null || issuedOn === null) return null
  const prices = isRecord(raw.Prices) ? raw.Prices : {}
  const partner = isRecord(raw.PartnerAddress) ? raw.PartnerAddress : {}
  const person = [str(partner.Firstname), str(partner.Surname)].filter(Boolean).join(' ')
  const gross = num(prices.TotalWithVat) ?? 0
  return {
    id: invoiceId,
    documentNumber,
    variableSymbol: str(raw.VariableSymbol),
    issuedOn,
    dueOn: day(raw.DateOfMaturity),
    paidOn: day(raw.DateOfPayment),
    currencyId: id(raw.CurrencyId),
    currency: null,
    totalNet: num(prices.TotalWithoutVat) ?? gross,
    totalGross: gross,
    totalPaid: num(prices.TotalPaid) ?? 0,
    paymentStatus: statusOf(raw.PaymentStatus),
    partnerId: id(raw.PartnerId),
    partnerIco: str(partner.IdentificationNumber),
    partnerName: str(partner.NickName) ?? (person || null),
  }
}

export function normalizePayment(raw: unknown): IdokladPayment | null {
  if (!isRecord(raw)) return null
  const paymentId = id(raw.Id)
  const invoiceId = id(raw.InvoiceId)
  const paidOn = day(raw.DateOfPayment)
  const prices = isRecord(raw.Prices) ? raw.Prices : {}
  const amount = num(prices.PaymentAmount)
  if (paymentId === null || invoiceId === null || paidOn === null || amount === null) return null
  return { id: paymentId, invoiceId, documentNumber: str(raw.InvoiceDocumentNumber), paidOn, amount, currencyId: id(raw.CurrencyId) }
}

// ---------------------------------------------------------------- načítání

export type ListOptions = { filter?: string; sort?: string; maxPages?: number }
export type ListResult<T> = { items: T[]; truncated: boolean }

/** Všechny stránky seznamu (nejvýš maxPages po 200 položkách). */
export async function listAll(client: IdokladClient, path: string, opts: ListOptions = {}): Promise<ListResult<unknown>> {
  const maxPages = opts.maxPages ?? 10
  const items: unknown[] = []
  for (let page = 1; page <= maxPages; page++) {
    const data = await client.get(path, { filter: opts.filter, sort: opts.sort, page, pagesize: IDOKLAD_MAX_PAGE_SIZE })
    const pageItems = isRecord(data) && Array.isArray(data.Items) ? data.Items : Array.isArray(data) ? data : []
    items.push(...pageItems)
    const totalPages = isRecord(data) && typeof data.TotalPages === 'number' ? data.TotalPages : page
    if (page >= totalPages || pageItems.length === 0) return { items, truncated: false }
  }
  return { items, truncated: true }
}

/** Podmínka filtru `sloupec~operátor~hodnota`; datum jako v ukázkách dokumentace (YYYY-MM-DDT00:00:00.000). */
const dateFilter = (column: string, op: 'gte' | 'lte', date: string) => `${column}~${op}~${date}T00:00:00.000`

/**
 * Vydané faktury vystavené NEBO změněné od data `since` (změna = např. úhrada
 * nebo posun splatnosti). Měny se doplní z číselníku.
 */
export async function fetchIssuedInvoices(
  client: IdokladClient,
  since: string,
  opts: { maxPages?: number } = {},
): Promise<ListResult<IdokladInvoice>> {
  const filter = `(${dateFilter('DateOfIssue', 'gte', since)}~or~${dateFilter('DateLastChange', 'gte', since)})`
  const raw = await listAll(client, 'IssuedInvoices', { filter, sort: 'Id~asc', maxPages: opts.maxPages })
  return { items: await withCurrencies(client, raw.items.map(normalizeInvoice).filter((i): i is IdokladInvoice => i !== null)), truncated: raw.truncated }
}

/** Faktury podle id (např. k úhradám starších faktur). Filtr `Id~ct~1,2,3` podle dokumentace. */
export async function fetchInvoicesByIds(client: IdokladClient, ids: readonly number[]): Promise<IdokladInvoice[]> {
  const out: IdokladInvoice[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const raw = await listAll(client, 'IssuedInvoices', { filter: `(Id~ct~${chunk.join(',')})`, maxPages: 1 })
    out.push(...raw.items.map(normalizeInvoice).filter((x): x is IdokladInvoice => x !== null))
  }
  return withCurrencies(client, out)
}

/** Faktura podle čísla dokladu (přesná shoda, hodnota v base64 podle dokumentace); null = neexistuje. */
export async function fetchInvoiceByDocumentNumber(client: IdokladClient, documentNumber: string): Promise<IdokladInvoice | null> {
  const b64 = Buffer.from(documentNumber, 'utf8').toString('base64')
  const raw = await listAll(client, 'IssuedInvoices', { filter: `(DocumentNumber~eq:base64~${b64})`, maxPages: 1 })
  const found = raw.items.map(normalizeInvoice).find((i): i is IdokladInvoice => i !== null && i.documentNumber === documentNumber)
  return found ? (await withCurrencies(client, [found]))[0] : null
}

export async function fetchIssuedPayments(
  client: IdokladClient,
  since: string,
  opts: { maxPages?: number } = {},
): Promise<ListResult<IdokladPayment>> {
  const raw = await listAll(client, 'IssuedDocumentPayments', {
    filter: `(${dateFilter('DateOfPayment', 'gte', since)})`,
    sort: 'Id~asc',
    maxPages: opts.maxPages,
  })
  return { items: raw.items.map(normalizePayment).filter((p): p is IdokladPayment => p !== null), truncated: raw.truncated }
}

const currencyCache = new WeakMap<IdokladClient, Promise<Map<number, string>>>()

/** Číselník měn: Id → kód (CZK, EUR, …); jednou na klienta (běh). */
export function fetchCurrencies(client: IdokladClient): Promise<Map<number, string>> {
  let cached = currencyCache.get(client)
  if (!cached) {
    cached = loadCurrencies(client)
    currencyCache.set(client, cached)
    cached.catch(() => currencyCache.delete(client))
  }
  return cached
}

async function loadCurrencies(client: IdokladClient): Promise<Map<number, string>> {
  const raw = await listAll(client, 'Currencies', { maxPages: 2 })
  const map = new Map<number, string>()
  for (const r of raw.items) {
    if (!isRecord(r)) continue
    const cid = id(r.Id)
    const code = str(r.Code)
    if (cid !== null && code) map.set(cid, code.toUpperCase())
  }
  return map
}

async function withCurrencies(client: IdokladClient, invoices: IdokladInvoice[]): Promise<IdokladInvoice[]> {
  if (invoices.length === 0) return invoices
  const currencies = await fetchCurrencies(client)
  return invoices.map((i) => ({ ...i, currency: i.currencyId !== null ? currencies.get(i.currencyId) ?? null : null }))
}
