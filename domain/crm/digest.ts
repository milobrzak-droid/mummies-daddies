// Obsah týdenního přehledu (pondělí/pátek) — jen skládání textu z dat,
// které už spočítaly existující čisté funkce (domain/crm/followUp.ts, domain/crm/outreach.ts).
//
// Záměrně žádné I/O, žádný createAdminClient/createClient. Volající si data
// natáhne z DB a předá sem hotová pole — díky tomu jde tahle logika testovat
// bez databáze, stejně jako dueFollowUps a dueForOutreach.
//
// Co tenhle soubor NENÍ: cron, e-mailová šablona, ani nic, co něco odesílá.
// Odesílání (po/pá přehled týdne, ostatní dny ranní souhrn) řeší
// domain/crm/digestDelivery.ts. Tady se jen odpovídá na otázku:
// "kdyby se tahle funkce spustila v libovolné pondělí, jaký český text by
// vznikl?" Ranní souhrn je stejný digest bez sekce „Firmy k oslovení"
// (volající předá outreach: []).
//
// Rozsah je záměrně jen AKTUÁLNÍ STAV (co je teď po termínu / teď potichu /
// teď blokované) — ne delta oproti minulému týdnu. Na to zatím neexistuje
// tabulka změn (audit_event teprve vzniká v jiné větvi práce a nebude mít
// data), takže "co se v pipeline hnulo" tenhle soubor neřeší.

import type { Nudge } from '@/domain/crm/followUp'
import type { OutreachCandidate } from '@/domain/crm/outreach'
import { isStale, type ConnectorState } from '@/core/connectorState'
import { formatDate } from '@/lib/format'
import type { MailWebhookHealth } from '@/domain/crm/mailWebhook'
import { jobHealthStatus, type JobHealth } from '@/domain/crm/jobHealth'
import { oauthHealthStatus, type OAuthHealth } from '@/lib/oauthOverview'

export type BlockedDeal = {
  id: number
  account_id: number | null
  title: string
  account_name: string | null
  status_blocker: string
}

// Follow-up pro digest = Nudge + account_id (kvůli odkazu na detail obchodu
// /clients/{account_id}/deals/{deal_id}). Na text řádku nemá vliv.
export type DigestFollowUp = Nudge & { account_id: number | null }

// Stav zdrojů: graph_calendar (Outlook kalendář/úkoly) si vede vlastní
// connector_state (viz core/connectorState.ts). Zápisy schůzek z Wispr Flow
// žádný konektor nemají (Wispr Flow nemá API, zápis přenáší člověk přes
// Cowork skill a MCP) — jejich "čerstvost" je proto čas posledního zápisu
// schůzky přes skill (viz domain/crm/queries/meetingNotes.ts). Fireflies je
// od 2026-09-28 zrušený. Volající (domain/crm/queries/digest.ts,
// domain/crm/digestDelivery.ts) natáhne hodnoty (vč. OUTLOOK_MAIL_SYNC_ENABLED
// z env) a předá je sem hotové — buildDigest zůstává bez I/O.
//
// Outlook pošta (mailSync.ts): dva konektory, 'outlook:inbox' a
// 'outlook:sent' (domain/crm/mailSync.ts, FOLDERS). Digest je zobrazuje jako
// jeden řádek — starší z obou last_success_at, ať se ticho jedné složky
// neschová za čerstvost druhé. Sync je denní cron (viz docs/PROVOZ.md), práh
// je proto 36 h (o něco víc než 24 h, ať jednorázové zpoždění běhu cronu
// samo o sobě neukazuje "zastaralé"). Když je OUTLOOK_MAIL_SYNC_ENABLED
// vypnuté, řádek hlásí "vypnuto" místo posledního běhu.
//
// Odesílání přehledu (graph_send, core/connectorState.ts): jen informativní
// řádek s časem posledního úspěšného odeslání — bez prahu na "zastaralé".
// Přehled se posílá jen po/pá vždy a jinak jen když je co hlásit, takže
// "dlouho neodesláno" samo o sobě nic neznamená (klidně to byl týden ticha).
export type DigestConnectorStates = {
  graphCalendar: ConnectorState | null
  outlookMailInbox: ConnectorState | null
  outlookMailSent: ConnectorState | null
  graphSend: ConnectorState | null
}

/**
 * Zápisy schůzek přijaté z diktátu (Wispr Flow → /api/ingest/meeting-notes,
 * migrace 0078). Volitelné: bez nich (starší volání, nenasazená 0078) se
 * řádek zdroje vypisuje po starém.
 */
