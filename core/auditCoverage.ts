// Pokrytí auditu DB triggerem (migrace 0064_audit_coverage.sql, 0082 a 0084) — čisté
// funkce a data, bez I/O. Přehled všech zápisových cest je v
// docs/PROVOZ.md.
//
// Tabulky v DB_AUDITED_TABLES mají trigger audit_row_change() (0064, chyba
// auditu shodí zápis) nebo — položky se `soft: true` z migrace 0082 —
// audit_row_change_soft() (chyba auditu zápis NEshodí, jen varování; výjimka od 0096:
// team_member a loop_node, viz AUDIT_FAIL_CLOSED_TABLES níže). Trigger je
// JEDINÝM zdrojem řádkových událostí `<tabulka>.created | .updated |
// .deleted`. Konfigurace tady MUSÍ sedět s argumenty CREATE TRIGGER v 0064
// (a v pozdějších migracích, které trigger na novou tabulku přidávají:
// dnes 0078 — meeting_note_intake a 0081 — auto_intake; seznam je v AUDIT_TRIGGER_EXTRA_MIGRATIONS
// níže, nebo ho na už kryté tabulce předefinují (napojují znovu) s novým allow-listem:
// 0084 — approval_request, deal_scope_version; 0087 — contact; 0090 — financial_record (due_on);
// 0094 — engagement_document;
// AUDIT_TRIGGER_REDEFINITIONS) —
// test/audit-coverage-0064.test.ts je porovnává (platí poslední definice). auditRowPayload je
// zrcadlo SQL funkce audit_row_change — kvůli testům a dokumentaci pravidel,
// ne kvůli zápisu (ten dělá databáze).
//
// Co smí do auditu jako HODNOTA: id a cizí klíče, stavy a číselníky, data,
// booleany, počty. Nikdy jména, e-maily, telefony, volný text, odkazy ani
// IČO/jméno firmy (u OSVČ osobní údaj) — audit_event nemá retenci ani výmaz
// (stejný důvod jako 0037 a domain/crm/auditPayload.ts). Ostatní sloupce se
// zapíšou jen NÁZVEM v `_columns`.

import { INFORMATION_STATES, type InformationState } from '@/core/informationState'
import { AGENT_AUDIT } from '@/core/auditCoverage.agent'
import { FOLLOWUP_AUDIT } from '@/core/auditCoverage.followup'
import { OUTBOX_AUDIT } from '@/core/auditCoverage.outbox'
import { WEB_AUDIT } from '@/core/auditCoverage.web'

// Dílčí seznamy paralelních balíků (P2, P3, P4, P6). Tenhle soubor po
// rozvětvení nikdo nemění — nové tabulky patří do core/auditCoverage.<balík>.ts.
const PARTS = [AGENT_AUDIT, OUTBOX_AUDIT, FOLLOWUP_AUDIT, WEB_AUDIT] as const
const fromParts = <K extends keyof (typeof PARTS)[number]>(k: K) =>
  Object.assign({}, ...PARTS.map((p) => p[k])) as (typeof PARTS)[number][K]

export type AuditOp = 'INSERT' | 'UPDATE' | 'DELETE'

export type AuditTableConfig = {
  /** Operace, na které trigger reaguje (pořadí jako v CREATE TRIGGER). */
  ops: readonly AuditOp[]
  /** Sloupce, jejichž HODNOTY smí do auditu. */
  safe: readonly string[]
  /** Sloupce, jejichž samotná změna není auditní událost (updated_at vždy). */
  ignore: readonly string[]
  /** Sloupec s id evidence, který se při změně propíše do audit_event.evidence_id. */
  evidenceColumn?: string
  /** Trigger audit_row_change_soft (0082): chyba zápisu auditu původní změnu neshodí. */
  soft?: boolean
  /**
   * Sloupce klíče, když entita nemá bigint `id` (0082): audit_event.entity_id je pak
   * NULL a entity_ref = hodnoty klíče spojené dvojtečkou.
   */
  key?: readonly string[]
}

const ALL: readonly AuditOp[] = ['INSERT', 'UPDATE', 'DELETE']

