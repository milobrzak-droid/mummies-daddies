import { expect, test } from 'vitest'
import { buildDigest, moreLine, renderDigestText, SECTION_LIMITS, sectionTotal, type BlockedDeal, type DigestConnectorStates, type DigestFollowUp, type DigestInput } from '@/domain/crm/digest'
import type { OutreachCandidate } from '@/domain/crm/outreach'
import type { ConnectorState } from '@/core/connectorState'

// connectorStates jde v testech zadávat po jednotlivých konektorech
// (chybějící = null z výchozí hodnoty níže) — input() proto bere Partial
// jen pro connectorStates zvlášť, ne DigestInput napřímo (ten by pro
// connectorStates vyžadoval vždy VŠECHNY čtyři konektory).
type InputOverrides = Partial<Omit<DigestInput, 'connectorStates'>> & { connectorStates?: Partial<DigestConnectorStates> }

const GENERATED_AT = new Date('2026-09-28T07:00:00Z')

// isStale (core/connectorState.ts) srovnává last_success_at proti skutečnému
// Date.now(), ne proti injektovanému generatedAt — je to čistá funkce, ale
// časovaná na hodinách reálných, ne testovacích. "Čerstvý" fixture proto
// musí být blízko reálnému "teď", ne blízko fixnímu GENERATED_AT výše;
// "starý" fixture je 30 dní zpátky, což je bezpečně za oběma prahy
// (168 h pro graph_calendar). Zápisy schůzek (Wispr Flow přes skill) se
// naopak měří proti injektovanému generatedAt, proto fixní časy níže.
const REAL_NOW = Date.now()

const connectorState = (connector: string, o: Partial<ConnectorState> = {}): ConnectorState => ({
  connector, cursor: null, last_success_at: new Date(REAL_NOW - 60_000).toISOString(),
  last_error: null, last_error_at: null, consecutive_errors: 0,
  updated_at: new Date(REAL_NOW - 60_000).toISOString(), ...o,
})

const FRESH_NOTE = '2026-09-27T10:00:00Z'
const STALE_NOTE = '2026-08-01T10:00:00Z'
const freshGraphCalendar = (): ConnectorState => connectorState('graph_calendar')

const staleTimestamp = new Date(REAL_NOW - 1000 * 60 * 60 * 24 * 30).toISOString()
const staleGraphCalendar = (): ConnectorState =>
  connectorState('graph_calendar', { last_success_at: staleTimestamp, updated_at: staleTimestamp })

const nudge = (o: Partial<DigestFollowUp> = {}): DigestFollowUp => ({
  deal_id: 1, account_id: 1, title: 'Agentizace', account_name: 'ALFATECH', due: '2026-09-25',
  days_overdue: 3, level: 'owner', ...o,
})

const candidate = (o: Partial<OutreachCandidate> = {}): OutreachCandidate => ({
  account_id: 1, name: 'Spolchemie', last_direction: 'us', last_at: '2026-08-03', days_silent: 56, ...o,
})

const blocked = (o: Partial<BlockedDeal> = {}): BlockedDeal => ({
  id: 1, account_id: 1, title: 'Rollout', account_name: 'Continental', status_blocker: 'čeká na podpis smlouvy', ...o,
})

const input = (o: InputOverrides = {}): DigestInput => ({
  followUps: [], outreach: [], blockedDeals: [],
  lastMeetingNoteAt: null,
  outlookMailSyncEnabled: true,
  generatedAt: GENERATED_AT,
  ...o,
  connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null, ...o.connectorStates },
})

test('all three inputs empty — isEmpty, "Nic k řešení.", zero sections', () => {
  const digest = buildDigest(input())
  expect(digest.isEmpty).toBe(true)
  expect(digest.headline).toBe('Nic k řešení.')
  expect(digest.sections).toEqual([])
  expect(digest.generatedAt).toBe(GENERATED_AT)
})

test('only followUps present — one section, others absent (not empty-but-present)', () => {
  const digest = buildDigest(input({ followUps: [nudge()] }))
  expect(digest.isEmpty).toBe(false)
  expect(digest.sections).toHaveLength(1)
  expect(digest.sections[0].title).toBe('Follow-upy po termínu')
  expect(digest.sections.map((s) => s.title)).not.toContain('Firmy k oslovení')
  expect(digest.sections.map((s) => s.title)).not.toContain('Blokované obchody')
})