export type MeetingIntakeSummary = {
  /** Zápisů přijatých za posledních 30 dní. */
  received30d: number
  /** Zápisů čekajících na ruční přiřazení. */
  unmatched: number
}

export type DigestInput = {
  followUps: DigestFollowUp[]
  outreach: OutreachCandidate[]
  blockedDeals: BlockedDeal[]
  connectorStates: DigestConnectorStates
  /**
   * Kdy naposledy přišel zápis schůzky (skill/MCP: created_at aktivity;
   * diktát: received_at příjmu — vyšší z nich), nebo null.
   */
  lastMeetingNoteAt: string | null
  /** Počty z příjmu diktátu; null/vynecháno = řádek po starém. */
  meetingIntake?: MeetingIntakeSummary | null
  /** OUTLOOK_MAIL_SYNC_ENABLED === 'true' (čte volající, buildDigest zůstává bez I/O). */
  outlookMailSyncEnabled: boolean
  /**
   * Webhook pošty (graph_subscription, domain/crm/mailWebhook.ts
   * assessMailWebhook). Volitelné: bez něj se řádek nevypisuje (starší
   * volání a testy); loadery ho posílají vždy.
   */
  mailWebhook?: MailWebhookHealth
  /**
   * Stav plánovaných úloh (job_run, domain/crm/jobHealth.ts). Volitelné: bez
   * něj (nebo null = nešlo přečíst) se řádek nevypisuje. Selhání nebo visící
   * běh z posledních 26 h spustí ranní souhrn.
   */
  jobHealth?: JobHealth | null
  /**
   * Konektor Claude za 24 h (lib/oauthOverview.ts): zrušené připojení nebo
   * opakované 401 u platného připojení. Řádek jen při problému — a ten
   * spustí ranní souhrn. Volitelné jako jobHealth.
   */
  oauthHealth?: OAuthHealth | null
  generatedAt: Date
}

/** Čistá funkce (žádné I/O): přepínač syncu pošty z env proměnné. */
export function outlookMailSyncEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.OUTLOOK_MAIL_SYNC_ENABLED === 'true'
}

export type DigestSection = {
  title: string
  lines: string[]
  /**
   * Sekce oříznutá na SECTION_LIMITS: kolik položek se nevypsalo a kde je
   * celý seznam (cesta v Cockpitu). Text řádku dává moreLine().
   */
  more?: { hidden: number; path: string }
}

// Strop položek na sekci. Po importu z Radaru má „Firmy k oslovení" stovky
// řádků (548 v produkci) — celý seznam v e-mailu i na /prehled-tydne je
// nečitelný. Pořadí se tu NEMĚNÍ: dueForOutreach řadí podle days_silent
// sestupně, dueFollowUps podle days_overdue sestupně, blokované obchody
// přicházejí seřazené z dotazu — takže se ukáže prvních N nejnaléhavějších.
// (Přeřazení tady by rozbilo párování řádků s odkazy v digestEmail.ts.)
// Počty v headline zůstávají CELKOVÉ.
export const SECTION_LIMITS = { followUps: 25, outreach: 15, blockedDeals: 25 } as const

// Kde je celý seznam: fronta oslovování má vlastní stránku; follow-upy
// a blokery jsou vidět u obchodů v pipeline.
export const SECTION_FULL_LIST_PATHS = {
  followUps: '/cockpit/pipeline',
  outreach: '/cockpit/oslovovani',
  blockedDeals: '/cockpit/pipeline',
} as const

/** Poslední řádek oříznuté sekce. */
export function moreLine(hidden: number): string {
  return `… a dalších ${hidden} — celý seznam v Cockpitu`
}

/** Celkový počet položek sekce (vypsané + skryté). */
export function sectionTotal(section: DigestSection): number {
  return section.lines.length + (section.more?.hidden ?? 0)
}

function cappedSection<T>(title: string, items: T[], limit: number, path: string, line: (item: T) => string): DigestSection {
  const shown = items.slice(0, limit)
  const hidden = items.length - shown.length
  return { title, lines: shown.map(line), ...(hidden > 0 ? { more: { hidden, path } } : {}) }
}

