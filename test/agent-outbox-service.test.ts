// Úloha agent-outbox (domain/crm/agentOutbox.ts) s falešným úložištěm
// (chová se jako RPC 0104: queued → claimed → sent / failed / needs_attention)
// a falešným Gmailem. Hlídá hlavně záruku „nikdy dvakrát": pád mezi
// odesláním a potvrzením zprávu znovu nepošle, nejistá zpráva se jen dohledá.
import { describe, expect, test, vi } from 'vitest'
import { COMPANY } from '@/config'
import {
  newRfcMessageId,
  runAgentOutbox,
  type DealFacts,
  type OutboxMail,
  type OutboxRow,
  type OutboxRunConfig,
  type OutboxStore,
  type SendOutcome,
} from '@/domain/crm/agentOutbox'
import { outboxRunConfig, pragueWeekdayHour } from '@/domain/crm/agentOutboxService'

const NOW = new Date('2026-11-05T10:00:00Z')
const MAILBOX = 'b1111111-1111-4111-8111-111111111111'
const AUTH_OK = 'mx.google.com; dkim=pass header.i=@alfa.example; spf=pass smtp.mailfrom=karel@alfa.example; dmarc=pass header.from=alfa.example'

const CONFIG: OutboxRunConfig = {
  outbox: {
    fromName: 'Firma Test', messageIdDomain: 'firma.example', footer: '—\nFirma Test s.r.o., IČO 00000000', offerTerms: 'Kalkulace je nezávazná.',
    ownDomains: ['firma.example'], vipAddresses: ['@vip.example'], maxQueueAgeHours: 72, staleClaimMinutes: 30, retentionDays: 365,
    maxPerRun: 20, trustedAuthServId: 'mx.google.com',
  },
  autoSendEnabled: true,
  companyMapVersion: '2027-01',
  autoSendMaxTotal: 30_000,
  autoSendKinds: ['offer', 'info_request', 'follow_up'],
  inquiryLimits: { dailyAutoSendLimit: 20, perRecipientDailyLimit: 2 },
  followUpLimits: { dailyLimit: 20 },
  followUpWindowOpen: true,
  wonPhases: ['potvrzeno', 'realizovano'],
}

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 7, kind: 'offer', source_ref: 'inquiry:1', deal_id: 11, scope_version_id: 21, mailbox_member_id: MAILBOX, mode: 'reply',
  in_reply_to_message_id: 'gm-orig', to_email: null, subject: 'Re: Poptávka', body: 'Dobrý den, Karle,\nposíláme nabídku.',
  price_map_version: '2027-01', quote_total: 20_000, status: 'queued', stop_reason: null, approved_at: null, rfc_message_id: null,
  created_at: '2026-11-05T09:00:00Z', body_purged_at: null, ...over,
})

const FACTS: DealFacts = {
  dealClosed: false, snoozed: false, doNotContact: false, versionStatus: 'draft', versionSendApproved: false,
  mailbox: { email: 'obchod@firma.example', active: true }, humanActivity: false,
}

type Finish = { id: number; status: string; reason: string; errorCode?: string | null; task?: { title: string; text: string } | null }

function fakeStore(rows: OutboxRow[], opts: { facts?: Partial<DealFacts>; autonomy?: boolean; claimReason?: string; confirmThrows?: number } = {}) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]))
  let confirmThrows = opts.confirmThrows ?? 0
  const calls = { claims: [] as unknown[], confirms: [] as unknown[], finishes: [] as Finish[], approvals: [] as number[] }
  const store: OutboxStore = {
    async markStale() {
      // Test simuluje uplynutí času: každý claimed je „zastaralý".
      const ids: number[] = []
      for (const r of db.values()) if (r.status === 'claimed') { r.status = 'needs_attention'; r.stop_reason = 'stale_claim'; ids.push(r.id) }
      return ids
    },
    async syncApprovals() { return 0 },
    async listQueued(limit) { return [...db.values()].filter((r) => r.status === 'queued').slice(0, limit).map((r) => ({ ...r })) },
    async listUncertain(limit) {
      return [...db.values()].filter((r) => r.status === 'needs_attention' && r.rfc_message_id && ['stale_claim', 'uncertain'].includes(r.stop_reason ?? '')).slice(0, limit).map((r) => ({ ...r }))
    },
    async autonomyGranted() { return opts.autonomy ?? true },
    async dealFacts() { return { ...FACTS, ...opts.facts } },
    async claim(x) {
      calls.claims.push(x)
      const r = db.get(x.id)!
      if (opts.claimReason) return { ok: false, reason: opts.claimReason }
      if (r.status !== 'queued') return { ok: false, reason: 'not_queued' }
      r.status = 'claimed'
      r.rfc_message_id = x.rfcMessageId
      return { ok: true }
    },
    async confirm(id, mid, tid, sha) {
      calls.confirms.push({ id, mid, tid, sha })
      if (confirmThrows > 0) { confirmThrows--; throw new Error('db down') }
      const r = db.get(id)!
      if (!['claimed', 'needs_attention'].includes(r.status)) throw new Error('AO012')
      r.status = 'sent'
    },
    async finish(id, status, reason, errorCode, task) {
      calls.finishes.push({ id, status, reason, errorCode, task })
      const r = db.get(id)!
      r.status = status
      r.stop_reason = status === 'queued' ? null : reason
      if (status === 'queued') r.rfc_message_id = null
      return true
    },
    async requestOfferApproval(id) {
      calls.approvals.push(id)
      db.get(id)!.status = 'blocked'
      db.get(id)!.stop_reason = 'approval_required'
      return { ok: true }
    },
    async purgeText() { return 0 },
  }
  return { store, db, calls }
}

