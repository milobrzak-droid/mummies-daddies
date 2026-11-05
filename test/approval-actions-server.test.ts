// Server akce schválení napojeného na akci (0084) nad falešnou databází:
// brána AAL2, vstupy, srozumitelné věty předem, přesné argumenty RPC
// a překlad chyb. Pravidla samotná (čtyři oči, pravomoc, provedení) drží
// SQL — viz test/approval-executor-pglite.test.ts.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { requestNextStepApproval, retryApprovalExecution, snoozeApprovalRequest } from '@/core/actions/approvals'
import { decideApprovalRequest } from '@/core/actions/workCases'
import { requestScopeVersionSendApproval, sendScopeVersion } from '@/domain/crm/actions/scopeVersions'
import { APPROVAL_ACTION_PENDING_MESSAGE } from '@/core/approvalActions'
import { pragueToday, addDaysToPragueDay } from '@/lib/pragueDate'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: USER })),
  tryRequireUser: vi.fn(async () => ({ id: USER })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(),
  memberSeesSales: (m: { role?: string } | null) => m?.role === 'vedeni' || m?.role === 'obchodnik',
}))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbSoftAuditActive: vi.fn(async () => true), dbAuditActive: vi.fn(async () => true) }))
vi.mock('@/connectors/cnb', () => ({ czkPerEur: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PAVLA = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

const ok = (data: unknown): QueryResult => ({ data, error: null })
function setup(route: (call: QueryCall) => QueryResult | undefined, rpc?: (name: string, args: unknown) => QueryResult) {
  const fake = createSupabaseFake({ user: { id: USER }, resolve: (c) => route(c) ?? ok(null), rpc })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}
function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentMember).mockResolvedValue({ member: { role: 'obchodnik' } } as never)
})

describe('brána AAL2: bez ní se nesáhne do DB', () => {
  test.each([
    ['requestNextStepApproval', () => requestNextStepApproval(null, form({}))],
    ['snoozeApprovalRequest', () => snoozeApprovalRequest(null, form({}))],
    ['retryApprovalExecution', () => retryApprovalExecution(null, form({}))],
    ['requestScopeVersionSendApproval', () => requestScopeVersionSendApproval(1, 5, 9)],
  ])('%s', async (_n, run) => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const fake = setup(() => undefined)
    expect(await run()).toMatchObject({ success: false, error: 'auth' })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(fake.from).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalled()
  })
})