test('only outreach present — one section, others absent', () => {
  const digest = buildDigest(input({ outreach: [candidate()] }))
  expect(digest.isEmpty).toBe(false)
  expect(digest.sections).toHaveLength(1)
  expect(digest.sections[0].title).toBe('Firmy k oslovení')
})

test('only blockedDeals present — one section, others absent', () => {
  const digest = buildDigest(input({ blockedDeals: [blocked()] }))
  expect(digest.isEmpty).toBe(false)
  expect(digest.sections).toHaveLength(1)
  expect(digest.sections[0].title).toBe('Blokované obchody')
})

test('all three present — three sections in order, headline mentions all three counts', () => {
  const digest = buildDigest(input({
    followUps: [nudge(), nudge({ deal_id: 2 })],
    outreach: [candidate()],
    blockedDeals: [blocked()],
  }))
  expect(digest.isEmpty).toBe(false)
  expect(digest.sections.map((s) => s.title)).toEqual([
    'Follow-upy po termínu', 'Firmy k oslovení', 'Blokované obchody',
  ])
  expect(digest.headline).toBe('Follow-upy po termínu: 2, Firmy k oslovení: 1, Blokované obchody: 1.')
})

test('headline omits a clause entirely when its count is 0, never says "0 ..."', () => {
  const digest = buildDigest(input({ followUps: [nudge()], blockedDeals: [blocked()] }))
  expect(digest.headline).toBe('Follow-upy po termínu: 1, Blokované obchody: 1.')
  expect(digest.headline).not.toContain('0')
  expect(digest.headline).not.toContain('Firmy k oslovení')
})

test('headline construction sidesteps Czech numeral agreement via "Label: N" — no broken singular/plural', () => {
  const one = buildDigest(input({ followUps: [nudge()] }))
  const many = buildDigest(input({ followUps: [nudge(), nudge({ deal_id: 2 }), nudge({ deal_id: 3 })] }))
  expect(one.headline).toBe('Follow-upy po termínu: 1.')
  expect(many.headline).toBe('Follow-upy po termínu: 3.')
})

test('renderDigestText contains headline and each present section title and lines', () => {
  const digest = buildDigest(input({
    followUps: [nudge()],
    outreach: [candidate()],
  }))
  const text = renderDigestText(digest)
  expect(text).toContain(digest.headline)
  expect(text).toContain('## Follow-upy po termínu')
  expect(text).toContain('ALFATECH — Agentizace — 3 dní po termínu')
  expect(text).toContain('## Firmy k oslovení')
  expect(text).toContain('Spolchemie — ticho 56 dní')
})

test('renderDigestText does not contain a header for an absent section', () => {
  const digest = buildDigest(input({ followUps: [nudge()] }))
  const text = renderDigestText(digest)
  expect(text).not.toContain('## Firmy k oslovení')
  expect(text).not.toContain('## Blokované obchody')
})

test('renderDigestText for an empty digest is the headline plus the always-on Stav zdrojů section, no other headers', () => {
  const digest = buildDigest(input())
  const text = renderDigestText(digest)
  // Never-synced (null) is itself "zastaralé" per isStale (core/connectorState.ts:
  // `if (state === null) return true`), so both threshold-based lines carry the
  // flag; graph_send is informational only (no flag), no matter the value.
  expect(text).toBe(
    'Nic k řešení.\n\n## Stav zdrojů\n' +
    'Wispr Flow (zápisy schůzek přes skill): poslední zápis nikdy — zastaralé\n' +
    'Outlook (kalendář a úkoly): nikdy — zastaralé\n' +
    'Outlook pošta (příjem a odeslání): nikdy — zastaralé\n' +
    'Odesílání přehledu (graph_send): nikdy',
  )
})

test('an escalated Nudge shows "(eskalováno)" in its line', () => {
  const digest = buildDigest(input({ followUps: [nudge({ level: 'manager' })] }))
  expect(digest.sections[0].lines[0]).toContain('(eskalováno)')
})

