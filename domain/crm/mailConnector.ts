// Outlook pošta jako konektor podle kontraktu Loop Core
// (core/connectors/contract.ts, kapitola 11). Tenký adaptér: chování syncu
// se nemění — runOutlookMailConnector volá tentýž runMailSync se stejnými
// závislostmi a jen si přes onPageStored skládá normalizované události.
// test/mail-connector.test.ts dokazuje, že DB volání, statistiky i evidence
// jsou s adaptérem i bez něj totožné.
//
// Mapování:
//   složka inbox / sent       → ConnectorDescriptor 'outlook:inbox' / 'outlook:sent'
//                               (klíč = connector_state.connector, beze změny)
//   řádek mail_event          → NormalizedEvent<MailEventRow>
//     internet_message_id     → external_id (Message-ID je stabilní i po resyncu)
//     direction               → type 'message.inbound' / 'message.outbound'
//     spárovaná firma         → subject { kind: 'account' }
//     kontakt / doména        → participants (nikdy adresa)
//     spárovaná zpráva        → evidence 'email_message' + webLink, přesně
//                               ten, který sync poslal do recordEvidence
//   title                     → vždy null: obsahová politika metadata_only (0041)
//   FolderStats.outcome       → SyncResult.outcome (stejné hodnoty)
import type { ConnectorDescriptor, NormalizedEvent, SyncResult } from '@/core/connectors/contract'
import type { EvidenceRef } from '@/core/informationState'
import type { MailDirection } from '@/domain/crm/mailMatch'
import type { IntakeCandidate } from '@/domain/crm/autoIntake'
import {
  FOLDERS,
  runMailSync,
  type FolderKey,
  type FolderStats,
  type MailEventRow,
  type MailEvidenceRef,
  type MailSyncDeps,
  type MailSyncOptions,
  type MailSyncStats,
  type StoredMailPage,
} from '@/domain/crm/mailSync'

export const OUTLOOK_MAIL_SYSTEM = 'microsoft_graph'
/** Denní cron (Vercel Hobby) + rezerva na posunutý běh. */
export const OUTLOOK_MAIL_FRESHNESS_HOURS = 36

const descriptor = (key: FolderKey): ConnectorDescriptor => ({
  key: FOLDERS[key].connector,
  system: OUTLOOK_MAIL_SYSTEM,
  kind: 'mail',
  scopes: ['Mail.Read'],
  freshnessHours: OUTLOOK_MAIL_FRESHNESS_HOURS,
  content: 'metadata_only',
  eventTypes: [`message.${FOLDERS[key].direction}`],
})

export const OUTLOOK_MAIL_CONNECTORS: Readonly<Record<FolderKey, ConnectorDescriptor>> = {
  inbox: descriptor('inbox'),
  sent: descriptor('sent'),
}

export type OutlookMailEvent = NormalizedEvent<MailEventRow>

const FOLDER_OF: Record<MailDirection, FolderKey> = { inbound: 'inbox', outbound: 'sent' }

/** Řádek mail_event → normalizovaná událost. `webLink` = odkaz, který sync dal do evidence. */
export function mailRowToEvent(row: MailEventRow, webLink: string | null): OutlookMailEvent {
  const matched = row.match_status === 'matched' && row.account_id !== null
  const evidence: EvidenceRef | null = matched
    ? { kind: 'email_message', sourceId: row.internet_message_id, webLink }
    : null
  return {
    source: FOLDERS[FOLDER_OF[row.direction]].connector,
    type: `message.${row.direction}`,
    external_id: row.internet_message_id,
    occurred_at: row.occurred_at,
    subject: matched ? { kind: 'account', id: row.account_id as number } : null,
    participants: [
      {
        role: row.direction === 'inbound' ? 'from' : 'to',
        accountId: row.account_id,
        contactId: row.contact_id,
        domain: row.counterpart_domain,
      },
    ],
    evidence,
    title: null,
    payload: row,
  }
}

/** Zpětně: odkaz, který z události vzejde pro recordEvidence (null = nespárovaná). */
export function eventEvidenceRef(ev: OutlookMailEvent): MailEvidenceRef | null {
  return ev.evidence ? { internetMessageId: ev.evidence.sourceId, webLink: ev.evidence.webLink ?? null } : null
}

/** Zapsaná stránka → události (webLink z evidence stránky podle Message-ID). */
export function pageToEvents(page: StoredMailPage): OutlookMailEvent[] {
  const links = new Map(page.evidence.map((r) => [r.internetMessageId, r.webLink]))
  return page.rows.map((row) => mailRowToEvent(row, links.get(row.internet_message_id) ?? null))
}

export function folderSyncResult(
  key: FolderKey,
  fs: FolderStats,
  events: readonly OutlookMailEvent[],
): SyncResult<MailEventRow> {
  return {
    connector: FOLDERS[key].connector,
    outcome: fs.outcome,
    pages: fs.pages,
    inserted: fs.inserted,
    events,
    ...(fs.error !== undefined ? { error: fs.error } : {}),
  }
}

export type OutlookMailRun = {
  /** Beze změny to, co vrací runMailSync (jde do job_run.stats). */
  stats: MailSyncStats
  results: Record<FolderKey, SyncResult<MailEventRow>>
  /**
   * Kandidáti na automatické zakládání poptávek (jen s options.collectIntake).
   * Nesou adresu a jméno odesílatele — žijí jen v paměti tohoto běhu a do
   * job_run.stats ani do logu nepatří (stats je jen `stats` výš).
   */
  intake: IntakeCandidate[]
}

/** runMailSync přes kontrakt konektorů: stejný běh + normalizované události. */
export async function runOutlookMailConnector(
  deps: MailSyncDeps,
  options: Partial<MailSyncOptions> = {},
): Promise<OutlookMailRun> {
  const collected: Record<FolderKey, OutlookMailEvent[]> = { inbox: [], sent: [] }
  const intake: IntakeCandidate[] = []
  const stats = await runMailSync(
    {
      ...deps,
      async onPageStored(page) {
        collected[page.folder].push(...pageToEvents(page))
        if (page.intake) intake.push(...page.intake)
        await deps.onPageStored?.(page)
      },
    },
    options,
  )
  return {
    stats,
    results: {
      inbox: folderSyncResult('inbox', stats.folders.inbox, collected.inbox),
      sent: folderSyncResult('sent', stats.folders.sent, collected.sent),
    },
    intake,
  }
}
