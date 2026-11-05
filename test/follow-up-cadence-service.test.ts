// Follow-up cadence nad falešným Supabase klientem: Supabase adaptér
// (worker/followUpSend.ts) + zápis plánu (domain/crm/followUpCadenceService.ts).
// Chybějící agent_outbox_enqueue (P3) nechá pokus 'planned'; agent nezapisuje
// sales_activity, takže follow-up hlídač případ nad stejnými daty nezavře.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { createFollowUpCadenceDb } from '@/worker/followUpSend'
import { runFollowUpCadence, type RunCadenceOptions } from '@/domain/crm/followUpCadenceService'
import { FOLLOW_UP_WATCH_ACTOR, planFollowUpWatch, type WatchCase, type WatchDeal } from '@/domain/crm/followUpWatch'
import type { CadenceAttempt, CadenceFacts } from '@/domain/crm/followUpCadence'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

const OWNER = 'b1111111-1111-4111-8111-111111111111'
const CFG = COMPANY.capabilities.followUpCadence!
const OPTS: RunCadenceOptions = {
  cfg: CFG,
  wonPhases: COMPANY.wonPhases,
  lostReasonKeys: COMPANY.lostReasons!.map((r) => r.key),
}
// Čtvrtek 5. 11. 2026 10:00 Praha; nabídka odešla v pondělí 2. 11.
const NOW = new Date('2026-11-05T09:00:00Z')
const OFFER_SENT = '2026-11-02T09:00:00Z'

type World = {
  dealRow?: Record<string, unknown>
  attempts?: CadenceAttempt[]
  facts?: Partial<CadenceFacts>
  cases?: { deal_id: number }[]
  enqueue?: QueryResult
  attemptTableMissing?: boolean
}

function setup(w: World = {}) {
  const dealRow = {
    id: 7, title: 'Vánoční večírek 120 hostů', stage: 'rozsah_nabidka', pillar: 'b2b_akce', phase: 'nabidka',
    owner_id: OWNER, account_id: 10, primary_contact_id: 100, next_step_due: null, ...w.dealRow,
  }
  const facts: CadenceFacts = {
    deal_id: 7, last_inbound_at: null, last_outbound_at: OFFER_SENT, last_human_activity_at: null, offer_sent_at: OFFER_SENT,
    contact_do_not_contact: false, account_contacts: 1, account_opted_out: 0, event_date: '2026-12-11', ...w.facts,
  }
  const resolve = (call: QueryCall): QueryResult => {
    const write = hasOp(call, 'insert') || hasOp(call, 'update')
    if (write) return { data: null, error: null }
    switch (call.table) {
      case 'follow_up_attempt':
        if (w.attemptTableMissing) return { data: null, error: { code: '42P01', message: 'relation does not exist' } }
        if (hasOp(call, 'gte')) return { data: [], error: null }
        if (hasOp(call, 'in')) return { data: w.attempts ?? [], error: null }
        return { data: (w.attempts ?? []).filter((a) => a.status === 'planned'), error: null }
      case 'deal': return { data: [dealRow], error: null }
      case 'contact':
        return { data: [{ id: 100, full_name: 'Karel Ukázkový', email: 'karel@alfa.example', do_not_contact: false, notes: null }], error: null }
      case 'account': return { data: [{ id: 10, notes: null, snooze_until: null }], error: null }
      case 'work_case': return { data: w.cases ?? [], error: null }
      default: return { data: null, error: null }
    }
  }
  const fake = createSupabaseFake({
    resolve,
    rpc: (name) => {
      if (name === 'follow_up_facts') return { data: [facts], error: null }
      if (name === 'agent_outbox_enqueue') return w.enqueue ?? { data: { outbox_id: 501, duplicate: false }, error: null }
      return { data: null, error: null }
    },
  })
  const db = createFollowUpCadenceDb(fake.client as never)
  const writes = (table: string, op: 'insert' | 'update') => fake.calls.filter((c) => c.table === table && hasOp(c, op))
  return { fake, db, writes, dealRow }
}