// Seřazené abecedně — stejné pořadí jako v SQL, ať se dají porovnat 1:1.
export const DB_AUDITED_TABLES: Readonly<Record<string, AuditTableConfig>> = {
  account: {
    ops: ALL,
    safe: ['client_since', 'founded_on', 'industry', 'is_reference', 'legal_form', 'ms_licenses', 'nace', 'nudged_on',
      'owner_id', 'raynet_id', 'referred_by_partner_id', 'size_band', 'snooze_until'],
    ignore: ['last_inbound_at', 'last_outbound_at'],
  },
  // 0082 (soft): kdo kolik hodin na čem; poznámka je volný text → jen názvem.
  allocation: {
    ops: ALL,
    safe: ['created_by', 'ends_on', 'engagement_id', 'hours_per_week', 'member_id', 'starts_on', 'substitute_id', 'work_case_id'],
    ignore: [],
    soft: true,
  },
  // 0084 (soft): výsledek provedení schválené/zamítnuté/vypršelé žádosti; result jen názvem.
  approval_execution: {
    ops: ALL,
    safe: ['action_type', 'attempts', 'case_id', 'executed_at', 'executed_by', 'request_id', 'request_status', 'status'],
    ignore: [],
    soft: true,
  },
  // 0084 předefinuje trigger z 0064: druh akce, cíl, otisk, přechod a odložení
  // s hodnotou; parametry (název kroku = volný text) a poznámka jen názvem.
  approval_request: {
    ops: ALL,
    safe: ['action_kind', 'action_type', 'case_id', 'decided_at', 'decided_by', 'expires_at', 'node', 'params_hash',
      'requested_by', 'requested_level', 'snoozed_by', 'snoozed_until', 'status', 'target_id', 'target_table', 'transition'],
    ignore: [],
  },
  authority_policy: {
    ops: ALL,
    safe: ['action_kind', 'active', 'level', 'updated_by'],
    ignore: [],
  },
  // Automatické založení poptávky z e-mailu (0081). Doména, klíč zprávy (Message-ID)
  // a důvody nikdy — jen id, stavy a časy; ostatní sloupce jen názvem v `_columns`.
  auto_intake: {
    ops: ALL,
    safe: ['account_id', 'activity_id', 'alias_id', 'contact_id', 'created_by', 'deal_id', 'decided_at', 'decided_by',
      'evidence_id', 'occurred_at', 'source', 'status', 'task_id'],
    ignore: [],
    evidenceColumn: 'evidence_id',
  },
  // 0082 (soft): název, zdůvodnění, kroky, poznámka rozhodnutí a klíč zdroje jen názvem.
  case_proposal: {
    ops: ALL,
    safe: ['account_id', 'capability', 'created_by', 'decided_at', 'decided_by', 'evidence_id', 'info_state', 'method', 'node',
      'occurred_at', 'status', 'work_case_id'],
    ignore: [],
    evidenceColumn: 'evidence_id',
    soft: true,
  },
  case_step: {
    ops: ALL,
    safe: ['case_id', 'due_at', 'position', 'status'],
    ignore: [],
  },
  company_alias: {
    ops: ALL,
    safe: ['account_id'],
    ignore: [],
  },
  // 0087 napojuje contact znovu: nesouhlas s oslovením (příznak, kdy, kdo)
  // s hodnotou; důvod nesouhlasu je volný text → jen názvem.
  contact: {
    ops: ALL,
    safe: ['account_id', 'do_not_contact', 'do_not_contact_at', 'do_not_contact_by', 'is_champion', 'partner_id'],
    ignore: [],
  },
  // Jen UPDATE a nikdy sloupce, které audituje 0034/0035 (DEAL_AUDIT_0035_COLUMNS).
  deal: {
    ops: ['UPDATE'],
    safe: ['account_id', 'closed_at', 'deal_kind', 'decision_due', 'delivery_lane', 'delivery_team', 'estimate_md',
      'expected_close', 'forecast_category', 'next_step_due', 'owner_id', 'phase', 'pillar', 'primary_contact_id',
      'probability_pct', 'revenue_category', 'revenue_line', 'sourced_by_partner', 'subsidy_program', 'won_at'],
    ignore: ['amount_one_time', 'amount_one_time_original', 'client_paid_one_time', 'cogs_one_time', 'currency',
      'expected_mrr', 'follow_up_escalated_on', 'follow_up_nudged_on', 'fx_rate', 'last_activity_at', 'stage', 'subsidy_pct'],
  },
  // 0082 (soft): složený klíč deal_id + partner_id + program → entity_ref.
  deal_partner: {
    ops: ALL,
    safe: ['attribution_pct', 'deal_id', 'is_sourcing', 'nnpsa_target', 'partner_id', 'program'],
    ignore: [],
    soft: true,
    key: ['deal_id', 'partner_id', 'program'],
  },
  // 0082 (soft): rozsah nabídky (text) jen názvem; částky s hodnotou, jen obchodní role.
  // 0084 předefinuje trigger o schválení k odeslání (send_approval_request_id, send_approved_at).
  deal_scope_version: {
    ops: ALL,
    safe: ['amount_one_time', 'created_by', 'currency', 'deal_id', 'decided_at', 'evidence_id', 'expected_mrr',
      'send_approval_request_id', 'send_approved_at', 'sent_at', 'status', 'version'],
    ignore: [],
    evidenceColumn: 'evidence_id',
    soft: true,
  },
  decision: {
    ops: ALL,
    safe: ['case_id', 'decided_at', 'decided_by', 'evidence_id'],
    ignore: [],
    evidenceColumn: 'evidence_id',
  },
  engagement: {
    ops: ALL,
    safe: ['account_id', 'baseline_adoption_pct', 'baseline_captured_on', 'client_sponsor_contact_id', 'copilot_licenses',
      'deal_id', 'due_on', 'follow_up_checkpoint_on', 'gate_next_steps_owned', 'gate_outputs_captured', 'gate_pack_delivered',
      'gate_peer_learning', 'gate_ratios_respected', 'gate_safety_followed', 'handoff_by', 'handoff_completed_at', 'kind',
      'nnpsa', 'phase', 'post_adoption_pct', 'post_captured_on', 'reference_worthy', 'started_on', 'time_saved_min_week',
      'trained_count', 'workshops_delivered'],
    ignore: ['adoption_delta_pp'],
  },
  // 0094 předefinuje trigger z 0064: typ, stav, kdo a kdy stav změnil, schválení a
  // připíchnutá verze, stav zdroje a číslo verze s hodnotou. Identita položky
  // (drive_id, item_id), eTag/cTag, kdo soubor naposledy upravil a odkaz jen
  // názvem sloupce. source_checked_at (denní kontrola) se ignoruje.
  engagement_document: {
    ops: ALL,
    safe: ['approved_at', 'approved_by', 'approved_version_id', 'created_by', 'doc_type', 'engagement_id', 'kind',
      'milestone_id', 'source_state', 'status', 'status_changed_at', 'status_changed_by', 'version_label'],
    ignore: ['source_checked_at'],
  },
  // 0094 (soft): nález denní kontroly dokumentu (změnil se od schválení, zmizel, bez přístupu).
  engagement_document_finding: {
    ops: ALL,
    safe: ['detected_at', 'document_id', 'kind', 'resolution', 'resolved_at', 'resolved_by', 'task_id', 'version_id'],
    ignore: [],
    soft: true,
  },
  engagement_milestone: {
    ops: ALL,
    safe: ['acceptance_evidence_id', 'accepted_at', 'accepted_by_contact_id', 'deputy_id', 'due_on', 'engagement_id',
      'owner_id', 'status'],
    ignore: [],
    evidenceColumn: 'acceptance_evidence_id',
  },
  // 0098 (soft): dávka hromadného importu zakázek. Popisek (název souboru) je volný
  // text → jen názvem v `_columns`.
  import_batch: {
    ops: ALL,
    safe: ['created_by', 'kind', 'reverted_at', 'reverted_by', 'status'],
    ignore: [],
    soft: true,
  },
  // 0082 (soft): číslo dokladu (external_ref) a poznámka jen názvem; jen obchodní role.
  // 0090 přidává due_on (splatnost faktury, datum) s hodnotou.
  financial_record: {
    ops: ALL,
    safe: ['account_id', 'amount', 'created_by', 'currency', 'deal_id', 'due_on', 'engagement_id', 'evidence_id', 'kind', 'milestone_id',
      'period_month', 'source', 'status'],
    ignore: [],
    evidenceColumn: 'evidence_id',
    soft: true,
  },
  // 0092 (soft): fronta „Rozdíly k vyřešení" z iDokladu. Číslo dokladu, důvod,
  // částky, měna, poznámka a otisk jen názvem; last_seen_at (denní „viděno
  // znovu") není auditní událost. Jen obchodní role.
  idoklad_discrepancy: {
    ops: ALL,
    safe: ['account_id', 'idoklad_id', 'idoklad_kind', 'kind', 'record_id', 'resolution', 'resolved_at', 'resolved_by', 'status'],
    ignore: ['last_seen_at'],
    soft: true,
  },
  // 0082 (soft): obsazení uzlů Loop Core; klíč = kód uzlu.
  loop_node: {
    ops: ALL,
    safe: ['deputy_id', 'node', 'owner_id'],
    ignore: [],
    soft: true,
    key: ['node'],
  },
  // 0091 (soft): vybraná pošta s obsahem. Předmět, úryvek, názvy příloh, doména
  // odesílatele, datum z textu a klíč zprávy nikdy jako hodnota — jen názvem.
  mail_content_intake: {
    ops: ALL,
    safe: ['account_id', 'ai_used', 'created_by', 'deal_id', 'decided_at', 'decided_by', 'engagement_id', 'evidence_id',
      'match_method', 'milestone_id', 'proposal_id', 'received_at', 'signals', 'source', 'status', 'wait_reason'],
    ignore: [],
    evidenceColumn: 'evidence_id',
    soft: true,
  },
  // Příjem zápisů schůzek (0078). Text, název a nápověda klienta nikdy — jen
  // stavy, čas a vazby; ostatní sloupce jen názvem v `_columns`.
  meeting_note_intake: {
    ops: ALL,
    safe: ['account_id', 'activity_id', 'created_by', 'decided_at', 'decided_by', 'match_method', 'occurred_at',
      'proposal_id', 'source', 'status'],
    ignore: [],
  },
  // 0082 (soft): název metriky, jednotka a poznámka jen názvem; naměřené hodnoty bez peněz.
  metric_observation: {
    ops: ALL,
    safe: ['actual', 'baseline', 'created_by', 'engagement_id', 'evidence_id', 'observed_on'],
    ignore: [],
    evidenceColumn: 'evidence_id',
    soft: true,
  },
  partner: {
    ops: ALL,
    safe: ['is_referrer', 'kind', 'roles', 'via_partner_id'],
    ignore: [],
  },
  partner_registration: {
    ops: ALL,
    safe: ['partner_id', 'program', 'status'],
    ignore: [],
  },
  reference_card: {
    ops: ALL,
    safe: ['account_id', 'approved_public', 'engagement_id', 'is_ms_anchor', 'used_in_deals'],
    ignore: [],
  },
  relationship: {
    ops: ALL,
    safe: ['child_account_id', 'parent_account_id', 'relationship_type'],
    ignore: [],
  },
  // Změna jen předmětu/těla = GDPR redakce; tu zapisuje appka jako
  // sales_activity.redacted (SEMANTIC_AUDIT_ACTIONS), proto ignorované.
  sales_activity: {
    ops: ALL,
    safe: ['account_id', 'contact_id', 'created_by', 'deal_id', 'follow_up_on', 'kind', 'occurred_at', 'outcome',
      'partner_id', 'source'],
    ignore: ['body', 'subject'],
  },
  subscription: {
    ops: ALL,
    safe: ['account_id', 'churn_risk', 'deal_id', 'ended_on', 'health_score', 'is_ms_subsidized', 'mrr', 'product',
      'renewal_date', 'seats', 'started_on'],
    ignore: [],
  },
  target_list: {
    ops: ALL,
    safe: ['created_by', 'owner_id'],
    ignore: [],
  },
  target_list_item: {
    ops: ALL,
    safe: ['account_id', 'contact_id', 'created_by', 'list_id', 'next_step_due', 'status'],
    ignore: [],
  },
  task: {
    ops: ALL,
    safe: ['account_id', 'assignee_id', 'created_by', 'deal_id', 'due_on', 'engagement_id', 'priority', 'status'],
    ignore: ['ms_event_id'],
  },
  // 0082 (soft): oprávnění (role, admin, manažer, deaktivace) s hodnotou; jméno
  // a kapacita ignorované, e-mail jen názvem. Klíč = uuid člena.
  team_member: {
    ops: ALL,
    safe: ['deactivated_at', 'is_admin', 'manager_id', 'role'],
    ignore: ['full_name', 'weekly_capacity_hours'],
    soft: true,
    key: ['id'],
  },
  work_case: {
    ops: ALL,
    safe: ['account_id', 'created_by', 'deal_id', 'deputy_id', 'lead_owner_id', 'node', 'status'],
    ignore: [],
  },
  ...fromParts('tables'),
}

