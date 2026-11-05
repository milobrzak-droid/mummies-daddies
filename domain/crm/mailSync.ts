// Outlook sync metadat pošty → mail_event → last_inbound_at / last_outbound_at
// (docs/PROVOZ.md, kapitola 8).
//
// Tady je veškerá logika; route app/api/cron/outlook-mail je jen tenká slupka,
// která sem vstříkne Graph (fetch stránky) a DB (adaptér). Díky tomu se celý
// stavový automat testuje bez sítě a bez Supabase (test/mail-sync*.test.ts).
//
// Průběh jedné složky (Inbox / Odeslané):
//   kurzor chybí          → začni od mailDeltaStartUrl (phase 'initial'); s oknem
//                           `initialDays` jen zprávy z posledních N dní, nejnovější první
//   stránka s nextLink    → zapiš události, POTOM ulož {phase:'paging', link}
//   stránka s deltaLink   → zapiš události, POTOM ulož {phase:'delta', link}; hotovo
//   429/503               → počkej Retry-After, jen když se to vejde do rozpočtu;
//                           jinak skonči (kurzor = poslední zapsaná stránka)
//   410 / syncStateNotFound → smaž kurzor, zapiš chybu konektoru, jednou znovu od začátku
//   403 (token bez Mail.Read) → zapiš srozumitelnou chybu u obou složek a skonči;
//                           žádné opakování ani resync — pomůže jen nové připojení
//
// Složky se dělí o limit stránek a času FÉROVĚ (každá smí spotřebovat svůj
// podíl zbývajícího, nevyužité se přenáší dál). Dřív dostala první složka
// všechno: první načtení historie Doručené (tisíce zpráv) spolklo denní
// limit 20 stránek a Odeslaná se týdny nedostala na řadu — bez jediné stopy.
// Výjimka uvnitř jedné složky se zapíše jako její chyba a druhá se dojede.
//
// První načtení historie je omezené na okno posledních `initialDays` dní
// (env MAIL_SYNC_INITIAL_DAYS, výchozí 120; 0 = bez omezení). Starší pošta se
// nenačítá. Kurzor si při stránkování nese začátek okna (`since`), nejstarší
// dosud načtené datum (`reached`) a počet běhů (`runs`) — z toho Stav zdrojů
// (mailSyncProgress.ts) ukáže postup a odhad zbývajících běhů. Kurzor je jen
// text v connector_state.cursor, žádná migrace.
//
// Na konci každého běhu (i neúspěšného) se volá purge_unmatched_mail_events
// (0041): nespárované řádky (unknown/ambiguous) se drží 30 dní.
//
// Soukromí: token má od 28. 9. 2026 Mail.Read (plný obsah), ale sync dál
// čte a ukládá JEN metadata. Mail.Read otevírá budoucí klasifikaci odpovědí;
// ta potřebuje vlastní návrh s ochranou proti prompt injection a sem nepatří.
//
// Evidence (core/evidence.ts, docs/PROVOZ.md kapitola 3 + 8): pro
// každou SPÁROVANOU (matched) událost, obě strany, se po zapsání stránky
// zavolá recordEvidence(source_kind='email_message', source_id=
// internetMessageId, web_link=msg.webLink — jen když je https a míří na
// outlook.office.com/outlook.office365.com, jinak se vynechá). Je to jen
// ukazatel na zprávu, ne obsah. mail_event nemá (a podle 0041 nedostává)
// sloupec s evidence_id — spojení je přes shodný internet_message_id mezi
// mail_event a evidence.source_id (source_kind='email_message'), dohledatelné
// při čtení, žádná nová migrace. Zápis evidence je best-effort: dávkově po
// stránce, nikdy nezhatí ani výrazně nezpomalí sync (chyba se jen zaloguje
// na straně volajícího, viz app/api/cron/outlook-mail/route.ts).
//
// Kurzor se ukládá až po zapsání stránky: když běh spadne uprostřed, další
// běh stránku zopakuje a unikátní (internet_message_id, direction) duplicitu
// tiše zahodí. apply_mail_event_to_account je monotónní (GREATEST), takže
// opakované volání nevadí — proto ho voláme pro všechny spárované zprávy
// stránky, nejen nově vložené (jinak by pád mezi insertem a apply dal ztrátu).