export type Digest = {
  headline: string
  sections: DigestSection[]
  isEmpty: boolean
  generatedAt: Date
  // Na rozdíl od `sections` tahle sekce existuje VŽDY, i pro prázdný digest —
  // viz komentář u jejího sestavení v buildDigest.
  sources: DigestSection
  /**
   * Kolik zdrojů ve „Stavu zdrojů" potřebuje pozornost: poslední běh skončil
   * chybou (consecutive_errors > 0), nebo je zastaralý zdroj, který běží sám
   * (sync pošty). Zastaralý kalendář (synchronizace na kliknutí) a zápisy
   * schůzek (přenáší člověk) se jen zobrazí, nepočítají se.
   * Vypnutý sync pošty se nepočítá. Ranní souhrn se kvůli tomu posílá i bez
   * jiného obsahu — rozbitý zdroj nesmí zapadnout (isEmpty se tím nemění).
   */
  sourceAlerts: number
}

function followUpLine(n: Nudge): string {
  const who = n.account_name ?? 'Bez klienta'
  const escalated = n.level === 'manager' ? ' (eskalováno)' : ''
  return `${who} — ${n.title} — ${n.days_overdue} dní po termínu${escalated}`
}

function outreachLine(o: OutreachCandidate): string {
  // Firma, kde s oslovením nesouhlasí jen někdo (0087 / poznámka): ať se
  // neosloví zrovna ten člověk.
  const optOut = o.opt_out && o.opt_out.opted_out > 0
    ? ` — ${o.opt_out.opted_out} z ${o.opt_out.total} lidí nesouhlasí s oslovením`
    : ''
  return `${o.name} — ticho ${o.days_silent} dní${optOut}`
}

function blockedLine(b: BlockedDeal): string {
  const who = b.account_name ?? 'Bez klienta'
  return `${who} — ${b.title} — ${b.status_blocker}`
}

// Práh pro Outlook záměrně KOPÍRUJE stránku Nastavení
// (app/cockpit/nastaveni/page.tsx, 24×7 h — Outlook sync běží nárazově, ne
// denně), ať Cockpit o stejném konektoru netvrdí na dvou místech dvě různé
// věci. Zápisy schůzek: 7 dní — týden bez jediného zápisu znamená, že se
// schůzky buď nekonaly, nebo se zápisy přes skill přestaly přenášet.
const MEETING_NOTES_STALE_AFTER_HOURS = 24 * 7
const GRAPH_CALENDAR_STALE_AFTER_HOURS = 24 * 7

// Outlook pošta (outlook:inbox / outlook:sent, domain/crm/mailSync.ts): cron
// je denní (docs/PROVOZ.md), práh je proto 36 h — o něco víc než 24 h, ať
// obyčejné zpoždění jednoho běhu samo o sobě neukazuje "zastaralé".
const OUTLOOK_MAIL_STALE_AFTER_HOURS = 36

// Řádek zdroje + příznak, jestli potřebuje pozornost (počítá se do
// Digest.sourceAlerts).
type SourceStatus = { line: string; alert: boolean }

// Text poslední chyby konektoru do přehledu: jeden řádek, zkrácený. Chyby
// konektorů jsou už na zápisu očištěné (bez tajemství, viz
// connectors/graph/send.ts) — a přehled jde jen obchodním rolím týmu.
const ERROR_TEXT_MAX = 160

function hasError(state: ConnectorState | null): boolean {
  return (state?.consecutive_errors ?? 0) > 0
}