test('a non-escalated Nudge does not show "(eskalováno)"', () => {
  const digest = buildDigest(input({ followUps: [nudge({ level: 'owner' })] }))
  expect(digest.sections[0].lines[0]).not.toContain('(eskalováno)')
})

test('a follow-up with no account_name falls back to "Bez klienta"', () => {
  const digest = buildDigest(input({ followUps: [nudge({ account_name: null })] }))
  expect(digest.sections[0].lines[0]).toContain('Bez klienta')
})

test('a blocked deal with no account_name falls back to "Bez klienta"', () => {
  const digest = buildDigest(input({ blockedDeals: [blocked({ account_name: null })] }))
  expect(digest.sections[0].lines[0]).toContain('Bez klienta')
})

// --- Stav zdrojů (čas poslední synchronizace konektorů) ---

test('sources section is present even for an otherwise-empty digest (isEmpty stays about the three categories only)', () => {
  const digest = buildDigest(input())
  expect(digest.isEmpty).toBe(true)
  expect(digest.sources.title).toBe('Stav zdrojů')
  expect(digest.sources.lines).toHaveLength(4)
})

test('both connectors never synced (null state) — both lines say "nikdy" and are flagged stale', () => {
  const digest = buildDigest(input({ connectorStates: { graphCalendar: null }, lastMeetingNoteAt: null }))
  expect(digest.sources.lines).toEqual([
    'Wispr Flow (zápisy schůzek přes skill): poslední zápis nikdy — zastaralé',
    'Outlook (kalendář a úkoly): nikdy — zastaralé',
    'Outlook pošta (příjem a odeslání): nikdy — zastaralé',
    'Odesílání přehledu (graph_send): nikdy',
  ])
})

// --- Outlook pošta (outlook:inbox / outlook:sent) a odesílání (graph_send) ---

test('outlook mail sync line shows "vypnuto" when OUTLOOK_MAIL_SYNC_ENABLED is not true, regardless of connector state', () => {
  const digest = buildDigest(input({
    connectorStates: { outlookMailInbox: freshGraphCalendar(), outlookMailSent: freshGraphCalendar() },
    outlookMailSyncEnabled: false,
  }))
  expect(digest.sources.lines[2]).toBe('Outlook pošta (příjem a odeslání): vypnuto')
})

test('outlook mail sync line uses the OLDER of inbox/sent last_success_at — one stale folder makes the combined line stale', () => {
  const digest = buildDigest(input({
    connectorStates: { outlookMailInbox: freshGraphCalendar(), outlookMailSent: staleGraphCalendar() },
    outlookMailSyncEnabled: true,
  }))
  expect(digest.sources.lines[2]).toContain('zastaralé')
})

test('outlook mail sync line: both folders fresh — no "zastaralé" flag', () => {
  const digest = buildDigest(input({
    connectorStates: { outlookMailInbox: freshGraphCalendar(), outlookMailSent: freshGraphCalendar() },
    outlookMailSyncEnabled: true,
  }))
  expect(digest.sources.lines[2]).not.toContain('zastaralé')
  expect(digest.sources.lines[2]).not.toContain('nikdy')
})

test('one folder never synced (null) — combined line says "nikdy" even if the other folder is fresh', () => {
  const digest = buildDigest(input({
    connectorStates: { outlookMailInbox: null, outlookMailSent: freshGraphCalendar() },
    outlookMailSyncEnabled: true,
  }))
  expect(digest.sources.lines[2]).toContain('nikdy')
  expect(digest.sources.lines[2]).toContain('zastaralé')
})

test('graph_send line is purely informational — shows last success with no "zastaralé" flag, even when old', () => {
  const digest = buildDigest(input({ connectorStates: { graphSend: staleGraphCalendar() } }))
  expect(digest.sources.lines[3]).not.toContain('zastaralé')
  expect(digest.sources.lines[3]).toMatch(/^Odesílání přehledu \(graph_send\): /)
})

test('both connectors fresh — dated lines, no "zastaralé" flag', () => {
  const digest = buildDigest(input({
    connectorStates: { graphCalendar: freshGraphCalendar() }, lastMeetingNoteAt: FRESH_NOTE,
  }))
  // Jen Wispr Flow + Outlook kalendář — ostatní dva řádky (mail sync,
  // graph_send) mají vlastní testy níže a defaultní (null) stav.
  for (const line of digest.sources.lines.slice(0, 2)) {
    expect(line).not.toContain('nikdy')
    expect(line).not.toContain('zastaralé')
  }
})