import {
  isGraphLink,
  mailDeltaStartUrl,
  type GraphMailMessage,
  type MailDeltaResult,
  type MailFolder,
} from '@/connectors/graph'
import { matchMail, OUR_DOMAIN, type MailAlias, type MailContact, type MailDirection } from '@/domain/crm/mailMatch'
import { intakeCandidateFromMessage, type IntakeCandidate } from '@/domain/crm/autoIntake'

// ---------------------------------------------------------------------------
// Složky a kurzor

export type FolderKey = 'inbox' | 'sent'

export const FOLDERS: Record<FolderKey, { connector: string; graphFolder: MailFolder; direction: MailDirection }> = {
  inbox: { connector: 'outlook:inbox', graphFolder: 'inbox', direction: 'inbound' },
  sent: { connector: 'outlook:sent', graphFolder: 'sentitems', direction: 'outbound' },
}

export type CursorPhase = 'paging' | 'delta'
export type MailCursor = {
  phase: CursorPhase
  link: string
  /** Začátek okna prvního načtení (ISO). Chybí u kurzorů z doby před oknem a při načtení bez omezení. */
  since?: string
  /** Nejstarší dosud načtené datum zprávy (ISO), jen ve fázi paging. */
  reached?: string
  /** Kolik běhů první načtení už posunulo, jen ve fázi paging. */
  runs?: number
}

function isoOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined
}

/** Rozbitý nebo cizí kurzor = žádný kurzor (začne se znovu, duplicity odfiltruje DB). */
export function parseCursor(raw: string | null | undefined): MailCursor | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { phase?: unknown; link?: unknown; since?: unknown; reached?: unknown; runs?: unknown }
    if ((v.phase === 'paging' || v.phase === 'delta') && isGraphLink(v.link)) {
      const since = isoOrUndefined(v.since)
      const reached = isoOrUndefined(v.reached)
      const runs = typeof v.runs === 'number' && Number.isInteger(v.runs) && v.runs >= 0 ? v.runs : undefined
      return {
        phase: v.phase,
        link: v.link,
        ...(since ? { since } : {}),
        ...(reached ? { reached } : {}),
        ...(runs !== undefined ? { runs } : {}),
      }
    }
  } catch {
    /* neplatný JSON */
  }
  return null
}

export function serializeCursor(c: MailCursor): string {
  return JSON.stringify({ phase: c.phase, link: c.link, since: c.since, reached: c.reached, runs: c.runs })
}

/** Co po zapsané stránce: další kurzor a jestli je složka pro tenhle běh hotová. */
export function nextCursorAfterPage(
  page: { nextLink: string | null; deltaLink: string | null },
): { cursor: MailCursor; done: boolean } | null {
  if (page.nextLink) return { cursor: { phase: 'paging', link: page.nextLink }, done: false }
  if (page.deltaLink) return { cursor: { phase: 'delta', link: page.deltaLink }, done: true }
  return null // Graph neposlal ani jedno — kurzor neposouváme
}

// ---------------------------------------------------------------------------
// Rozhodnutí o čekání na throttling

export type RetryDecision = { action: 'wait'; waitMs: number } | { action: 'stop'; reason: string }

export function decideThrottle(opts: {
  retryAfterSeconds: number
  attempt: number
  maxAttempts: number
  remainingMs: number
  maxWaitMs: number
}): RetryDecision {
  if (opts.attempt >= opts.maxAttempts) return { action: 'stop', reason: 'throttled: vyčerpány pokusy' }
  const waitMs = Math.max(0, opts.retryAfterSeconds) * 1000
  if (waitMs > opts.maxWaitMs) return { action: 'stop', reason: 'throttled: Retry-After příliš dlouhé' }
  // Po čekání musí zbýt čas aspoň na jeden požadavek.
  if (waitMs + REQUEST_RESERVE_MS > opts.remainingMs) return { action: 'stop', reason: 'throttled: nevejde se do rozpočtu' }
  return { action: 'wait', waitMs }
}