describe('runFollowUpCadence + Supabase adaptér', () => {
  test('bez agent_outbox_enqueue (P3) zůstane pokus planned a obchod se nemění', async () => {
    const { db, writes, fake } = setup({ enqueue: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } })
    const stats = await runFollowUpCadence(db, NOW, OPTS)
    expect(stats).toMatchObject({ state: 'ok', enqueued: 0, pending_outbox: 1, failed: 0 })
    const inserts = writes('follow_up_attempt', 'insert')
    expect(inserts).toHaveLength(1)
    expect(opArgs(inserts[0], 'insert')?.[0]).toEqual({
      deal_id: 7, attempt: 1, planned_on: '2026-11-05', status: 'planned', stop_reason: null, template: 'pripominka_1',
    })
    expect(writes('follow_up_attempt', 'update')).toEqual([])
    expect(writes('deal', 'update')).toEqual([])
    expect(fake.rpc).toHaveBeenCalledWith('agent_outbox_enqueue', { p: expect.objectContaining({
      kind: 'follow_up', source_ref: 'followup:7:1', deal_id: 7, mailbox_member_id: OWNER, mode: { to: 'karel@alfa.example' },
    }) })
  })

  test('další běh zkusí naplánovaný pokus znovu (bez nového řádku) a zařadí ho', async () => {
    const planned: CadenceAttempt = { deal_id: 7, attempt: 1, status: 'planned', planned_on: '2026-11-05', enqueued_at: null }
    const { db, writes } = setup({ attempts: [planned] })
    const stats = await runFollowUpCadence(db, new Date('2026-11-06T09:00:00Z'), OPTS)
    expect(stats).toMatchObject({ enqueued: 1, pending_outbox: 0 })
    expect(writes('follow_up_attempt', 'insert')).toEqual([])
    const upd = writes('follow_up_attempt', 'update')[0]
    expect(opArgs(upd, 'update')?.[0]).toMatchObject({ status: 'enqueued', outbox_id: 501, outbox_source_ref: 'followup:7:1' })
  })

  test('zařazení: řádek enqueued, next_step_due jen dopředu, žádná sales_activity', async () => {
    const { db, writes, fake } = setup()
    const stats = await runFollowUpCadence(db, NOW, OPTS)
    expect(stats).toMatchObject({ enqueued: 1, failed: 0 })
    const deal = writes('deal', 'update')
    expect(deal).toHaveLength(1)
    expect(opArgs(deal[0], 'update')?.[0]).toEqual({ next_step_due: '2026-11-12' })
    expect(opArgs(deal[0], 'or')?.[0]).toBe('next_step_due.is.null,next_step_due.lt.2026-11-12')
    expect(fake.calls.some((c) => c.table === 'sales_activity')).toBe(false)
    // Do statistik nejde e-mail ani jméno.
    expect(JSON.stringify(stats)).not.toMatch(/karel|alfa\.example/i)
  })

  test('souběžný běh (UNIQUE deal+pořadí) nic nezdvojí', async () => {
    const { db, fake } = setup()
    const resolveOrig = fake.from.getMockImplementation()!
    fake.from.mockImplementation((table: string) => {
      const b = resolveOrig(table) as Record<string, (...a: unknown[]) => unknown>
      if (table !== 'follow_up_attempt') return b
      const insert = b.insert
      b.insert = (...args: unknown[]) => {
        insert(...args)
        return { then: (ok: (v: QueryResult) => unknown) => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }).then(ok) }
      }
      return b
    })
    const stats = await runFollowUpCadence(db, NOW, OPTS)
    expect(stats).toMatchObject({ enqueued: 0, duplicates: 1, failed: 0 })
    expect(fake.rpc).not.toHaveBeenCalledWith('agent_outbox_enqueue', expect.anything())
  })

  test('odpověď zákazníka → řádek stopped, nic do fronty', async () => {
    const { db, writes, fake } = setup({ facts: { last_inbound_at: '2026-11-03T08:00:00Z' } })
    const stats = await runFollowUpCadence(db, NOW, OPTS)
    expect(stats).toMatchObject({ stopped: 1, enqueued: 0 })
    expect(opArgs(writes('follow_up_attempt', 'insert')[0], 'insert')?.[0]).toMatchObject({ status: 'stopped', stop_reason: 'customer_replied', attempt: 1 })
    expect(fake.rpc).not.toHaveBeenCalledWith('agent_outbox_enqueue', expect.anything())
  })

  test('chybí 0105 → missing_migration, nic se nepíše', async () => {
    const { db, fake } = setup({ attemptTableMissing: true })
    expect((await runFollowUpCadence(db, NOW, OPTS)).state).toBe('missing_migration')
    expect(fake.calls.filter((c) => hasOp(c, 'insert') || hasOp(c, 'update'))).toEqual([])
  })

  test('bez nastavení firmy (cfg null) se nic nečte', async () => {
    const { db, fake } = setup()
    expect((await runFollowUpCadence(db, NOW, { ...OPTS, cfg: null })).state).toBe('disabled')
    expect(fake.calls).toEqual([])
  })

  const sent = [
    { deal_id: 7, attempt: 1, status: 'enqueued' as const, planned_on: '2026-11-05', enqueued_at: '2026-11-05T09:00:00Z' },
    { deal_id: 7, attempt: 2, status: 'enqueued' as const, planned_on: '2026-11-12', enqueued_at: '2026-11-12T09:00:00Z' },
  ]

  test('vyčerpání (case): značka exhausted a next_step_due = dnes − 3, hlídač pak založí případ', async () => {
    // 12. 11. + 5 pracovních dnů (17. 11. svátek) = pá 20. 11.
    const { db: early } = setup({ attempts: sent })
    expect((await runFollowUpCadence(early, new Date('2026-11-19T09:00:00Z'), OPTS)).skipped).toEqual({ waiting_exhaustion: 1 })
    const now = new Date('2026-11-20T09:00:00Z')
    const { db, writes, dealRow } = setup({ attempts: sent, dealRow: { next_step_due: '2026-11-20' } })
    const stats = await runFollowUpCadence(db, now, OPTS)
    expect(stats).toMatchObject({ exhausted: 1 })
    expect(opArgs(writes('follow_up_attempt', 'insert')[0], 'insert')?.[0])
      .toMatchObject({ attempt: 3, status: 'exhausted', stop_reason: 'max_attempts' })
    const upd = writes('deal', 'update')[0]
    expect(opArgs(upd, 'update')?.[0]).toEqual({ next_step_due: '2026-11-17' })
    expect(hasOp(upd, 'or')).toBe(false)

    // Hlídač nad stejnými daty (potvrzení odeslání v P3 posunulo
    // last_activity_at na den po 2. zařazení) případ založí.
    const watchDeal: WatchDeal = {
      id: 7, title: String(dealRow.title), account_name: null, owner_id: OWNER, account_id: 10, next_step: null,
      next_step_due: '2026-11-17', last_activity_at: '2026-11-13T06:30:00Z', follow_up_nudged_on: null, follow_up_escalated_on: null,
    }
    const actions = planFollowUpWatch({ deals: [watchDeal], activeCases: [], nodeOwnerId: null, now: new Date('2026-11-21T05:00:00Z') })
    expect(actions.map((a) => a.kind)).toEqual(['open'])
  })

  test('vyčerpání (lost): obchod prohraný s důvodem z číselníku', async () => {
    const { db, writes } = setup({ attempts: sent })
    await runFollowUpCadence(db, new Date('2026-11-20T09:00:00Z'), { ...OPTS, cfg: { ...CFG, onExhausted: 'lost' } })
    const upd = writes('deal', 'update')[0]
    expect(opArgs(upd, 'update')?.[0]).toMatchObject({ stage: 'prohráno', lost_reason: 'Bez odpovědi', closed_at: '2026-11-20', next_step_due: null })
  })
})