test('both connectors stale (old last_success_at, past their own threshold) — both lines flagged "zastaralé"', () => {
  const digest = buildDigest(input({
    connectorStates: { graphCalendar: staleGraphCalendar() }, lastMeetingNoteAt: STALE_NOTE,
  }))
  for (const line of digest.sources.lines.slice(0, 2)) {
    expect(line).toContain('zastaralé')
    expect(line).not.toContain('nikdy')
  }
})

test('one never synced (null), the other fresh — only the null one says "nikdy" and only it is flagged stale', () => {
  const digest = buildDigest(input({
    connectorStates: { graphCalendar: freshGraphCalendar() }, lastMeetingNoteAt: null,
  }))
  const [notesLine, graphLine] = digest.sources.lines
  expect(notesLine).toContain('nikdy')
  expect(notesLine).toContain('zastaralé')
  expect(graphLine).not.toContain('nikdy')
  expect(graphLine).not.toContain('zastaralé')
})

test('mixed: meeting notes stale, graph_calendar fresh — each connector judged independently against its own threshold', () => {
  const digest = buildDigest(input({
    connectorStates: { graphCalendar: freshGraphCalendar() }, lastMeetingNoteAt: STALE_NOTE,
  }))
  const [notesLine, graphLine] = digest.sources.lines
  expect(notesLine).toContain('Wispr Flow (zápisy schůzek přes skill)')
  expect(notesLine).toContain('zastaralé')
  expect(graphLine).toContain('Outlook (kalendář a úkoly)')
  expect(graphLine).not.toContain('zastaralé')
})

test('renderDigestText always renders "## Stav zdrojů" as the last section, even when other sections are present', () => {
  const digest = buildDigest(input({
    followUps: [nudge()],
    connectorStates: { graphCalendar: freshGraphCalendar() }, lastMeetingNoteAt: FRESH_NOTE,
  }))
  const text = renderDigestText(digest)
  const followUpsHeaderIndex = text.indexOf('## Follow-upy po termínu')
  const sourcesHeaderIndex = text.indexOf('## Stav zdrojů')
  expect(followUpsHeaderIndex).toBeGreaterThan(-1)
  expect(sourcesHeaderIndex).toBeGreaterThan(followUpsHeaderIndex)
})

test('buildDigest is pure: same input produces the same output on repeated calls', () => {
  const digestInput = input({
    followUps: [nudge()],
    connectorStates: { graphCalendar: staleGraphCalendar() }, lastMeetingNoteAt: FRESH_NOTE,
  })
  const first = buildDigest(digestInput)
  const second = buildDigest(digestInput)
  expect(second).toEqual(first)
})

test('account_id nemění text digestu', () => {
  const a = buildDigest(input({ followUps: [nudge({ account_id: 1 })], blockedDeals: [blocked({ account_id: 1 })] }))
  const b = buildDigest(input({ followUps: [nudge({ account_id: 99 })], blockedDeals: [blocked({ account_id: null })] }))
  expect(renderDigestText(a)).toBe(renderDigestText(b))
})

test('zápis schůzky přesně na hraně 7 dní ještě není zastaralý, o hodinu později už ano', () => {
  const at = (h: number) => new Date(GENERATED_AT.getTime() - h * 3_600_000).toISOString()
  expect(buildDigest(input({ lastMeetingNoteAt: at(24 * 7) })).sources.lines[0]).not.toContain('zastaralé')
  expect(buildDigest(input({ lastMeetingNoteAt: at(24 * 7 + 1) })).sources.lines[0]).toContain('zastaralé')
})

// Příjem zápisů z diktátu (0078): řádek zdroje nese počet za 30 dní a kolik
// čeká na ruční přiřazení; bez příjmu (nenasazená migrace) zůstává po starém.
test('Wispr Flow řádek s příjmem diktátu: poslední zápis, počet za 30 dní, čekající', () => {
  const line = buildDigest(input({
    lastMeetingNoteAt: '2026-09-28T06:00:00Z',
    meetingIntake: { received30d: 7, unmatched: 2 },
  })).sources.lines[0]
  expect(line).toMatch(/^Wispr Flow \(zápisy schůzek\): poslední zápis .* · za 30 dní 7 · čekají na přiřazení 2$/)
  expect(line).not.toContain('přes skill')
  expect(line).not.toContain('zastaralé')
})