// Rezerva na jeden požadavek = timeout fetch v connectors/graph/mail.ts.
export const REQUEST_RESERVE_MS = 15_000

// ---------------------------------------------------------------------------
// Zpráva → událost

export type MailEventRow = {
  internet_message_id: string
  direction: MailDirection
  occurred_at: string
  account_id: number | null
  contact_id: number | null
  match_status: 'matched' | 'ambiguous' | 'unknown'
  counterpart_domain: string | null
}

export type SkipReason = 'removed' | 'draft' | 'no_message_id' | 'no_date' | 'internal'

export type MatchData = { contacts: MailContact[]; aliases: MailAlias[]; ourDomain?: string }

// ---------------------------------------------------------------------------
// Provenience (evidence) pro spárované zprávy

/** Vstup pro MailSyncDb.recordEvidence — jen ukazatel na zprávu, nikdy obsah. */
export type MailEvidenceRef = { internetMessageId: string; webLink: string | null }

/** Hostitelé, na které Graph webLink zpráv skutečně míří (Outlook na webu). */
const ALLOWED_WEB_LINK_HOSTS = new Set(['outlook.office.com', 'outlook.office365.com'])

/** https odkaz na povolený Outlook host, jinak null (evidence.web_link pak zůstane prázdný). */
export function sanitizeMailWebLink(webLink: string | null | undefined): string | null {
  if (typeof webLink !== 'string' || webLink === '') return null
  let u: URL
  try {
    u = new URL(webLink)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !ALLOWED_WEB_LINK_HOSTS.has(u.hostname)) return null
  return webLink
}

const DAY_MS = 86_400_000

/** Začátek okna: teď minus N dní, na celé sekundy (ISO). */
export function windowStart(nowMs: number, days: number): string {
  return new Date(Math.floor((nowMs - days * DAY_MS) / 1000) * 1000).toISOString()
}

/** Nejstarší datum zprávy na stránce (včetně přeskočených) — postup stránkování od nejnovějších. */
function oldestDate(messages: readonly GraphMailMessage[]): string | undefined {
  let best: number | null = null
  for (const m of messages) {
    const t = Date.parse(m.receivedDateTime ?? m.sentDateTime ?? '')
    if (Number.isFinite(t) && (best === null || t < best)) best = t
  }
  return best === null ? undefined : new Date(best).toISOString()
}

function olderOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) < Date.parse(a) ? b : a
}

function addr(r: { emailAddress?: { address?: string | null } | null } | null | undefined): string | null {
  const a = r?.emailAddress?.address
  return typeof a === 'string' && a.includes('@') ? a : null
}

/**
 * Metadata zprávy → řádek mail_event, nebo důvod přeskočení. Řádek se
 * skládá nově — ze zprávy se nepřenáší nic mimo vyjmenovaná pole, takže
 * předmět ani tělo se sem nedostanou, ani kdyby je Graph vrátil.
 */
export function messageToEvent(
  msg: GraphMailMessage,
  direction: MailDirection,
  match: MatchData,
): { row: MailEventRow } | { skip: SkipReason } {
  if (msg['@removed'] !== undefined) return { skip: 'removed' }
  if (msg.isDraft) return { skip: 'draft' }
  const mid = typeof msg.internetMessageId === 'string' ? msg.internetMessageId.trim() : ''
  if (!mid) return { skip: 'no_message_id' }
  const when = direction === 'inbound' ? msg.receivedDateTime : (msg.sentDateTime ?? msg.receivedDateTime)
  if (!when || !Number.isFinite(Date.parse(when))) return { skip: 'no_date' }

  const counterparts =
    direction === 'inbound'
      ? [addr(msg.from)].filter((a): a is string => !!a)
      : [...(msg.toRecipients ?? []), ...(msg.ccRecipients ?? [])].map(addr).filter((a): a is string => !!a)

  const res = matchMail({
    direction,
    counterparts,
    contacts: match.contacts,
    aliases: match.aliases,
    ourDomain: match.ourDomain ?? OUR_DOMAIN,
  })
  if (res.status === 'internal') return { skip: 'internal' }

  const base = { internet_message_id: mid, direction, occurred_at: new Date(when).toISOString() }
  if (res.status === 'matched') {
    return { row: { ...base, account_id: res.account_id, contact_id: res.contact_id, match_status: 'matched', counterpart_domain: null } }
  }
  return {
    row: { ...base, account_id: null, contact_id: null, match_status: res.status, counterpart_domain: res.counterpart_domain },
  }
}