/** Sloupce obchodu, které audituje výhradně 0034/0035 (deal.amount_changed / stage_changed / money_changed). */
export const DEAL_AUDIT_0035_COLUMNS = [
  'amount_one_time', 'amount_one_time_original', 'cogs_one_time', 'currency', 'expected_mrr', 'fx_rate', 'stage', 'subsidy_pct',
] as const

/**
 * Appkové audit události nad krytými tabulkami, které NEJSOU řádkovou změnou
 * (nebo změnou, kterou trigger záměrně ignoruje) — smí se zapisovat vždy.
 * Všechna ostatní volání recordAudit nad krytou tabulkou musí být jen
 * záloha za trigger (`if (!(await dbAuditActive()))`), jinak by se změna
 * zapsala dvakrát. Hlídá test/audit-coverage-0064.test.ts.
 */
export const SEMANTIC_AUDIT_ACTIONS: readonly string[] = [
  'contact.exported',              // export dat kontaktu (GDPR) — čtení, ne zápis
  'sales_activity.redacted',       // GDPR redakce subject/body — trigger ji ignoruje
  'deal.offer_confirmed',          // vzniká s INSERT obchodu z nabídky — deal má trigger jen na UPDATE (0034/0035 kryje INSERT/DELETE)
  'deal.connector_proposal_confirmed', // schválení návrhu z konektoru člověkem (doklad + human_confirmed); INSERT/UPDATE zapíše trigger zvlášť
  'deal.scope_version_accepted',   // RPC mění jen sloupce z DEAL_AUDIT_0035_COLUMNS (ignore u deal) — trigger 0064 na ně nereaguje
]

