// Denní kontrola dokumentů dodávek v SharePointu (revize kap. 2E, migrace 0094).
//
// Co dělá: schválený, odeslaný nebo přijatý dokument s ověřenou identitou
// (drive + item) se jednou denně přečte přes Microsoft Graph (jen METADATA:
// eTag/cTag, číslo verze, kdy a kdo změnil — obsah souboru se nikdy nečte ani
// neindexuje) a porovná se s verzí připíchnutou při schválení. Když
//   - se soubor od schválení změnil (jiná verze),
//   - soubor zmizel (404/410),
//   - kontrola k souboru nemá přístup (403),
// vznikne nález (engagement_document_finding), úkol pro vlastníka dodávky
// (assignee) a tím i položka „Co se změnilo" (druh „Dokumenty dodávek"). Jeden
// otevřený nález na dokument a druh — nic se nezakládá dokola; když se stav
// vrátí (soubor je zpátky, verze zase sedí), nález se sám zavře.
//
// Přístup: delegovaný token JEDNOHO člena (SHAREPOINT_DOC_SYNC_MEMBER_ID,
// jinak OUTLOOK_MAIL_SYNC_MEMBER_ID — stejný vzor jako sync pošty). „Nemá
// přístup" tedy znamená: nemá ho tento člen. Práva Files.Read.All Cockpit
// NEPŘIDÁVÁ: využije se jen, pokud je zapnutý GRAPH_FILES_SCOPE_ENABLED a člen
// ho při připojení udělil. Chybí-li, kontrola to řekne (stav konektoru
// graph_files, statistika běhu) a nevytváří nálezy pro každý dokument zvlášť.
//
// Vypnuto: SHAREPOINT_DOC_SYNC_ENABLED musí být přesně 'true' (výchozí vypnuto).
// Vlastní cron nemá (Vercel Hobby) — běží v denním cronu /api/cron/follow-ups.
//
// Testovatelnost: veškerý I/O (DB, token, Graph, čas) jde přes `deps`.
import { pragueToday } from '@/lib/pragueDate'
import { DOC_SYNC_BATCH, DOC_SYNC_DEFAULT_BUDGET_MS } from '@/domain/delivery/documentSyncConfig'
import { GRAPH_FILES_SCOPE } from '@/connectors/graph'
import { storableSharePointUrl } from '@/domain/delivery/documentLink'
import { isDocumentStatus, type DocumentStatus } from '@/domain/delivery/documents'
import type { SourceRead } from '@/domain/delivery/documentMetadata'
import {
  findingSentence,
  findingTaskTitle,
  planDocumentCheck,
  type FindingKind,
  type SourceOutcome,
  type SourceState,
  type VersionFacts,
} from '@/domain/delivery/documentWatch'

export {
  DOC_SYNC_ACTOR,
  DOC_SYNC_BATCH,
  DOC_SYNC_CONNECTOR,
  DOC_SYNC_DEFAULT_BUDGET_MS,
  DOC_SYNC_JOB,
  DOC_SYNC_TTL_SECONDS,
  docSyncEnabledFromEnv,
  docSyncMemberFromEnv,
} from '@/domain/delivery/documentSyncConfig'

export type SyncDoc = {
  id: number
  engagement_id: number
  title: string
  url: string
  status: DocumentStatus
  drive_id: string
  item_id: string
  current: VersionFacts
  source_state: SourceState | null
  approved_version_id: number | null
}

export type SyncTask = {
  title: string
  description: string
  priority: 'normal' | 'high'
  assignee_id: string | null
  account_id: number | null
  engagement_id: number
  due_on: string
}

export interface DocumentSyncDb {
  /** Sledované dokumenty (status ≠ koncept, s identitou), nejdřív ty s nejstarší kontrolou. */
  loadWatched(limit: number): Promise<SyncDoc[]>
  loadVersions(ids: readonly number[]): Promise<Map<number, VersionFacts>>
  loadOpenFindings(docIds: readonly number[]): Promise<Map<number, FindingKind[]>>
  /** Komu patří upozornění: vlastník dodávky, jinak zástupce, jinak autor dokumentu. */
  loadOwner(engagementId: number, docId: number): Promise<{ assigneeId: string | null; accountId: number | null }>
  saveDocument(docId: number, patch: Record<string, unknown>): Promise<void>
  /** Zaznamená verzi (dedupe) a vrátí její id, nebo null. */
  recordVersion(docId: number, facts: VersionFacts): Promise<number | null>
  /** Založí otevřený nález; null = takový už je otevřený (nic se nezakládá dokola). */
  openFinding(docId: number, kind: FindingKind, versionId: number | null): Promise<number | null>
  createTask(task: SyncTask): Promise<number | null>
  attachTask(findingId: number, taskId: number): Promise<void>
  closeFindings(docId: number, kinds: readonly FindingKind[]): Promise<void>
}

