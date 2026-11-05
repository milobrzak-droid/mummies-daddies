import { describe, expect, it } from 'vitest'
import {
  accountUpdates,
  decideThrottle,
  messageToEvent,
  MISSING_SCOPE_ERROR,
  nextCursorAfterPage,
  parseCursor,
  resolveAccessToken,
  runMailSync,
  sanitizeMailWebLink,
  serializeCursor,
  type MailEventRow,
  type MailEvidenceRef,
  type MailSyncDb,
  type MatchData,
} from '@/domain/crm/mailSync'
import { mailDeltaStartUrl, type GraphMailMessage, type MailDeltaResult } from '@/connectors/graph'

const G = 'https://graph.microsoft.com/v1.0'
const match: MatchData = {
  contacts: [{ id: 7, email: 'jana@acme.cz', account_id: 1 }],
  aliases: [{ domain: 'beta.cz', account_id: 2 }],
}

function msg(over: Partial<GraphMailMessage> & { id: string }): GraphMailMessage {
  return {
    internetMessageId: `<${over.id}@x>`,
    from: { emailAddress: { address: 'jana@acme.cz' } },
    toRecipients: [{ emailAddress: { address: 'viktor@mummiesdaddies.com' } }],
    ccRecipients: [],
    receivedDateTime: '2026-09-01T10:00:00Z',
    sentDateTime: '2026-09-01T09:59:00Z',
    isDraft: false,
    ...over,
  }
}

function fakeDb(initial: Record<string, string | null> = {}) {
  const cursors = new Map<string, string | null>(Object.entries(initial))
  const events = new Map<string, MailEventRow>()
  const applied: { accountId: number; direction: string; occurredAt: string }[] = []
  const errors: { connector: string; error: string }[] = []
  const successes: string[] = []
  const cursorLog: { connector: string; cursor: string | null }[] = []
  const evidenceCalls: MailEvidenceRef[][] = []
  const attempts: string[] = []
  let matchLoads = 0
  let purges = 0
  const db: MailSyncDb = {
    async loadCursor(c) { return cursors.get(c) ?? null },
    async saveCursor(c, v) { cursors.set(c, v); cursorLog.push({ connector: c, cursor: v }) },
    async recordSuccess(c) { successes.push(c) },
    async recordError(c, e) { errors.push({ connector: c, error: e }) },
    async loadMatchData() { matchLoads++; return match },
    async insertEvents(rows) {
      let n = 0
      for (const r of rows) {
        const k = `${r.internet_message_id}|${r.direction}`
        if (!events.has(k)) { events.set(k, r); n++ }
      }
      return n
    },
    async applyToAccount(accountId, direction, occurredAt) { applied.push({ accountId, direction, occurredAt }) },
    async purgeUnmatchedEvents() { purges++; return 3 },
    async recordEvidence(refs) { evidenceCalls.push(refs) },
    async markAttempt(c) { attempts.push(c) },
  }
  return { db, attempts, cursors, events, applied, errors, successes, cursorLog, evidenceCalls, matchLoads: () => matchLoads, purges: () => purges }
}

/** Fake Graph: fronta odpovědí podle URL. */
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

function clock() {
  const c = { t: 0, slept: [] as number[] }
  return { c, now: () => c.t, sleep: async (ms: number) => { c.slept.push(ms); c.t += ms } }
}

const page = (messages: GraphMailMessage[], next: string | null, delta: string | null): MailDeltaResult =>
  ({ kind: 'page', messages, nextLink: next, deltaLink: delta })

const INBOX = mailDeltaStartUrl('inbox')
const SENT = mailDeltaStartUrl('sentitems')

describe('kurzor', () => {
  it('serializuje a parsuje', () => {
    const c = { phase: 'delta' as const, link: `${G}/x?$deltatoken=1` }
    expect(parseCursor(serializeCursor(c))).toEqual(c)
  })
  it('odmítne nesmysl i cizí host', () => {
    expect(parseCursor(null)).toBeNull()
    expect(parseCursor('nejson')).toBeNull()
    expect(parseCursor(JSON.stringify({ phase: 'delta', link: 'https://evil.example/x' }))).toBeNull()
    expect(parseCursor(JSON.stringify({ phase: 'boom', link: `${G}/x` }))).toBeNull()
  })
  it('nextLink má přednost, deltaLink končí složku', () => {
    expect(nextCursorAfterPage({ nextLink: 'n', deltaLink: null })).toEqual({ cursor: { phase: 'paging', link: 'n' }, done: false })
    expect(nextCursorAfterPage({ nextLink: null, deltaLink: 'd' })).toEqual({ cursor: { phase: 'delta', link: 'd' }, done: true })
    expect(nextCursorAfterPage({ nextLink: null, deltaLink: null })).toBeNull()
  })
})