test('Wispr Flow řádek s příjmem: nikdy nepřišel zápis → zastaralé + nuly; čekající zápis ranní souhrn nespouští', () => {
  const digest = buildDigest(input({ lastMeetingNoteAt: null, meetingIntake: { received30d: 0, unmatched: 3 } }))
  expect(digest.sources.lines[0]).toBe('Wispr Flow (zápisy schůzek): poslední zápis nikdy — zastaralé · za 30 dní 0 · čekají na přiřazení 3')
  expect(digest.sourceAlerts).toBe(buildDigest(input({ lastMeetingNoteAt: null })).sourceAlerts)
})

test('Wispr Flow řádek bez příjmu (null i vynechané) zůstává po starém', () => {
  const old = buildDigest(input({ lastMeetingNoteAt: '2026-09-28T06:00:00Z' })).sources.lines[0]
  expect(old).toContain('Wispr Flow (zápisy schůzek přes skill): poslední zápis')
  expect(buildDigest(input({ lastMeetingNoteAt: '2026-09-28T06:00:00Z', meetingIntake: null })).sources.lines[0]).toBe(old)
})

// ---------------------------------------------------------------------------
// Stav zdrojů: kolik zdrojů potřebuje pozornost (ranní souhrn podle toho
// odchází i bez položek).

const allFresh = (): Partial<DigestConnectorStates> => ({
  graphCalendar: freshGraphCalendar(),
  outlookMailInbox: connectorState('outlook:inbox'),
  outlookMailSent: connectorState('outlook:sent'),
  graphSend: connectorState('graph_send'),
})

test('sourceAlerts: všechny zdroje čerstvé a bez chyb = 0, isEmpty se nemění', () => {
  const digest = buildDigest(input({ connectorStates: allFresh(), lastMeetingNoteAt: '2026-09-28T06:00:00Z' }))
  expect(digest.sourceAlerts).toBe(0)
  expect(digest.isEmpty).toBe(true)
  for (const line of digest.sources.lines) expect(line).not.toMatch(/zastaralé|chyba/)
})

test('sourceAlerts: zastaralost se počítá jen u zdroje, který běží sám (sync pošty); kalendář a zápisy schůzek se jen zobrazí', () => {
  // Wispr nikdy, kalendář nikdy, pošta nikdy → počítá se jen pošta (denní cron).
  const fresh = buildDigest(input())
  expect(fresh.sourceAlerts).toBe(1)
  expect(fresh.sources.lines[0]).toContain('zastaralé')
  expect(fresh.sources.lines[1]).toContain('zastaralé')
  expect(buildDigest(input({ outlookMailSyncEnabled: false })).sourceAlerts).toBe(0)
  const staleCalendar = buildDigest(input({
    connectorStates: { ...allFresh(), graphCalendar: staleGraphCalendar() }, lastMeetingNoteAt: '2026-09-28T06:00:00Z',
  }))
  expect(staleCalendar.sourceAlerts).toBe(0)
  expect(staleCalendar.sources.lines[1]).toContain('zastaralé')
  expect(staleCalendar.isEmpty).toBe(true)
  const staleMail = buildDigest(input({
    connectorStates: { ...allFresh(), outlookMailInbox: null }, lastMeetingNoteAt: '2026-09-28T06:00:00Z',
  }))
  expect(staleMail.sourceAlerts).toBe(1)
})

test('sourceAlerts: chyba kalendáře se počítá, i když zastaralost ne', () => {
  const digest = buildDigest(input({
    connectorStates: { ...allFresh(), graphCalendar: connectorState('graph_calendar', { consecutive_errors: 1, last_error: 'invalid_grant' }) },
    lastMeetingNoteAt: '2026-09-28T06:00:00Z',
  }))
  expect(digest.sourceAlerts).toBe(1)
})

