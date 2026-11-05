// Načtení metadat dokumentu ze SharePointu/OneDrivu/Teams přes Microsoft
// Graph s delegovaným tokenem PŘIHLÁŠENÉHO člena (plan kap. 8). Cockpit tak
// uvidí jen to, co člen sám smí otevřít — žádný servisní účet.
//
// Nikdy nestahuje obsah (connectors/graph/files.ts). Když metadata načíst
// nejde (přepínač GRAPH_FILES_SCOPE_ENABLED vypnutý, Outlook nepřipojený,
// chybí Files.Read.All, soubor nedostupný), volající uloží odkaz tak, jak ho
// člen vložil, a ukáže `problem` jako nápovědu.
import {
  filesScopeEnabled,
  getDriveItemLatestVersion,
  getDriveItemMetadata,
  getSharedDriveItemMetadata,
  graphTokenForCurrentUser,
  type DriveItemMetadata,
  type DriveItemVersion,
  type SharedItemResult,
} from '@/connectors/graph'
import { formatDate } from '@/lib/format'
import type { SourceOutcome, VersionFacts } from '@/domain/delivery/documentWatch'

export type DocumentMetadata = DriveItemMetadata

export type MetadataResult =
  | { ok: true; meta: DocumentMetadata; version: DriveItemVersion | null }
  /** `problem` = česká věta pro člena; null jen u vypnutého přepínače. */
  | { ok: false; reason: 'disabled' | 'not_connected' | 'forbidden' | 'not_found' | 'error'; problem: string | null }

export async function resolveDocumentMetadata(resolveUrl: string): Promise<MetadataResult> {
  // Vypnuto = funkce neexistuje; žádná nápověda, chování jako dřív.
  if (!filesScopeEnabled()) return { ok: false, reason: 'disabled', problem: null }

  const token = await graphTokenForCurrentUser()
  if (!token.ok) {
    return {
      ok: false,
      reason: 'not_connected',
      problem: `Metadata ze SharePointu se nenačetla: ${token.error}`,
    }
  }

  const r = await getSharedDriveItemMetadata(token.accessToken, resolveUrl)
  switch (r.kind) {
    case 'ok': {
      // Číslo verze je doplněk (další jeden dotaz); bez identity ho nemáme odkud vzít.
      const version = r.item.driveId && r.item.itemId
        ? await getDriveItemLatestVersion(token.accessToken, r.item.driveId, r.item.itemId)
        : null
      return { ok: true, meta: r.item, version }
    }
    case 'unauthorized':
      return {
        ok: false,
        reason: 'not_connected',
        problem: 'Přihlášení k Microsoftu vypršelo — připoj Outlook znovu v Nastavení.',
      }
    case 'forbidden':
      return {
        ok: false,
        reason: 'forbidden',
        problem: 'Microsoft nepovolil načíst metadata: buď chybí oprávnění Files.Read.All (Nastavení → Znovu připojit), nebo k souboru nemáš přístup.',
      }
    case 'not_found':
      return { ok: false, reason: 'not_found', problem: 'Soubor se v SharePointu nenašel — zkontroluj odkaz.' }
    default:
      return { ok: false, reason: 'error', problem: 'Metadata ze SharePointu se teď nepodařilo načíst.' }
  }
}

/** „Poslední změna: 28. 9. 2026, Jana Nováková" — null, když Graph datum nevrátil. */
export function formatLastChange(meta: Pick<DocumentMetadata, 'lastModifiedAt' | 'lastModifiedBy'>): string | null {
  if (!meta.lastModifiedAt) return null
  const when = formatDate(meta.lastModifiedAt)
  if (when === '—') return null
  return meta.lastModifiedBy ? `Poslední změna: ${when}, ${meta.lastModifiedBy}` : `Poslední změna: ${when}`
}

/** Verze k uložení: metadata položky + číslo verze z Graphu. */
export function versionFactsOf(item: DriveItemMetadata, version: DriveItemVersion | null): VersionFacts {
  return {
    eTag: item.eTag,
    cTag: item.cTag,
    versionLabel: version?.label ?? null,
    modifiedAt: item.lastModifiedAt ?? version?.modifiedAt ?? null,
    modifiedBy: item.lastModifiedBy ?? version?.modifiedBy ?? null,
  }
}

/** Výsledek čtení uložené položky přeložený na to, co potřebuje kontrola. */
export type SourceRead =
  | { outcome: Extract<SourceOutcome, { kind: 'ok' }>; item: DriveItemMetadata }
  | { outcome: Exclude<SourceOutcome, { kind: 'ok' }>; item: null; raw: Exclude<SharedItemResult['kind'], 'ok'> }

/**
 * Přečte už uloženou položku (drive + item) s daným tokenem: metadata a číslo
 * verze. Překlad odpovědi Graphu:
 *   ok → verze; 404/410 → zmizel; 403 → bez přístupu;
 *   401, 429 a jiné chyby → `skip` (nevíme, nic se nemění).
 */
export async function readStoredItem(accessToken: string, driveId: string, itemId: string): Promise<SourceRead> {
  const r = await getDriveItemMetadata(accessToken, driveId, itemId)
  if (r.kind === 'ok') {
    const version = await getDriveItemLatestVersion(accessToken, driveId, itemId)
    return { outcome: { kind: 'ok', facts: versionFactsOf(r.item, version) }, item: r.item }
  }
  if (r.kind === 'not_found') return { outcome: { kind: 'missing' }, item: null, raw: r.kind }
  if (r.kind === 'forbidden') return { outcome: { kind: 'no_access' }, item: null, raw: r.kind }
  return { outcome: { kind: 'skip' }, item: null, raw: r.kind }
}
