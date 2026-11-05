// Microsoft Graph — metadata sdíleného souboru ze SharePointu/OneDrivu/Teams
// (plan kap. 8: „SharePoint/Teams knihovna: metadata a vazba na milník, ne
// obsah").
//
// Jen transport: zakóduje odkaz, pošle JEDEN požadavek s delegovaným tokenem
// přihlášeného člena a odpověď přeloží na jednoznačný výsledek. Který odkaz
// se vůbec smí poslat (povolené hosty, přísné parsování URL) rozhoduje
// doména (domain/delivery/documentLink.ts); tady je jen pojistka „https".
//
// Obsah souboru se NIKDY nestahuje: voláme jen …/driveItem s $select na
// metadata. Bez $select by driveItem vracel i předpodepsaný
// @microsoft.graph.downloadUrl — ten si nevyžádáme a z odpovědi ho ani
// nepřebíráme (mapování níže bere jen vyjmenovaná pole). Hlavičku
// `Prefer: redeemSharingLink…` záměrně neposíláme: redeem mění oprávnění
// v SharePointu (trvalý přístup volajícímu), a to Cockpit dělat nemá.
//
// Identita a verze (revize kap. 2E, migrace 0094): kromě metadat čteme
// `id`, `parentReference.driveId` (trvalá identita položky), `eTag` a `cTag`
// (verze podle Graphu) a číslo verze z …/versions. Čtení už uložené položky
// jde přímo přes /drives/{driveId}/items/{itemId} (denní kontrola), bez
// sdílecího odkazu. Pořád jen metadata: žádné /content, žádný downloadUrl,
// žádné náhledy.
//
// Právo: Files.Read.All (connectors/graph/client.ts, GRAPH_FILES_SCOPE —
// jen s GRAPH_FILES_SCOPE_ENABLED=true). Pozn.: stránka shares-get na
// learn.microsoft.com uvádí jako „least privileged" Files.ReadWrite; čtení
// cizích (sdílených) souborů přes Files.Read.All je rozhodnutí vlastníka —
// kdyby Graph vracel 403 i s uděleným Files.Read.All, je to první místo,
// kde hledat.
import { z } from 'zod'
import { logError } from '@/lib/log'
import { GRAPH_BASE, type FetchLike } from './mail'

/**
 * Zakóduje sdílecí URL pro GET /shares/{shareIdOrEncodedSharingUrl}.
 *
 * Pravidla přesně podle learn.microsoft.com/en-us/graph/api/shares-get
 * (oddíl „Encoding sharing URLs"):
 *   1. URL zakódovat base64 (z UTF-8 bajtů),
 *   2. převést na base64url BEZ paddingu: odstranit koncová „=",
 *      nahradit „/" → „_" a „+" → „-",
 *   3. na začátek přidat „u!".
 */
export function encodeSharingUrl(url: string): string {
  const base64 = Buffer.from(url, 'utf8').toString('base64')
  return `u!${base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`
}

/** Jen metadata — žádné content, downloadUrl ani thumbnails. */
export const DRIVE_ITEM_SELECT = [
  'id', 'name', 'webUrl', 'lastModifiedDateTime', 'lastModifiedBy', 'size', 'file', 'eTag', 'cTag', 'parentReference',
] as const

export function sharedDriveItemUrl(sharingUrl: string): string {
  return `${GRAPH_BASE}/shares/${encodeSharingUrl(sharingUrl)}/driveItem?$select=${DRIVE_ITEM_SELECT.join(',')}`
}

export type DriveItemMetadata = {
  /** Graph id položky (driveItem.id); null, když ho Graph nevrátil. */
  itemId: string | null
  /** Graph id knihovny (parentReference.driveId); null, když ho Graph nevrátil. */
  driveId: string | null
  /** eTag: mění se i se změnou metadat. */
  eTag: string | null
  /** cTag: mění se jen se změnou obsahu. */
  cTag: string | null
  name: string
  webUrl: string
  lastModifiedAt: string | null
  lastModifiedBy: string | null
  size: number | null
  mimeType: string | null
}

export type SharedItemResult =
  | { kind: 'ok'; item: DriveItemMetadata }
  /** 401 — token neplatí / vypršel. */
  | { kind: 'unauthorized' }
  /** 403 — chybí Files.Read.All, nebo člen k souboru nemá přístup. */
  | { kind: 'forbidden' }
  /** 404 — odkaz nevede na existující soubor (nebo ho Graph neumí rozpoznat). */
  | { kind: 'not_found' }
  | { kind: 'throttled' }
  | { kind: 'error'; status: number }

const trimmed = (max: number) => z.string().trim().min(1).max(max)
// Graph id se vkládá do cesty URL (a do DB CHECKu 0094): jen bezpečné znaky,
// nejvýš 255 (víc Postgres v regulárním výrazu neumí).
export const GRAPH_ID_RE = /^[A-Za-z0-9!_.=-]{1,255}$/
const graphId = z.string().regex(GRAPH_ID_RE)
const tag = z.string().trim().min(1).max(256)
const driveItemSchema = z.object({
  id: graphId.nullish().catch(null),
  parentReference: z.object({ driveId: graphId.nullish().catch(null) }).nullish().catch(null),
  eTag: tag.nullish().catch(null),
  cTag: tag.nullish().catch(null),
  name: trimmed(400),
  webUrl: trimmed(2000),
  lastModifiedDateTime: z.string().max(64).nullish(),
  lastModifiedBy: z
    .object({ user: z.object({ displayName: z.string().max(200).nullish() }).nullish() })
    .nullish(),
  size: z.number().int().nonnegative().nullish(),
  file: z.object({ mimeType: z.string().max(200).nullish() }).nullish(),
})

