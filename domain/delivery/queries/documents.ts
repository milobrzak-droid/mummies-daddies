// Čtení dokumentů engagementu. Tabulka je v 0051_engagement_document.sql,
// která ještě nemusí být aplikovaná — chybějící relace (42P01 / PGRST205)
// je stav „čeká na migraci", ne chyba (vzor domain/crm/queries/targetLists.ts).
//
// Sloupce z 0094 (identita, verze, typ, stav) se čtou, když existují; bez nich
// (0094 ještě neběžela) se načtou původní sloupce a dokument dostane výchozí
// typ „Jiné" a stav „Koncept". Nálezy denní kontroly a připíchnuté verze jsou
// doplněk: chybějící tabulka nebo chyba je tichý „nic", dokumenty se ukážou dál.
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { isMissingDocumentColumn } from '@/domain/delivery/documentVersions'
import { logError } from '@/lib/log'
import type { DocumentKind, DocumentStatus, DocumentType } from '@/domain/delivery/documents'
import { isDocumentStatus, isDocumentType } from '@/domain/delivery/documents'
import { sameVersion, type FindingKind, type SourceState } from '@/domain/delivery/documentWatch'

export type DocumentVersionInfo = {
  version_label: string | null
  modified_at: string | null
  modified_by: string | null
  e_tag: string | null
  c_tag: string | null
}

export type EngagementDocument = {
  id: number
  engagement_id: number
  milestone_id: number | null
  title: string
  url: string
  kind: DocumentKind
  created_by: string | null
  created_at: string
  // --- 0094 (výchozí hodnoty, když migrace ještě neběžela)
  doc_type: DocumentType
  status: DocumentStatus
  status_changed_at: string | null
  status_changed_by: string | null
  approved_at: string | null
  approved_by: string | null
  approved_version_id: number | null
  /** Připíchnutá (schválená) verze; null = schváleno bez známé verze nebo koncept. */
  approved_version: DocumentVersionInfo | null
  /** Máme ověřenou identitu položky (drive + item) — bez ní se změny nehlídají. */
  has_identity: boolean
  version_label: string | null
  last_modified_at: string | null
  last_modified_by: string | null
  source_state: SourceState | null
  source_checked_at: string | null
  /**
   * Podle uložené verze (poslední kontrola nebo načtení) se dokument od schválení
   * změnil. false i když to nevíme (bez připíchnuté verze).
   */
  changed_since_approval: boolean
  /** Otevřené nálezy denní kontroly. */
  findings: FindingKind[]
}

export type Loaded<T> = { state: 'missing_migration' } | { state: 'error'; message: string } | ({ state: 'ok' } & T)

const LEGACY_COLUMNS = 'id, engagement_id, milestone_id, title, url, kind, created_by, created_at'
const V0094_COLUMNS = `${LEGACY_COLUMNS}, doc_type, status, status_changed_at, status_changed_by, approved_at, approved_by, approved_version_id, drive_id, item_id, e_tag, c_tag, version_label, last_modified_at, last_modified_by, source_state, source_checked_at`

type Raw = Record<string, unknown> & { id: number }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function toDocument(r: Raw, approved: Map<number, DocumentVersionInfo>, findings: Map<number, FindingKind[]>): EngagementDocument {
  const approvedId = num(r.approved_version_id)
  const state = str(r.source_state)
  const status = isDocumentStatus(r.status) ? r.status : 'draft'
  const approvedVersion = approvedId !== null ? (approved.get(approvedId) ?? null) : null
  const changed = status !== 'draft' && approvedVersion !== null
    && sameVersion({ eTag: approvedVersion.e_tag, cTag: approvedVersion.c_tag, versionLabel: approvedVersion.version_label }, { eTag: str(r.e_tag), cTag: str(r.c_tag), versionLabel: str(r.version_label) }) === false
  return {
    id: r.id,
    engagement_id: r.engagement_id as number,
    milestone_id: num(r.milestone_id),
    title: String(r.title ?? ''),
    url: String(r.url ?? ''),
    kind: r.kind as DocumentKind,
    created_by: str(r.created_by),
    created_at: String(r.created_at ?? ''),
    doc_type: isDocumentType(r.doc_type) ? r.doc_type : 'jine',
    status,
    status_changed_at: str(r.status_changed_at),
    status_changed_by: str(r.status_changed_by),
    approved_at: str(r.approved_at),
    approved_by: str(r.approved_by),
    approved_version_id: approvedId,
    approved_version: approvedVersion,
    has_identity: str(r.drive_id) !== null && str(r.item_id) !== null,
    version_label: str(r.version_label),
    last_modified_at: str(r.last_modified_at),
    last_modified_by: str(r.last_modified_by),
    source_state: state === 'ok' || state === 'missing' || state === 'no_access' ? state : null,
    source_checked_at: str(r.source_checked_at),
    changed_since_approval: changed,
    findings: findings.get(r.id) ?? [],
  }
}

async function loadApprovedVersions(ids: number[]): Promise<Map<number, DocumentVersionInfo>> {
  const out = new Map<number, DocumentVersionInfo>()
  if (ids.length === 0) return out
  const s = await createClient()
  const { data, error } = await s
    .from('engagement_document_version')
    .select('id, version_label, modified_at, modified_by, e_tag, c_tag')
    .in('id', ids)
  if (error) {
    if (!isMissingRelation(error)) logError('documents.versions', error)
    return out
  }
  for (const v of (data ?? []) as unknown as (DocumentVersionInfo & { id: number })[]) {
    out.set(v.id, { version_label: v.version_label, modified_at: v.modified_at, modified_by: v.modified_by, e_tag: v.e_tag, c_tag: v.c_tag })
  }
  return out
}

async function loadOpenFindings(docIds: number[]): Promise<Map<number, FindingKind[]>> {
  const out = new Map<number, FindingKind[]>()
  if (docIds.length === 0) return out
  const s = await createClient()
  const { data, error } = await s
    .from('engagement_document_finding')
    .select('document_id, kind')
    .in('document_id', docIds)
    .is('resolved_at', null)
  if (error) {
    if (!isMissingRelation(error)) logError('documents.findings', error)
    return out
  }
  for (const f of (data ?? []) as unknown as { document_id: number; kind: FindingKind }[]) {
    out.set(f.document_id, [...(out.get(f.document_id) ?? []), f.kind])
  }
  return out
}

export async function getEngagementDocuments(engagementId: number): Promise<Loaded<{ documents: EngagementDocument[] }>> {
  const s = await createClient()
  const read = (columns: string) =>
    s.from('engagement_document').select(columns).eq('engagement_id', engagementId).order('created_at', { ascending: false })
  let res = await read(V0094_COLUMNS)
  // Migrace 0094 ještě neběžela: původní sloupce, výchozí typ a stav.
  if (res.error && isMissingDocumentColumn(res.error)) res = await read(LEGACY_COLUMNS)
  if (isMissingRelation(res.error)) return { state: 'missing_migration' }
  if (res.error) return { state: 'error', message: res.error.message }
  const rows = (res.data ?? []) as unknown as Raw[]
  const [approved, findings] = await Promise.all([
    loadApprovedVersions([...new Set(rows.map((r) => num(r.approved_version_id)).filter((v): v is number => v !== null))]),
    loadOpenFindings(rows.map((r) => r.id)),
  ])
  return { state: 'ok', documents: rows.map((r) => toDocument(r, approved, findings)) }
}
