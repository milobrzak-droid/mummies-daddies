// Běh outbound agenta (P7) nad paměťovou náhradou databáze: sběr →
// kvalifikace → lead → právní brána → fronta. Ověřuje hlavně to, že nová
// firma nikdy nedostane e-mail, že stávající klient ano jen se zapnutým
// samostatným odesláním, v okně, do limitu a z oddělené schránky.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import type { OutboundAgentConfig } from '@/core/outbound/config'
import type { CrmAccountSnapshot } from '@/core/outbound/crmSignals'
import type { SignalCandidate } from '@/core/outbound/signal'
import { emailHash, verifyUnsubscribeToken } from '@/core/outbound/unsubscribe'
import { runOutboundAgent, type ApprovedOutreach, type CrmContext, type EnqueueResult, type NewOutreach, type OutboundDb, type OutreachTarget, type StoredSignal } from '@/domain/outbound/run'

const CFG = COMPANY.capabilities.outboundAgent as OutboundAgentConfig
const SECRET = 's'.repeat(48)
// Úterý 10. 11. 2026, 10:30 v Praze — v okně odesílání.
const NOW = new Date('2026-11-10T09:30:00Z')
const TODAY = '2026-11-10'

type Sig = StoredSignal & { status: string; score: number | null; reasons: string[] }
type Out = NewOutreach & { id: number; outboxRef?: string; skipReason?: string; decidedBy?: string | null }

function memoryDb(seed: { accounts?: CrmAccountSnapshot[]; ctx?: (s: { accountId: number | null; ico: string | null }) => CrmContext; targets?: Record<number, OutreachTarget>; mailbox?: string | null; enqueue?: (p: Record<string, unknown>) => EnqueueResult } = {}) {
  const signals: Sig[] = []
  const outreach: Out[] = []
  const queued: Record<string, unknown>[] = []
  let nextDeal = 100
  const db: OutboundDb = {
    async upsertSignal(c: SignalCandidate) {
      const ex = signals.find((s) => s.source === c.source && s.externalRef === c.externalRef)
      if (ex) return { signalId: ex.id, duplicate: true }
      const id = signals.length + 1
      signals.push({ id, source: c.source, kind: c.kind, externalRef: c.externalRef, title: c.title, url: c.url, ico: c.company.ico, companyName: c.company.name, facts: [...c.facts], accountId: c.accountId ?? null, attempts: 0, status: 'new', score: null, reasons: [] })
      return { signalId: id, duplicate: false }
    },
    async pendingSignals(limit) { return signals.filter((s) => s.status === 'new').slice(0, limit) },
    async crmContext(s) { return seed.ctx?.(s) ?? { accountId: s.accountId, relationship: s.accountId ? 'klient' : null, optedOut: false, recentlyContacted: false } },
    async saveQualification(id, x) { Object.assign(signals[id - 1], { status: x.status, score: x.score, reasons: x.reasons }) },
    async createLead(id, x) {
      const s = signals[id - 1]
      Object.assign(s, { score: x.score, reasons: x.reasons })
      if (!s.accountId && !s.companyName) return null
      s.status = 'converted'
      s.accountId = s.accountId ?? 900 + id
      return { accountId: s.accountId, dealId: nextDeal++ }
    },
    async outreachTarget(accountId) { return seed.targets?.[accountId] ?? { contactId: null, email: null, optedOut: false, consent: null, isExistingCustomer: false, accountName: `Firma ${accountId}` } },
    async insertOutreach(x) { const id = outreach.length + 1; outreach.push({ ...x, id }); return id },
    async setOutreachText(id, x) { Object.assign(outreach[id - 1], x) },
    async countSentToday() { return outreach.filter((o) => o.status === ('queued' as string)).length },
    async approvedOutreach(): Promise<ApprovedOutreach[]> {
      return outreach.filter((o) => o.status === 'approved' && o.channel !== 'manual').map((o) => ({
        id: o.id, channel: o.channel as 'auto_email', humanApproved: !!o.decidedBy, dealId: o.dealId, subject: o.subject!, body: o.body!,
        emailHash: o.emailHash, email: seed.targets?.[o.accountId]?.email ?? null, suppressed: false,
      }))
    },
    async markQueued(id, x) { Object.assign(outreach[id - 1], { status: 'queued', outboxRef: x.sourceRef }) },
    async markSkipped(id, reason) { Object.assign(outreach[id - 1], { status: 'skipped', skipReason: reason }) },
    async enqueue(p) { queued.push(p); return seed.enqueue?.(p) ?? { ok: true, outboxId: queued.length, duplicate: false } },
    async memberIdByEmail(email) { return email === CFG.outreach.senderMailboxEmail ? (seed.mailbox === undefined ? 'mailbox-outbound' : seed.mailbox) : null },
    async crmAccounts() { return seed.accounts ?? [] },
  }
  return { db, signals, outreach, queued }
}