/** Nejnovější čas pro každou dvojici (firma, směr) — méně RPC volání. */
export function accountUpdates(rows: MailEventRow[]): { account_id: number; direction: MailDirection; occurred_at: string }[] {
  const best = new Map<string, { account_id: number; direction: MailDirection; occurred_at: string }>()
  for (const r of rows) {
    if (r.match_status !== 'matched' || r.account_id == null) continue
    const key = `${r.account_id}:${r.direction}`
    const cur = best.get(key)
    if (!cur || Date.parse(r.occurred_at) > Date.parse(cur.occurred_at)) {
      best.set(key, { account_id: r.account_id, direction: r.direction, occurred_at: r.occurred_at })
    }
  }
  return [...best.values()]
}

// ---------------------------------------------------------------------------
// Přístupový token (service RPC z 0041)

export type StoredToken = { access_token: string | null; refresh_token: string | null; expires_at: string | null }

export interface TokenDeps {
  load(): Promise<StoredToken | null>
  refresh(refreshToken: string): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null>
  save(t: { access_token: string; refresh_token: string; expires_at: string }): Promise<boolean>
  now(): number
}

/** Platný token, nebo výjimka s krátkou chybou (runJob ji zapíše jako 'failed'). */
export async function resolveAccessToken(deps: TokenDeps, skewMs = 60_000): Promise<string> {
  const t = await deps.load()
  if (!t?.access_token || !t.refresh_token) throw new Error('Outlook není pro sync připojený')
  if (t.expires_at && Date.parse(t.expires_at) - skewMs > deps.now()) return t.access_token
  const r = await deps.refresh(t.refresh_token)
  if (!r) throw new Error('Obnova tokenu selhala — znovu připojte Outlook v Nastavení (token musí mít i Mail.Read)')
  const saved = await deps.save({
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: new Date(deps.now() + r.expires_in * 1000).toISOString(),
  })
  // Rotovaný refresh token, který se neuložil, by příště skončil na invalid_grant.
  if (!saved) throw new Error('Obnovený token se nepodařilo uložit')
  return r.access_token
}

// ---------------------------------------------------------------------------
// Běh syncu

/** Text chyby konektoru, když token nemá právo na poštu. Čte ho člověk v Nastavení. */
export const MISSING_SCOPE_ERROR =
  'Chybí oprávnění Mail.Read — znovu připojte Outlook v Nastavení (Odpojit → Připojit Outlook)'

export interface MailSyncDb {
  loadCursor(connector: string): Promise<string | null>
  /** Uloží jen kurzor (null = smazat); nesahá na stav chyb. */
  saveCursor(connector: string, cursor: string | null): Promise<void>
  recordSuccess(connector: string, cursor: string | null): Promise<void>
  recordError(connector: string, error: string): Promise<void>
  loadMatchData(): Promise<MatchData>
  /** Vloží řádky, duplicity (internet_message_id, direction) ignoruje. Vrací počet vložených. */
  insertEvents(rows: MailEventRow[]): Promise<number>
  applyToAccount(accountId: number, direction: MailDirection, occurredAt: string): Promise<void>
  /** purge_unmatched_mail_events (0041, výchozí 30 dní). Vrací počet smazaných řádků. */
  purgeUnmatchedEvents(): Promise<number>
  /**
   * core/evidence.ts recordEvidence pro spárované zprávy stránky (dávkově).
   * Best-effort — implementace NESMÍ vyhodit výjimku ven (viz route.ts:
   * chyby jen loguje), runMailSync navíc volání i tak obalí try/catch, ať
   * to nikdy nestrhne sync ani nezastaví kurzor.
   */
  recordEvidence(refs: MailEvidenceRef[]): Promise<void>
  /**
   * Zapíše jen čas pokusu o synchronizaci složky (connector_state.updated_at)
   * — bez kurzoru, úspěchu a chyby. Volá se, když složka v běhu nedošla do
   * cíle (limit stránek/času, throttling, nezačala), aby Stav zdrojů ukázal
   * „poslední pokus" místo holého „nikdy". Best-effort, nevyhazuje.
   */
  markAttempt?(connector: string): Promise<void>
}