function fakeMail(opts: { outcome?: SendOutcome | (() => SendOutcome); token?: boolean; replyTo?: string | null; auth?: readonly string[]; customerReplied?: boolean; found?: boolean } = {}) {
  const sent: Parameters<OutboxMail['send']>[1][] = []
  const mail: OutboxMail = {
    async token() { return opts.token === false ? { ok: false } : { ok: true, accessToken: 'tok' } },
    async original() {
      return { ok: true, message: {
        threadId: 'thr1', from: 'Karel Ukázkový <karel@alfa.example>', replyTo: opts.replyTo ?? null, messageId: '<orig@alfa.example>',
        references: '<root@alfa.example>', authResults: [...(opts.auth ?? [AUTH_OK])],
      } }
    },
    async customerRepliedInThread() { return opts.customerReplied ?? false },
    send: vi.fn(async (_t: string, x: Parameters<OutboxMail['send']>[1]) => {
      sent.push(x)
      const o = opts.outcome ?? { kind: 'accepted', id: 'gm-sent', threadId: 'thr1' }
      return typeof o === 'function' ? o() : o
    }),
    async findSent() { return { ok: true, found: opts.found ? { id: 'gm-found', threadId: 'thr1' } : null } },
  }
  return { mail, sent }
}

const run = (store: OutboxStore, mail: OutboxMail, config: Partial<OutboxRunConfig> = {}, log?: (e: string, c: Record<string, unknown>) => void) =>
  runAgentOutbox({ store, mail, config: { ...CONFIG, ...config }, now: () => NOW, log })

