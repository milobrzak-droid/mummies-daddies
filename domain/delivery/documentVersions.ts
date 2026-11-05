// Zápis pozorovaných verzí dokumentu dodávky (engagement_document_version,
// migrace 0094). Tabulka je append-only a píše do ní jen server se servisním
// klíčem PO ověření člena — proto tady klient přichází zvenčí (admin klient,
// v testech podstrčený). Nic tu nečte obsah souboru: verze = eTag/cTag, číslo
// verze, kdy a kdo soubor naposledy upravil (metadata z Graphu).
//
// Selhání se neprojeví výjimkou: verze je pozorovací vrstva jako audit, její
// výpadek nesmí strhnout schválení ani odeslání dokumentu; volající dostane
// typovaný výsledek.
import type { SupabaseClient } from '@supabase/supabase-js'
import { logError } from '@/lib/log'
import { hasVersionFacts, sameVersion, type VersionFacts } from '@/domain/delivery/documentWatch'

export type VersionDb = Pick<SupabaseClient, 'from'>

export type VersionReason = 'linked' | 'refreshed' | 'approved' | 'sync'

export type RecordVersionResult =
  | { ok: true; id: number; created: boolean }
  | { ok: false; reason: 'no_facts' | 'db_error' }

type PgError = { code?: string | null; message?: string | null } | null | undefined

/** Sloupec, který migrace 0094 přidává, ještě neexistuje (select: 42703, insert/update: PGRST204). */
export function isMissingDocumentColumn(e: PgError): boolean {
  if (!e) return false
  if (e.code === '42703' || e.code === 'PGRST204') return true
  return /column .* does not exist|could not find the .* column/i.test(e.message ?? '')
}

export type StoredVersion = VersionFacts & { id: number }

const VERSION_COLUMNS = 'id, e_tag, c_tag, version_label, modified_at, modified_by'
type VersionRow = { id: number; e_tag: string | null; c_tag: string | null; version_label: string | null; modified_at: string | null; modified_by: string | null }

export const versionFromRow = (r: VersionRow): StoredVersion => ({
  id: r.id, eTag: r.e_tag, cTag: r.c_tag, versionLabel: r.version_label, modifiedAt: r.modified_at, modifiedBy: r.modified_by,
})

/** Nejnovější zaznamenaná verze dokumentu, nebo null. */
export async function latestDocumentVersion(db: VersionDb, documentId: number): Promise<StoredVersion | null> {
  const { data, error } = await db
    .from('engagement_document_version')
    .select(VERSION_COLUMNS)
    .eq('document_id', documentId)
    .order('id', { ascending: false })
    .limit(1)
  if (error) return null
  const row = ((data ?? []) as unknown as VersionRow[])[0]
  return row ? versionFromRow(row) : null
}

/**
 * Zaznamená verzi, když je jiná než poslední zaznamenaná (stejnou znovu
 * nezapisuje a vrátí id té stávající). `observedBy` = 'user:<uuid>' nebo
 * 'system:<úloha>'.
 */
export async function recordDocumentVersion(
  db: VersionDb,
  documentId: number,
  facts: VersionFacts,
  reason: VersionReason,
  observedBy: string,
): Promise<RecordVersionResult> {
  if (!hasVersionFacts(facts)) return { ok: false, reason: 'no_facts' }
  try {
    const latest = await latestDocumentVersion(db, documentId)
    if (latest && sameVersion(latest, facts) === true) return { ok: true, id: latest.id, created: false }
    const { data, error } = await db
      .from('engagement_document_version')
      .insert({
        document_id: documentId,
        e_tag: facts.eTag,
        c_tag: facts.cTag,
        version_label: facts.versionLabel,
        modified_at: facts.modifiedAt,
        modified_by: facts.modifiedBy,
        observed_by: observedBy,
        reason,
      })
      .select('id')
      .single()
    const id = (data as { id?: number } | null)?.id
    if (error || typeof id !== 'number') {
      // Do logu jen kód chyby; hláška z DB může citovat hodnoty.
      logError('documentVersion', new Error(`insert: ${error?.code ?? 'bez id'}`))
      return { ok: false, reason: 'db_error' }
    }
    return { ok: true, id, created: true }
  } catch (e) {
    logError('documentVersion', e)
    return { ok: false, reason: 'db_error' }
  }
}