/** Zapsaná stránka jedné složky — pro posluchače onPageStored. */
export type StoredMailPage = {
  folder: FolderKey
  /** Řádky, které šly do insertEvents (včetně duplicit, které DB zahodila). */
  rows: readonly MailEventRow[]
  /** Odkazy na zdroj spárovaných zpráv, přesně jak šly do recordEvidence. */
  evidence: readonly MailEvidenceRef[]
  /**
   * Kandidáti na automatické založení poptávky (domain/crm/autoIntake.ts):
   * příchozí zprávy, které sync nespároval. Jen když běh dostal
   * `collectIntake: true`. Nesou adresu a jméno odesílatele, proto žijí
   * jen v paměti běhu (nikdy v mail_event ani v evidenci) a listener je
   * nesmí zapsat nikam mimo vlastní rozhodnutí o založení.
   */
  intake?: readonly IntakeCandidate[]
}

export interface MailSyncDeps {
  fetchPage(url: string): Promise<MailDeltaResult>
  db: MailSyncDb
  sleep(ms: number): Promise<void>
  now(): number
  /**
   * Volitelný posluchač (kapitola 11): adaptér na kontrakt konektorů
   * (domain/crm/mailConnector.ts) z něj skládá normalizované události.
   * Volá se po zápisu událostí, last_*_at a evidence, PŘED uložením kurzoru.
   * Jen pozoruje — výjimku spolkne a sync pokračuje beze změny.
   */
  onPageStored?(page: StoredMailPage): void | Promise<void>
}

export type MailSyncOptions = {
  maxPages: number
  budgetMs: number
  maxThrottleAttempts: number
  maxWaitMs: number
  /** Kolikrát smí jedna složka v jednom běhu začít znovu po expiraci tokenu. */
  maxResyncs: number
  /**
   * Okno prvního načtení: jen zprávy z posledních N dní (0 = bez omezení).
   * Výchozí hodnota knihovny je 0; volající předávají mailSyncInitialDaysFromEnv
   * (env MAIL_SYNC_INITIAL_DAYS, výchozí 120). Týká se jen začátku složky —
   * rozjetý delta kurzor se nemění.
   */
  initialDays: number
  /**
   * Jen tyhle složky (výchozí obě). Webhook (domain/crm/mailWebhookRun.ts)
   * synchronizuje jen složku, ze které přišla notifikace.
   */
  folders?: FolderKey[]
  /** false = bez purge_unmatched_mail_events na konci (webhook; retenci drží denní cron). */
  purge?: boolean
  /**
   * true = z nespárovaných PŘÍCHOZÍCH zpráv se skládají kandidáti pro
   * automatické zakládání poptávek (StoredMailPage.intake). Výchozí false:
   * dokud je zakládání vypnuté, adresa ani jméno odesílatele nespárované
   * zprávy neopustí smyčku, která ze zprávy dělá metadata.
   */
  collectIntake?: boolean
}

export const DEFAULT_OPTIONS: MailSyncOptions = {
  maxPages: 20,
  budgetMs: 50_000,
  maxThrottleAttempts: 3,
  maxWaitMs: 20_000,
  maxResyncs: 1,
  initialDays: 0,
}

/** Výchozí okno prvního načtení (dny), když MAIL_SYNC_INITIAL_DAYS chybí nebo je neplatné. */
export const DEFAULT_INITIAL_DAYS = 120
const MAX_INITIAL_DAYS = 3650