describe('agent-outbox: odeslání', () => {
  test('samostatná odpověď ve vlákně: claim → Gmail → confirm; jen na From, s patičkou', async () => {
    const { store, db, calls } = fakeStore([row()])
    const { mail, sent } = fakeMail()
    const stats = await run(store, mail)
    expect(stats).toMatchObject({ sent: 1, sentAutonomous: 1, blocked: 0 })
    expect(calls.claims[0]).toMatchObject({ id: 7, recipient: 'karel@alfa.example', autonomous: true, dailyLimit: 20, limitKinds: ['offer', 'info_request'], perRecipientDailyLimit: 2 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: 'karel@alfa.example', from: { name: 'Firma Test', address: 'obchod@firma.example' }, threadId: 'thr1',
      inReplyTo: '<orig@alfa.example>', references: '<root@alfa.example>', subject: 'Re: Poptávka', outboxId: 7,
    })
    expect(sent[0].text).toMatch(/posíláme nabídku\.\n\nKalkulace je nezávazná\.\n\n—\nFirma Test s\.r\.o\., IČO 00000000$/)
    expect(sent[0].messageId).toMatch(/^<ao\.7\.[0-9a-f]+@firma\.example>$/)
    expect(calls.confirms[0]).toMatchObject({ id: 7, mid: 'gm-sent', tid: 'thr1' })
    expect((calls.confirms[0] as { sha: string }).sha).toMatch(/^[0-9a-f]{64}$/)
    expect(db.get(7)!.status).toBe('sent')
  })

  test('nová zpráva (web): příjemce z fronty, bez vlákna', async () => {
    const { store } = fakeStore([row({ kind: 'info_request', mode: 'to', to_email: 'Karel@Alfa.example', in_reply_to_message_id: null, scope_version_id: null, quote_total: null })])
    const { mail, sent } = fakeMail()
    await run(store, mail)
    expect(sent[0]).toMatchObject({ to: 'karel@alfa.example', threadId: null, inReplyTo: null })
    expect(sent[0].text).not.toContain('Kalkulace je nezávazná.')
  })

  test('PÁD mezi odesláním a potvrzením: zpráva se znovu NEPOŠLE, dohledá se podle Message-ID', async () => {
    const { store, db, calls } = fakeStore([row()], { confirmThrows: 1 })
    const { mail } = fakeMail({ found: true })
    const s1 = await run(store, mail)
    expect(s1.sent).toBe(0)
    expect(db.get(7)!.status).toBe('claimed')
    // Další běh: zastaralá rezervace → needs_attention → dohledání → potvrzení.
    const s2 = await run(store, mail)
    expect(s2.reconciled).toBe(1)
    expect(mail.send).toHaveBeenCalledTimes(1)
    expect(db.get(7)!.status).toBe('sent')
    expect(calls.confirms.at(-1)).toMatchObject({ id: 7, mid: 'gm-found', sha: null })
    // Třetí běh nic nedělá.
    await run(store, mail)
    expect(mail.send).toHaveBeenCalledTimes(1)
  })

  test('nejistý výsledek (5xx): needs_attention + úkol; nenalezená zpráva zůstane člověku', async () => {
    const { store, db, calls } = fakeStore([row()])
    const { mail } = fakeMail({ outcome: { kind: 'uncertain', reason: 'backendError' }, found: false })
    const s = await run(store, mail)
    expect(s.uncertain).toBe(1)
    expect(calls.finishes[0]).toMatchObject({ status: 'needs_attention', reason: 'uncertain', errorCode: 'backenderror' })
    expect(calls.finishes[0].task?.title).toMatch(/Zkontrolovat odeslání/)
    await run(store, mail)
    expect(mail.send).toHaveBeenCalledTimes(1)
    expect(db.get(7)!.status).toBe('needs_attention')
  })

  test('403 → failed + úkol; 429 → zpět do fronty; neplatný token → nic se nemění', async () => {
    const a = fakeStore([row()])
    await run(a.store, fakeMail({ outcome: { kind: 'forbidden', reason: 'insufficientPermissions' } }).mail)
    expect(a.calls.finishes[0]).toMatchObject({ status: 'failed', reason: 'forbidden', errorCode: 'insufficientpermissions' })
    expect(a.calls.finishes[0].task?.text).toContain('Gmail odeslání odmítl')

    const b = fakeStore([row()])
    const s = await run(b.store, fakeMail({ outcome: { kind: 'throttled', reason: 'rateLimitExceeded' } }).mail)
    expect(b.calls.finishes[0]).toMatchObject({ status: 'queued', reason: 'throttled' })
    expect(s.deferred).toBe(1)
    expect(b.db.get(7)!.status).toBe('queued')

    const c = fakeStore([row()])
    const m = fakeMail({ token: false })
    const s3 = await run(c.store, m.mail)
    expect(s3.reasons.token_unavailable).toBe(1)
    expect(c.calls.claims).toHaveLength(0)
    expect(m.mail.send).not.toHaveBeenCalled()
  })

  test('denní limit: zpráva zůstane ve frontě, Gmail se nevolá', async () => {
    const { store, db } = fakeStore([row()], { claimReason: 'daily_limit' })
    const { mail } = fakeMail()
    const s = await run(store, mail)
    expect(s.reasons.daily_limit).toBe(1)
    expect(mail.send).not.toHaveBeenCalled()
    expect(db.get(7)!.status).toBe('queued')
  })
})