const tender: SignalCandidate = {
  source: 'vvz', kind: 'public_tender', externalRef: 'Z-1', title: 'Catering pro konferenci', url: 'https://vvz.example/Z-1', signalDate: '2026-12-01',
  company: { ico: '12345678', name: 'Firma Beta a.s.' }, facts: [{ key: 'zakazka', value: 'Catering', sourceUrl: null }, { key: 'zadavatel', value: 'Beta', sourceUrl: null }],
}
const aresPrague = async (ico: string | null) => ico ? { ico, legalName: 'Firma Beta a.s.', city: 'Praha', region: 'Hlavní město Praha', nace: ['62010'], employees: 80 } : null
const client: CrmAccountSnapshot = { accountId: 1, name: 'Firma Alfa s.r.o.', ico: '11111111', lastEventDate: '2025-12-11', lastEventTitle: 'Vánoční večírek', hasOpenDeal: false }
const clientTarget: OutreachTarget = { contactId: 11, email: 'karel@alfa.cz', optedOut: false, consent: null, isExistingCustomer: true, accountName: 'Firma Alfa s.r.o.' }
const opts = (over: Partial<Parameters<typeof runOutboundAgent>[2]> = {}) => ({ config: CFG, now: NOW, today: TODAY, timeZone: COMPANY.timeZone, autosendEnabled: true, unsubscribeSecret: SECRET, ...over })