/**
 * MAIL_SYNC_INITIAL_DAYS: celé číslo dní 1–3650, 0 = bez omezení (načte se
 * celá historie). Chybějící nebo nesmyslná hodnota = výchozích 120 dní —
 * překlep nesmí tiše spustit stahování celé historie.
 */
export function mailSyncInitialDaysFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.MAIL_SYNC_INITIAL_DAYS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_INITIAL_DAYS
  const n = Number(raw)
  return n <= MAX_INITIAL_DAYS ? n : DEFAULT_INITIAL_DAYS
}

export type FolderOutcome =
  | 'caught_up'
  | 'more_pending'
  | 'throttled'
  | 'expired'
  | 'error'
  | 'missing_scope'
  | 'not_started'

export type FolderStats = {
  outcome: FolderOutcome
  pages: number
  inserted: number
  matched: number
  skipped: Partial<Record<SkipReason, number>>
  resyncs: number
  error?: string
}

export type MailSyncStats = {
  pages: number
  folders: Record<FolderKey, FolderStats>
  /** Token nemá Mail.Read (Graph 403) — je potřeba znovu připojit Outlook. */
  missingScope: boolean
  /** Kolik nespárovaných řádků purge smazal; null = purge selhal (viz purgeError). */
  purged: number | null
  purgeError?: string
}

function emptyFolder(): FolderStats {
  return { outcome: 'not_started', pages: 0, inserted: 0, matched: 0, skipped: {}, resyncs: 0 }
}

export async function runMailSync(
  deps: MailSyncDeps,
  options: Partial<MailSyncOptions> = {},
): Promise<MailSyncStats> {
  const opt = { ...DEFAULT_OPTIONS, ...options }
  const start = deps.now()
  const remaining = () => opt.budgetMs - (deps.now() - start)
  const stats: MailSyncStats = {
    pages: 0,
    folders: { inbox: emptyFolder(), sent: emptyFolder() },
    missingScope: false,
    purged: null,
  }

  try {
    await syncFolders(deps, opt, stats, remaining)
  } finally {
    // Retence běží vždy, i když sync spadl — chyba purge ale běh neshodí
    // (a nepřebije případnou původní výjimku). Webhook ji vypíná (purge: false).
    if (opt.purge !== false) {
      try {
        stats.purged = await deps.db.purgeUnmatchedEvents()
      } catch (e) {
        stats.purgeError = e instanceof Error ? e.message : String(e)
      }
    }
  }
  return stats
}

/** Prefix chyby, která vznikla výjimkou uvnitř zpracování složky (zápis do DB apod.). */
export const FOLDER_FAILED_PREFIX = 'Synchronizace složky selhala:'

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Best-effort: nikdy nevyhodí (stav konektoru je jen provozní stopa). */
async function safely(fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch {
    /* stopa o pokusu nesmí shodit sync */
  }
}

