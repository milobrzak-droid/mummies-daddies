// Okno prvního načtení pošty (MAIL_SYNC_INITIAL_DAYS): filtr v delta dotazu,
// stránkování od nejnovějších, postup v kurzoru, restart starého kurzoru,
// odhad zbývajících běhů a věta o ručním běhu. Bez sítě a bez Supabase.
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INITIAL_DAYS,
  FOLDERS,
  mailSyncInitialDaysFromEnv,
  parseCursor,
  runMailSync,
  serializeCursor,
  windowStart,
  type MailEventRow,
  type MailSyncDb,
} from '@/domain/crm/mailSync'
import {
  MANUAL_RUN_MIN_INTERVAL_MS,
  canRunMailSyncNow,
  describeManualRun,
  describeProgress,
  mailSyncProgress,
  manualRunWaitSeconds,
} from '@/domain/crm/mailSyncProgress'
import { describeFolderStatus } from '@/domain/crm/mailFolderStatus'
import { mailDeltaStartUrl, MAIL_DELTA_SELECT, type GraphMailMessage, type MailDeltaResult } from '@/connectors/graph'
import type { ConnectorState } from '@/core/connectorState'

const G = 'https://graph.microsoft.com/v1.0'
const DAY = 86_400_000
const NOW = Date.parse('2026-09-30T10:00:00Z')

function msg(id: string, received: string): GraphMailMessage {
  return {
    id,
    internetMessageId: `<${id}@x>`,
    from: { emailAddress: { address: 'jana@acme.cz' } },
    toRecipients: [{ emailAddress: { address: 'viktor@mummiesdaddies.com' } }],
    receivedDateTime: received,
    sentDateTime: received,
    isDraft: false,
  }
}

function fakeDb(initial: Record<string, string | null> = {}) {
  const cursors = new Map<string, string | null>(Object.entries(initial))
  const events = new Map<string, MailEventRow>()
  const db: MailSyncDb = {
    async loadCursor(c) { return cursors.get(c) ?? null },
    async saveCursor(c, v) { cursors.set(c, v) },
    async recordSuccess() {},
    async recordError() {},
    async loadMatchData() { return { contacts: [{ id: 7, email: 'jana@acme.cz', account_id: 1 }], aliases: [] } },
    async insertEvents(rows) {
      let n = 0
      for (const r of rows) {
        const k = `${r.internet_message_id}|${r.direction}`
        if (!events.has(k)) { events.set(k, r); n++ }
      }
      return n
    },
    async applyToAccount() {},
    async purgeUnmatchedEvents() { return 0 },
    async recordEvidence() {},
    async markAttempt() {},
  }
  return { db, cursors, events }
}

function fakeGraph(script: Record<string, MailDeltaResult[]>) {
  const calls: string[] = []
  return {
    calls,
    fetchPage: async (url: string): Promise<MailDeltaResult> => {
      calls.push(url)
      const q = script[url]
      if (!q || q.length === 0) throw new Error(`nečekané URL ${url}`)
      return q.length > 1 ? q.shift()! : q[0]
    },
  }
}

const page = (messages: GraphMailMessage[], next: string | null, delta: string | null): MailDeltaResult =>
  ({ kind: 'page', messages, nextLink: next, deltaLink: delta })

const clock = () => ({ now: () => NOW, sleep: async () => {} })

describe('mailDeltaStartUrl — okno', () => {
  const since = '2026-06-02T10:00:00.000Z'

  it('bez okna zůstává URL beze změny (žádný filtr)', () => {
    expect(mailDeltaStartUrl('inbox')).not.toContain('filter')
    expect(mailDeltaStartUrl('inbox', null)).toBe(mailDeltaStartUrl('inbox'))
  })

  it('s oknem: $filter receivedDateTime ge a $orderby receivedDateTime desc, obojí zakódované', () => {
    const u = new URL(mailDeltaStartUrl('sentitems', since))
    expect(u.pathname).toBe('/v1.0/me/mailFolders/sentitems/messages/delta')
    expect(u.searchParams.get('$filter')).toBe('receivedDateTime ge 2026-06-02T10:00:00Z')
    expect(u.searchParams.get('$orderby')).toBe('receivedDateTime desc')
    expect(mailDeltaStartUrl('inbox', since)).not.toMatch(/ /)
  })

  it('$select zůstává jen metadata, i s oknem', () => {
    const u = new URL(mailDeltaStartUrl('inbox', since))
    expect(u.searchParams.get('$select')).toBe(MAIL_DELTA_SELECT.join(','))
    expect(u.search).not.toMatch(/subject|body|preview/i)
  })

  it('nesmyslný čas okno nezapne', () => {
    expect(mailDeltaStartUrl('inbox', 'včera')).toBe(mailDeltaStartUrl('inbox'))
  })
})