describe('decideThrottle', () => {
  const base = { attempt: 0, maxAttempts: 3, remainingMs: 40_000, maxWaitMs: 20_000 }
  it('počká, když se to vejde', () => {
    expect(decideThrottle({ ...base, retryAfterSeconds: 5 })).toEqual({ action: 'wait', waitMs: 5000 })
  })
  it('skončí při dlouhém Retry-After, malém rozpočtu nebo vyčerpaných pokusech', () => {
    expect(decideThrottle({ ...base, retryAfterSeconds: 30 }).action).toBe('stop')
    expect(decideThrottle({ ...base, retryAfterSeconds: 10, remainingMs: 12_000 }).action).toBe('stop')
    expect(decideThrottle({ ...base, retryAfterSeconds: 1, attempt: 3 }).action).toBe('stop')
  })
})

describe('messageToEvent', () => {
  it('příchozí od známého kontaktu = matched, bez předmětu a těla', () => {
    const m = { ...msg({ id: 'a' }), subject: 'TAJNÉ', body: { content: 'x' }, bodyPreview: 'y' } as GraphMailMessage
    const r = messageToEvent(m, 'inbound', match)
    expect(r).toEqual({
      row: {
        internet_message_id: '<a@x>', direction: 'inbound', occurred_at: '2026-09-01T10:00:00.000Z',
        account_id: 1, contact_id: 7, match_status: 'matched', counterpart_domain: null,
      },
    })
    expect(JSON.stringify(r)).not.toMatch(/TAJNÉ|bodyPreview|jana@/)
  })
  it('odchozí používá sentDateTime a příjemce to+cc', () => {
    const r = messageToEvent(
      msg({ id: 'b', from: { emailAddress: { address: 'viktor@mummiesdaddies.com' } }, toRecipients: [{ emailAddress: { address: 'x@beta.cz' } }] }),
      'outbound', match,
    )
    expect(r).toMatchObject({ row: { direction: 'outbound', account_id: 2, occurred_at: '2026-09-01T09:59:00.000Z' } })
  })
  it('neznámá firma nese jen doménu', () => {
    const r = messageToEvent(msg({ id: 'c', from: { emailAddress: { address: 'p@nova.cz' } } }), 'inbound', match)
    expect(r).toMatchObject({ row: { match_status: 'unknown', counterpart_domain: 'nova.cz', account_id: null } })
  })
  it('přeskočí koncept, interní, smazané, bez id a bez data', () => {
    expect(messageToEvent(msg({ id: 'd', isDraft: true }), 'inbound', match)).toEqual({ skip: 'draft' })
    expect(messageToEvent(msg({ id: 'e', from: { emailAddress: { address: 'kolega@mummiesdaddies.com' } } }), 'inbound', match)).toEqual({ skip: 'internal' })
    expect(messageToEvent({ id: 'f', '@removed': { reason: 'deleted' } }, 'inbound', match)).toEqual({ skip: 'removed' })
    expect(messageToEvent(msg({ id: 'g', internetMessageId: null }), 'inbound', match)).toEqual({ skip: 'no_message_id' })
    expect(messageToEvent(msg({ id: 'h', receivedDateTime: 'zítra' }), 'inbound', match)).toEqual({ skip: 'no_date' })
  })
})

describe('accountUpdates', () => {
  it('bere nejnovější čas na firmu a směr, ignoruje nespárované', () => {
    const r = (id: string, acc: number | null, at: string): MailEventRow => ({
      internet_message_id: id, direction: 'inbound', occurred_at: at, account_id: acc, contact_id: null,
      match_status: acc ? 'matched' : 'unknown', counterpart_domain: null,
    })
    expect(accountUpdates([r('1', 1, '2026-01-01T00:00:00Z'), r('2', 1, '2026-02-01T00:00:00Z'), r('3', null, '2026-03-01T00:00:00Z')]))
      .toEqual([{ account_id: 1, direction: 'inbound', occurred_at: '2026-02-01T00:00:00Z' }])
  })
})

