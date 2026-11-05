// Outlook pošta přes kontrakt konektorů (domain/crm/mailConnector.ts,
// kapitola 11). Hlavní tvrzení: adaptér NEMĚNÍ chování syncu — stejné Graph
// odpovědi dají s adaptérem i bez něj totožné volání DB (včetně pořadí),
// totožné statistiky i totožnou evidenci. Normalizované události jsou jen
// jiný pohled na tytéž zapsané řádky.
import { describe, expect, it } from 'vitest'
import {
  FOLDERS,
  runMailSync,
  type MailEventRow,
  type MailEvidenceRef,
  type MailSyncDb,
  type MatchData,
} from '@/domain/crm/mailSync'
import {
  OUTLOOK_MAIL_CONNECTORS,
  eventEvidenceRef,
  folderSyncResult,
  mailRowToEvent,
  runOutlookMailConnector,
} from '@/domain/crm/mailConnector'
import { descriptorIssues, normalizedEventIssues, stateWriteFor } from '@/core/connectors/contract'
import { mailDeltaStartUrl, type GraphMailMessage, type MailDeltaResult } from '@/connectors/graph'

const G = 'https://graph.microsoft.com/v1.0'
const match: MatchData = {
  contacts: [{ id: 7, email: 'jana@acme.cz', account_id: 1 }],
  aliases: [{ domain: 'beta.cz', account_id: 2 }],
  ourDomain: 'nase-firma.test',
}
const OUR = 'obchod@nase-firma.test'

function msg(over: Partial<GraphMailMessage> & { id: string }): GraphMailMessage {
  return {
    internetMessageId: `<${over.id}@x>`,
    from: { emailAddress: { address: 'jana@acme.cz' } },
    toRecipients: [{ emailAddress: { address: OUR } }],
    ccRecipients: [],
    receivedDateTime: '2026-09-27T10:00:00Z',
    sentDateTime: '2026-09-27T09:59:00Z',
    isDraft: false,
    webLink: `https://outlook.office.com/mail/id/${over.id}`,
    ...over,
  }
}

type Call = [string, ...unknown[]]

/** Fake DB, která zapisuje KAŽDÉ volání (jméno + argumenty) v pořadí. */
function recordingDb() {
  const calls: Call[] = []
  const cursors = new Map<string, string | null>()
  const events = new Map<string, MailEventRow>()
  const db: MailSyncDb = {
    async loadCursor(c) { calls.push(['loadCursor', c]); return cursors.get(c) ?? null },
    async saveCursor(c, v) { calls.push(['saveCursor', c, v]); cursors.set(c, v) },
    async recordSuccess(c, v) { calls.push(['recordSuccess', c, v]) },
    async recordError(c, e) { calls.push(['recordError', c, e]) },
    async loadMatchData() { calls.push(['loadMatchData']); return match },
    async insertEvents(rows) {
      calls.push(['insertEvents', rows.map((r) => ({ ...r }))])
      let n = 0
      for (const r of rows) {
        const k = `${r.internet_message_id}|${r.direction}`
        if (!events.has(k)) { events.set(k, r); n++ }
      }
      return n
    },
    async applyToAccount(a, d, t) { calls.push(['applyToAccount', a, d, t]) },
    async purgeUnmatchedEvents() { calls.push(['purge']); return 2 },
    async recordEvidence(refs) { calls.push(['recordEvidence', refs.map((r) => ({ ...r }))]) },
  }
  return { db, calls }
}

function fakeGraph(script: Record<string, MailDeltaResult[]>) {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]))
  return async (url: string): Promise<MailDeltaResult> => {
    const q = queues[url]
    if (!q || q.length === 0) throw new Error(`nečekané URL ${url}`)
    return q.length > 1 ? q.shift()! : q[0]
  }
}

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

const page = (messages: GraphMailMessage[], next: string | null, delta: string | null): MailDeltaResult =>
  ({ kind: 'page', messages, nextLink: next, deltaLink: delta })