describe('mailSyncInitialDaysFromEnv', () => {
  it('výchozí 120, platné číslo se přebírá, 0 = bez omezení', () => {
    expect(DEFAULT_INITIAL_DAYS).toBe(120)
    expect(mailSyncInitialDaysFromEnv({})).toBe(120)
    expect(mailSyncInitialDaysFromEnv({ MAIL_SYNC_INITIAL_DAYS: '30' })).toBe(30)
    expect(mailSyncInitialDaysFromEnv({ MAIL_SYNC_INITIAL_DAYS: ' 365 ' })).toBe(365)
    expect(mailSyncInitialDaysFromEnv({ MAIL_SYNC_INITIAL_DAYS: '0' })).toBe(0)
  })
  it('nesmysl nebo příliš velké číslo = výchozí, ne tiché stažení celé historie', () => {
    for (const v of ['', 'abc', '-5', '1.5', '12 dní', '99999']) {
      expect(mailSyncInitialDaysFromEnv({ MAIL_SYNC_INITIAL_DAYS: v })).toBe(120)
    }
  })
})

describe('runMailSync — okno prvního načtení', () => {
  const since = windowStart(NOW, 120)
  const INBOX = mailDeltaStartUrl('inbox', since)
  const SENT = mailDeltaStartUrl('sentitems', since)

  it('windowStart = teď minus N dní, na celé sekundy', () => {
    expect(since).toBe('2026-06-02T10:00:00.000Z')
    expect(windowStart(NOW + 500, 1)).toBe('2026-09-29T10:00:00.000Z')
  })

  it('obě složky začnou filtrovaným dotazem; kurzor nese since, reached (nejstarší datum) a runs', async () => {
    const f = fakeDb()
    const g = fakeGraph({
      [INBOX]: [page([msg('a', '2026-09-29T10:00:00Z'), msg('b', '2026-09-01T10:00:00Z')], `${G}/i2`, null)],
      [SENT]: [page([msg('c', '2026-09-20T10:00:00Z')], `${G}/s2`, null)],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120, maxPages: 2 })
    expect(g.calls).toEqual([INBOX, SENT])
    expect(s.folders.inbox.outcome).toBe('more_pending')
    expect(parseCursor(f.cursors.get(FOLDERS.inbox.connector))).toEqual({
      phase: 'paging', link: `${G}/i2`, since, reached: '2026-09-01T10:00:00.000Z', runs: 1,
    })
    expect(parseCursor(f.cursors.get(FOLDERS.sent.connector))).toMatchObject({ reached: '2026-09-20T10:00:00.000Z', since })
  })

  it('stránkování: reached jen klesá, runs se v jednom běhu zvýší jednou, další běh naváže a zvýší znovu', async () => {
    const f = fakeDb()
    const g = fakeGraph({
      [INBOX]: [page([msg('a', '2026-09-29T10:00:00Z')], `${G}/i2`, null)],
      [`${G}/i2`]: [page([msg('b', '2026-08-01T10:00:00Z')], `${G}/i3`, null)],
      [`${G}/i3`]: [page([msg('c', '2026-07-01T10:00:00Z')], null, `${G}/i-delta`)],
      [SENT]: [page([], null, `${G}/s-delta`)],
      [`${G}/s-delta`]: [page([], null, `${G}/s-delta2`)],
    })
    // Běh 1: jediná stránka Doručené a Odeslaná (maxPages 3 → férově 2 + 1).
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120, maxPages: 3 })
    const afterFirst = parseCursor(f.cursors.get(FOLDERS.inbox.connector))
    expect(afterFirst).toMatchObject({ phase: 'paging', runs: 1, reached: '2026-08-01T10:00:00.000Z' })

    // Běh 2: naváže na uložený odkaz, ne od začátku; dotáhne a přejde do delty.
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120, maxPages: 5 })
    expect(g.calls.filter((u) => u === INBOX)).toHaveLength(1)
    expect(s.folders.inbox.outcome).toBe('caught_up')
    // Delta kurzor nese jen since (reached a runs už nejsou potřeba).
    expect(parseCursor(f.cursors.get(FOLDERS.inbox.connector))).toEqual({ phase: 'delta', link: `${G}/i-delta`, since })
    expect(f.events.size).toBe(3)
  })

  it('rozjetý delta kurzor se oknem nemění (žádný filtr, žádný nový začátek)', async () => {
    const deltaLink = `${G}/i-delta`
    const f = fakeDb({ [FOLDERS.inbox.connector]: serializeCursor({ phase: 'delta', link: deltaLink }) })
    const g = fakeGraph({ [deltaLink]: [page([], null, `${G}/i-delta2`)], [SENT]: [page([], null, `${G}/s-delta`)] })
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120 })
    expect(g.calls[0]).toBe(deltaLink)
  })

  it('starý kurzor „paging" bez since (první načtení před oknem) se s oknem začne znovu', async () => {
    const f = fakeDb({ [FOLDERS.inbox.connector]: serializeCursor({ phase: 'paging', link: `${G}/stara-stranka` }) })
    const g = fakeGraph({ [INBOX]: [page([msg('a', '2026-09-29T10:00:00Z')], `${G}/i2`, null)], [SENT]: [page([], null, `${G}/s-delta`)] })
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120, maxPages: 2 })
    expect(g.calls[0]).toBe(INBOX)
    expect(g.calls).not.toContain(`${G}/stara-stranka`)
  })

  it('bez okna (initialDays 0) se starý kurzor „paging" nechá být', async () => {
    const f = fakeDb({ [FOLDERS.inbox.connector]: serializeCursor({ phase: 'paging', link: `${G}/stara-stranka` }) })
    const g = fakeGraph({ [`${G}/stara-stranka`]: [page([], null, `${G}/d`)], [mailDeltaStartUrl('sentitems')]: [page([], null, `${G}/s`)] })
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 0 })
    expect(g.calls[0]).toBe(`${G}/stara-stranka`)
  })

  it('expirovaný token uprostřed načtení: nový začátek okna a postup od nuly', async () => {
    const f = fakeDb({
      [FOLDERS.inbox.connector]: serializeCursor({ phase: 'paging', link: `${G}/i2`, since, reached: '2026-08-01T10:00:00.000Z', runs: 4 }),
    })
    const g = fakeGraph({
      [`${G}/i2`]: [{ kind: 'expired' }],
      [INBOX]: [page([msg('a', '2026-09-29T10:00:00Z')], `${G}/n2`, null)],
      [SENT]: [page([], null, `${G}/s-delta`)],
    })
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120, maxPages: 2 })
    expect(parseCursor(f.cursors.get(FOLDERS.inbox.connector))).toMatchObject({ link: `${G}/n2`, runs: 1, reached: '2026-09-29T10:00:00.000Z' })
  })

  it('přeskočené zprávy (koncept) se do postupu počítají, ale nezapíšou', async () => {
    const f = fakeDb()
    const draft = { ...msg('d', '2026-07-15T10:00:00Z'), isDraft: true }
    const g = fakeGraph({ [INBOX]: [page([msg('a', '2026-09-29T10:00:00Z'), draft], `${G}/i2`, null)], [SENT]: [page([], null, `${G}/s`)] })
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120, maxPages: 2 })
    expect(f.events.size).toBe(1)
    expect(parseCursor(f.cursors.get(FOLDERS.inbox.connector))?.reached).toBe('2026-07-15T10:00:00.000Z')
  })

  it('ukládá se jen metadata: do kurzoru ani událostí se nedostane obsah', async () => {
    const f = fakeDb()
    const secret = { ...msg('a', '2026-09-29T10:00:00Z'), subject: 'TAJNÝ PŘEDMĚT', bodyPreview: 'TAJNÉ TĚLO' } as GraphMailMessage
    const g = fakeGraph({ [INBOX]: [page([secret], `${G}/i2`, null)], [SENT]: [page([], null, `${G}/s`)] })
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, ...clock() }, { initialDays: 120, maxPages: 2 })
    expect(JSON.stringify([...f.events.values()]) + [...f.cursors.values()].join('')).not.toMatch(/TAJN/)
  })
})

