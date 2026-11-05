// Denní kontrola dokumentů dodávek — adaptér nad Supabase a živé spuštění
// (cron /api/cron/follow-ups). Rozhodování a průběh běhu jsou v
// domain/delivery/documentSync.ts a documentWatch.ts.
//
// Zápisy jdou přes servisní klíč s aktérem 'system:sharepoint-doc-sync' a
// stavem údaje 'source_fact' (verze a stav souboru jsou fakt ze SharePointu),
// takže je DB audit trigger (0064/0082) připíše kontrole. Čtení jde přes
// obyčejného servisního klienta. Bez migrace 0094 (chybí tabulka nebo
// sloupce) není co kontrolovat a běh skončí klidně s nulou.
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { isMissingRelation } from '@/core/loopQueries'
import { logWarn } from '@/lib/log'
import { refreshAccessTokenForFiles } from '@/connectors/graph'
import { resolveAccessToken } from '@/domain/crm/mailSync'
import { createMailTokenDeps } from '@/domain/crm/mailSyncService'
import { isDocumentStatus } from '@/domain/delivery/documents'
import { readStoredItem } from '@/domain/delivery/documentMetadata'
import { isMissingDocumentColumn, recordDocumentVersion, versionFromRow } from '@/domain/delivery/documentVersions'
import type { FindingKind, SourceState, VersionFacts } from '@/domain/delivery/documentWatch'
import {
  DOC_SYNC_ACTOR,
  DOC_SYNC_CONNECTOR,
  DOC_SYNC_JOB,
  docSyncMemberFromEnv,
  runDocumentSync,
  type DocumentSyncDb,
  type DocumentSyncStats,
  type SyncDoc,
} from '@/domain/delivery/documentSync'

type Db = Pick<SupabaseClient, 'from'>
type PgError = { code?: string | null; message?: string | null } | null | undefined

const LOG_SCOPE = 'documentSync'
const OBSERVER = `${DOC_SYNC_ACTOR.type}:${DOC_SYNC_ACTOR.id}`

/** Do výjimky jen kód chyby — hláška z DB může citovat řádek. */
function dbError(scope: string, e: PgError): Error {
  return new Error(`${scope}: ${e?.code ?? 'chyba databáze'}`)
}

const DOC_COLUMNS =
  'id, engagement_id, title, url, status, drive_id, item_id, e_tag, c_tag, version_label, last_modified_at, last_modified_by, source_state, approved_version_id'

type DocRow = {
  id: number
  engagement_id: number
  title: string
  url: string
  status: string
  drive_id: string | null
  item_id: string | null
  e_tag: string | null
  c_tag: string | null
  version_label: string | null
  last_modified_at: string | null
  last_modified_by: string | null
  source_state: string | null
  approved_version_id: number | null
}

const toSyncDoc = (r: DocRow): SyncDoc | null =>
  r.drive_id && r.item_id && isDocumentStatus(r.status) && r.status !== 'draft'
    ? {
        id: r.id,
        engagement_id: r.engagement_id,
        title: r.title,
        url: r.url,
        status: r.status,
        drive_id: r.drive_id,
        item_id: r.item_id,
        current: { eTag: r.e_tag, cTag: r.c_tag, versionLabel: r.version_label, modifiedAt: r.last_modified_at, modifiedBy: r.last_modified_by },
        source_state: r.source_state === 'ok' || r.source_state === 'missing' || r.source_state === 'no_access' ? (r.source_state as SourceState) : null,
        approved_version_id: r.approved_version_id,
      }
    : null

