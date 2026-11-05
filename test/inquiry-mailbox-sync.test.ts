// Čtení schránek Gmailu do fronty agenta (P2): historie od kurzoru, záložní
// polling, přeskočení známých zpráv, předfiltr a posun kurzoru jen po celé
// dávce. Gmail i úložiště jsou podvržené (bez sítě a DB).
import { describe, expect, it, vi } from 'vitest'
import type { GmailMessageMeta, GmailResult } from '@/connectors/gmail'
import { syncInquiryMailboxes, type GmailPort, type MailboxStore } from '@/domain/crm/inquiryMailboxService'

const NOW = new Date('2026-11-05T10:00:00Z')
const BOX = 'obchod@mummiesdaddies.com'

const meta = (id: string, from = `Zákazník ${id} <z${id}@seznam.cz>`, extra: Record<string, string> = {}): GmailMessageMeta => ({
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
    meta: vi.fn(async (_t: string, id: string): Promise<GmailResult<GmailMessageMeta>> => (metas[id] ? { kind: 'ok', data: metas[id] } : { kind: 'ok', data: meta(id) })),
    ...over,
  }
}

function store(cursor: string | null, known: string[] = []) {
  const enq: Record<string, unknown>[] = []
  const s: MailboxStore & { enq: typeof enq } = {
    enq,
    cursor: vi.fn(async () => cursor),
    success: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    knownIds: vi.fn(async (_m: string, ids: readonly string[]) => new Set(ids.filter((i) => known.includes(i)))),
    enqueue: vi.fn(async (p: Record<string, unknown>) => {
      enq.push(p)
      return 'created' as const
    }),
    memberIdByEmail: vi.fn(async () => 'u-obchod'),
  }
  return s
}

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
    expect(g.listIds).toHaveBeenCalledWith('at', 'in:inbox -in:chats newer_than:3d', null)
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
        a: meta('a', 'Kolega <ceo@mummiesdaddies.com>'),
        b: meta('b', 'noreply@eshop.cz'),
        c: meta('c', 'Obchod Beta <akce@obchod-beta.cz>', { 'List-Unsubscribe': '<mailto:u@obchod-beta.cz>' }),
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
})