describe('agent-outbox: brány a stop pravidla', () => {
  test('bez pravomoci: nabídka → žádost send_offer, doptání → blok s úkolem; nic neodejde', async () => {
    const { store, calls } = fakeStore([row(), row({ id: 8, kind: 'info_request', source_ref: 'inquiry:2', scope_version_id: null })], { autonomy: false })
    const { mail } = fakeMail()
    const s = await run(store, mail)
    expect(mail.send).not.toHaveBeenCalled()
    expect(calls.approvals).toEqual([7])
    expect(calls.finishes).toEqual([expect.objectContaining({ id: 8, status: 'blocked', reason: 'approval_required' })])
    expect(calls.finishes[0].task?.text).toContain('agent nemá pravomoc')
    expect(s.approvalRequested).toBe(2)
  })

  test('ilustrační mapa firmy: nic samostatně, i se zapnutým přepínačem a L4', async () => {
    const { store, calls } = fakeStore([row()])
    const { mail } = fakeMail()
    await run(store, mail, { companyMapVersion: 'ilustracni-2026-11' })
    expect(mail.send).not.toHaveBeenCalled()
    expect(calls.approvals).toEqual([7])
  })

  test('schválená nabídka odejde i bez přepínače (autonomous = false)', async () => {
    const { store, calls } = fakeStore([row()], { facts: { versionSendApproved: true } })
    const { mail } = fakeMail()
    await run(store, mail, { autoSendEnabled: false })
    expect(calls.claims[0]).toMatchObject({ autonomous: false })
    expect(mail.send).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['jiné Reply-To', { replyTo: 'utok@evil.example' }, {}, 'reply_to_mismatch', true],
    ['neověřený odesílatel', { auth: ['mx.google.com; dmarc=fail header.from=alfa.example'] }, {}, 'sender_not_verified', true],
    ['zákazník mezitím napsal', { customerReplied: true }, {}, 'customer_replied', true],
    ['nesouhlas s oslovením', {}, { doNotContact: true }, 'do_not_contact', false],
    ['uzavřený obchod', {}, { dealClosed: true }, 'deal_closed', false],
  ] as const)('%s → blok bez odeslání', async (_n, mailOpts, facts, reason, withTask) => {
    const { store, calls } = fakeStore([row()], { facts })
    const { mail } = fakeMail(mailOpts)
    await run(store, mail)
    expect(mail.send).not.toHaveBeenCalled()
    expect(calls.claims).toHaveLength(0)
    expect(calls.finishes[0]).toMatchObject({ status: 'blocked', reason })
    expect(calls.finishes[0].task != null).toBe(withTask)
  })

  test('VIP kontakt a zásah člověka → schválení člověkem', async () => {
    const vip = fakeStore([row({ kind: 'info_request', mode: 'to', to_email: 'ceo@vip.example', in_reply_to_message_id: null, scope_version_id: null })])
    await run(vip.store, fakeMail().mail)
    expect(vip.calls.finishes[0]).toMatchObject({ reason: 'approval_required' })
    expect(vip.calls.finishes[0].task?.text).toContain('VIP')
  })

  test('logy nesou jen id, druh a kódy — nikdy text, předmět ani adresy', async () => {
    const events: string[] = []
    const { store } = fakeStore([row(), row({ id: 8, source_ref: 'inquiry:2', scope_version_id: 22 })])
    const { mail } = fakeMail({ outcome: () => ({ kind: 'forbidden', reason: 'x' }) })
    await run(store, mail, {}, (e, c) => events.push(`${e} ${JSON.stringify(c)}`))
    expect(events.length).toBeGreaterThan(0)
    expect(events.join('\n')).not.toMatch(/karel|alfa\.example|Poptávka|nabídku|Dobrý den/)
  })
})

describe('agent-outbox: nastavení firmy', () => {
  test('firma má frontu; ilustrační mapa; limity a druhy z kontraktů P2/P4', () => {
    const cfg = outboxRunConfig({}, NOW)!
    expect(cfg).not.toBeNull()
    expect(cfg.autoSendEnabled).toBe(false)
    expect(outboxRunConfig({ AGENT_AUTOSEND_ENABLED: 'true' }, NOW)!.autoSendEnabled).toBe(true)
    expect(cfg.companyMapVersion).toMatch(/^ilustracni/)
    expect(cfg.autoSendKinds).toContain('offer')
    expect(cfg.inquiryLimits).toEqual({ dailyAutoSendLimit: COMPANY.capabilities.inquiryAgent!.dailyAutoSendLimit, perRecipientDailyLimit: COMPANY.capabilities.inquiryAgent!.perRecipientDailyLimit })
    expect(cfg.outbox.footer).toContain('IČO 17957524')
    expect(cfg.outbox.offerTerms).toMatch(/nezávazná/)
    expect(cfg.outbox.offerTerms).toMatch(/písemným potvrzením/)
    expect(cfg.outbox.offerTerms).toMatch(/[Ss]torno/)
    expect(cfg.outbox.offerTerms).toMatch(/alergen/)
    expect(cfg.outbox.footer).toMatch(/automatický systém/)
    expect(cfg.wonPhases).toEqual(expect.arrayContaining(['potvrzeno', 'realizovano']))
  })

  test('pražský den a hodina (okno připomínek)', () => {
    expect(pragueWeekdayHour(new Date('2026-11-05T10:00:00Z'))).toEqual({ isoWeekday: 4, hour: 11 })
    expect(pragueWeekdayHour(new Date('2026-11-08T23:30:00Z'))).toEqual({ isoWeekday: 1, hour: 0 })
  })

  test('vlastní Message-ID', () => {
    expect(newRfcMessageId(5, 'Firma.Example', () => 'ab12')).toBe('<ao.5.ab12@firma.example>')
    expect(() => newRfcMessageId(5, 'zla domena')).toThrow()
  })
})
