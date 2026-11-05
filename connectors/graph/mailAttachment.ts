// Microsoft Graph — stažení JEDNÉ přílohy zprávy ze složky „Cockpit" pro import
// nabídky z e-mailu (MAIL_OFFER_ATTACHMENT_ENABLED; docs/PROVOZ.md).
//
// Výjimka z pravidla „přílohy jen jako názvy" (connectors/graph/mailContent.ts):
// smí se volat JEN pro zprávu, kterou člověk vědomě přesunul do složky, a JEN pro
// přílohu, která podle názvu vypadá jako nabídka (domain/crm/mailOffer.ts). Tady
// je pouze transport; rozhodnutí, co stáhnout, dělá volající.
//
// Práva: stačí delegované Mail.Read. Graph pro čtení příloh vlastní pošty žádá
// Mail.Read (Mail.ReadBasic přílohy nevydá) a Cockpit ho už má; nic víc se
// nežádá. Obě volání jsou čisté GET, žádný zápis (test/mail-offer-graph.test.ts
// hlídá, že se nikdy neodešle jiná metoda ani jiná cesta než přílohy zprávy).
//
// Soukromí: bajty přílohy se vrací volajícímu do paměti a nikde se neukládají ani
// nelogují. Chyby nesou jen kód, ne obsah odpovědi.
import { GRAPH_BASE, parseRetryAfter, type FetchLike } from './mail'

const PREFER = 'IdType="ImmutableId"'

export type MessageAttachment = {
  id: string
  name: string
  contentType: string
  size: number
  isInline: boolean
  /** Souborová příloha (ne vložená zpráva ani odkaz na soubor). */
  isFile: boolean
}

export type AttachmentFailure =
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'throttled'; retryAfterSeconds: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'error' }

export type AttachmentList = { ok: true; items: MessageAttachment[] } | AttachmentFailure

function failure(status: number, retryAfter: string | null): AttachmentFailure {
  if (status === 429 || status === 503) return { ok: false, reason: 'throttled', retryAfterSeconds: parseRetryAfter(retryAfter) }
  if (status === 403 || status === 401) return { ok: false, reason: 'forbidden' }
  if (status === 404) return { ok: false, reason: 'not_found' }
  return { ok: false, reason: 'error' }
}

/**
 * Přílohy zprávy s metadaty potřebnými k rozhodnutí (název, typ, velikost). Obsah
 * se nestahuje. Nejvýš 20 příloh.
 */
export async function listMessageAttachments(
  accessToken: string,
  messageId: string,
  fetchImpl: FetchLike = fetch,
): Promise<AttachmentList> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline&$top=20`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: PREFER },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return { ok: false, reason: 'error' }
  }
  if (!res.ok) return failure(res.status, res.headers.get('Retry-After'))
  let json: { value?: unknown }
  try {
    json = (await res.json()) as { value?: unknown }
  } catch {
    return { ok: false, reason: 'error' }
  }
  const list = Array.isArray(json.value) ? (json.value as Record<string, unknown>[]) : []
  const items: MessageAttachment[] = []
  for (const a of list) {
    if (typeof a.id !== 'string' || typeof a.name !== 'string') continue
    const odataType = typeof a['@odata.type'] === 'string' ? (a['@odata.type'] as string) : '#microsoft.graph.fileAttachment'
    items.push({
      id: a.id,
      name: a.name.trim(),
      contentType: typeof a.contentType === 'string' ? a.contentType.trim().toLowerCase() : '',
      size: typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0 ? a.size : Number.MAX_SAFE_INTEGER,
      isInline: a.isInline === true,
      isFile: odataType === '#microsoft.graph.fileAttachment',
    })
  }
  return { ok: true, items }
}

export type AttachmentDownload =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' }
  | AttachmentFailure

/**
 * Stáhne obsah jedné souborové přílohy (`/$value`, syrové bajty). Nikdy nepřečte
 * víc než `maxBytes`: příliš velká příloha se přeruší a vrátí `too_large`.
 */
export async function downloadMessageAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  maxBytes: number,
  fetchImpl: FetchLike = fetch,
): Promise<AttachmentDownload> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: PREFER },
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return { ok: false, reason: 'error' }
  }
  if (!res.ok) return failure(res.status, res.headers.get('Retry-After'))
  const declared = Number(res.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    return { ok: false, reason: 'too_large' }
  }
  try {
    if (!res.body) {
      const all = new Uint8Array(await res.arrayBuffer())
      return all.byteLength > maxBytes ? { ok: false, reason: 'too_large' } : { ok: true, bytes: all }
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      bytes.set(c, offset)
      offset += c.byteLength
    }
    return { ok: true, bytes }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
