// Kontrakt konektorů Loop Core (kapitola 11 plánu přestavby: „kontrakty
// konektorů"). Tady je jen TVAR a čisté funkce, žádné I/O a žádná konkrétní
// firma ani systém. Konektor (Outlook, později SharePoint, ERP…) ho plní
// tenkým adaptérem — dnes domain/crm/mailConnector.ts.
//
// Kanonický tok z cílové architektury: zdroj → normalizace události →
// identita firmy → pravidlo nebo model → návrh → člověk → zápis → audit.
// Tenhle soubor pokrývá první dva kroky a stav konektoru:
//
//   ConnectorDescriptor  co konektor je: klíč (= connector_state.connector),
//                        systém, druh, oprávnění, práh čerstvosti, co smí
//                        z obsahu předat dál
//   NormalizedEvent<T>   jedna událost ze zdroje ve společném tvaru
//   eventKey             pravidla idempotence (viz níže)
//   SyncResult<T>        výsledek jednoho běhu synchronizace
//   stateWriteFor        výsledek běhu → zápis do connector_state
//   connectorHealth      řádek connector_state → zdraví konektoru
//
// Import vždy absolutně `@/core/connectors/contract` — lint vyjímá jen tuhle
// cestu z pravidla „core nesmí na connectors/" (eslint.config.mjs).
import type { ConnectorState } from '@/core/connectorState'
import { evidenceRefIssues, EVIDENCE_SOURCE_ID_MAX, type EvidenceRef } from '@/core/informationState'

// ---------------------------------------------------------------------------
// Popis konektoru