const INBOX = mailDeltaStartUrl('inbox')
const SENT = mailDeltaStartUrl('sentitems')

// Scénáře: stejné Graph odpovědi pro oba běhy.
const SCENARIOS: Record<string, () => Record<string, MailDeltaResult[]>> = {
  'dvě stránky Doručené + Odeslané, spárované i nespárované': () => ({
    [INBOX]: [page([
      msg({ id: 'a' }),
      msg({ id: 'b', from: { emailAddress: { address: 'x@beta.cz' } } }),
      msg({ id: 'c', from: { emailAddress: { address: 'neznamy@firma.test' } } }),
      msg({ id: 'd', from: { emailAddress: { address: 'kolega@nase-firma.test' } } }),
      msg({ id: 'e', isDraft: true }),
    ], `${G}/inbox?page=2`, null)],
    [`${G}/inbox?page=2`]: [page([msg({ id: 'f', webLink: 'https://evil.example/x' })], null, `${G}/inbox?delta=1`)],
    [SENT]: [page([
      msg({ id: 's1', from: { emailAddress: { address: OUR } }, toRecipients: [{ emailAddress: { address: 'jana@acme.cz' } }] }),
    ], null, `${G}/sent?delta=1`)],
  }),
  'vypršelý delta token → resync': () => ({
    [INBOX]: [{ kind: 'expired' }, page([msg({ id: 'r' })], null, `${G}/inbox?delta=2`)],
    [SENT]: [page([], null, `${G}/sent?delta=2`)],
  }),
  'throttling a chyba': () => ({
    [INBOX]: [{ kind: 'throttled', retryAfterSeconds: 60 }],
    [SENT]: [{ kind: 'error', status: 500, message: 'Graph 500' }],
  }),
  'token bez Mail.Read': () => ({
    [INBOX]: [{ kind: 'forbidden', code: 'ErrorAccessDenied' }],
  }),
}

async function runBoth(name: string) {
  const plain = recordingDb()
  const c1 = clock()
  const plainStats = await runMailSync({ fetchPage: fakeGraph(SCENARIOS[name]()), db: plain.db, ...c1 })
  const adapted = recordingDb()
  const c2 = clock()
  const run = await runOutlookMailConnector({ fetchPage: fakeGraph(SCENARIOS[name]()), db: adapted.db, ...c2 })
  return { plain, plainStats, adapted, run }
}

describe('popis konektorů Outlooku', () => {
  it('klíče jsou beze změny (connector_state), popisy jsou platné, jen metadata', () => {
    expect(OUTLOOK_MAIL_CONNECTORS.inbox.key).toBe(FOLDERS.inbox.connector)
    expect(OUTLOOK_MAIL_CONNECTORS.sent.key).toBe(FOLDERS.sent.connector)
    for (const d of Object.values(OUTLOOK_MAIL_CONNECTORS)) {
      expect(descriptorIssues(d)).toEqual([])
      expect(d.content).toBe('metadata_only')
      expect(d.scopes).toEqual(['Mail.Read'])
    }
    expect(OUTLOOK_MAIL_CONNECTORS.inbox.eventTypes).toEqual(['message.inbound'])
    expect(OUTLOOK_MAIL_CONNECTORS.sent.eventTypes).toEqual(['message.outbound'])
  })
})