describe('soužití s follow-up hlídačem', () => {
  const activeCase: WatchCase = {
    id: 55, deal_id: 7, title: 'Follow-up: Vánoční večírek 120 hostů', status: 'open', lead_owner_id: OWNER, deputy_id: null,
    account_id: 10, steps: [{ id: 1, title: 'Ozvat se klientovi', status: 'todo', due_at: '2026-10-31T22:59:59.999Z', position: 1 }],
    open_decisions: 0, pending_approvals: 0,
  }
  const watchDeal = (over: Partial<WatchDeal> = {}): WatchDeal => ({
    id: 7, title: 'Vánoční večírek 120 hostů', account_name: null, owner_id: OWNER, account_id: 10, next_step: null,
    next_step_due: '2026-10-31', last_activity_at: '2026-10-30T10:00:00Z', follow_up_nudged_on: null, follow_up_escalated_on: null, ...over,
  })

  test('otevřený případ hlídače: cadence nic nepošle ani nepřeplánuje, hlídač případ nezavře', async () => {
    const { db, writes, fake } = setup({ dealRow: { next_step_due: '2026-10-31' }, cases: [{ deal_id: 7 }] })
    const stats = await runFollowUpCadence(db, NOW, OPTS)
    expect(stats.skipped).toEqual({ case_open: 1 })
    expect(writes('deal', 'update')).toEqual([])
    const caseQuery = fake.calls.find((c) => c.table === 'work_case')!
    expect(opArgs(caseQuery, 'eq')).toEqual(['created_by', FOLLOW_UP_WATCH_ACTOR])
    const actions = planFollowUpWatch({ deals: [watchDeal()], activeCases: [activeCase], nodeOwnerId: null, now: NOW })
    expect(actions.map((a) => a.kind)).not.toContain('close')
  })

  test('po zařazení follow-upu: bez sales_activity se last_activity_at nehne a hlídač případ nezavře', async () => {
    const { db, fake } = setup({ dealRow: { next_step_due: '2026-11-04' } })
    await runFollowUpCadence(db, NOW, OPTS)
    // Agent nic do sales_activity nezapsal → trigger touch_deal_last_activity
    // nemá co posunout; obchod pro hlídača vypadá stejně jako před během.
    expect(fake.calls.some((c) => c.table === 'sales_activity')).toBe(false)
    const actions = planFollowUpWatch({
      deals: [watchDeal({ next_step_due: '2026-10-31' })], activeCases: [activeCase], nodeOwnerId: null, now: NOW,
    })
    expect(actions.map((a) => a.kind)).not.toContain('close')
  })
})