export type SyncTokenResult = { ok: true; accessToken: string } | { ok: false; error: string }

export type DocumentSyncDeps = {
  db: DocumentSyncDb
  /** Udělená oprávnění člena (calendar_token.granted_scopes), nebo null = neznáme. */
  grantedScopes(): Promise<string | null>
  token(): Promise<SyncTokenResult>
  read(accessToken: string, driveId: string, itemId: string): Promise<SourceRead>
  now(): Date
}

export type DocumentSyncStats = {
  state: 'ok' | 'nothing_to_check' | 'missing_scope' | 'no_token'
  /** Kolik sledovaných dokumentů kontrola vzala. */
  docs: number
  ok: number
  missing: number
  noAccess: number
  /** Graph neodpověděl použitelně (vypršelé přihlášení, omezení, chyba) — nic se nezměnilo. */
  skipped: number
  /** Nestihlo se v rozpočtu; vezme je příští běh. */
  deferred: number
  opened: number
  closed: number
  tasks: number
  /** Chyba zápisu u jednotlivého dokumentu (běh pokračuje). */
  errors: number
  /** Všechny čtené dokumenty vrátily 403: chybí právo nebo přístup, ne chyba jednotlivých souborů. */
  systemicNoAccess: boolean
  /** Věta pro stav konektoru (bez jmen a adres); jen při problému s přístupem. */
  accessError?: string
}

export const MISSING_SCOPE_ERROR =
  `Členu, jehož token kontrola dokumentů používá, chybí oprávnění ${GRAPH_FILES_SCOPE} — znovu připojte Outlook v Nastavení (s GRAPH_FILES_SCOPE_ENABLED=true).`
export const SYSTEMIC_NO_ACCESS_ERROR =
  `Microsoft odmítl čtení všech kontrolovaných souborů: chybí oprávnění ${GRAPH_FILES_SCOPE} (Nastavení → Znovu připojit), nebo člen, jehož token se používá, k nim nemá přístup.`

const emptyStats = (): DocumentSyncStats => ({
  state: 'ok', docs: 0, ok: 0, missing: 0, noAccess: 0, skipped: 0, deferred: 0,
  opened: 0, closed: 0, tasks: 0, errors: 0, systemicNoAccess: false,
})

function taskFor(kind: FindingKind, doc: SyncDoc, sentence: string, owner: { assigneeId: string | null; accountId: number | null }, today: string): SyncTask {
  return {
    title: findingTaskTitle(kind, doc.title).slice(0, 300),
    description: `${sentence} Otevři záložku Dokumenty dodávky a rozhodni: schválit aktuální verzi znovu, vrátit dokument do konceptu, nebo opravit odkaz. Obsah souboru Cockpit nečte, viděl jen jeho verzi.`,
    priority: kind === 'no_access' ? 'normal' : 'high',
    assignee_id: owner.assigneeId,
    account_id: owner.accountId,
    engagement_id: doc.engagement_id,
    due_on: today,
  }
}

/**
 * Jeden běh kontroly. Nikdy nevyhazuje kvůli jednomu dokumentu; chyba
 * přístupu (token, chybějící právo) se vrací ve statistice, ne výjimkou.
 */