describe('runOutboundAgent', () => {
  test('nová firma ze signálu: lead v CRM a jen návrh pro člověka — nic se neodesílá', async () => {
    const m = memoryDb({ ctx: () => ({ accountId: null, relationship: null, optedOut: false, recentlyContacted: false }),
      targets: { 901: { contactId: 5, email: 'nakup@beta.cz', optedOut: false, consent: null, isExistingCustomer: false, accountName: 'Firma Beta a.s.' } } })
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [tender], errors: [] }), ares: aresPrague }, opts())
    expect(stats).toMatchObject({ new: 1, leads: 1, outreachManual: 1, outreachAuto: 0, queued: 0 })
    expect(m.outreach[0]).toMatchObject({ channel: 'manual', basis: 'none', reasonCodes: ['no_legal_basis'], emailHash: null })
    expect(m.outreach[0].body).toContain('E-mail se neposílá')
    expect(m.queued).toEqual([])
  })

  test('stávající klient (výročí z CRM): e-mail s odhlášením do fronty z oddělené schránky', async () => {
    const m = memoryDb({ accounts: [client], targets: { 1: clientTarget } })
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [], errors: [] }), ares: null }, opts())
    expect(stats).toMatchObject({ new: 1, leads: 1, outreachAuto: 1, queued: 1 })
    expect(m.outreach[0]).toMatchObject({ channel: 'auto_email', basis: 'existing_customer', emailHash: emailHash('karel@alfa.cz') })
    const p = m.queued[0]
    expect(p).toMatchObject({ kind: 'outreach', source_ref: 'outreach:1', mailbox_member_id: 'mailbox-outbound', mode: { to: 'karel@alfa.cz' }, deal_id: 100 })
    expect(p.text).toContain('Firma Alfa s.r.o.')
    expect(p.text).toContain('11. 12. 2025')
    const token = /\?t=([^\s]+)/.exec(p.text as string)![1]
    expect(verifyUnsubscribeToken(decodeURIComponent(token), SECRET)).toEqual({ emailHash: emailHash('karel@alfa.cz'), outreachId: 1 })
    // Druhý běh: nic nového, nic znovu do fronty.
    const again = await runOutboundAgent(m.db, { collect: async () => ({ signals: [], errors: [] }), ares: null }, opts())
    expect(again).toMatchObject({ new: 0, queued: 0 })
  })

  test('bez OUTBOUND_AUTOSEND_ENABLED: jen koncept ke schválení, fronta prázdná', async () => {
    const m = memoryDb({ accounts: [client], targets: { 1: clientTarget } })
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [], errors: [] }), ares: null }, opts({ autosendEnabled: false }))
    expect(stats).toMatchObject({ outreachReview: 1, queued: 0 })
    expect(m.outreach[0]).toMatchObject({ channel: 'review_email', status: 'draft' })
    expect(m.outreach[0].body).toContain('Odhlásíte se jedním kliknutím')
  })

  test('mimo okno, bez oddělené schránky nebo bez tajemství odhlášení se nic neodešle', async () => {
    const sunday = new Date('2026-11-08T10:00:00Z')
    for (const [o, seed, reason] of [
      [opts({ now: sunday }), {}, 'outside_window'],
      [opts(), { mailbox: null }, 'sender_mailbox_missing'],
    ] as const) {
      const m = memoryDb({ accounts: [client], targets: { 1: clientTarget }, ...seed })
      const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [], errors: [] }), ares: null }, o)
      expect(stats.queued).toBe(0)
      expect(stats.stopReason).toBe(reason)
      expect(m.queued).toEqual([])
    }
    const m = memoryDb({ accounts: [client], targets: { 1: clientTarget } })
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [], errors: [] }), ares: null }, opts({ unsubscribeSecret: null }))
    // Bez tajemství nevznikne e-mail vůbec — jen ruční návrh.
    expect(stats).toMatchObject({ outreachManual: 1, queued: 0 })
  })

  test('chybějící RPC fronty (P3 nenasazen): oslovení zůstane schválené a zkusí se příště', async () => {
    const m = memoryDb({ accounts: [client], targets: { 1: clientTarget }, enqueue: () => ({ ok: false, missingRpc: true }) })
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [], errors: [] }), ares: null }, opts())
    expect(stats).toMatchObject({ queued: 0, stopReason: 'outbox_missing' })
    expect(m.outreach[0].status).toBe('approved')
  })

  test('denní limit', async () => {
    const accounts = Array.from({ length: CFG.outreach.dailyLimit + 2 }, (_, i) => ({ ...client, accountId: i + 1 }))
    const targets = Object.fromEntries(accounts.map((a) => [a.accountId, { ...clientTarget, email: `k${a.accountId}@alfa.cz` }]))
    const m = memoryDb({ accounts, targets })
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [], errors: [] }), ares: null }, opts())
    expect(stats.queued).toBe(CFG.outreach.dailyLimit)
    expect(stats.stopReason).toBe('daily_limit')
  })

  test('odhlášený kontakt, freemail a neplatný signál', async () => {
    const m = memoryDb({ accounts: [client, { ...client, accountId: 2 }], targets: { 1: { ...clientTarget, optedOut: true }, 2: { ...clientTarget, email: 'jana@seznam.cz' } } })
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [{ source: 'vvz', title: '' }], errors: [{ source: 'vvz', code: 'FeedUnavailableError' }] }), ares: null }, opts())
    expect(stats).toMatchObject({ invalid: 1, leads: 2, outreachManual: 1, queued: 0, sourceErrors: [{ source: 'vvz', code: 'FeedUnavailableError' }] })
    expect(m.outreach).toHaveLength(1)
    expect(m.outreach[0].reasonCodes).toEqual(['freemail'])
  })

  test('nejasný signál jde na review, selhání se zapíše kódem', async () => {
    const m = memoryDb({ ctx: () => ({ accountId: null, relationship: null, optedOut: false, recentlyContacted: false }) })
    const unknown = { ...tender, externalRef: 'Z-2', company: { ico: null, name: 'Neznámá' } }
    m.db.crmContext = async (s) => { if (s.ico === 'boom') throw new TypeError('x'); return { accountId: null, relationship: null, optedOut: false, recentlyContacted: false } }
    const boom = { ...tender, externalRef: 'Z-3', company: { ico: null, name: 'X' } }
    const stats = await runOutboundAgent(m.db, { collect: async () => ({ signals: [unknown, boom], errors: [] }), ares: async (_i, n) => (n === 'X' ? { ico: 'boom', legalName: 'X', city: null, region: null, nace: [] } : null) }, opts())
    expect(stats).toMatchObject({ review: 1, failed: 1 })
    expect(m.signals[0]).toMatchObject({ status: 'review' })
    expect(m.signals[0].reasons).toContain('company_unknown')
    expect(m.signals[1].status).toBe('failed')
  })
})