/** Sloupce, které nesmí být v allow-listu nikdy (jména, kontakty, volný text, odkazy). */
export const NEVER_SAFE_COLUMNS: readonly string[] = [
  'name', 'full_name', 'email', 'phone', 'role', 'notes', 'note', 'title', 'description', 'subject', 'body', 'headline',
  'reason', 'rationale', 'value_hypothesis', 'segment', 'next_step', 'no_next_step_reason', 'lost_reason', 'problem',
  'expected_outcome', 'decision_maker', 'decision_process', 'value_basis', 'goal', 'scope', 'financial_frame', 'risks',
  'question', 'options', 'chosen', 'decision_note', 'url', 'web', 'deliverable_pack_url', 'source_pdf_path', 'ico',
  'alias_domain', 'alias_name', 'profile', 'region', 'tier_note', 'margin_pct', 'roi_czk_year', 'dev_team',
  'status_done', 'status_next', 'status_blocker', 'external_id', 'ms_event_id',
  // 0082: číslo dokladu, klíč zdroje (identifikátor zprávy), název metriky, jednotka, kroky návrhu.
  'external_ref', 'source_key', 'metric', 'unit', 'steps',
  // 0084: parametry žádosti (název kroku) a výsledek provedení (volný jsonb).
  'params', 'result',
  // 0087: odkud/proč kontakt nesouhlasí s oslovením (volný text o člověku).
  'do_not_contact_reason',
]

