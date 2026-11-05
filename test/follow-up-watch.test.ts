import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FOLLOW_UP_NODE,
  FOLLOW_UP_STEP_TITLE,
  FOLLOW_UP_WATCH_ACTOR,
  episodeDueAt,
  planFollowUpWatch,
  runFollowUpWatch,
  type FollowUpWatchDb,
  type WatchCase,
  type WatchDeal,
} from '@/domain/crm/followUpWatch'
import { COMPANY } from '@/config'
import { createFollowUpWatchDb, runFollowUpWatchJob, isMissingRelation } from '@/worker/followUpWatch'
import { createSupabaseFake } from './helpers/supabaseFake'

const NOW = new Date('2026-09-29T08:00:00Z')
const DUE = '2026-09-24' // 5 dní po termínu → eskalace

const deal = (o: Partial<WatchDeal> = {}): WatchDeal => ({
  id: 7, title: 'Agentizace ALFATECH', account_name: 'ALFATECH', account_id: 3, owner_id: 'u-owner',
  next_step: 'Zavolat', next_step_due: DUE, last_activity_at: null,
  follow_up_nudged_on: null, follow_up_escalated_on: null, ...o,
})

const kase = (o: Partial<WatchCase> = {}): WatchCase => ({
  id: 50, deal_id: 7, title: 'Follow-up: Agentizace ALFATECH', status: 'open',
  lead_owner_id: 'u-owner', deputy_id: null, account_id: 3,
  steps: [{ id: 500, title: FOLLOW_UP_STEP_TITLE, status: 'todo', due_at: episodeDueAt(DUE), position: 1 }],
  open_decisions: 0, pending_approvals: 0, ...o,
})

const plan = (deals: WatchDeal[], activeCases: WatchCase[] = [], closedCases: WatchCase[] = []) =>
  planFollowUpWatch({ deals, activeCases, closedCases, nodeOwnerId: 'u-node', now: NOW })

describe('planFollowUpWatch — rozhodnutí', () => {
  it('uzel případu je z konfigurace firmy', () => {
    expect(FOLLOW_UP_NODE).toBe(COMPANY.followUpNode)
  })

  it('eskalovaný follow-up bez případu → open s jedním krokem, vlastník = vlastník obchodu', () => {
    const [a] = plan([deal()])
    expect(a.kind).toBe('open')
    if (a.kind !== 'open') return
    expect(a.case).toEqual({
      title: 'Follow-up: Agentizace ALFATECH', node: COMPANY.followUpNode, status: 'open',
      lead_owner_id: 'u-owner', account_id: 3, deal_id: 7, created_by: FOLLOW_UP_WATCH_ACTOR,
    })
    expect(a.step).toMatchObject({ title: 'Ozvat se klientovi', status: 'todo', position: 1 })
  })

  it('neeskalovaný follow-up (jen vlastník) případ nezakládá', () => {
    expect(plan([deal({ next_step_due: '2026-09-28' })])).toEqual([])
  })

  it('obchod bez vlastníka → vlastník uzlu', () => {
    const [a] = plan([deal({ owner_id: null })])
    expect(a.kind === 'open' && a.case.lead_owner_id).toBe('u-node')
  })

  it('změněný název a vlastník obchodu → update', () => {
    const [a] = plan([deal({ title: 'Nový název', owner_id: 'u-2' })], [kase()])
    expect(a).toMatchObject({ kind: 'update', case_id: 50, patch: { title: 'Follow-up: Nový název', lead_owner_id: 'u-2' }, step: null })
  })

  it('nový termín (nová epizoda) → přeplánuje aktivní krok', () => {
    const [a] = plan([deal({ next_step_due: '2026-09-25' })], [kase()])
    expect(a).toMatchObject({ kind: 'update', step: { op: 'reschedule', step_id: 500, due_at: episodeDueAt('2026-09-25') } })
  })

  it('vyřešený follow-up → krok todo → doing → done a případ do done', () => {
    const [a] = plan([deal({ last_activity_at: '2026-09-28T10:00:00Z' })], [kase()])
    expect(a).toMatchObject({
      kind: 'close', case_id: 50,
      steps: [{ step_id: 500, from: 'todo', path: ['doing', 'done'] }],
      case_move: { from: 'open', path: ['in_progress', 'done'] },
    })
  })

  it('smazaný obchod (deal_id NULL po ON DELETE SET NULL) → případ se uzavře', () => {
    const actions = plan([], [kase({ deal_id: null })])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      kind: 'close', deal_id: null, case_id: 50,
      steps: [{ step_id: 500, from: 'todo', path: ['doing', 'done'] }],
      case_move: { from: 'open', path: ['in_progress', 'done'] },
    })
  })

  it('vyřešený, ale případ má otevřené rozhodnutí → zavře jen krok', () => {
    const [a] = plan([], [kase({ open_decisions: 1 })])
    expect(a).toMatchObject({ kind: 'close', case_move: null })
  })

  it('aktuální případ → noop', () => {
    expect(plan([deal()], [kase()])).toEqual([{ kind: 'noop', deal_id: 7, case_id: 50, reason: 'up_to_date' }])
  })

  it('člověk v téže epizodě případ uzavřel → znovu neotevírá', () => {
    const closed = kase({ status: 'done', steps: [{ ...kase().steps[0], status: 'done' }] })
    expect(plan([deal()], [], [closed])).toEqual([{ kind: 'noop', deal_id: 7, case_id: null, reason: 'closed_in_episode' }])
  })

  it('druhý aktivní případ téhož obchodu se nesahá', () => {
    const actions = plan([deal()], [kase(), kase({ id: 51 })])
    expect(actions).toContainEqual({ kind: 'noop', deal_id: 7, case_id: 51, reason: 'duplicate' })
    expect(actions.filter((a) => a.kind === 'open')).toEqual([])
  })
})