test('rozbitý zdroj (poslední běh s chybou) = alert a řádek s textem chyby, i když poslední úspěch je čerstvý', () => {
  const digest = buildDigest(input({
    connectorStates: {
      ...allFresh(),
      outlookMailSent: connectorState('outlook:sent', { consecutive_errors: 1, last_error: 'Chybí oprávnění Mail.Read — znovu připojte Outlook v Nastavení' }),
      graphSend: connectorState('graph_send', { consecutive_errors: 2, last_error: 'Chybí oprávnění Mail.Send — znovu připojte Outlook v Nastavení' }),
    },
    lastMeetingNoteAt: '2026-09-28T06:00:00Z',
  }))
  expect(digest.sourceAlerts).toBe(2)
  expect(digest.sources.lines[2]).toMatch(/^Outlook pošta \(příjem a odeslání\): .* — chyba: Chybí oprávnění Mail\.Read/)
  expect(digest.sources.lines[2]).not.toContain('zastaralé')
  expect(digest.sources.lines[3]).toMatch(/^Odesílání přehledu \(graph_send\): .* — chyba: Chybí oprávnění Mail\.Send/)
})

test('text chyby v řádku je jednořádkový a zkrácený', () => {
  const long = `řádek1\nřádek2 ${'x'.repeat(300)}`
  const line = buildDigest(input({
    connectorStates: { ...allFresh(), graphCalendar: connectorState('graph_calendar', { consecutive_errors: 1, last_error: long }) },
  })).sources.lines[1]
  expect(line).not.toMatch(/[\r\n]/)
  expect(line).toContain('— chyba: řádek1 řádek2 ')
  expect(line.endsWith('…')).toBe(true)
  expect(line.length).toBeLessThan(260)
})

// ---------------------------------------------------------------------------
// Strop položek na sekci (po importu z Radaru 548 firem k oslovení).

const many = <T,>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i))

test('Firmy k oslovení: prvních 15 v daném pořadí + řádek „… a dalších N" s odkazem na /oslovovani; headline s celkovým počtem', () => {
  const outreach = many(548, (i) => candidate({ account_id: i + 1, name: `Firma ${i + 1}`, days_silent: 1000 - i }))
  const digest = buildDigest(input({ outreach }))
  const section = digest.sections.find((s) => s.title === 'Firmy k oslovení')!
  expect(SECTION_LIMITS.outreach).toBe(15)
  expect(section.lines).toHaveLength(15)
  expect(section.lines[0]).toBe('Firma 1 — ticho 1000 dní')
  expect(section.lines[14]).toBe('Firma 15 — ticho 986 dní')
  expect(section.more).toEqual({ hidden: 533, path: '/cockpit/oslovovani' })
  expect(sectionTotal(section)).toBe(548)
  expect(digest.headline).toBe('Firmy k oslovení: 548.')
  const text = renderDigestText(digest)
  expect(text).toContain('Firma 15 — ticho 986 dní\n… a dalších 533 — celý seznam v Cockpitu')
  expect(text).not.toContain('Firma 16 ')
})

test('follow-upy (25) a blokované obchody (25) se ořezávají taky; přesně na limitu bez řádku „a dalších"', () => {
  const digest = buildDigest(input({
    followUps: many(30, (i) => nudge({ deal_id: i + 1, title: `FU ${i + 1}` })),
    blockedDeals: many(25, (i) => blocked({ id: i + 1, title: `B ${i + 1}` })),
  }))
  const [fu, bl] = digest.sections
  expect(fu.lines).toHaveLength(25)
  expect(fu.more).toEqual({ hidden: 5, path: '/cockpit/pipeline' })
  expect(bl.lines).toHaveLength(25)
  expect(bl.more).toBeUndefined()
  expect(digest.headline).toBe('Follow-upy po termínu: 30, Blokované obchody: 25.')
  expect(moreLine(5)).toBe('… a dalších 5 — celý seznam v Cockpitu')
})

test('firma, kde někdo nesouhlasí s oslovením (0087): řádek to řekne', () => {
  const digest = buildDigest(input({ outreach: [candidate({ opt_out: { opted_out: 1, total: 3, account_note: false } })] }))
  const text = renderDigestText(digest)
  expect(text).toContain('ticho 56 dní — 1 z 3 lidí nesouhlasí s oslovením')
})