describe('sanitizeMailWebLink', () => {
  it('projde https na oba povolené Outlook hosty', () => {
    expect(sanitizeMailWebLink('https://outlook.office.com/mail/x')).toBe('https://outlook.office.com/mail/x')
    expect(sanitizeMailWebLink('https://outlook.office365.com/owa/?ItemID=x')).toBe('https://outlook.office365.com/owa/?ItemID=x')
  })
  it('zahodí cizí host, http, nesmysl i prázdno', () => {
    expect(sanitizeMailWebLink('https://evil.example/x')).toBeNull()
    expect(sanitizeMailWebLink('http://outlook.office.com/mail/x')).toBeNull()
    expect(sanitizeMailWebLink('https://outlook.office.com.evil.example/x')).toBeNull()
    expect(sanitizeMailWebLink('nejsem URL')).toBeNull()
    expect(sanitizeMailWebLink(null)).toBeNull()
    expect(sanitizeMailWebLink(undefined)).toBeNull()
    expect(sanitizeMailWebLink('')).toBeNull()
  })
})

describe('resolveAccessToken', () => {
  const now = () => Date.parse('2026-09-01T12:00:00Z')
  it('platný token vrátí bez obnovy', async () => {
    const t = await resolveAccessToken({
      load: async () => ({ access_token: 'A', refresh_token: 'R', expires_at: '2026-09-01T13:00:00Z' }),
      refresh: async () => { throw new Error('ne') },
      save: async () => true,
      now,
    })
    expect(t).toBe('A')
  })
  it('prošlý obnoví a uloží rotovaný refresh token', async () => {
    const saved: unknown[] = []
    const t = await resolveAccessToken({
      load: async () => ({ access_token: 'A', refresh_token: 'R', expires_at: '2026-09-01T12:00:30Z' }),
      refresh: async () => ({ access_token: 'B', refresh_token: 'R2', expires_in: 3600 }),
      save: async (x) => { saved.push(x); return true },
      now,
    })
    expect(t).toBe('B')
    expect(saved).toEqual([{ access_token: 'B', refresh_token: 'R2', expires_at: '2026-09-01T13:00:00.000Z' }])
  })
  it('selže bez tokenu, při neúspěšné obnově i neuloženém tokenu', async () => {
    const base = { refresh: async () => ({ access_token: 'B', refresh_token: 'R2', expires_in: 1 }), save: async () => true, now }
    await expect(resolveAccessToken({ ...base, load: async () => null })).rejects.toThrow()
    const expired = async () => ({ access_token: 'A', refresh_token: 'R', expires_at: null })
    await expect(resolveAccessToken({ ...base, load: expired, refresh: async () => null })).rejects.toThrow()
    await expect(resolveAccessToken({ ...base, load: expired, save: async () => false })).rejects.toThrow()
  })
})