export async function runDocumentSync(
  deps: DocumentSyncDeps,
  opts: { budgetMs?: number; batch?: number } = {},
): Promise<DocumentSyncStats> {
  const stats = emptyStats()
  const started = deps.now().getTime()
  const budget = opts.budgetMs ?? DOC_SYNC_DEFAULT_BUDGET_MS
  const docs = await deps.db.loadWatched(opts.batch ?? DOC_SYNC_BATCH)
  stats.docs = docs.length
  if (docs.length === 0) return { ...stats, state: 'nothing_to_check' }

  // Bez práva na soubory se do Graphu vůbec nechodí (a nevznikají falešné nálezy).
  const scopes = await deps.grantedScopes()
  if (scopes !== null && !scopes.split(/\s+/).some((s) => s.toLowerCase() === GRAPH_FILES_SCOPE.toLowerCase())) {
    return { ...stats, state: 'missing_scope', accessError: MISSING_SCOPE_ERROR }
  }
  const token = await deps.token()
  if (!token.ok) return { ...stats, state: 'no_token', accessError: token.error.slice(0, 300) }

  // 1) Čtení (jen metadata) v rozpočtu; co se nestihne, vezme příští běh.
  const reads: { doc: SyncDoc; read: SourceRead }[] = []
  for (const doc of docs) {
    if (deps.now().getTime() - started > budget) {
      stats.deferred++
      continue
    }
    reads.push({ doc, read: await deps.read(token.accessToken, doc.drive_id, doc.item_id) })
  }

  // 2) 403 u všech přečtených = systémový problém (právo), ne nález u každého souboru.
  const answered = reads.filter((r) => r.read.outcome.kind !== 'skip')
  const forbidden = answered.filter((r) => r.read.outcome.kind === 'no_access').length
  stats.systemicNoAccess = forbidden >= 2 && forbidden === answered.length
  if (stats.systemicNoAccess) {
    stats.noAccess = forbidden
    stats.skipped = reads.length - forbidden
    return { ...stats, accessError: SYSTEMIC_NO_ACCESS_ERROR }
  }

  const versions = await deps.db.loadVersions([...new Set(docs.map((d) => d.approved_version_id).filter((v): v is number => v !== null))])
  const findings = await deps.db.loadOpenFindings(docs.map((d) => d.id))
  const now = deps.now()
  const today = pragueToday(now)

  for (const { doc, read } of reads) {
    const outcome: SourceOutcome = read.outcome
    if (outcome.kind === 'ok') stats.ok++
    else if (outcome.kind === 'missing') stats.missing++
    else if (outcome.kind === 'no_access') stats.noAccess++
    else {
      stats.skipped++
      continue
    }
    try {
      const plan = planDocumentCheck(
        {
          status: isDocumentStatus(doc.status) ? doc.status : 'draft',
          current: doc.current,
          approved: doc.approved_version_id !== null ? (versions.get(doc.approved_version_id) ?? null) : null,
          sourceState: doc.source_state,
          openFindings: findings.get(doc.id) ?? [],
        },
        outcome,
      )
      if (plan.sourceState) {
        const patch: Record<string, unknown> = { source_state: plan.sourceState, source_checked_at: now.toISOString() }
        if (plan.writeFacts) {
          Object.assign(patch, {
            e_tag: plan.writeFacts.eTag,
            c_tag: plan.writeFacts.cTag,
            version_label: plan.writeFacts.versionLabel,
            last_modified_at: plan.writeFacts.modifiedAt,
            last_modified_by: plan.writeFacts.modifiedBy,
          })
          // Přesunutý nebo přejmenovaný soubor: odkaz se srovná podle identity (jen firemní SharePoint).
          const moved = read.item ? storableSharePointUrl(read.item.webUrl) : null
          if (moved && moved !== doc.url) patch.url = moved
        }
        await deps.db.saveDocument(doc.id, patch)
      }

      let versionId: number | null = null
      if (plan.writeFacts && (plan.newVersion || plan.open.includes('changed'))) {
        versionId = await deps.db.recordVersion(doc.id, plan.writeFacts)
      }

      for (const kind of plan.open) {
        const findingId = await deps.db.openFinding(doc.id, kind, kind === 'changed' ? versionId : null)
        if (findingId === null) continue
        stats.opened++
        const approved = doc.approved_version_id !== null ? (versions.get(doc.approved_version_id) ?? null) : null
        const sentence = findingSentence(kind, doc.status, { approved, seen: plan.writeFacts })
        const owner = await deps.db.loadOwner(doc.engagement_id, doc.id)
        const taskId = await deps.db.createTask(taskFor(kind, doc, sentence, owner, today))
        if (taskId !== null) {
          stats.tasks++
          await deps.db.attachTask(findingId, taskId)
        }
      }
      if (plan.close.length > 0) {
        await deps.db.closeFindings(doc.id, plan.close)
        stats.closed += plan.close.length
      }
    } catch {
      // Podrobnosti do logu dává adaptér; tady jen počet, ať běh pokračuje dalším dokumentem.
      stats.errors++
    }
  }
  return stats
}