describe('mailSyncProgress a věta pro Stav zdrojů', () => {
  const since = new Date(NOW - 120 * DAY).toISOString()
  const cursor = (over: object) => parseCursor(serializeCursor({ phase: 'paging', link: `${G}/x`, since, ...over }))

  it('bez okna, v delta fázi nebo bez kurzoru žádný postup', () => {
    expect(mailSyncProgress(null, NOW)).toBeNull()
    expect(mailSyncProgress(parseCursor(serializeCursor({ phase: 'paging', link: `${G}/x` })), NOW)).toBeNull()
    expect(mailSyncProgress(parseCursor(serializeCursor({ phase: 'delta', link: `${G}/x`, since })), NOW)).toBeNull()
  })

  it('podíl a odhad běhů: čtvrtina za 1 běh → zbývají 3', () => {
    const p = mailSyncProgress(cursor({ reached: new Date(NOW - 30 * DAY).toISOString(), runs: 1 }), NOW)
    expect(p).toMatchObject({ percent: 25, runsLeft: 3 })
  })

  it('polovina za 2 běhy → zbývají 2; skoro hotovo nikdy nepřeleze 99 %', () => {
    expect(mailSyncProgress(cursor({ reached: new Date(NOW - 60 * DAY).toISOString(), runs: 2 }), NOW)).toMatchObject({ percent: 50, runsLeft: 2 })
    const almost = mailSyncProgress(cursor({ reached: new Date(NOW - 121 * DAY).toISOString(), runs: 5 }), NOW)
    expect(almost?.percent).toBe(99)
    expect(almost?.runsLeft).toBe(1)
  })

  it('bez načtené stránky nebo se zanedbatelným postupem odhad není', () => {
    expect(mailSyncProgress(cursor({}), NOW)).toMatchObject({ percent: 0, reachedAt: null, runsLeft: null })
    expect(mailSyncProgress(cursor({ reached: new Date(NOW - 1 * DAY).toISOString(), runs: 1 }), NOW)?.runsLeft).toBeNull()
  })

  it('věta říká „načteno zpět do data", procenta a odhad běhů', () => {
    const p = mailSyncProgress(cursor({ reached: new Date(NOW - 30 * DAY).toISOString(), runs: 1 }), NOW)!
    const text = describeProgress(p)
    expect(text).toContain('načteno zpět do')
    expect(text).toContain('25 %')
    expect(text).toContain('ještě asi 3 běhy')
    expect(describeProgress({ ...p, runsLeft: null })).toContain('Odhad zbývajících běhů bude po prvních bězích')
  })

  it('describeFolderStatus místo holého „probíhá" ukáže postup; kurzor bez okna zůstává u starého textu', () => {
    const state = (c: string): ConnectorState => ({
      connector: 'outlook:sent', cursor: c, last_success_at: null, last_error: null, last_error_at: null,
      consecutive_errors: 0, updated_at: new Date(NOW - 3600_000).toISOString(),
    })
    const withWindow = describeFolderStatus(
      state(serializeCursor({ phase: 'paging', link: `${G}/x`, since, reached: new Date(NOW - 60 * DAY).toISOString(), runs: 2 })),
      36, NOW,
    )
    expect(withWindow.tone).toBe('warn')
    expect(withWindow.message).toContain('hotovo asi 50 %')
    const legacy = describeFolderStatus(state(serializeCursor({ phase: 'paging', link: `${G}/x` })), 36, NOW)
    expect(legacy.message).toContain('první načtení historie')
    expect(legacy.message).not.toContain('%')
  })
})