// Paměťová DB: aplikuje zápisy, aby šla ověřit idempotence opakovaného běhu.
function memoryDb(deals: WatchDeal[]) {
  const cases: WatchCase[] = []
  let seq = 100
  const db: FollowUpWatchDb = {
    loadDeals: async () => deals,
    loadNodeOwner: async () => 'u-node',
    loadActiveCases: async () => cases.filter((c) => ['open', 'in_progress', 'waiting'].includes(c.status)),
    loadClosedCases: async (_a, ids) => cases.filter((c) => ['done', 'cancelled'].includes(c.status) && ids.includes(c.deal_id!)),
    insertCase: async (row) => {
      const id = ++seq
      cases.push({ id, deal_id: row.deal_id, title: row.title, status: row.status, lead_owner_id: row.lead_owner_id,
        deputy_id: null, account_id: row.account_id, steps: [], open_decisions: 0, pending_approvals: 0 })
      return id
    },
    cancelCase: async (id) => { cases.find((c) => c.id === id)!.status = 'cancelled' },
    updateCase: async (id, patch) => { Object.assign(cases.find((c) => c.id === id)!, patch) },
    insertStep: async (id, row) => {
      const c = cases.find((x) => x.id === id)!
      c.steps = [...c.steps, { id: ++seq, ...row }]
    },
    rescheduleStep: async (sid, due) => {
      for (const c of cases) c.steps = c.steps.map((s) => (s.id === sid ? { ...s, due_at: due } : s))
    },
    setStepStatus: async (sid, from, to) => {
      for (const c of cases) {
        const s = c.steps.find((x) => x.id === sid)
        if (s) { if (s.status !== from) return false; c.steps = c.steps.map((x) => (x.id === sid ? { ...x, status: to } : x)); return true }
      }
      return false
    },
    setCaseStatus: async (id, from, to) => {
      const c = cases.find((x) => x.id === id)!
      if (c.status !== from) return false
      c.status = to
      return true
    },
  }
  return { db, cases }
}

