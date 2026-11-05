// Microsoft Graph — delta dotaz na metadata pošty (Inbox / Odeslané).
//
// Jen transport: sestaví URL, pošle jeden požadavek a odpověď přeloží na
// jednoznačný výsledek (stránka / throttling / expirovaný delta token /
// chyba). Stavový automat kurzoru a zápis do DB řeší domain/crm/mailSync.ts.
//
// Soukromí: $select je natvrdo jen metadata. NIKDY subject, body ani
// bodyPreview — i kdyby je Graph poslal, mapování v doméně je zahodí.

export type MailFolder = 'inbox' | 'sentitems'

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export const MAIL_DELTA_SELECT = [
  'id',
  'internetMessageId',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'isDraft',
  // Jen odkaz zpět na Outlook (pro evidence u spárovaných zpráv, viz
  // domain/crm/mailSync.ts) — ne obsah. Standardní vlastnost zprávy,
  // čitelná s Mail.Read stejně jako ostatní pole v tomhle výběru.
  'webLink',
] as const

/** Stránka po 50 a neměnná id (přesun mezi složkami id nezmění). */
export const MAIL_DELTA_PREFER = 'odata.maxpagesize=50, IdType="ImmutableId"'

// `name` je jméno z hlavičky (Od / Komu / Kopie) — Graph ho vrací spolu s adresou,
// $select se kvůli němu nemění. Sync ho neukládá; čte ho jen automatické zakládání
// poptávek (domain/crm/autoIntake.ts) a jen v paměti jednoho běhu.
type Recipient = { emailAddress?: { address?: string | null; name?: string | null } | null }

export type GraphMailMessage = {
  id: string
  internetMessageId?: string | null
  from?: Recipient | null
  toRecipients?: Recipient[] | null
  ccRecipients?: Recipient[] | null
  receivedDateTime?: string | null
  sentDateTime?: string | null
  isDraft?: boolean | null
  /** URL zprávy v Outlook na webu; sanitizace (https + povolený host) je v domain/crm/mailSync.ts. */
  webLink?: string | null
  /** Delta hlásí smazané zprávy takhle; pro nás nic neznamenají. */
  '@removed'?: unknown
}

/** Výsledek jedné stránky delta dotazu (tvar sdílí pošta metadat i obsahový vstup). */
export type DeltaResult<M> =
  | { kind: 'page'; messages: M[]; nextLink: string | null; deltaLink: string | null }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'expired' }
  /** 403 — token nemá právo na poštu (typicky chybí Mail.Read, Outlook je potřeba znovu připojit). */
  | { kind: 'forbidden'; code: string | null }
  | { kind: 'error'; status: number; message: string }

export type MailDeltaResult = DeltaResult<GraphMailMessage>

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * Počáteční URL delta dotazu. S `since` (ISO čas) se první načtení omezí na
 * zprávy `receivedDateTime ge since`, nejnovější první.
 *
 * Podle dokumentace Graphu (message: delta) je jediný podporovaný $filter
 * `receivedDateTime ge|gt <čas>` a jediný $orderby `receivedDateTime desc`;
 * bez $orderby není pořadí zaručené. Filtr na sentDateTime delta nepodporuje —
 * v Odeslané poště se receivedDateTime rovná času odeslání, proto se filtruje
 * podle něj. Filtr i řazení se zakódují do nextLink / deltaLink, takže se
 * uvádějí jen tady, v první žádosti. $select zůstává jen metadata.
 */
export function mailDeltaStartUrl(folder: MailFolder, since?: string | null): string {
  const base = `${GRAPH_BASE}/me/mailFolders/${folder}/messages/delta?$select=${MAIL_DELTA_SELECT.join(',')}`
  if (!since || !Number.isFinite(Date.parse(since))) return base
  const at = new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `${base}&$filter=${encodeURIComponent(`receivedDateTime ge ${at}`)}&$orderby=${encodeURIComponent('receivedDateTime desc')}`
}

/** Následujeme a ukládáme jen odkazy zpět na Graph — nic, co by šlo podstrčit jinam. */
export function isGraphLink(link: unknown): link is string {
  return typeof link === 'string' && link.startsWith(`${GRAPH_BASE}/`)
}

/** Retry-After v sekundách; chybějící/nesmyslná hodnota → rozumný default. */
export function parseRetryAfter(value: string | null, fallbackSeconds = 10): number {
  if (!value) return fallbackSeconds
  const n = Number(value)
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n)
  const at = Date.parse(value)
  if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000))
  return fallbackSeconds
}

const EXPIRED_CODES = new Set(['syncStateNotFound', 'syncStateInvalid', 'resyncRequired'])

export async function fetchMailDeltaPage(
  accessToken: string,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<MailDeltaResult> {
  return fetchDeltaPage<GraphMailMessage>(accessToken, url, MAIL_DELTA_PREFER, fetchImpl)
}

/**
 * Jedna stránka delta dotazu nad zprávami. `prefer` určuje velikost stránky
 * a formát; tvar zprávy (`M`) i $select v URL určuje volající — tenhle
 * transport jen vyhodnotí odpověď.
 */
export async function fetchDeltaPage<M>(
  accessToken: string,
  url: string,
  prefer: string,
  fetchImpl: FetchLike = fetch,
): Promise<DeltaResult<M>> {
  if (!isGraphLink(url)) return { kind: 'error', status: 0, message: 'Neplatná delta URL' }
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: prefer },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return { kind: 'error', status: 0, message: e instanceof Error ? e.message : String(e) }
  }

  if (res.status === 429 || res.status === 503) {
    return { kind: 'throttled', retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')) }
  }

  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    json = null
  }

  if (!res.ok) {
    const err = (json?.error ?? null) as { code?: string; message?: string } | null
    if (res.status === 410 || (err?.code && EXPIRED_CODES.has(err.code))) return { kind: 'expired' }
    // 403 na /me/mailFolders = token bez práva na poštu (ErrorAccessDenied /
    // Authorization_RequestDenied). Opakování nepomůže, jen nové připojení.
    if (res.status === 403) return { kind: 'forbidden', code: typeof err?.code === 'string' ? err.code : null }
    // Zpráva z Graphu může nést detaily; do stavu jde jen kód.
    return { kind: 'error', status: res.status, message: `Graph ${res.status}${err?.code ? ` ${err.code}` : ''}` }
  }

  const value = Array.isArray(json?.value) ? (json!.value as M[]) : []
  const next = json?.['@odata.nextLink']
  const delta = json?.['@odata.deltaLink']
  return {
    kind: 'page',
    messages: value,
    nextLink: isGraphLink(next) ? next : null,
    deltaLink: isGraphLink(delta) ? delta : null,
  }
}