describe('runMailSync', () => {
  it('první běh: stránkuje obě složky, ukládá kurzor po každé stránce, hlásí úspěch', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [page([msg({ id: '1' }), msg({ id: '2', isDraft: true })], `${G}/in?skip=1`, null)],
      [`${G}/in?skip=1`]: [page([msg({ id: '3', from: { emailAddress: { address: 'p@nova.cz' } } })], null, `${G}/in?delta=1`)],
      [SENT]: [page([msg({ id: '4', toRecipients: [{ emailAddress: { address: 'jana@acme.cz' } }] })], null, `${G}/sent?delta=1`)],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })

    expect(s.pages).toBe(3)
    expect(s.folders.inbox).toMatchObject({ outcome: 'caught_up', pages: 2, inserted: 2, matched: 1, skipped: { draft: 1 } })
    expect(s.folders.sent).toMatchObject({ outcome: 'caught_up', inserted: 1, matched: 1 })
    expect(f.cursorLog.map((c) => [c.connector, parseCursor(c.cursor)?.phase])).toEqual([
      ['outlook:inbox', 'paging'], ['outlook:inbox', 'delta'], ['outlook:sent', 'delta'],
    ])
    expect(f.successes).toEqual(['outlook:inbox', 'outlook:sent'])
    expect(f.applied.map((a) => [a.accountId, a.direction])).toEqual([[1, 'inbound'], [1, 'outbound']])
    expect(f.matchLoads()).toBe(1)
  })

  it('další běh pokračuje z uloženého delta odkazu a duplicity nezapíše', async () => {
    const f = fakeDb({
      'outlook:inbox': serializeCursor({ phase: 'delta', link: `${G}/in?delta=1` }),
      'outlook:sent': serializeCursor({ phase: 'delta', link: `${G}/sent?delta=1` }),
    })
    await f.db.insertEvents([messageToEvent(msg({ id: '1' }), 'inbound', match) as never].map((r) => (r as { row: MailEventRow }).row))
    const { now, sleep } = clock()
    const g = fakeGraph({
      [`${G}/in?delta=1`]: [page([msg({ id: '1' })], null, `${G}/in?delta=2`)],
      [`${G}/sent?delta=1`]: [page([], null, `${G}/sent?delta=2`)],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(g.calls).not.toContain(INBOX)
    expect(s.folders.inbox.inserted).toBe(0)
    // apply se volá i pro duplicitu — je idempotentní a chrání před pádem mezi insertem a apply
    expect(f.applied).toHaveLength(1)
    expect(parseCursor(f.cursors.get('outlook:inbox'))?.link).toBe(`${G}/in?delta=2`)
  })

  it('limit stránek: složky se o něj dělí férově, kurzor zůstane na poslední zapsané stránce', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const script: Record<string, MailDeltaResult[]> = {
      [INBOX]: [page([], `${G}/p1`, null)],
      [SENT]: [page([], `${G}/s1`, null)],
    }
    for (let i = 1; i < 30; i++) {
      script[`${G}/p${i}`] = [page([], `${G}/p${i + 1}`, null)]
      script[`${G}/s${i}`] = [page([], `${G}/s${i + 1}`, null)]
    }
    const g = fakeGraph(script)
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep }, { maxPages: 4 })
    expect(s.pages).toBe(4)
    expect(s.folders.inbox).toMatchObject({ outcome: 'more_pending', pages: 2 })
    // Regrese: Odeslaná dřív zůstávala `not_started` a bez jediné stopy.
    expect(s.folders.sent).toMatchObject({ outcome: 'more_pending', pages: 2 })
    expect(parseCursor(f.cursors.get('outlook:inbox'))).toEqual({ phase: 'paging', link: `${G}/p2`, runs: 1 })
    expect(parseCursor(f.cursors.get('outlook:sent'))).toEqual({ phase: 'paging', link: `${G}/s2`, runs: 1 })
    expect(f.successes).toEqual([])
    expect(f.attempts).toEqual(['outlook:inbox', 'outlook:sent'])
  })

  it('výchozí limit 20 stránek: nekonečná historie Doručené nesní celý běh, Odeslaná dostane 10 stránek', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const script: Record<string, MailDeltaResult[]> = {
      [INBOX]: [page([], `${G}/p1`, null)],
      [SENT]: [page([], `${G}/s1`, null)],
    }
    for (let i = 1; i < 60; i++) {
      script[`${G}/p${i}`] = [page([], `${G}/p${i + 1}`, null)]
      script[`${G}/s${i}`] = [page([], `${G}/s${i + 1}`, null)]
    }
    const s = await runMailSync({ fetchPage: fakeGraph(script).fetchPage, db: f.db, now, sleep })
    expect(s.folders.inbox.pages).toBe(10)
    expect(s.folders.sent.pages).toBe(10)
    expect(f.cursors.has('outlook:sent')).toBe(true)
  })

  it('Doručená dotažená po jedné stránce přenechá zbytek limitu Odeslané', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const script: Record<string, MailDeltaResult[]> = {
      [INBOX]: [page([], null, `${G}/in?delta`)],
      [SENT]: [page([], `${G}/s1`, null)],
    }
    for (let i = 1; i < 60; i++) script[`${G}/s${i}`] = [page([], `${G}/s${i + 1}`, null)]
    const s = await runMailSync({ fetchPage: fakeGraph(script).fetchPage, db: f.db, now, sleep }, { maxPages: 6 })
    expect(s.folders.inbox.outcome).toBe('caught_up')
    expect(s.folders.sent.pages).toBe(5)
  })

  it('složka na kterou nezbylo nic (limit vyčerpán před ní) nezůstane beze stopy: zapíše se čas pokusu', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const g = fakeGraph({ [INBOX]: [page([], null, `${G}/in?delta`)], [SENT]: [page([], null, `${G}/s?d`)] })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep }, { maxPages: 0 })
    expect(s.folders.sent.outcome).toBe('not_started')
    expect(g.calls).toEqual([])
    expect(f.attempts).toEqual(['outlook:inbox', 'outlook:sent'])
  })

  it('výjimka v Doručené: chyba se zapíše u ní, Odeslaná se přesto dotáhne, výjimka jde nahoru', async () => {
    const f = fakeDb()
    let first = true
    const orig = f.db.insertEvents
    f.db.insertEvents = async (rows) => {
      if (first) { first = false; throw new Error('db down') }
      return orig(rows)
    }
    const { now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [page([msg({ id: '1' })], `${G}/p1`, null)],
      [SENT]: [page([msg({ id: '4', toRecipients: [{ emailAddress: { address: 'jana@acme.cz' } }] })], null, `${G}/sent?d`)],
    })
    await expect(runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })).rejects.toThrow('db down')
    expect(f.errors).toEqual([{ connector: 'outlook:inbox', error: 'Synchronizace složky selhala: db down' }])
    expect(f.successes).toEqual(['outlook:sent'])
    expect(f.events.size).toBe(1)
  })

  it('výjimka v Odeslané se zapíše jako chyba její složky (dřív bez stopy → „nikdy")', async () => {
    const f = fakeDb()
    f.db.insertEvents = async (rows) => {
      if (rows.some((r) => r.direction === 'outbound')) throw new Error('mail_event: check violation')
      return rows.length
    }
    const { now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [page([msg({ id: '1' })], null, `${G}/in?d`)],
      [SENT]: [page([msg({ id: '4', toRecipients: [{ emailAddress: { address: 'jana@acme.cz' } }] })], null, `${G}/s?d`)],
    })
    await expect(runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })).rejects.toThrow('check violation')
    expect(f.errors).toEqual([{ connector: 'outlook:sent', error: 'Synchronizace složky selhala: mail_event: check violation' }])
    expect(f.successes).toEqual(['outlook:inbox'])
  })

  it('markAttempt je volitelné a jeho selhání sync neshodí', async () => {
    const f = fakeDb()
    f.db.markAttempt = async () => { throw new Error('nelze zapsat') }
    const { now, sleep } = clock()
    const script: Record<string, MailDeltaResult[]> = { [INBOX]: [page([], `${G}/p1`, null)], [SENT]: [page([], `${G}/s1`, null)] }
    for (let i = 1; i < 30; i++) { script[`${G}/p${i}`] = [page([], `${G}/p${i + 1}`, null)]; script[`${G}/s${i}`] = [page([], `${G}/s${i + 1}`, null)] }
    const s = await runMailSync({ fetchPage: fakeGraph(script).fetchPage, db: f.db, now, sleep }, { maxPages: 2 })
    expect(s.folders.sent.pages).toBe(1)
    delete f.db.markAttempt
    await expect(runMailSync({ fetchPage: fakeGraph(script).fetchPage, db: f.db, now, sleep }, { maxPages: 2 })).resolves.toBeDefined()
  })

  it('jediná složka (webhook) dostane celý limit', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const script: Record<string, MailDeltaResult[]> = { [SENT]: [page([], `${G}/s1`, null)] }
    for (let i = 1; i < 30; i++) script[`${G}/s${i}`] = [page([], `${G}/s${i + 1}`, null)]
    const s = await runMailSync({ fetchPage: fakeGraph(script).fetchPage, db: f.db, now, sleep }, { folders: ['sent'], maxPages: 7 })
    expect(s.folders.sent.pages).toBe(7)
  })

  it('časový rozpočet: nezačne další požadavek, když nezbývá čas; Odeslaná dostane svůj podíl času', async () => {
    const f = fakeDb()
    const { c, now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [page([], `${G}/p1`, null)],
      [`${G}/p1`]: [page([], `${G}/p2`, null)],
      [SENT]: [page([], `${G}/s1`, null)],
      [`${G}/s1`]: [page([], `${G}/s2`, null)],
    })
    const fetchPage = async (u: string) => { c.t += 20_000; return g.fetchPage(u) }
    const s = await runMailSync({ fetchPage, db: f.db, now, sleep }, { budgetMs: 50_000 })
    // Doručená smí začít požadavek jen do poloviny použitelného času (17,5 s) → jedna stránka;
    // Odeslané zbylo 30 s, tedy jedna stránka (další by už nevešla rezervu 15 s).
    expect(s.folders.inbox.pages).toBe(1)
    expect(s.folders.sent.pages).toBe(1)
    expect(g.calls).toHaveLength(2)
    expect(f.attempts).toEqual(['outlook:inbox', 'outlook:sent'])
  })

  it('429: počká Retry-After a zkusí znovu', async () => {
    const f = fakeDb()
    const { c, now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [{ kind: 'throttled', retryAfterSeconds: 2 }, page([msg({ id: '1' })], null, `${G}/in?d`)],
      [SENT]: [page([], null, `${G}/s?d`)],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(c.slept).toEqual([2000])
    expect(s.folders.inbox.outcome).toBe('caught_up')
  })

  it('429 s čekáním nad rozpočet: nečeká, kurzor nemění, skončí', async () => {
    const f = fakeDb({ 'outlook:inbox': serializeCursor({ phase: 'paging', link: `${G}/p5` }) })
    const { c, now, sleep } = clock()
    const g = fakeGraph({
      [`${G}/p5`]: [{ kind: 'throttled', retryAfterSeconds: 120 }],
      [SENT]: [{ kind: 'throttled', retryAfterSeconds: 120 }],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(c.slept).toEqual([])
    expect(s.folders.inbox.outcome).toBe('throttled')
    expect(f.cursorLog).toEqual([])
    expect(parseCursor(f.cursors.get('outlook:inbox'))?.link).toBe(`${G}/p5`)
  })

  it('429 opakovaně: po maxThrottleAttempts přestane', async () => {
    const f = fakeDb()
    const { c, now, sleep } = clock()
    const g = fakeGraph({ [INBOX]: [{ kind: 'throttled', retryAfterSeconds: 1 }], [SENT]: [page([], null, `${G}/s?d`)] })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep }, { maxThrottleAttempts: 2 })
    expect(c.slept).toEqual([1000, 1000])
    expect(s.folders.inbox.outcome).toBe('throttled')
    expect(s.folders.sent.outcome).toBe('caught_up')
  })

  it('expirovaný delta token: smaže kurzor, zapíše chybu a jednou začne znovu', async () => {
    const f = fakeDb({ 'outlook:inbox': serializeCursor({ phase: 'delta', link: `${G}/old` }) })
    const { now, sleep } = clock()
    const g = fakeGraph({
      [`${G}/old`]: [{ kind: 'expired' }],
      [INBOX]: [page([msg({ id: '1' })], null, `${G}/in?d`)],
      [SENT]: [page([], null, `${G}/s?d`)],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(f.cursorLog[0]).toEqual({ connector: 'outlook:inbox', cursor: null })
    expect(f.errors.map((e) => e.connector)).toEqual(['outlook:inbox'])
    expect(s.folders.inbox).toMatchObject({ outcome: 'caught_up', resyncs: 1 })
  })

  it('expirace i po resyncu: omezeno, skončí jako expired', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const g = fakeGraph({ [INBOX]: [{ kind: 'expired' }], [SENT]: [page([], null, `${G}/s?d`)] })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(s.folders.inbox).toMatchObject({ outcome: 'expired', resyncs: 1 })
    expect(g.calls.filter((u) => u === INBOX)).toHaveLength(2)
  })

  it('chyba Graphu: zapíše chybu konektoru, kurzor nechá a pokračuje další složkou', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [{ kind: 'error', status: 500, message: 'Graph 500 generalException' }],
      [SENT]: [page([], null, `${G}/s?d`)],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(s.folders.inbox.outcome).toBe('error')
    expect(f.errors).toEqual([{ connector: 'outlook:inbox', error: 'Graph 500 generalException' }])
    expect(f.cursors.has('outlook:inbox')).toBe(false)
    expect(s.folders.sent.outcome).toBe('caught_up')
  })

  it('selhání zápisu událostí: kurzor se neposune a výjimka jde nahoru (runJob → failed)', async () => {
    const f = fakeDb()
    f.db.insertEvents = async () => { throw new Error('db down') }
    const { now, sleep } = clock()
    const g = fakeGraph({ [INBOX]: [page([msg({ id: '1' })], `${G}/p1`, null)] })
    await expect(runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })).rejects.toThrow('db down')
    expect(f.cursorLog).toEqual([])
    // Retence proběhne i po pádu syncu.
    expect(f.purges()).toBe(1)
  })

  it('token bez Mail.Read (403): chyba u obou složek, sent se už nevolá, kurzor zůstane, žádné čekání', async () => {
    const saved = serializeCursor({ phase: 'delta', link: `${G}/old` })
    const f = fakeDb({ 'outlook:inbox': saved })
    const { c, now, sleep } = clock()
    const g = fakeGraph({ [`${G}/old`]: [{ kind: 'forbidden', code: 'ErrorAccessDenied' }] })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(s.missingScope).toBe(true)
    expect(g.calls).toEqual([`${G}/old`])
    expect(c.slept).toEqual([])
    expect(s.folders.inbox).toMatchObject({ outcome: 'missing_scope', error: MISSING_SCOPE_ERROR })
    expect(s.folders.sent).toMatchObject({ outcome: 'missing_scope', error: MISSING_SCOPE_ERROR })
    expect(f.errors).toEqual([
      { connector: 'outlook:inbox', error: MISSING_SCOPE_ERROR },
      { connector: 'outlook:sent', error: MISSING_SCOPE_ERROR },
    ])
    expect(MISSING_SCOPE_ERROR).toContain('Mail.Read')
    expect(MISSING_SCOPE_ERROR).toContain('Nastavení')
    expect(f.cursors.get('outlook:inbox')).toBe(saved)
    expect(f.successes).toEqual([])
    expect(f.purges()).toBe(1)
  })

  it('na konci každého běhu zavolá purge a výsledek dá do statistik', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const g = fakeGraph({ [INBOX]: [page([], null, `${G}/in?d`)], [SENT]: [page([], null, `${G}/s?d`)] })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(f.purges()).toBe(1)
    expect(s.purged).toBe(3)
    expect(s.purgeError).toBeUndefined()
  })

  it('selhání purge běh neshodí, jen se objeví ve statistikách', async () => {
    const f = fakeDb()
    f.db.purgeUnmatchedEvents = async () => { throw new Error('rpc down') }
    const { now, sleep } = clock()
    const g = fakeGraph({ [INBOX]: [page([], null, `${G}/in?d`)], [SENT]: [page([], null, `${G}/s?d`)] })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(s.purged).toBeNull()
    expect(s.purgeError).toBe('rpc down')
    expect(s.folders.inbox.outcome).toBe('caught_up')
  })

  it('evidence: zapíše jen spárované zprávy, webLink jen z povoleného Outlook hostu', async () => {
    const f = fakeDb()
    const { now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [
        page(
          [
            msg({ id: '1', webLink: 'https://outlook.office.com/mail/1' }),
            msg({ id: '2', from: { emailAddress: { address: 'p@nova.cz' } }, webLink: 'https://outlook.office.com/mail/2' }),
            msg({ id: '3', webLink: 'https://evil.example/mail/3' }),
          ],
          null,
          `${G}/in?delta=1`,
        ),
      ],
      [SENT]: [page([], null, `${G}/sent?delta=1`)],
    })
    await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })

    // msg 2 je unknown (nová doména) → žádná evidence; msg 3 má cizí host → webLink null.
    expect(f.evidenceCalls).toEqual([
      [
        { internetMessageId: '<1@x>', webLink: 'https://outlook.office.com/mail/1' },
        { internetMessageId: '<3@x>', webLink: null },
      ],
    ])
  })

  it('evidence: selhání zápisu sync neshodí ani nezpomalí — kurzor se posune dál', async () => {
    const f = fakeDb()
    f.db.recordEvidence = async () => { throw new Error('evidence db down') }
    const { now, sleep } = clock()
    const g = fakeGraph({
      [INBOX]: [page([msg({ id: '1' })], null, `${G}/in?delta=1`)],
      [SENT]: [page([], null, `${G}/sent?delta=1`)],
    })
    const s = await runMailSync({ fetchPage: g.fetchPage, db: f.db, now, sleep })
    expect(s.folders.inbox).toMatchObject({ outcome: 'caught_up', inserted: 1, matched: 1 })
    expect(f.successes).toEqual(['outlook:inbox', 'outlook:sent'])
  })
})