describe('runFollowUpWatch — idempotence', () => {
  it('druhý běh nic nemění, jeden případ na obchod', async () => {
    const { db, cases } = memoryDb([deal()])
    const first = await runFollowUpWatch(db, NOW)
    expect(first).toMatchObject({ state: 'ok', opened: 1, failed: 0 })
    const second = await runFollowUpWatch(db, NOW)
    expect(second).toMatchObject({ opened: 0, updated: 0, unchanged: 1 })
    expect(cases).toHaveLength(1)
    expect(cases[0].steps).toHaveLength(1)
  })

  it('po vyřešení uzavře krok i případ a pak už nic', async () => {
    const deals = [deal()]
    const { db, cases } = memoryDb(deals)
    await runFollowUpWatch(db, NOW)
    deals[0] = deal({ last_activity_at: '2026-09-29T07:00:00Z' })
    const s = await runFollowUpWatch(db, NOW)
    expect(s).toMatchObject({ closed_steps: 1, closed_cases: 1 })
    expect(cases[0]).toMatchObject({ status: 'done', steps: [{ status: 'done' }] })
    expect(await runFollowUpWatch(db, NOW)).toMatchObject({ opened: 0, closed_steps: 0, unchanged: 0 })
  })

  it('chybějící Loop Core → missing_migration, nic nezapisuje', async () => {
    const { db } = memoryDb([deal()])
    db.loadActiveCases = async () => null
    expect((await runFollowUpWatch(db, NOW)).state).toBe('missing_migration')
  })
})

describe('worker adaptér (service role)', () => {
  it('insert work_case posílá created_by výslovně (system:follow-up-watch)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: { id: 9 }, error: null }) })
    const db = createFollowUpWatchDb(fake.client as never)
    const [a] = plan([deal()])
    if (a.kind !== 'open') throw new Error('čekán open')
    expect(await db.insertCase(a.case)).toBe(9)
    const call = fake.calls.find((c) => c.table === 'work_case')!
    const row = call.ops.find((o) => o.method === 'insert')!.args[0] as Record<string, unknown>
    expect(row.created_by).toBe('system:follow-up-watch')
    expect(FOLLOW_UP_WATCH_ACTOR.startsWith('system:')).toBe(true)
  })

  it('chybějící tabulka work_case → null (klidná zpráva místo pádu)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42P01', message: 'x' } }) })
    expect(await createFollowUpWatchDb(fake.client as never).loadActiveCases(FOLLOW_UP_WATCH_ACTOR)).toBeNull()
    expect(isMissingRelation({ code: 'PGRST205', message: '' })).toBe(true)
  })

  it('runFollowUpWatchJob zapisuje stav konektoru', async () => {
    const { db } = memoryDb([deal()])
    const recordSuccess = vi.fn(async () => {})
    const recordError = vi.fn(async () => {})
    const finish = vi.fn(async () => {})
    const r = await runFollowUpWatchJob({
      jobDb: { tryAcquireJobLock: async () => 1, finishJobRun: finish },
      watchDb: db, recordSuccess, recordError, connector: 'follow_up_watch', now: () => NOW,
    })
    expect(r.status).toBe('succeeded')
    expect(recordSuccess).toHaveBeenCalledWith('follow_up_watch', null)
    expect(finish).toHaveBeenCalledWith(1, 'succeeded', expect.objectContaining({ opened: 1 }), null)
  })
})

describe('/api/cron/follow-ups', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('bez FOLLOWUP_WATCH_ENABLED=true vrací 404 i se správným secretem', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('FOLLOWUP_WATCH_ENABLED', '1')
    const { GET } = await import('@/app/api/cron/follow-ups/route')
    const res = await GET(new Request('https://x/api/cron/follow-ups', { headers: { authorization: 'Bearer s3cret' } }))
    expect(res.status).toBe(404)
  })

  it('zapnutá route se špatným Bearer vrací 401', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('FOLLOWUP_WATCH_ENABLED', 'true')
    const { GET } = await import('@/app/api/cron/follow-ups/route')
    const res = await GET(new Request('https://x/api/cron/follow-ups', { headers: { authorization: 'Bearer spatne' } }))
    expect(res.status).toBe(401)
  })

  it('maxDuration 60 a denní plán ve vercel.json', async () => {
    const mod = await import('@/app/api/cron/follow-ups/route')
    expect(mod.maxDuration).toBe(60)
    const { readFileSync } = await import('node:fs')
    const cfg = JSON.parse(readFileSync(`${__dirname}/../vercel.json`, 'utf8')) as { crons: unknown[] }
    expect(cfg.crons).toContainEqual({ path: '/api/cron/follow-ups', schedule: '0 6 * * *' })
  })
})