/** `read` čte (servisní klient), `write` zapisuje (servisní klient s aktérem kontroly pro audit). */
export function createDocumentSyncDb(read: Db, write: Db): DocumentSyncDb {
  return {
    async loadWatched(limit) {
      const { data, error } = await read
        .from('engagement_document')
        .select(DOC_COLUMNS)
        .not('item_id', 'is', null)
        .neq('status', 'draft')
        .order('source_checked_at', { ascending: true, nullsFirst: true })
        .limit(limit)
      // Migrace 0094 ještě neběžela: nic ke kontrole.
      if (isMissingRelation(error) || isMissingDocumentColumn(error)) return []
      if (error) throw dbError('engagement_document', error)
      return ((data ?? []) as unknown as DocRow[]).map(toSyncDoc).filter((d): d is SyncDoc => d !== null)
    },

    async loadVersions(ids) {
      const out = new Map<number, VersionFacts>()
      if (ids.length === 0) return out
      const { data, error } = await read
        .from('engagement_document_version')
        .select('id, e_tag, c_tag, version_label, modified_at, modified_by')
        .in('id', [...ids])
      if (error) throw dbError('engagement_document_version', error)
      for (const r of (data ?? []) as unknown as Parameters<typeof versionFromRow>[0][]) out.set(r.id, versionFromRow(r))
      return out
    },

    async loadOpenFindings(docIds) {
      const out = new Map<number, FindingKind[]>()
      if (docIds.length === 0) return out
      const { data, error } = await read
        .from('engagement_document_finding')
        .select('document_id, kind')
        .in('document_id', [...docIds])
        .is('resolved_at', null)
      if (error) throw dbError('engagement_document_finding', error)
      for (const f of (data ?? []) as unknown as { document_id: number; kind: FindingKind }[]) {
        out.set(f.document_id, [...(out.get(f.document_id) ?? []), f.kind])
      }
      return out
    },

    async loadOwner(engagementId, docId) {
      // owner_id/deputy_id jsou od 0061; bez nich zůstane klient a autor dokumentu.
      let res = await read.from('engagement').select('account_id, owner_id, deputy_id').eq('id', engagementId).maybeSingle()
      if (isMissingDocumentColumn(res.error)) res = await read.from('engagement').select('account_id').eq('id', engagementId).maybeSingle()
      const eng = res.error ? null : (res.data as { account_id?: number | null; owner_id?: string | null; deputy_id?: string | null } | null)
      let assignee = eng?.owner_id ?? eng?.deputy_id ?? null
      if (!assignee) {
        const doc = await read.from('engagement_document').select('created_by').eq('id', docId).maybeSingle()
        assignee = doc.error ? null : ((doc.data as { created_by?: string | null } | null)?.created_by ?? null)
      }
      return { assigneeId: assignee, accountId: eng?.account_id ?? null }
    },

    async saveDocument(docId, patch) {
      const { error } = await write.from('engagement_document').update(patch).eq('id', docId)
      if (error) throw dbError('engagement_document.update', error)
    },

    async recordVersion(docId, facts) {
      const r = await recordDocumentVersion(write, docId, facts, 'sync', OBSERVER)
      return r.ok ? r.id : null
    },

    async openFinding(docId, kind, versionId) {
      const { data, error } = await write
        .from('engagement_document_finding')
        .insert({ document_id: docId, kind, version_id: versionId })
        .select('id')
        .single()
      // Otevřený nález téhož druhu už je (unikát): nic se nezakládá dokola.
      if (error?.code === '23505') return null
      if (error) throw dbError('engagement_document_finding.insert', error)
      return (data as { id?: number } | null)?.id ?? null
    },

    async createTask(task) {
      // created_by NULL: úkol založil systém (created_by je uuid člena týmu).
      const { data, error } = await write.from('task').insert({ ...task, status: 'todo', created_by: null }).select('id').single()
      if (error) throw dbError('task.insert', error)
      return (data as { id?: number } | null)?.id ?? null
    },

    async attachTask(findingId, taskId) {
      const { error } = await write.from('engagement_document_finding').update({ task_id: taskId }).eq('id', findingId)
      if (error) throw dbError('engagement_document_finding.update', error)
    },

    async closeFindings(docId, kinds) {
      const { error } = await write
        .from('engagement_document_finding')
        .update({ resolved_at: new Date().toISOString(), resolution: 'auto' })
        .eq('document_id', docId)
        .in('kind', [...kinds])
        .is('resolved_at', null)
      if (error) throw dbError('engagement_document_finding.close', error)
    },
  }
}

/**
 * Stav konektoru graph_files po běhu: chyba jen při problému s přístupem
 * (token, chybějící právo, všechny soubory 403); úspěch, když Microsoft
 * aspoň jednou odpověděl. Bez dokumentů ke kontrole se stav nemění.
 */
export async function recordDocSyncConnectorState(stats: DocumentSyncStats): Promise<void> {
  if (stats.accessError) await recordConnectorError(DOC_SYNC_CONNECTOR, stats.accessError)
  else if (stats.ok + stats.missing > 0) await recordConnectorSuccess(DOC_SYNC_CONNECTOR, new Date().toISOString())
}

/** Živý běh nad Supabase a Microsoft Graph (volá ho cron pod zámkem úlohy). */
export async function runDocumentSyncLive(opts: { budgetMs?: number } = {}): Promise<DocumentSyncStats> {
  const memberId = docSyncMemberFromEnv(process.env)
  if (!memberId) {
    return {
      state: 'no_token', docs: 0, ok: 0, missing: 0, noAccess: 0, skipped: 0, deferred: 0, opened: 0, closed: 0, tasks: 0, errors: 0,
      systemicNoAccess: false,
      accessError: 'Chybí SHAREPOINT_DOC_SYNC_MEMBER_ID (nebo OUTLOOK_MAIL_SYNC_MEMBER_ID): kontrola neví, čí přístup má použít.',
    }
  }
  const admin = createAdminClient()
  const db = createDocumentSyncDb(admin, createAuditedAdminClient({ actor: DOC_SYNC_ACTOR, infoState: 'source_fact' }))
  const stats = await runDocumentSync(
    {
      db,
      async grantedScopes() {
        // Sloupec je od 0060; chyba čtení = udělená práva neznáme (nic netvrdíme).
        const { data, error } = await admin.from('calendar_token').select('granted_scopes').eq('member_id', memberId).maybeSingle()
        if (error) return null
        return (data as { granted_scopes?: string | null } | null)?.granted_scopes ?? null
      },
      async token() {
        try {
          // Obnova žádá i Files.Read.All (jen když je zapnutý přepínač a člen ho udělil).
          const accessToken = await resolveAccessToken({ ...createMailTokenDeps(admin, memberId, LOG_SCOPE), refresh: refreshAccessTokenForFiles })
          return { ok: true, accessToken }
        } catch (e) {
          return { ok: false, error: `Přístup člena ke SharePointu se nepodařilo obnovit: ${e instanceof Error ? e.message : String(e)}` }
        }
      },
      read: readStoredItem,
      now: () => new Date(),
    },
    { budgetMs: opts.budgetMs },
  )
  if (stats.errors > 0) logWarn(LOG_SCOPE, 'u části dokumentů se zápis nepodařil', { errors: stats.errors, job: DOC_SYNC_JOB })
  await recordDocSyncConnectorState(stats)
  return stats
}