describe.each(Object.keys(SCENARIOS))('adaptér nemění sync: %s', (name) => {
  it('totožná volání DB (i pořadí) a totožné statistiky', async () => {
    const { plain, plainStats, adapted, run } = await runBoth(name)
    expect(adapted.calls).toEqual(plain.calls)
    expect(run.stats).toEqual(plainStats)
  })

  it('události = zapsané řádky; evidence událostí = evidence syncu', async () => {
    const { adapted, run } = await runBoth(name)
    const events = [...run.results.inbox.events, ...run.results.sent.events]
    const inserted = adapted.calls.filter((c) => c[0] === 'insertEvents').flatMap((c) => c[1] as MailEventRow[])
    expect(events.map((e) => e.payload)).toEqual(inserted)
    const evidence = adapted.calls.filter((c) => c[0] === 'recordEvidence').flatMap((c) => c[1] as MailEvidenceRef[])
    expect(events.map(eventEvidenceRef).filter((r) => r !== null)).toEqual(evidence)
  })

  it('každá událost splňuje kontrakt svého konektoru a nenese obsah', async () => {
    const { run } = await runBoth(name)
    for (const key of ['inbox', 'sent'] as const) {
      for (const e of run.results[key].events) {
        expect(normalizedEventIssues(e, OUTLOOK_MAIL_CONNECTORS[key])).toEqual([])
        expect(e.title).toBeNull()
      }
    }
    expect(JSON.stringify(run.results)).not.toMatch(/jana@|x@beta|neznamy@|obchod@/)
  })

  it('výsledek složky → connector_state přesně jako poslední zápis syncu', async () => {
    const { adapted, run } = await runBoth(name)
    for (const key of ['inbox', 'sent'] as const) {
      const r = run.results[key]
      expect(r).toEqual(folderSyncResult(key, run.stats.folders[key], r.events))
      const writes = adapted.calls.filter((c) => (c[0] === 'recordSuccess' || c[0] === 'recordError') && c[1] === r.connector)
      const last = writes.at(-1)
      const expected = stateWriteFor(r.outcome, r.error)
      if (expected.kind === 'none') {
        // Rozpracovaný nebo přiškrcený běh stav nemění.
        expect(writes).toEqual([])
      } else {
        expect(last?.[0]).toBe(expected.kind === 'success' ? 'recordSuccess' : 'recordError')
      }
    }
  })
})

describe('mapování řádku na událost', () => {
  const row: MailEventRow = {
    internet_message_id: '<a@x>',
    direction: 'inbound',
    occurred_at: '2026-09-27T10:00:00.000Z',
    account_id: 1,
    contact_id: 7,
    match_status: 'matched',
    counterpart_domain: null,
  }

  it('spárovaná příchozí: firma jako subject, evidence s webLinkem', () => {
    expect(mailRowToEvent(row, 'https://outlook.office.com/mail/id/a')).toEqual({
      source: 'outlook:inbox',
      type: 'message.inbound',
      external_id: '<a@x>',
      occurred_at: '2026-09-27T10:00:00.000Z',
      subject: { kind: 'account', id: 1 },
      participants: [{ role: 'from', accountId: 1, contactId: 7, domain: null }],
      evidence: { kind: 'email_message', sourceId: '<a@x>', webLink: 'https://outlook.office.com/mail/id/a' },
      title: null,
      payload: row,
    })
  })

  it('nespárovaná odchozí: bez firmy, bez evidence, jen doména', () => {
    const e = mailRowToEvent(
      { ...row, direction: 'outbound', account_id: null, contact_id: null, match_status: 'unknown', counterpart_domain: 'firma.test' },
      null,
    )
    expect(e.source).toBe('outlook:sent')
    expect(e.type).toBe('message.outbound')
    expect(e.subject).toBeNull()
    expect(e.evidence).toBeNull()
    expect(e.participants).toEqual([{ role: 'to', accountId: null, contactId: null, domain: 'firma.test' }])
  })

  it('posluchač, který spadne, sync nezastaví ani nezmění', async () => {
    const plain = recordingDb()
    await runMailSync({ fetchPage: fakeGraph(SCENARIOS['dvě stránky Doručené + Odeslané, spárované i nespárované']()), db: plain.db, ...clock() })
    const broken = recordingDb()
    await runMailSync({
      fetchPage: fakeGraph(SCENARIOS['dvě stránky Doručené + Odeslané, spárované i nespárované']()),
      db: broken.db,
      ...clock(),
      onPageStored: () => { throw new Error('posluchač selhal') },
    })
    expect(broken.calls).toEqual(plain.calls)
  })
})