async function syncFolders(
  deps: MailSyncDeps,
  opt: MailSyncOptions,
  stats: MailSyncStats,
  remaining: () => number,
): Promise<void> {
  let match: MatchData | null = null
  const getMatch = async () => (match ??= await deps.db.loadMatchData())

  const keys = opt.folders ?? (['inbox', 'sent'] as FolderKey[])
  // Výjimka jedné složky nesmí zablokovat další (dřív pád „doručené" znamenal,
  // že „odeslaná" nikdy nedostala řadu a nezanechala ani stopu). Složka
  // dostane chybu do connector_state, ostatní se dojedou a teprve pak se
  // první výjimka pošle nahoru (runJob → failed).
  let firstError: { error: unknown } | null = null

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const f = FOLDERS[key]
    const fs = stats.folders[key]
    if (stats.missingScope) {
      // Stejný token, stejný výsledek — Graph znovu nevoláme, jen chybu
      // zapíšeme i u této složky, aby ji Nastavení ukázalo u obou.
      fs.outcome = 'missing_scope'
      fs.error = MISSING_SCOPE_ERROR
      await deps.db.recordError(f.connector, MISSING_SCOPE_ERROR)
      continue
    }
    if (stats.pages >= opt.maxPages || remaining() < REQUEST_RESERVE_MS) {
      // Dřív tady byl `break` a složka zůstala úplně bez stopy (ve Stavu
      // zdrojů „nikdy"). Teď se aspoň zapíše čas pokusu; outcome zůstává not_started.
      if (deps.db.markAttempt) await safely(() => deps.db.markAttempt!(f.connector))
      continue
    }

    // Férové dělení: každá složka smí spotřebovat jen svůj podíl zbývajících
    // stránek a času, nevyužitý zbytek dostane další. Bez toho první načtení
    // historie Doručené (tisíce zpráv) spolklo celý denní limit a Odeslaná
    // nikdy nezačala.
    const left = keys.length - i
    const pageCap = stats.pages + Math.max(1, Math.ceil((opt.maxPages - stats.pages) / left))
    const usableMs = remaining() - REQUEST_RESERVE_MS
    const deadline = left > 1 ? deps.now() + usableMs / left : Number.POSITIVE_INFINITY
    const shouldStop = () => stats.pages >= pageCap || remaining() < REQUEST_RESERVE_MS || deps.now() >= deadline

    try {
      await syncOneFolder(deps, opt, stats, key, getMatch, remaining, shouldStop)
    } catch (e) {
      fs.outcome = 'error'
      fs.error = `${FOLDER_FAILED_PREFIX} ${errorMessage(e)}`
      await safely(() => deps.db.recordError(f.connector, fs.error as string))
      firstError ??= { error: e }
    }

    if (fs.outcome === 'more_pending' || fs.outcome === 'throttled') {
      if (deps.db.markAttempt) await safely(() => deps.db.markAttempt!(f.connector))
    }
  }
  if (firstError) throw firstError.error
}