/**
 * Výjimky z NEVER_SAFE_COLUMNS pro konkrétní tabulku: stejný název sloupce
 * znamená jinde volný text a jinde číselník. `contact.role` je pracovní
 * pozice (text), `team_member.role` je enum oprávnění (vedeni, obchodnik, …)
 * a právě jeho změna je to, co má audit ukázat.
 */
export const NEVER_SAFE_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  team_member: ['role'],
}

/** Entity, jejichž audit_event řádky vidí jen obchodní role (politika audit_event_sales_only, 0064). */
export const SALES_ONLY_AUDIT_ENTITIES: readonly string[] = ['deal', 'deal_partner', 'subscription']

/** Další entity jen pro obchodní role (politika audit_event_sales_only_fin, 0082): částky a rozsah nabídky. */
export const SALES_ONLY_AUDIT_ENTITIES_0082: readonly string[] = ['deal_scope_version', 'financial_record']

/** A fronta rozdílů z iDokladu (politika audit_event_sales_only_idoklad, 0092). */
export const SALES_ONLY_AUDIT_ENTITIES_0092: readonly string[] = ['idoklad_discrepancy']

export function isSalesOnlyAuditEntity(table: string): boolean {
  return SALES_ONLY_AUDIT_ENTITIES.includes(table) || SALES_ONLY_AUDIT_ENTITIES_0082.includes(table)
    || SALES_ONLY_AUDIT_ENTITIES_0092.includes(table)
}