export const CONNECTOR_KINDS = ['mail', 'calendar', 'files', 'accounting', 'other'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/**
 * Co konektor smí z obsahu zdroje předat do události:
 *   metadata_only  nic z obsahu (ani předmět) — jen kdo, kdy, s kým, odkaz
 *   title          krátký titulek (předmět, název souboru), nikdy tělo
 * Plný obsah záměrně nemá hodnotu: tělo zprávy do události nepatří nikdy.
 */
export const CONTENT_POLICIES = ['metadata_only', 'title'] as const
export type ContentPolicy = (typeof CONTENT_POLICIES)[number]

export interface ConnectorDescriptor {
  /** Stabilní klíč — shodný s connector_state.connector (např. „outlook:inbox"). */
  key: string
  /** Zdrojový systém (malá písmena), např. „microsoft_graph". */
  system: string
  kind: ConnectorKind
  /** Oprávnění, která konektor u zdroje potřebuje (čte je člověk v Nastavení). */
  scopes: readonly string[]
  /** Po kolika hodinách bez úspěchu je konektor „zastaralý" (connectorHealth). */
  freshnessHours: number
  content: ContentPolicy
  /** Typy událostí, které konektor vydává (NormalizedEvent.type). */
  eventTypes: readonly string[]
}

const KEY_RE = /^[a-z][a-z0-9_]*(:[a-z0-9_]+)*$/
const SYSTEM_RE = /^[a-z][a-z0-9_]*$/
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** Chyby popisu konektoru; prázdné pole = v pořádku. */
export function descriptorIssues(d: ConnectorDescriptor): string[] {
  const issues: string[] = []
  if (!KEY_RE.test(d.key)) issues.push(`neplatný klíč konektoru: ${d.key}`)
  if (!SYSTEM_RE.test(d.system)) issues.push(`neplatný systém: ${d.system}`)
  if (!(CONNECTOR_KINDS as readonly string[]).includes(d.kind)) issues.push(`neznámý druh: ${String(d.kind)}`)
  if (!(CONTENT_POLICIES as readonly string[]).includes(d.content)) issues.push(`neznámá obsahová politika: ${String(d.content)}`)
  if (!Number.isFinite(d.freshnessHours) || d.freshnessHours <= 0) issues.push('freshnessHours musí být kladné číslo')
  if (d.eventTypes.length === 0) issues.push('konektor nevydává žádný typ události')
  for (const t of d.eventTypes) if (!EVENT_TYPE_RE.test(t)) issues.push(`neplatný typ události: ${t}`)
  return issues
}

// ---------------------------------------------------------------------------
// Normalizovaná událost

/**
 * O čem událost je — entita v Cockpitu, ke které se zdroj spároval.
 * POZOR: není to předmět e-mailu. Ten Outlook konektor nečte vůbec (0041);
 * krátký titulek, když ho konektor smí předat, je v `title`.
 */
export type EventSubject = { kind: 'account'; id: number }

/**
 * Účastník události. Nikdy adresa ani jméno osoby — jen vazba na záznam
 * v Cockpitu, nebo firemní doména u nespárované protistrany.
 */
export interface EventParticipant {
  role: 'from' | 'to' | 'counterpart'
  accountId: number | null
  contactId: number | null
  domain: string | null
}

export interface NormalizedEvent<T = unknown> {
  /** Klíč konektoru, který událost vydal (ConnectorDescriptor.key). */
  source: string
  /** Typ události, např. „message.inbound". */
  type: string
  /** Id ve zdrojovém systému (u pošty RFC 5322 Message-ID), ne naše DB id. */
  external_id: string
  /** Kdy se to ve zdroji stalo, ISO 8601 v UTC. */
  occurred_at: string
  subject: EventSubject | null
  participants: readonly EventParticipant[]
  /** Odkaz na zdroj (tabulka evidence, 0038). Bez něj nejde nic doložit. */
  evidence: EvidenceRef | null
  /** Krátký titulek — jen když ConnectorDescriptor.content = 'title', jinak null. */
  title: string | null
  /** Doménový tvar události tak, jak ho konektor ukládá (u pošty řádek mail_event). */
  payload: T
}

export const EVENT_TITLE_MAX = 300

// ---------------------------------------------------------------------------
// Idempotence
//
// Pravidla (platí pro každý konektor i spotřebitele):
//  1. external_id je stabilní id ze ZDROJE (ne naše DB id, ne čas). Stejná
//     věc ve zdroji = stejné external_id při každém běhu, i po resyncu.
//  2. Klíč události = source | type | external_id. Stejná zpráva v Doručené
//     a Odeslané má jiný type (i source), takže jsou to dvě události —
//     přesně jako UNIQUE (internet_message_id, direction) v mail_event.
//  3. Spotřebitel (schopnost) ukládá výsledek pod klíčem události a DB ho
//     drží unikátní (case_proposal: UNIQUE (capability, source_key)).
//     Opakovaný běh nad stejnými událostmi tedy nic nezdvojí.
//  4. V jednom běhu vyhrává první výskyt klíče (dedupeEvents).

export const EVENT_KEY_MAX = 700

export function eventKey(ev: Pick<NormalizedEvent, 'source' | 'type' | 'external_id'>): string {
  return `${ev.source}|${ev.type}|${ev.external_id}`
}

/** Bez duplicit podle eventKey; pořadí zachované, vyhrává první výskyt. */
export function dedupeEvents<T>(events: readonly NormalizedEvent<T>[]): NormalizedEvent<T>[] {
  const seen = new Set<string>()
  const out: NormalizedEvent<T>[] = []
  for (const ev of events) {
    const k = eventKey(ev)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(ev)
  }
  return out
}

/**
 * Chyby normalizované události; prázdné pole = v pořádku. S popisem
 * konektoru navíc hlídá, že událost sedí k němu (klíč, typ, obsahová politika).
 */
export function normalizedEventIssues(ev: NormalizedEvent, d?: ConnectorDescriptor): string[] {
  const issues: string[] = []
  if (!KEY_RE.test(ev.source)) issues.push(`neplatný zdroj: ${ev.source}`)
  if (!EVENT_TYPE_RE.test(ev.type)) issues.push(`neplatný typ události: ${ev.type}`)
  const id = ev.external_id
  if (typeof id !== 'string' || id.trim() === '' || id !== id.trim()) {
    issues.push('external_id je prázdné nebo má okrajové mezery')
  } else if (id.length > EVIDENCE_SOURCE_ID_MAX) {
    issues.push(`external_id je delší než ${EVIDENCE_SOURCE_ID_MAX} znaků`)
  }
  if (eventKey(ev).length > EVENT_KEY_MAX) issues.push(`klíč události je delší než ${EVENT_KEY_MAX} znaků`)
  const t = Date.parse(ev.occurred_at)
  if (!Number.isFinite(t) || new Date(t).toISOString() !== ev.occurred_at) {
    issues.push('occurred_at není ISO 8601 v UTC')
  }
  for (const p of ev.participants) {
    if (p.domain !== null && p.domain.includes('@')) issues.push('účastník nese adresu místo domény')
  }
  if (ev.title !== null && (ev.title.trim() === '' || ev.title.length > EVENT_TITLE_MAX)) {
    issues.push(`titulek je prázdný nebo delší než ${EVENT_TITLE_MAX} znaků`)
  }
  if (ev.evidence) issues.push(...evidenceRefIssues(ev.evidence))
  if (d) {
    if (ev.source !== d.key) issues.push(`událost je z ${ev.source}, konektor ${d.key}`)
    if (!d.eventTypes.includes(ev.type)) issues.push(`konektor ${d.key} nevydává ${ev.type}`)
    if (d.content === 'metadata_only' && ev.title !== null) {
      issues.push(`konektor ${d.key} smí předat jen metadata, ne titulek`)
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Výsledek synchronizace a jeho zápis do connector_state

export const SYNC_OUTCOMES = [
  'caught_up',
  'more_pending',
  'throttled',
  'expired',
  'error',
  'missing_scope',
  'not_started',
] as const
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number]

export interface SyncResult<T = unknown> {
  connector: string
  outcome: SyncOutcome
  pages: number
  /** Kolik událostí se nově uložilo (duplicity ze zdroje se nepočítají). */
  inserted: number
  events: readonly NormalizedEvent<T>[]
  error?: string
}

/**
 * Jak se konečný výsledek běhu propíše do connector_state
 * (core/connectorState.ts):
 *   caught_up                        → recordConnectorSuccess (kurzor, čerstvost, nula chyb)
 *   error, missing_scope, expired    → recordConnectorError (chyba, +1 v řadě)
 *   more_pending, throttled,
 *   not_started                      → nic; posune se jen kurzor, stav zůstává
 * „Nic" je záměr: rozpracovaný nebo přiškrcený běh není chyba ani úspěch —
 * o zdraví rozhodne až další běh (a práh čerstvosti v connectorHealth).
 */
export type ConnectorStateWrite =
  | { kind: 'success' }
  | { kind: 'error'; message: string }
  | { kind: 'none' }

export function stateWriteFor(outcome: SyncOutcome, error?: string): ConnectorStateWrite {
  switch (outcome) {
    case 'caught_up':
      return { kind: 'success' }
    case 'error':
    case 'missing_scope':
    case 'expired':
      return { kind: 'error', message: error ?? outcome }
    default:
      return { kind: 'none' }
  }
}

// ---------------------------------------------------------------------------
// Zdraví konektoru z connector_state

export const CONNECTOR_HEALTH = ['ok', 'stale', 'failing', 'never_ran'] as const
export type ConnectorHealth = (typeof CONNECTOR_HEALTH)[number]

/** Tři chyby v řadě = rozbité bez ohledu na čerstvost (shodně s isStale). */
export const FAILING_AFTER_ERRORS = 3

/**
 * Zdraví konektoru. `ok` právě tehdy, když isStale(state, d.freshnessHours)
 * z core/connectorState.ts vrací false — test to hlídá; tady je jen jemnější
 * rozlišení důvodu pro UI a přehled:
 *   never_ran  žádný řádek, nebo řádek bez úspěchu i bez chyby
 *   failing    3+ chyb v řadě, nebo chyby a ještě žádný úspěch
 *   stale      poslední úspěch je starší než práh čerstvosti
 */
export function connectorHealth(
  d: Pick<ConnectorDescriptor, 'freshnessHours'>,
  state: Pick<ConnectorState, 'last_success_at' | 'consecutive_errors'> | null,
  now: number = Date.now(),
): ConnectorHealth {
  if (state === null) return 'never_ran'
  if (state.consecutive_errors >= FAILING_AFTER_ERRORS) return 'failing'
  if (state.last_success_at === null) return state.consecutive_errors > 0 ? 'failing' : 'never_ran'
  const ageMs = now - new Date(state.last_success_at).getTime()
  return ageMs > d.freshnessHours * 3_600_000 ? 'stale' : 'ok'
}