function toMetadata(raw: z.infer<typeof driveItemSchema>): DriveItemMetadata {
  const modified = raw.lastModifiedDateTime && !Number.isNaN(Date.parse(raw.lastModifiedDateTime))
    ? raw.lastModifiedDateTime
    : null
  const by = raw.lastModifiedBy?.user?.displayName?.trim()
  return {
    itemId: raw.id ?? null,
    driveId: raw.parentReference?.driveId ?? null,
    eTag: raw.eTag ?? null,
    cTag: raw.cTag ?? null,
    name: raw.name,
    webUrl: raw.webUrl,
    lastModifiedAt: modified,
    lastModifiedBy: by ? by : null,
    size: raw.size ?? null,
    mimeType: raw.file?.mimeType?.trim() || null,
  }
}

async function fetchDriveItem(url: string, accessToken: string, fetchImpl: FetchLike): Promise<SharedItemResult> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    logError('graph.driveItem', e)
    return { kind: 'error', status: 0 }
  }
  if (res.status === 401) return { kind: 'unauthorized' }
  if (res.status === 403) return { kind: 'forbidden' }
  // 410 = položka smazaná (Graph ji tak občas hlásí místo 404).
  if (res.status === 404 || res.status === 410) return { kind: 'not_found' }
  if (res.status === 429) return { kind: 'throttled' }
  if (!res.ok) return { kind: 'error', status: res.status }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { kind: 'error', status: res.status }
  }
  const parsed = driveItemSchema.safeParse(json)
  if (!parsed.success) return { kind: 'error', status: res.status }
  return { kind: 'ok', item: toMetadata(parsed.data) }
}

/**
 * Metadata souboru, na který vede sdílecí (nebo přímý) odkaz, přes
 * GET /shares/{u!…}/driveItem. `fetchImpl` je kvůli testům (mock Graphu).
 */
export async function getSharedDriveItemMetadata(
  accessToken: string,
  sharingUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<SharedItemResult> {
  // Pojistka: doména posílá jen ověřené https odkazy; nic jiného do Graphu nejde.
  if (!sharingUrl.startsWith('https://')) return { kind: 'error', status: 0 }
  return fetchDriveItem(sharedDriveItemUrl(sharingUrl), accessToken, fetchImpl)
}

/** URL položky podle uložené identity; id je ověřené a přesto zakódované. */
export function driveItemUrl(driveId: string, itemId: string): string {
  return `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=${DRIVE_ITEM_SELECT.join(',')}`
}

/**
 * Metadata už uložené položky (denní kontrola, obnova) přes
 * GET /drives/{driveId}/items/{itemId}. Neplatné id do Graphu nejde.
 */
export async function getDriveItemMetadata(
  accessToken: string,
  driveId: string,
  itemId: string,
  fetchImpl: FetchLike = fetch,
): Promise<SharedItemResult> {
  if (!GRAPH_ID_RE.test(driveId) || !GRAPH_ID_RE.test(itemId)) return { kind: 'error', status: 0 }
  return fetchDriveItem(driveItemUrl(driveId, itemId), accessToken, fetchImpl)
}

// --- Číslo verze -------------------------------------------------------------

export type DriveItemVersion = {
  /** „3.0" — číslo verze v SharePointu. */
  label: string
  modifiedAt: string | null
  modifiedBy: string | null
}

// Verze v SharePointu mají id „major.minor" (1.0, 2.0, 2.1); alias „current" a
// cokoli jiného přeskočíme.
const VERSION_ID_RE = /^\d{1,6}(?:\.\d{1,6})?$/
const versionSchema = z.object({
  value: z.array(z.object({
    id: z.string().max(32),
    lastModifiedDateTime: z.string().max(64).nullish().catch(null),
    lastModifiedBy: z
      .object({ user: z.object({ displayName: z.string().max(200).nullish() }).nullish() })
      .nullish()
      .catch(null),
  })).max(5000),
})

function versionRank(id: string): number {
  const [major, minor = '0'] = id.split('.')
  return Number(major) * 1_000_000 + Number(minor)
}

/**
 * Nejvyšší verze souboru z GET /drives/{d}/items/{i}/versions. Jen id, čas
 * a jméno — obsah verze (`content`) se nikdy nevyžaduje. Selhání (chybějící
 * právo, knihovna bez verzování) je `null`: číslo verze je doplněk, ne
 * podmínka.
 */
export async function getDriveItemLatestVersion(
  accessToken: string,
  driveId: string,
  itemId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DriveItemVersion | null> {
  if (!GRAPH_ID_RE.test(driveId) || !GRAPH_ID_RE.test(itemId)) return null
  const url = `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/versions`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch (e) {
    logError('graph.driveItemVersions', e)
    return null
  }
  if (!res.ok) return null
  let json: unknown
  try {
    json = await res.json()
  } catch {
    return null
  }
  const parsed = versionSchema.safeParse(json)
  if (!parsed.success) return null
  const best = parsed.data.value
    .filter((v) => VERSION_ID_RE.test(v.id))
    .sort((a, b) => versionRank(b.id) - versionRank(a.id))[0]
  if (!best) return null
  const at = best.lastModifiedDateTime && !Number.isNaN(Date.parse(best.lastModifiedDateTime)) ? best.lastModifiedDateTime : null
  const by = best.lastModifiedBy?.user?.displayName?.trim()
  return { label: best.id, modifiedAt: at, modifiedBy: by ? by : null }
}