export function isDbAuditedTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(DB_AUDITED_TABLES, table)
}

/** Smí hodnota sloupce do auditu? Neznámá tabulka nebo sloupec = ne (fail safe). */
export function isAuditSafeColumn(table: string, column: string): boolean {
  if (!isDbAuditedTable(table)) return false
  if (NEVER_SAFE_COLUMNS.includes(column) && !NEVER_SAFE_EXCEPTIONS[table]?.includes(column)) return false
  return DB_AUDITED_TABLES[table].safe.includes(column)
}

export type AuditRow = Record<string, unknown>

export type AuditRowPayload = {
  action: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  /** Jen u tabulek s `key` (0082): hodnoty klíče spojené dvojtečkou; entity_id je pak NULL. */
  entityRef?: string
}

const ALWAYS_IGNORED = ['updated_at']
const NOT_LISTED_ON_CREATE_DELETE = ['id', 'created_at', 'updated_at']

// Porovnání hodnot jako jsonb v Postgresu: čísla numericky, ostatní přes JSON.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null
  if (b === undefined) b = null
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

function pick(row: AuditRow, columns: readonly string[], table: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of columns) if (isAuditSafeColumn(table, c)) out[c] = row[c] ?? null
  return out
}

/**
 * Zrcadlo SQL audit_row_change(): co trigger zapíše pro změnu řádku.
 * null = žádná auditní událost (nekrytá tabulka, operace mimo trigger,
 * nebo UPDATE jen ignorovaných sloupců).
 */
export function auditRowPayload(
  table: string,
  op: AuditOp,
  oldRow: AuditRow | null,
  newRow: AuditRow | null,
): AuditRowPayload | null {
  if (!isDbAuditedTable(table)) return null
  const cfg = DB_AUDITED_TABLES[table]
  if (!cfg.ops.includes(op)) return null
  const withRef = (p: AuditRowPayload | null, row: AuditRow): AuditRowPayload | null =>
    p && cfg.key ? { ...p, entityRef: cfg.key.map((k) => String(row[k] ?? '')).join(':') } : p

  if (op === 'UPDATE') {
    const oldR = oldRow ?? {}
    const newR = newRow ?? {}
    const ignore = [...ALWAYS_IGNORED, ...cfg.ignore]
    const columns = Object.keys(newR)
      .filter((k) => !ignore.includes(k) && !sameValue(newR[k], oldR[k]))
      .sort()
    if (columns.length === 0) return null
    return withRef({
      action: `${table}.updated`,
      before: pick(oldR, columns, table),
      after: { ...pick(newR, columns, table), _columns: columns },
    }, newR)
  }

  const row = (op === 'INSERT' ? newRow : oldRow) ?? {}
  const columns = Object.keys(row)
    .filter((k) => !NOT_LISTED_ON_CREATE_DELETE.includes(k) && row[k] !== null && row[k] !== undefined)
    .sort()
  const payload = { ...pick(row, columns, table), _columns: columns }
  return withRef(
    op === 'INSERT'
      ? { action: `${table}.created`, before: null, after: payload }
      : { action: `${table}.deleted`, before: payload, after: null },
    row,
  )
}

// ---------------------------------------------------------------------------
// Kontext servisního zápisu: hlavičky, kterými admin klient (servisní klíč)
// řekne triggeru, za koho a na základě čeho zapisuje. Trigger jim věří jen
// pod rolí service_role a bez přihlášeného uživatele (audit_request_context).

export const AUDIT_ACTOR_HEADER = 'x-cockpit-audit-actor'
export const AUDIT_EVIDENCE_HEADER = 'x-cockpit-audit-evidence'
export const AUDIT_INFO_STATE_HEADER = 'x-cockpit-audit-info-state'

/** MUSÍ sedět s regexem v audit_request_context (0064). */
export const AUDIT_ACTOR_RE = /^(user|api_key|system)(?::([A-Za-z0-9._:@-]{1,128}))?$/
const EVIDENCE_ID_RE = /^[1-9][0-9]{0,17}$/

export type AuditHeaderActor = { type: 'user' | 'api_key' | 'system'; id: string | null }

export type AuditContext = {
  actor: AuditHeaderActor
  evidenceId?: number | null
  infoState?: InformationState | null
}

/** Hodnota hlavičky aktéra, nebo null, když ji trigger stejně nepřijme. */
export function auditActorHeaderValue(actor: AuditHeaderActor): string | null {
  const value = actor.id ? `${actor.type}:${actor.id}` : actor.type
  return AUDIT_ACTOR_RE.test(value) ? value : null
}