function errorSuffix(state: ConnectorState | null): string {
  if (!hasError(state)) return ''
  const text = (state?.last_error ?? '').replace(/\s+/g, ' ').trim()
  const short = text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX - 1)}…` : text
  return short ? ` — chyba: ${short}` : ' — chyba'
}

// staleAlerts: jestli se „zastaralé" počítá do sourceAlerts (a tím spouští
// ranní souhrn). Jen u zdrojů, které běží SAMY (sync pošty je denní cron) —
// tam ticho znamená poruchu. Kalendář se synchronizuje na kliknutí, takže
// týden bez použití není porucha; kdyby se počítal, ranní souhrn by chodil
// každý den jen kvůli tomu. Chyba posledního běhu se počítá vždy.
function sourceStatus(label: string, state: ConnectorState | null, maxAgeHours: number, errorState: ConnectorState | null = state, staleAlerts = true): SourceStatus {
  const when = state?.last_success_at ? formatDate(state.last_success_at) : 'nikdy'
  const stale = isStale(state, maxAgeHours)
  return {
    line: `${label}: ${when}${stale ? ' — zastaralé' : ''}${errorSuffix(errorState)}`,
    alert: (staleAlerts && stale) || hasError(errorState),
  }
}

// Starší (méně čerstvý) ze dvou stavů konektoru; null (nikdy neuspěl) je
// vždy "starší" než jakýkoli skutečný úspěch — jedna mlčící složka nesmí
// schovat čerstvost druhé.
function olderConnectorState(a: ConnectorState | null, b: ConnectorState | null): ConnectorState | null {
  if (!a || !b) return null
  const at = a.last_success_at ? new Date(a.last_success_at).getTime() : -Infinity
  const bt = b.last_success_at ? new Date(b.last_success_at).getTime() : -Infinity
  return at <= bt ? a : b
}

function outlookMailStatus(inbox: ConnectorState | null, sent: ConnectorState | null, enabled: boolean): SourceStatus {
  const label = 'Outlook pošta (příjem a odeslání)'
  if (!enabled) return { line: `${label}: vypnuto`, alert: false }
  // Chyba kterékoli složky se hlásí, i když druhá běží.
  const errored = [inbox, sent].find(hasError) ?? null
  return sourceStatus(label, olderConnectorState(inbox, sent), OUTLOOK_MAIL_STALE_AFTER_HOURS, errored)
}

// Bez prahu na "zastaralé" — po/pá přehled odchází vždy, jinak jen když je
// co hlásit, takže dlouhá pauza mezi odesláními sama o sobě nic neznamená.
// Selhání posledního odeslání se ale hlásí (a ranní souhrn kvůli němu
// odejde, ať se o něm někdo dozví).
function graphSendStatus(state: ConnectorState | null): SourceStatus {
  const when = state?.last_success_at ? formatDate(state.last_success_at) : 'nikdy'
  return { line: `Odesílání přehledu (graph_send): ${when}${errorSuffix(state)}`, alert: hasError(state) }
}

// Webhook pošty (okamžité notifikace z Outlooku, kapitola 8). Rozbitý =
// chybí/vypršelo předplatné nebo chyba při jeho obnově — počítá se jako
// zdroj, který potřebuje pozornost (běží sám, takže porucha = alert a ranní
// souhrn kvůli ní odejde). Ticho bez notifikací samo o sobě chyba není (noc,
// víkend); pojistkou je denní delta sync s vlastním řádkem výše.
function mailWebhookStatus(h: MailWebhookHealth): SourceStatus {
  const label = 'Outlook pošta — okamžité notifikace (webhook)'
  if (!h.enabled) return { line: `${label}: vypnuto`, alert: false }
  if (h.migrationMissing) return { line: `${label}: nefunguje — chyba: chybí migrace 0066 (graph_subscription)`, alert: true }
  const last = h.lastNotificationAt ? formatDate(h.lastNotificationAt) : 'nikdy'
  const until = h.expiresAt ? `, předplatné do ${formatDate(h.expiresAt)}` : ''
  const problems = h.problems.join('; ')
  const short = problems.length > ERROR_TEXT_MAX ? `${problems.slice(0, ERROR_TEXT_MAX - 1)}…` : problems
  return {
    line: `${label}: poslední notifikace ${last}${until}${h.broken ? ` — chyba: ${short || 'nefunguje'}` : ''}`,
    alert: h.broken,
  }
}

// Zápisy schůzek přenáší člověk (skill + MCP), žádný konektor tu nemůže
// „spadnout". „Zastaralé" se proto ukáže v po/pá přehledu, ale nespouští
// ranní souhrn — jinak by chodil denně v každém týdnu bez schůzek.
function meetingNotesStatus(lastAt: string | null, now: Date, intake?: MeetingIntakeSummary | null): SourceStatus {
  const label = intake ? 'Wispr Flow (zápisy schůzek): poslední zápis' : 'Wispr Flow (zápisy schůzek přes skill): poslední zápis'
  // S příjmem diktátu se k času připojí počty: kolik zápisů za 30 dní a kolik
  // čeká na ruční přiřazení (fronta /schuzky/nesparovane). Čekající zápis
  // ranní souhrn nespouští (alert false) — je vidět tady i v Nastavení.
  const counts = intake
    ? ` · za 30 dní ${intake.received30d} · čekají na přiřazení ${intake.unmatched}`
    : ''
  if (!lastAt) return { line: `${label} nikdy — zastaralé${counts}`, alert: false }
  const t = new Date(lastAt).getTime()
  const stale = Number.isNaN(t) || now.getTime() - t > MEETING_NOTES_STALE_AFTER_HOURS * 3_600_000
  return { line: `${label} ${formatDate(lastAt)}${stale ? ' — zastaralé' : ''}${counts}`, alert: false }
}

// Headline schválně obchází českou číslovkovou shodu (1 follow-up / 2-4
// follow-upy / 5+ follow-upů) tvarem "Kategorie: N" — je to jednoznačné,
// gramaticky vždy správné a nevyžaduje logiku navíc jen kvůli plurálu.
function headlineClause(label: string, count: number): string | null {
  if (count === 0) return null
  return `${label}: ${count}`
}

export function buildDigest(input: DigestInput): Digest {
  const { followUps, outreach, blockedDeals, connectorStates, lastMeetingNoteAt, outlookMailSyncEnabled, generatedAt } = input

  const isEmpty = followUps.length === 0 && outreach.length === 0 && blockedDeals.length === 0

  // Sekce se stavějí jen pro kategorie, které mají obsah. Kategorie s nulou
  // položek NEDOSTANE sekci s nadpisem a prázdným tělem — prázdný nadpis
  // "Firmy k oslovení" bez jediného řádku je přesně ten šum, kterému se má
  // celý návrh (ticho musí něco znamenat) vyhnout. Kdyby se tohle "zjednodušilo"
  // na vždy tři sekce, digest by každý týden nesl balast i beze změny.
  const sections: DigestSection[] = []

  if (followUps.length > 0) {
    sections.push(cappedSection('Follow-upy po termínu', followUps, SECTION_LIMITS.followUps, SECTION_FULL_LIST_PATHS.followUps, followUpLine))
  }
  if (outreach.length > 0) {
    sections.push(cappedSection('Firmy k oslovení', outreach, SECTION_LIMITS.outreach, SECTION_FULL_LIST_PATHS.outreach, outreachLine))
  }
  if (blockedDeals.length > 0) {
    sections.push(cappedSection('Blokované obchody', blockedDeals, SECTION_LIMITS.blockedDeals, SECTION_FULL_LIST_PATHS.blockedDeals, blockedLine))
  }

  const clauses = [
    headlineClause('Follow-upy po termínu', followUps.length),
    headlineClause('Firmy k oslovení', outreach.length),
    headlineClause('Blokované obchody', blockedDeals.length),
  ].filter((c): c is string => c !== null)

  const headline = isEmpty ? 'Nic k řešení.' : `${clauses.join(', ')}.`

  // Stav zdrojů NENÍ jedna z kategorií výše — má se zobrazovat i pro jinak
  // prázdný digest (isEmpty === true). Cílová architektura (viz
  // docs/PROVOZ.md, kapitola "Týdenní rytmus": "Oba obsahují
  // čas poslední synchronizace zdrojů…") to vyžaduje bez výjimky pro
  // "nic k řešení" týden. A věcně: "tenhle konektor ještě nikdy neuspěl"
  // je informace, kterou chceme vidět právě TEHDY, když je zbytek digestu
  // tichý — ticho v pipeline a rozbitý konektor vypadají navenek stejně
  // (viz úvodní komentář core/connectorState.ts), takže tahle sekce se
  // nesmí schovat podle stejného pravidla "0 položek = žádná sekce".
  const statuses = [
    meetingNotesStatus(lastMeetingNoteAt, generatedAt, input.meetingIntake),
    sourceStatus('Outlook (kalendář a úkoly)', connectorStates.graphCalendar, GRAPH_CALENDAR_STALE_AFTER_HOURS, connectorStates.graphCalendar, false),
    outlookMailStatus(connectorStates.outlookMailInbox, connectorStates.outlookMailSent, outlookMailSyncEnabled),
    ...(input.mailWebhook ? [mailWebhookStatus(input.mailWebhook)] : []),
    graphSendStatus(connectorStates.graphSend),
    ...(input.jobHealth ? [jobHealthStatus(input.jobHealth)] : []),
    ...[oauthHealthStatus(input.oauthHealth)].filter((s): s is { line: string; alert: boolean } => s !== null),
  ]
  const sources: DigestSection = { title: 'Stav zdrojů', lines: statuses.map((s) => s.line) }
  const sourceAlerts = statuses.filter((s) => s.alert).length

  return { headline, sections, isEmpty, generatedAt, sources, sourceAlerts }
}

export function renderDigestText(digest: Digest): string {
  const parts: string[] = [digest.headline]

  for (const section of digest.sections) {
    parts.push('', `## ${section.title}`, ...section.lines)
    if (section.more) parts.push(moreLine(section.more.hidden))
  }

  // Stav zdrojů se vypisuje vždy jako poslední sekce, i pro prázdný digest —
  // viz komentář u jejího sestavení v buildDigest.
  parts.push('', `## ${digest.sources.title}`, ...digest.sources.lines)

  return parts.join('\n')
}
