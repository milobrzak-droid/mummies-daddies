// Microsoft Graph — obsahový vstup pošty: jen složka, kterou člověk VĚDOMĚ
// vybral (v Outlooku přesunul zprávu do složky „Cockpit"; docs/PROVOZ.md).
//
// Jen transport. Zbytek schránky se dál čte výhradně jako metadata
// (connectors/graph/mail.ts, MAIL_DELTA_SELECT bez předmětu a těla). Tady se
// smí číst tělo, ale:
//   - jen z JEDNÉ složky dané id (nikdy Doručená ani Odeslaná),
//   - těla se žádá jako prostý text (Prefer outlook.body-content-type),
//   - přílohy se čtou JEN jako názvy ($select=name,isInline; nikdy
//     contentBytes, nikdy /$value),
//   - co s textem dál (úryvek, zahození těla) řeší domain/crm/mailContent.ts.
//
// Práva: stačí Mail.Read (delegovaně). Založení složky by chtělo Mail.ReadWrite,
// které Cockpit nežádá, proto createMailFolder na 403 odpoví 'forbidden'
// a složku si založí člověk sám.
import {
  GRAPH_BASE,
  fetchDeltaPage,
  parseRetryAfter,
  type DeltaResult,
  type FetchLike,
  type GraphMailMessage,
} from './mail'

export const CONTENT_DELTA_SELECT = [
  'id',
  'internetMessageId',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'isDraft',
  'hasAttachments',
  'webLink',
  'body',
] as const

/** Stránka po 10 (těla jsou velká), neměnná id a tělo jako text. */
export const CONTENT_DELTA_PREFER = 'odata.maxpagesize=10, IdType="ImmutableId", outlook.body-content-type="text"'

export type GraphContentMessage = GraphMailMessage & {
  subject?: string | null
  hasAttachments?: boolean | null
  body?: { contentType?: string | null; content?: string | null } | null
}

export type ContentDeltaResult = DeltaResult<GraphContentMessage>

export function contentDeltaStartUrl(folderId: string): string {
  return `${GRAPH_BASE}/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${CONTENT_DELTA_SELECT.join(',')}`
}

export function fetchContentDeltaPage(
  accessToken: string,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<ContentDeltaResult> {
  return fetchDeltaPage<GraphContentMessage>(accessToken, url, CONTENT_DELTA_PREFER, fetchImpl)
}

// ---------------------------------------------------------------------------
// Složka podle názvu

export type FolderLookup =
  | { kind: 'found'; id: string }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'error'; message: string }

const normName = (s: string): string => s.trim().normalize('NFC').toLocaleLowerCase('cs')

async function getJson(
  accessToken: string,
  url: string,
  fetchImpl: FetchLike,
): Promise<{ ok: true; json: Record<string, unknown> } | Exclude<FolderLookup, { kind: 'found' | 'missing' }>> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  if (res.status === 429 || res.status === 503) {
    return { kind: 'throttled', retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')) }
  }
  if (res.status === 403) return { kind: 'forbidden' }
  if (!res.ok) return { kind: 'error', message: `Graph ${res.status}` }
  try {
    return { ok: true, json: (await res.json()) as Record<string, unknown> }
  } catch {
    return { kind: 'error', message: 'Graph vrátil nečitelnou odpověď' }
  }
}

function pickFolder(json: Record<string, unknown>, wanted: string): string | null {
  const list = Array.isArray(json.value) ? (json.value as { id?: unknown; displayName?: unknown }[]) : []
  for (const f of list) {
    if (typeof f.id === 'string' && typeof f.displayName === 'string' && normName(f.displayName) === wanted) return f.id
  }
  return null
}

/**
 * Najde složku podle názvu: nejdřív mezi složkami nejvyšší úrovně, pak
 * ve složce Doručená (kam si ji lidé nejčastěji zakládají). Nezakládá nic.
 */
export async function findMailFolder(
  accessToken: string,
  displayName: string,
  fetchImpl: FetchLike = fetch,
): Promise<FolderLookup> {
  const wanted = normName(displayName)
  if (wanted === '') return { kind: 'error', message: 'Název složky je prázdný' }
  for (const path of ['/me/mailFolders', '/me/mailFolders/inbox/childFolders']) {
    const r = await getJson(accessToken, `${GRAPH_BASE}${path}?$top=100&$select=id,displayName`, fetchImpl)
    if (!('ok' in r)) return r
    const id = pickFolder(r.json, wanted)
    if (id) return { kind: 'found', id }
  }
  return { kind: 'missing' }
}

/**
 * Založí složku nejvyšší úrovně. Volat jen za výslovným přepínačem
 * (MAIL_CONTENT_FOLDER_CREATE). S právem Mail.Read Graph odpoví 403 —
 * výsledek 'forbidden' (složku pak založí člověk v Outlooku).
 */
export async function createMailFolder(
  accessToken: string,
  displayName: string,
  fetchImpl: FetchLike = fetch,
): Promise<FolderLookup> {
  let res: Response
  try {
    res = await fetchImpl(`${GRAPH_BASE}/me/mailFolders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  if (res.status === 429 || res.status === 503) {
    return { kind: 'throttled', retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')) }
  }
  if (res.status === 403) return { kind: 'forbidden' }
  if (!res.ok) return { kind: 'error', message: `Graph ${res.status}` }
  try {
    const json = (await res.json()) as { id?: unknown }
    return typeof json.id === 'string' ? { kind: 'found', id: json.id } : { kind: 'error', message: 'Graph nevrátil id složky' }
  } catch {
    return { kind: 'error', message: 'Graph vrátil nečitelnou odpověď' }
  }
}

// ---------------------------------------------------------------------------
// Názvy příloh (jen jména, žádný obsah)

export type AttachmentNames = { ok: true; names: string[] } | { ok: false }

/** Názvy příloh zprávy bez vložených obrázků (podpisy). Best-effort; obsah příloh se nikdy nestahuje. */
export async function fetchAttachmentNames(
  accessToken: string,
  messageId: string,
  fetchImpl: FetchLike = fetch,
): Promise<AttachmentNames> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=name,isInline&$top=20`
  const r = await getJson(accessToken, url, fetchImpl)
  if (!('ok' in r)) return { ok: false }
  const list = Array.isArray(r.json.value) ? (r.json.value as { name?: unknown; isInline?: unknown }[]) : []
  const names = list
    .filter((a) => a.isInline !== true && typeof a.name === 'string' && a.name.trim() !== '')
    .map((a) => (a.name as string).trim())
  return { ok: true, names }
}