async function syncOneFolder(
  deps: MailSyncDeps,
  opt: MailSyncOptions,
  stats: MailSyncStats,
  key: FolderKey,
  getMatch: () => Promise<MatchData>,
  remaining: () => number,
  shouldStop: () => boolean,
): Promise<void> {
  const f = FOLDERS[key]
  const fs = stats.folders[key]

  let cursor = parseCursor(await deps.db.loadCursor(f.connector))
  const windowed = opt.initialDays > 0
  // První načtení bez okna (kurzor z doby před oknem) se s oknem začne znovu:
  // už uložené zprávy DB zahodí jako duplicity, ale zbytek historie se přestane
  // stahovat celý. Rozjetý delta kurzor se nemění.
  if (windowed && cursor?.phase === 'paging' && !cursor.since) cursor = null

  let since: string | undefined = cursor?.since
  let reached: string | undefined = cursor?.reached
  let runs = cursor?.runs ?? 0
  let runCounted = false
  const startFresh = () => {
    since = windowed ? windowStart(deps.now(), opt.initialDays) : undefined
    reached = undefined
    runs = 0
    runCounted = false
  }
  if (!cursor) startFresh()
  let url = cursor?.link ?? mailDeltaStartUrl(f.graphFolder, since)
  let attempt = 0
  fs.outcome = 'more_pending'

  while (true) {
    if (shouldStop()) {
      fs.outcome = 'more_pending'
      break
    }
    const res = await deps.fetchPage(url)

    if (res.kind === 'throttled') {
      const d = decideThrottle({
        retryAfterSeconds: res.retryAfterSeconds,
        attempt,
        maxAttempts: opt.maxThrottleAttempts,
        remainingMs: remaining(),
        maxWaitMs: opt.maxWaitMs,
      })
      if (d.action === 'stop') {
        // Kurzor už ukazuje za poslední zapsanou stránku — nic dalšího ukládat netřeba.
        fs.outcome = 'throttled'
        fs.error = d.reason
        // Kontrakt (stateWriteFor): throttling stav nemění; stopu o pokusu
        // zapíše volající přes markAttempt.
        break
      }
      attempt++
      await deps.sleep(d.waitMs)
      continue
    }
    attempt = 0

    if (res.kind === 'expired') {
      await deps.db.saveCursor(f.connector, null)
      await deps.db.recordError(f.connector, 'delta token vypršel — kurzor smazán, nová synchronizace')
      cursor = null
      startFresh()
      if (fs.resyncs >= opt.maxResyncs) {
        fs.outcome = 'expired'
        fs.error = 'delta token vypršel'
        break
      }
      fs.resyncs++
      url = mailDeltaStartUrl(f.graphFolder, since)
      continue
    }

    if (res.kind === 'forbidden') {
      // Kurzor nechat: po novém připojení se naváže tam, kde se skončilo.
      stats.missingScope = true
      fs.outcome = 'missing_scope'
      fs.error = MISSING_SCOPE_ERROR
      await deps.db.recordError(f.connector, MISSING_SCOPE_ERROR)
      break
    }

    if (res.kind === 'error') {
      fs.outcome = 'error'
      fs.error = res.message
      await deps.db.recordError(f.connector, res.message)
      break
    }

    // Stránka: nejdřív zapsat události, teprve pak posunout kurzor.
    const m = await getMatch()
    reached = olderOf(reached, oldestDate(res.messages))
    const rows: MailEventRow[] = []
    const evidenceRefs: MailEvidenceRef[] = []
    const intake: IntakeCandidate[] = []
    for (const msg of res.messages) {
      const r = messageToEvent(msg, f.direction, m)
      if ('skip' in r) {
        fs.skipped[r.skip] = (fs.skipped[r.skip] ?? 0) + 1
        continue
      }
      rows.push(r.row)
      if (r.row.match_status === 'matched') {
        evidenceRefs.push({ internetMessageId: r.row.internet_message_id, webLink: sanitizeMailWebLink(msg.webLink) })
      } else if (
        opt.collectIntake &&
        f.direction === 'inbound' &&
        (r.row.match_status === 'ambiguous' || r.row.counterpart_domain !== null)
      ) {
        // Kandidát na automatické založení poptávky: firemní doména, kterou
        // neznáme, nebo doména patřící víc firmám. Bez firemní domény (freemail)
        // se nevytváří vůbec.
        const cand = intakeCandidateFromMessage(msg, r.row.match_status === 'ambiguous' ? 'ambiguous' : 'unknown', sanitizeMailWebLink(msg.webLink))
        if (cand) intake.push(cand)
      }
    }
    if (rows.length > 0) fs.inserted += await deps.db.insertEvents(rows)
    for (const u of accountUpdates(rows)) await deps.db.applyToAccount(u.account_id, u.direction, u.occurred_at)
    fs.matched += rows.filter((r) => r.match_status === 'matched').length
    if (evidenceRefs.length > 0) {
      // Provenience je pozorovací vrstva, ne kritická cesta: selhání se
      // nikam nezapisuje jako chyba syncu a kurzor posouvá dál normálně.
      try {
        await deps.db.recordEvidence(evidenceRefs)
      } catch {
        /* best-effort — viz komentář u MailSyncDb.recordEvidence */
      }
    }
    if (deps.onPageStored) {
      try {
        await deps.onPageStored({ folder: key, rows, evidence: evidenceRefs, ...(intake.length > 0 ? { intake } : {}) })
      } catch {
        /* posluchač jen pozoruje; sync ani kurzor na něm nezávisí */
      }
    }
    fs.pages++
    stats.pages++

    const next = nextCursorAfterPage(res)
    if (!next) {
      fs.outcome = 'error'
      fs.error = 'Graph nevrátil nextLink ani deltaLink'
      await deps.db.recordError(f.connector, fs.error)
      break
    }
    if (!runCounted) {
      runs++
      runCounted = true
    }
    cursor = next.done
      ? { ...next.cursor, ...(since ? { since } : {}) }
      : { ...next.cursor, ...(since ? { since } : {}), ...(reached ? { reached } : {}), runs }
    await deps.db.saveCursor(f.connector, serializeCursor(cursor))
    if (next.done) {
      fs.outcome = 'caught_up'
      await deps.db.recordSuccess(f.connector, serializeCursor(cursor))
      break
    }
    url = cursor.link
  }
}