describe('requestNextStepApproval (Potvrdit další krok)', () => {
  const due = addDaysToPragueDay(pragueToday(), 5)
  const valid = { case_id: '3', title: 'Technická analýza', assignee_id: PAVLA, due_on: due, decision_id: '4' }
  const openCase = (call: QueryCall) => (call.table === 'work_case' ? ok({ id: 3, status: 'in_progress' }) : undefined)

  test('RPC dostane druh, cíl a parametry; platnost do konce pražského dne', async () => {
    const fake = setup(openCase, () => ok(12))
    expect(await requestNextStepApproval(null, form({ ...valid, expires_on: '2026-10-05' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('request_action_approval', {
      p_action_type: 'confirm_next_step',
      p_target_id: 3,
      p_params: { title: 'Technická analýza', assignee_id: PAVLA, due_on: due, decision_id: 4 },
      p_expires_at: '2026-10-05T22:00:00.000Z',
    })
  })

  test('bez platnosti rozhodne DB (výchozí z konfigurace)', async () => {
    const fake = setup(openCase, () => ok(12))
    await requestNextStepApproval(null, form({ ...valid, decision_id: '' }))
    expect(fake.rpc).toHaveBeenCalledWith('request_action_approval', expect.objectContaining({
      p_params: expect.objectContaining({ decision_id: null }), p_expires_at: null,
    }))
  })

  test('chybný vstup a termín v minulosti = chyby polí, do DB nic', async () => {
    const fake = setup(openCase)
    const bad = await requestNextStepApproval(null, form({ case_id: '3', title: '', assignee_id: 'x', due_on: '' }))
    expect(bad.fieldErrors).toMatchObject({ title: expect.any(String), assignee_id: expect.any(String), due_on: expect.any(String) })
    const past = await requestNextStepApproval(null, form({ ...valid, due_on: '2000-01-01' }))
    expect(past).toEqual({ success: false, fieldErrors: { due_on: 'Termín nesmí být v minulosti.' } })
    expect(fake.from).not.toHaveBeenCalled()
  })

  test('uzavřený případ: srozumitelná věta, RPC se nevolá', async () => {
    const fake = setup((c) => (c.table === 'work_case' ? ok({ id: 3, status: 'done' }) : undefined))
    expect(await requestNextStepApproval(null, form(valid))).toEqual({ success: false, error: 'Případ je uzavřený, další krok už se nenavrhuje.' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test.each([
    [{ code: 'PGRST202', message: 'Could not find the function public.request_action_approval(p_action_type, p_params, p_target_id, p_expires_at)' }, APPROVAL_ACTION_PENDING_MESSAGE],
    [{ code: '22023', message: 'Řešitel kroku musí být aktivní člen týmu' }, 'Řešitel kroku musí být aktivní člen týmu.'],
    [{ code: 'LP004', message: 'Případ je uzavřený — schválení už nejde žádat' }, 'Případ je uzavřený, už se nemění.'],
    [{ code: '42501', message: 'Jen pro člena týmu' }, 'Tuto akci může provést jen přihlášený člen týmu.'],
  ])('chyba RPC %j → česká věta', async (err, msg) => {
    setup(openCase, () => ({ data: null, error: err }))
    expect(await requestNextStepApproval(null, form(valid))).toEqual({ success: false, error: msg })
  })
})

describe('snoozeApprovalRequest („Odložit do…" na serveru)', () => {
  const pending = (expires: string | null) => (c: QueryCall) =>
    c.table === 'approval_request' ? ok({ id: 5, case_id: 3, status: 'pending', expires_at: expires, snoozed_until: null }) : undefined

  test('do zítřka: okamžik za den; vrátit: null', async () => {
    const fake = setup(pending(null), () => ok(null))
    const before = Date.now()
    expect(await snoozeApprovalRequest(null, form({ request_id: '5', choice: 'zitra' }))).toEqual({ success: true })
    const until = Date.parse((fake.rpc.mock.calls[0][1] as { p_until: string }).p_until)
    expect(until - before).toBeGreaterThanOrEqual(86_400_000 - 1000)
    expect(until - before).toBeLessThan(86_400_000 + 5000)
    await snoozeApprovalRequest(null, form({ request_id: '5', choice: 'vratit' }))
    expect(fake.rpc).toHaveBeenLastCalledWith('snooze_approval', { p_request_id: 5, p_until: null })
  })

  test('žádost brzy vyprší: odložit nejde, RPC se nevolá', async () => {
    const fake = setup(pending(new Date(Date.now() + 10 * 60_000).toISOString()))
    const r = await snoozeApprovalRequest(null, form({ request_id: '5', choice: 'tyden' }))
    expect(r).toEqual({ success: false, error: 'Žádost brzy vyprší, odložit už nejde. Rozhodni o ní.' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test('před migrací 0084 (sloupec chybí) klidná hláška', async () => {
    setup((c) => (c.table === 'approval_request' ? { data: null, error: { code: '42703', message: 'column approval_request.snoozed_until does not exist' } } : undefined))
    expect(await snoozeApprovalRequest(null, form({ request_id: '5', choice: 'zitra' }))).toEqual({ success: false, error: APPROVAL_ACTION_PENDING_MESSAGE })
  })

  test('rozhodnutá žádost a zákaz z DB', async () => {
    setup((c) => (c.table === 'approval_request' ? ok({ id: 5, case_id: 3, status: 'approved', expires_at: null }) : undefined))
    expect(await snoozeApprovalRequest(null, form({ request_id: '5', choice: 'zitra' }))).toEqual({ success: false, error: 'O požadavku už bylo rozhodnuto.' })
    setup(pending(null), () => ({ data: null, error: { code: '42501', message: 'Odložit smí jen ten, kdo o žádosti může rozhodnout' } }))
    expect(await snoozeApprovalRequest(null, form({ request_id: '5', choice: 'zitra' }))).toEqual({
      success: false, error: 'Odložit smí jen ten, kdo o žádosti může rozhodnout.',
    })
  })
})

describe('retryApprovalExecution', () => {
  test('provedeno = úspěch; znovu selhalo = věta; nic k opakování = věta z DB', async () => {
    const fake = setup((c) => (c.table === 'approval_request' ? ok({ case_id: 3 }) : undefined), () => ok('completed'))
    expect(await retryApprovalExecution(null, form({ request_id: '5' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('retry_approval_execution', { p_request_id: 5 })
    setup(() => undefined, () => ok('failed'))
    expect((await retryApprovalExecution(null, form({ request_id: '5' }))).error).toMatch(/ani teď nepovedlo/)
    setup(() => undefined, () => ({ data: null, error: { code: '22023', message: 'Provedení není co opakovat' } }))
    expect((await retryApprovalExecution(null, form({ request_id: '5' }))).error).toMatch(/není co opakovat/)
  })
})

describe('decideApprovalRequest u odeslání nabídky', () => {
  const world = (role: string) => (call: QueryCall) => {
    if (call.table === 'approval_request') {
      return ok({ id: 5, case_id: null, node: 'n1', action_type: 'send_offer', status: 'pending', requested_level: 'L2', requested_by: `user:${OTHER}`, expires_at: null, work_case: null })
    }
    if (call.table === 'loop_node') return ok([{ node: 'n1', owner_id: USER, deputy_id: null }])
    if (call.table === 'team_member') return ok({ role })
    return undefined
  }
  test('vlastník uzlu bez obchodní role: věta předem, RPC se nevolá', async () => {
    const fake = setup(world('projektak'))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).toEqual({
      success: false, error: 'Odeslání nabídky schvaluje jen člen s přístupem k obchodu.',
    })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
  test('obchodní role schválí přes RPC (provedení dělá DB)', async () => {
    const fake = setup(world('vedeni'), () => ok('approved'))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('decide_approval', { p_request_id: 5, p_approve: true, p_note: null })
    const read = fake.calls.find((c) => c.table === 'approval_request')!
    expect(String(opArgs(read, 'select')?.[0])).toContain('action_type')
  })
})

describe('nabídka: žádost o schválení odeslání a odeslání', () => {
  const DRAFT = {
    id: 9, deal_id: 5, version: 2, scope: 'Rozsah', amount_one_time: '150000', expected_mrr: '0', currency: 'CZK', status: 'draft',
    sent_at: null, decided_at: null, evidence_id: null, created_by: USER, created_at: '2026-09-01', send_approved_at: null, send_approval_request_id: null,
  }
  const versions = (row: Record<string, unknown>) => (c: QueryCall) => {
    if (c.table === 'deal_scope_version' && hasOp(c, 'update')) return ok([{ id: 9 }])
    if (c.table === 'deal_scope_version') return ok(row)
    return undefined
  }

  test('žádost: RPC send_offer na verzi, bez parametrů (DB si je vezme z verze)', async () => {
    const fake = setup(versions(DRAFT), () => ok(31))
    expect(await requestScopeVersionSendApproval(1, 5, 9)).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('request_action_approval', {
      p_action_type: 'send_offer', p_target_id: 9, p_params: {}, p_expires_at: null,
    })
  })

  test('žádost jen u konceptu a jen obchodní role', async () => {
    const sent = setup(versions({ ...DRAFT, status: 'sent' }))
    expect((await requestScopeVersionSendApproval(1, 5, 9)).error).toBe('Schválit k odeslání jde jen koncept nabídky.')
    expect(sent.rpc).not.toHaveBeenCalled()
    vi.mocked(getCurrentMember).mockResolvedValue({ member: { role: 'projektak' } } as never)
    const pm = setup(versions(DRAFT))
    expect((await requestScopeVersionSendApproval(1, 5, 9)).error).toMatch(/přístupem k obchodu/)
    expect(pm.from).not.toHaveBeenCalled()
  })

  test('odeslat bez schválení nejde (věta předem); schválenou verzi ano; před migrací jako dřív', async () => {
    const blocked = setup(versions(DRAFT))
    expect((await sendScopeVersion(1, 5, 9)).error).toMatch(/nejdřív schválit|před odesláním schválit/)
    expect(blocked.calls.some((c) => hasOp(c, 'update'))).toBe(false)

    const approved = setup(versions({ ...DRAFT, send_approved_at: '2026-09-29T10:00:00Z', send_approval_request_id: 31 }))
    expect(await sendScopeVersion(1, 5, 9)).toEqual({ success: true })
    expect(opArgs(approved.calls.find((c) => hasOp(c, 'update'))!, 'update')?.[0]).toEqual({ status: 'sent' })

    const legacy = { ...DRAFT } as Record<string, unknown>
    delete legacy.send_approved_at
    delete legacy.send_approval_request_id
    const before = setup(versions(legacy))
    expect(await sendScopeVersion(1, 5, 9)).toEqual({ success: true })
    expect(before.calls.some((c) => hasOp(c, 'update'))).toBe(true)
  })

  test('strážce z DB (SV006) se přeloží', async () => {
    setup((c) => {
      if (c.table === 'deal_scope_version' && hasOp(c, 'update')) return { data: null, error: { code: 'SV006', message: 'Verzi nabídky nejde označit jako odeslanou bez schválené žádosti' } }
      if (c.table === 'deal_scope_version') {
        const legacy = { ...DRAFT } as Record<string, unknown>
        delete legacy.send_approved_at
        return ok(legacy)
      }
      return undefined
    })
    expect((await sendScopeVersion(1, 5, 9)).error).toMatch(/před odesláním schválit/)
  })
})
