// Čtení schránek Gmailu do fronty agenta (P2): historie od kurzoru, záložní
// polling, přeskočení známých zpráv, předfiltr, průběžný kurzor (limit stránek
// ani limit zpráv na běh nevrací čtení na starý kurzor) a souhrnné nahlášení
// starých zpráv. Gmail i úložiště jsou podvržené (bez sítě a DB).
import { describe, expect, it, vi } from 'vitest'
import type { GmailMessageMeta, GmailResult } from '@/connectors/gmail'
import { MAX_HISTORY_PAGES, MAX_NEW_PER_MAILBOX, syncInquiryMailboxes, type GmailPort, type MailboxStore } from '@/domain/crm/inquiryMailboxService'
import { parseMailboxCursor, staleMessagesProposal } from '@/domain/crm/inquiryMailbox'

const NOW = new Date('2026-11-05T10:00:00Z')
const BOX = 'obchod@mummiesdaddies.com'

const meta0 = (id: string, from = `Zákazník ${id} <z${id}@seznam.cz>`, extra: Record<string, string> = {}): GmailMessageMeta => ({
  id, threadId: `t-${id}`, labelIds: ['INBOX'], receivedAt: '2026-11-05T08:00:00.000Z',
  headers: Object.entries({ From: from, 'Message-ID': `<${id}@x>`, ...extra }).map(([name, value]) => ({ name, value })),
})

function gmail(over: Partial<GmailPort> & { metas?: Record<string, GmailMessageMeta> } = {}): GmailPort {
  const metas = over.metas ?? {}
  return {
    token: vi.fn(async () => ({ ok: true as const, accessToken: 'at' })),
    profile: vi.fn(async () => ({ kind: 'ok' as const, data: { emailAddress: BOX, historyId: '500' } })),
    historyPage: vi.fn(async () => ({ kind: 'ok' as const, data: { messageIds: ['m1', 'm2'], nextPageToken: null, historyId: '600' } })),
    listIds: vi.fn(async () => ({ kind: 'ok' as const, data: { messageIds: ['p1'], nextPageToken: null } })),
    meta: vi.fn(async (_t: string, id: string): Promise<GmailResult<GmailMessageMeta>> => (metas[id] ? { kind: 'ok', data: metas[id] } : { kind: 'ok', data: meta0(id) })),
    ...over,
  }
}

/** Úložiště se stavem: kurzor se po success posune, zařazené zprávy fronta pak „zná". */
function store(cursor: string | null, known: string[] = []) {
  const enq: Record<string, unknown>[] = []
  const knownSet = new Set(known)
  const state = { cursor }
  const stale: Parameters<MailboxStore['reportStale']>[0][] = []
  const s: MailboxStore & { enq: typeof enq; state: typeof state; stale: typeof stale } = {
    enq,
    state,
    stale,
    cursor: vi.fn(async () => state.cursor),
    success: vi.fn(async (_k: string, c: string | null) => { state.cursor = c }),
    error: vi.fn(async () => undefined),
    knownIds: vi.fn(async (_m: string, ids: readonly string[]) => new Set(ids.filter((i) => knownSet.has(i)))),
    enqueue: vi.fn(async (p: Record<string, unknown>) => {
      enq.push(p)
      knownSet.add(String(p.graph_message_id))
      return 'created' as const
    }),
    memberIdByEmail: vi.fn(async () => 'u-obchod'),
    reportStale: vi.fn(async (a: Parameters<MailboxStore['reportStale']>[0]) => {
      stale.push(a)
      return 'created' as const
    }),
  }
  return s
}

const AFTER = Math.floor(NOW.getTime() / 1000) - 3 * 86_400
const ids = (prefix: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `${prefix}${i + from}`)