describe('ruční běh: oprávnění, odstup, věta o výsledku', () => {
  it('smí správce a obchodní role, ostatní ne, deaktivovaný nikdy', () => {
    expect(canRunMailSyncNow({ is_admin: true, role: 'projektak' }, false)).toBe(true)
    expect(canRunMailSyncNow({ is_admin: false, role: 'obchodnik' }, true)).toBe(true)
    expect(canRunMailSyncNow({ is_admin: false, role: 'projektak' }, false)).toBe(false)
    expect(canRunMailSyncNow({ is_admin: true, deactivated_at: '2026-09-01T00:00:00Z' }, true)).toBe(false)
    expect(canRunMailSyncNow(null, true)).toBe(false)
  })

  it('odstup 60 s od startu posledního běhu', () => {
    expect(MANUAL_RUN_MIN_INTERVAL_MS).toBe(60_000)
    expect(manualRunWaitSeconds(null, NOW)).toBe(0)
    expect(manualRunWaitSeconds(new Date(NOW - 20_000).toISOString(), NOW)).toBe(40)
    expect(manualRunWaitSeconds(new Date(NOW - 61_000).toISOString(), NOW)).toBe(0)
    expect(manualRunWaitSeconds('nesmysl', NOW)).toBe(0)
  })

  it('věta o výsledku: jen počty a stavy', () => {
    const fs = (over: object) => ({ outcome: 'more_pending', pages: 3, inserted: 120, matched: 5, skipped: {}, resyncs: 0, ...over })
    const text = describeManualRun({
      folders: { inbox: fs({}), sent: fs({ outcome: 'caught_up', pages: 1, inserted: 4 }) },
    } as never)
    expect(text).toContain('Doručená: načtena další část (3 str., 120 nových zpráv), zbývá ještě část.')
    expect(text).toContain('Odeslaná: dotažena (1 str., 4 nových zpráv).')
    expect(describeManualRun({ folders: { inbox: fs({ outcome: 'not_started' }), sent: fs({ outcome: 'throttled' }) } } as never))
      .toContain('nepřišla řada')
  })
})