/** Hlavičky pro admin klienta; neplatné hodnoty se vynechají (trigger pak zapíše db-trigger:service_role). */
export function auditContextHeaders(ctx: AuditContext): Record<string, string> {
  const headers: Record<string, string> = {}
  const actor = auditActorHeaderValue(ctx.actor)
  if (actor) headers[AUDIT_ACTOR_HEADER] = actor
  if (ctx.evidenceId != null && EVIDENCE_ID_RE.test(String(ctx.evidenceId))) {
    headers[AUDIT_EVIDENCE_HEADER] = String(ctx.evidenceId)
  }
  if (ctx.infoState != null && (INFORMATION_STATES as readonly string[]).includes(ctx.infoState)) {
    headers[AUDIT_INFO_STATE_HEADER] = ctx.infoState
  }
  return headers
}

/** Verze migrace, po jejímž aplikování audit řádkových změn dělá DB. */
export const AUDIT_TRIGGER_MIGRATION = '0064'

/**
 * Verze migrace 0082: audit tabulek `soft: true` (financial_record, allocation,
 * metric_observation, case_proposal, deal_scope_version, deal_partner,
 * loop_node, team_member). Appková volání recordAudit nad těmito tabulkami
 * jsou po ní jen záloha (dbSoftAuditActive v core/auditDb.ts).
 */
export const AUDIT_SOFT_TRIGGER_MIGRATION = '0082'
export const AUDIT_SOFT_TRIGGER_MIGRATION_FILE = '0082_audit_gaps_partner_lockdown.sql'

/**
 * Pozdější migrace, které napojují audit_row_change() na další tabulky
 * (0064 zakládá funkci a prvních 21 tabulek). Test porovnává triggery ze
 * všech těchto souborů s DB_AUDITED_TABLES.
 */
export const AUDIT_TRIGGER_EXTRA_MIGRATIONS: Readonly<Record<string, string>> = {
  meeting_note_intake: '0078_meeting_note_intake.sql',
  auto_intake: '0081_auto_intake.sql',
  ...fromParts('triggerMigrations'),
}

/**
 * Pozdější migrace, které trigger audit_row_change() na UŽ kryté tabulce
 * předefinují (DROP + CREATE s rozšířeným nebo jiným allow-listem). Platí
 * poslední definice v pořadí migrací; test ji porovnává s DB_AUDITED_TABLES.
 */
export const AUDIT_TRIGGER_REDEFINITIONS: Readonly<Record<string, string>> = {
  approval_request: '0084_approval_executor.sql',
  contact: '0087_contact_opt_out.sql',
  engagement_document: '0094_sp_documents.sql',
  ...fromParts('triggerRedefinitions'),
}

/** Měkký audit (audit_row_change_soft z 0082) na nových tabulkách z pozdějších migrací. */
export const AUDIT_SOFT_TRIGGER_EXTRA_MIGRATIONS: Readonly<Record<string, string>> = {
  approval_execution: '0084_approval_executor.sql',
  mail_content_intake: '0091_mail_content_intake.sql',
  idoklad_discrepancy: '0092_idoklad_sync.sql',
  engagement_document_finding: '0094_sp_documents.sql',
  import_batch: '0098_bulk_import.sql',
  ...fromParts('softTriggerMigrations'),
}

/**
 * Tabulky s triggerem audit_row_change_soft, u kterých chyba zápisu auditu
 * změnu ZRUŠÍ (0096, výjimka AU001), místo aby ji nechala projít bez stopy:
 * oprávnění (team_member: role, is_admin, manažer, deaktivace) a obsazení uzlů
 * Loop Core (kdo schvaluje). MUSÍ sedět s v_strict v audit_row_change_soft()
 * v 0096_security_round2.sql (hlídá test/security-0096-pglite.test.ts).
 */
export const AUDIT_FAIL_CLOSED_TABLES: readonly string[] = ['loop_node', 'team_member']

/** Pozdější migrace, které měkký trigger z 0082 předefinují (rozšířený allow-list). */
export const AUDIT_SOFT_TRIGGER_REDEFINITIONS: Readonly<Record<string, string>> = {
  deal_scope_version: '0084_approval_executor.sql',
  financial_record: '0090_financial_due_on.sql',
  ...fromParts('softTriggerRedefinitions'),
}