describe('syncInquiryMailboxes', () => {
  it('historie od kurzoru: známé zprávy přeskočí, nové zařadí jen s identifikátory, kurzor posune', async () => {
    const st = store('400', ['m2'])
    const g = gmail()
    const stats = await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(stats).toMatchObject({ mailboxes: 1, listed: 2, enqueued: 1, polled: 0 })
    expect(g.meta).toHaveBeenCalledTimes(1)
    expect(st.enq).toEqual([{
      internet_message_id: '<m1@x>', graph_message_id: 'm1', thread_id: 't-m1', mailbox: BOX, mailbox_member_id: 'u-obchod', received_at: '2026-11-05T08:00:00.000Z',
    }])
    expect(st.success).toHaveBeenCalledWith(expect.stringMatching(/^gmail:inquiry:[0-9a-f]{16}$/), '600')
  })

  it('první běh (bez kurzoru): kurzor z profilu, záložní polling', async () => {
    const st = store(null)
    const g = gmail()
    const stats = await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(g.historyPage).not.toHaveBeenCalled()
    expect(g.listIds).toHaveBeenCalledWith('at', `in:inbox -in:chats after:${AFTER}`, null)
    expect(stats).toMatchObject({ polled: 1, enqueued: 1 })
    expect(st.success).toHaveBeenCalledWith(expect.any(String), '500')
  })

  it('prošlé historyId (404) → polling', async () => {
    const st = store('1')
    const g = gmail({ historyPage: vi.fn(async () => ({ kind: 'not_found' as const })) })
    const stats = await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(stats.polled).toBe(1)
    expect(st.success).toHaveBeenCalledWith(expect.any(String), '500')
  })

  it('předfiltr: interní, automat a hromadná pošta do fronty nejdou', async () => {
    const st = store('400')
    const g = gmail({
      historyPage: vi.fn(async () => ({ kind: 'ok' as const, data: { messageIds: ['a', 'b', 'c', 'd'], nextPageToken: null, historyId: '601' } })),
      metas: {
        a: meta0('a', 'Kolega <ceo@mummiesdaddies.com>'),
        b: meta0('b', 'noreply@eshop.cz'),
        c: meta0('c', 'Obchod Beta <akce@obchod-beta.cz>', { 'List-Unsubscribe': '<mailto:u@obchod-beta.cz>' }),
      },
    })
    const stats = await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(stats.skipped).toEqual({ internal: 1, automated: 1, bulk: 1 })
    expect(st.enq.map((e) => e.graph_message_id)).toEqual(['d'])
  })

  it('throttling při čtení metadat: kurzor se neposune (další běh dávku projde znovu)', async () => {
    const st = store('400')
    const g = gmail({ meta: vi.fn(async () => ({ kind: 'throttled' as const, retryAfterSeconds: 30 })) })
    const stats = await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(stats.errors).toEqual({ meta_throttled: 1 })
    expect(st.success).not.toHaveBeenCalled()
  })

  it('schránka bez tokenu se přeskočí s chybou konektoru, ostatní běží', async () => {
    const st = store('400')
    const g = gmail({ token: vi.fn(async (m: string) => (m === BOX ? { ok: false as const, reason: 'not_configured' } : { ok: true as const, accessToken: 'at' })) })
    const stats = await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX, 'ceo@mummiesdaddies.com'], now: () => NOW })
    expect(stats.errors).toEqual({ token_not_configured: 1 })
    expect(st.error).toHaveBeenCalledWith(expect.any(String), 'token_not_configured')
    expect(stats.enqueued).toBe(2)
  })

  it('limit stránek historie: průběžný kurzor = poslední celý záznam; další běh pokračuje, nečte dokola od starého', async () => {
    // 7 stránek po 2 záznamech (jedna zpráva na záznam), id záznamů 1001…1014.
    const pages = Array.from({ length: 7 }, (_, p) => ({
      records: [0, 1].map((j) => ({ id: String(1001 + p * 2 + j), messageIds: [`h${p * 2 + j}`] })),
      next: p < 6 ? `p${p + 1}` : null,
    }))
    const historyPage = vi.fn(async (_t: string, start: string, page: string | null) => {
      // Gmail vrací záznamy za startHistoryId: najít stránku podle tokenu, jinak první záznam za startem.
      const idx = page ? Number(page.slice(1)) : pages.findIndex((pg) => Number(pg.records[0].id) > Number(start))
      const pg = pages[idx]
      const recs = pg.records.filter((r) => Number(r.id) > Number(start))
      return { kind: 'ok' as const, data: { messageIds: recs.flatMap((r) => r.messageIds), records: recs, nextPageToken: pg.next, historyId: '2000' } }
    })
    const st = store('1000')
    const g = gmail({ historyPage })
    await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(historyPage).toHaveBeenCalledTimes(MAX_HISTORY_PAGES)
    expect(st.enq).toHaveLength(10)
    expect(st.state.cursor).toBe('1010')
    expect(st.error).not.toHaveBeenCalled()

    historyPage.mockClear()
    await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(historyPage.mock.calls[0][1]).toBe('1010')
    expect(st.enq.map((e) => e.graph_message_id)).toEqual(ids('h', 14))
    expect(st.state.cursor).toBe('2000')
  })

  it('limit zpráv na běh v historii: kurzor za poslední zpracovanou zprávu, zbytek v dalším běhu', async () => {
    const n = MAX_NEW_PER_MAILBOX + 15
    const records = ids('r', n).map((id, i) => ({ id: String(3001 + i), messageIds: [id] }))
    const historyPage = vi.fn(async (_t: string, start: string) => {
      const recs = records.filter((r) => Number(r.id) > Number(start))
      return { kind: 'ok' as const, data: { messageIds: recs.flatMap((r) => r.messageIds), records: recs, nextPageToken: null, historyId: '4000' } }
    })
    const st = store('3000')
    const g = gmail({ historyPage })
    await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(st.enq).toHaveLength(MAX_NEW_PER_MAILBOX)
    expect(st.state.cursor).toBe(String(3000 + MAX_NEW_PER_MAILBOX))
    await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(st.enq).toHaveLength(n)
    expect(st.state.cursor).toBe('4000')
  })

  it('chyba čtení uprostřed: hotová část se uloží, chyba se zapíše', async () => {
    const records = ids('e', 4).map((id, i) => ({ id: String(5001 + i), messageIds: [id] }))
    const historyPage = vi.fn(async () => ({ kind: 'ok' as const, data: { messageIds: ids('e', 4), records, nextPageToken: null, historyId: '6000' } }))
    const meta = vi.fn(async (_t: string, id: string): Promise<GmailResult<GmailMessageMeta>> => (id === 'e2' ? { kind: 'throttled', retryAfterSeconds: 30 } : { kind: 'ok', data: meta0(id) }))
    const st = store('5000')
    await syncInquiryMailboxes({ gmail: gmail({ historyPage, meta }), store: st, mailboxes: [BOX], now: () => NOW })
    expect(st.enq.map((e) => e.graph_message_id)).toEqual(['e0', 'e1'])
    expect(st.state.cursor).toBe('5002')
    expect(st.error).toHaveBeenCalledWith(expect.any(String), 'meta_throttled')
  })

  it('polling projde všechny stránky výpisu (nad prvních 100) a pokračuje přes víc běhů bez přeskočení', async () => {
    // 130 zpráv (výpis od nejnovější), z toho každá třetí hromadná (předfiltr ji přeskočí).
    const all = ids('q', 130) // q0 = nejstarší
    const newestFirst = [...all].reverse()
    const listIds = vi.fn(async (_t: string, _q: string, page: string | null) => {
      const from = page ? Number(page) : 0
      const chunk = newestFirst.slice(from, from + 100)
      return { kind: 'ok' as const, data: { messageIds: chunk, nextPageToken: from + 100 < newestFirst.length ? String(from + 100) : null } }
    })
    const bulk = (id: string) => Number(id.slice(1)) % 3 === 0
    const meta = vi.fn(async (_t: string, id: string): Promise<GmailResult<GmailMessageMeta>> =>
      ({ kind: 'ok', data: bulk(id) ? meta0(id, `Akce <akce${id}@obchod.cz>`, { 'List-Unsubscribe': '<mailto:u@obchod.cz>' }) : meta0(id) }))
    const st = store(null)
    const g = gmail({ listIds, meta })
    const runs: (string | null)[] = []
    for (let i = 0; i < 6 && !(st.state.cursor && parseMailboxCursor(st.state.cursor).mode === 'history'); i++) {
      await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
      runs.push(st.state.cursor)
    }
    expect(listIds.mock.calls.some((c) => c[2] === '100')).toBe(true)
    expect(runs[0]).toBe(`poll:500:${AFTER}:${MAX_NEW_PER_MAILBOX}`)
    expect(runs[runs.length - 1]).toBe('500')
    // Každá zpráva, která není hromadná, je ve frontě právě jednou — žádná přeskočená ani zdvojená.
    const enq = st.enq.map((e) => String(e.graph_message_id))
    expect(enq.sort()).toEqual(all.filter((id) => !bulk(id)).sort())
    expect(new Set(enq).size).toBe(enq.length)
    expect(st.error).not.toHaveBeenCalled()
  })

  it('staré zprávy (too_old) nezmizí tiše: jeden souhrnný návrh s počtem a odkazy, kurzor se posune', async () => {
    const old = (id: string) => ({ ...meta0(id), receivedAt: '2026-10-25T08:00:00.000Z' })
    const records = ['o1', 'o2', 'n1', 'o3'].map((id, i) => ({ id: String(7001 + i), messageIds: [id] }))
    const historyPage = vi.fn(async () => ({ kind: 'ok' as const, data: { messageIds: records.map((r) => r.messageIds[0]), records, nextPageToken: null, historyId: '8000' } }))
    const g = gmail({ historyPage, metas: { o1: old('o1'), o2: old('o2'), o3: old('o3') } })
    const st = store('7000')
    const stats = await syncInquiryMailboxes({ gmail: g, store: st, mailboxes: [BOX], now: () => NOW })
    expect(stats.skipped).toEqual({ too_old: 3 })
    expect(stats.staleReported).toBe(3)
    expect(st.enq.map((e) => e.graph_message_id)).toEqual(['n1'])
    expect(st.stale).toHaveLength(1)
    expect(st.stale[0]).toMatchObject({ mailbox: BOX, maxAgeDays: 3, items: [{ gmailMessageId: 'o1' }, { gmailMessageId: 'o2' }, { gmailMessageId: 'o3' }] })
    expect(st.state.cursor).toBe('8000')

    // Zápis návrhu selže → kurzor se za ně neposune (příště znovu), chyba konektoru.
    const st2 = store('7000')
    st2.reportStale = vi.fn(async () => { throw new Error('case_proposal: 57014') })
    await syncInquiryMailboxes({ gmail: g, store: st2, mailboxes: [BOX], now: () => NOW })
    expect(st2.success).not.toHaveBeenCalled()
    expect(st2.error).toHaveBeenCalledWith(expect.any(String), 'report_stale')
  })

  it('souhrnný návrh: počet, rozmezí, hledání a odkazy v limitu zdůvodnění; uzel obchod', () => {
    const items = ids('m', 30).map((id, i) => ({ gmailMessageId: `18c2f0${id}`, receivedAt: `2026-10-${String(20 + (i % 5)).padStart(2, '0')}T08:00:00.000Z` }))
    const d = staleMessagesProposal({ mailbox: BOX, mailboxKey: 'gmail:inquiry:abc', batchKey: 'k1', items, maxAgeDays: 3, node: 'obchod', now: NOW })!
    expect(d.output.title).toBe('Nezpracované starší zprávy ve schránce (30)')
    expect(d.output.rationale.length).toBeLessThanOrEqual(1000)
    expect(d.output.rationale).toContain('30 zpráv starší než 3 dny (přišly 20. 10. 2026–24. 10. 2026)')
    expect(d.output.rationale).toContain('#search/')
    expect(d.output.rationale).toContain(`https://mail.google.com/mail/?authuser=${encodeURIComponent(BOX)}#all/18c2f0m0`)
    expect(d.output.rationale).toMatch(/\(a dalších \d+\)$/)
    expect(d).toMatchObject({ capability: 'inquiry_escalation', sourceKey: 'mailbox_stale:gmail:inquiry:abc:k1', target: { node: 'obchod', accountId: null } })
    expect(d.event.evidence).toMatchObject({ kind: 'email_message', sourceId: '18c2f0m0' })
    expect(staleMessagesProposal({ mailbox: BOX, mailboxKey: 'k', batchKey: 'b', items: [], maxAgeDays: 3, node: 'obchod', now: NOW })).toBeNull()
  })
})
