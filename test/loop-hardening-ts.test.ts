// TS strana 0057: mapování SQLSTATE triggerů na české hlášky, snímek uzlu
// schvalovacího požadavku (approval_request.node) v akci i v inboxu,
// požadavek bez uzlu jen pro vedení a obchody v Loop Core jen pro Byznys.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { changeCaseStatus, changeStepStatus, createWorkCase, decideApprovalRequest, requestCaseApproval } from '@/core/actions/workCases'
import {
  LOOP_GUARD_MESSAGES,
  approvalNodeOf,
  getDecisionInbox,
  getWorkCase,
  isMissingColumn,
  listCaseDealOptions,
  loopGuardErrorMessage,
} from '@/core/loopQueries'
import { actorOf, viewerCanDecide } from '@/core/workCaseFlow'
import { createSupabaseFake, hasOp, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: USER })),
  tryRequireUser: vi.fn(async () => ({ id: USER })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = '33333333-3333-4333-8333-333333333333'

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}
const ok = (data: unknown): QueryResult => ({ data, error: null })
const err = (code: string, message = 'x'): QueryResult => ({ data: null, error: { code, message } })
function setup(resolve: (call: QueryCall) => QueryResult = () => ok(null), rpc?: (name: string, args: unknown) => QueryResult) {
  const fake = createSupabaseFake({ user: { id: USER }, resolve, rpc })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}
const selectCols = (call: QueryCall) => String(call.ops.find((o) => o.method === 'select')?.args[0] ?? '')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(canCurrentUserSeeSales).mockResolvedValue(true)
})

describe('loopGuardErrorMessage', () => {
  test.each(Object.entries(LOOP_GUARD_MESSAGES))('%s → česká hláška', (code, msg) => {
    expect(loopGuardErrorMessage({ code, message: 'cokoli' })).toBe(msg)
  })
  test('cizí kódy a prázdná chyba → null', () => {
    expect(loopGuardErrorMessage({ code: '42501', message: 'x' })).toBeNull()
    expect(loopGuardErrorMessage(null)).toBeNull()
    expect(loopGuardErrorMessage({ message: 'LP001' })).toBeNull()
  })
  test('isMissingColumn', () => {
    expect(isMissingColumn({ code: '42703', message: 'column approval_request.node does not exist' })).toBe(true)
    expect(isMissingColumn({ code: '42P01', message: 'relation x does not exist' })).toBe(false)
    expect(isMissingColumn(null)).toBe(false)
  })
})

describe('akce mapují chyby triggerů', () => {
  test('uzavření případu odmítnuté DB (LP003, souběh s novým krokem)', async () => {
    setup((call) => {
      if (call.table === 'work_case' && hasOp(call, 'update')) return err('LP003', 'Případ nejde uzavřít: nedokončené kroky')
      if (call.table === 'work_case') return ok({ id: 3, status: 'in_progress' })
      if (call.table === 'case_step') return ok([{ status: 'done' }])
      return ok(null)
    })
    expect(await changeCaseStatus(null, form({ case_id: '3', to: 'done' }))).toEqual({ success: false, error: LOOP_GUARD_MESSAGES.LP003 })
  })
  test('krok v mezitím uzavřeném případu (LP004)', async () => {
    setup((call) => {
      if (call.table === 'case_step' && hasOp(call, 'update')) return err('LP004')
      if (call.table === 'case_step') return ok({ id: 1, case_id: 3, status: 'todo' })
      if (call.table === 'work_case') return ok({ id: 3, status: 'open', node: 'obchod' })
      return ok(null)
    })
    expect(await changeStepStatus(null, form({ step_id: '1', to: 'doing' }))).toEqual({ success: false, error: LOOP_GUARD_MESSAGES.LP004 })
  })
  test('request_approval na uzavřený případ (LP004 z RPC)', async () => {
    setup(
      (call) => (call.table === 'work_case' ? ok({ id: 3, status: 'open', node: 'obchod' }) : ok([])),
      () => err('LP004', 'Případ je uzavřený — schválení už nejde žádat'),
    )
    expect(await requestCaseApproval(null, form({ case_id: '3', action_kind: 'external_commitment' }))).toEqual({
      success: false, error: LOOP_GUARD_MESSAGES.LP004,
    })
  })
})

describe('snímek uzlu (approval_request.node)', () => {
  test('approvalNodeOf: snímek vyhrává, null snímek = bez uzlu, bez sloupce = uzel případu', () => {
    expect(approvalNodeOf({ node: 'vedeni' }, 'obchod')).toBe('vedeni')
    expect(approvalNodeOf({ node: null }, 'obchod')).toBeNull()
    expect(approvalNodeOf({}, 'obchod')).toBe('obchod')
    expect(approvalNodeOf({}, undefined)).toBeNull()
  })

  type Opts = { snapshot?: string | null; caseNode: string; owner: string; role?: string; noColumn?: boolean }
  const world = (o: Opts) => (call: QueryCall) => {
    if (call.table === 'approval_request') {
      if (o.noColumn && selectCols(call).includes(' node,')) return err('42703', 'column approval_request.node does not exist')
      const row: Record<string, unknown> = {
        id: 5, case_id: 3, status: 'pending', requested_level: 'L2', requested_by: `user:${OTHER}`, expires_at: null,
        work_case: { node: o.caseNode },
      }
      if (!o.noColumn) row.node = o.snapshot ?? null
      return ok(row)
    }
    if (call.table === 'loop_node') return ok([{ node: o.caseNode, owner_id: o.owner, deputy_id: null }])
    if (call.table === 'team_member') return ok({ role: o.role ?? 'obchodnik' })
    return ok(null)
  }

  test('případ přesunutý do mého uzlu: rozhoduje uzel ze žádosti, RPC se nevolá', async () => {
    const fake = setup(world({ snapshot: 'vedeni', caseNode: 'obchod', owner: USER }))
    const res = await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))
    expect(res).toEqual({ success: false, error: 'Na schválení úrovně L2 nemáte v tomto uzlu pravomoc.' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
  test('vlastník uzlu ze žádosti schválí', async () => {
    const fake = setup(world({ snapshot: 'obchod', caseNode: 'obchod', owner: USER }), () => ok('approved'))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('decide_approval', expect.objectContaining({ p_request_id: 5 }))
  })
  test('před 0057 (sloupec chybí) dotaz bez node a uzel z případu', async () => {
    const fake = setup(world({ caseNode: 'obchod', owner: USER, noColumn: true }), () => ok('approved'))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).toEqual({ success: true })
    const reads = fake.calls.filter((c) => c.table === 'approval_request')
    // Nejdřív se sloupci 0084 (action_type), pak jen s node (0057), nakonec bez obou.
    expect(reads.map((c) => selectCols(c).includes(' node,'))).toEqual([true, true, false])
    expect(reads.map((c) => selectCols(c).includes('action_type'))).toEqual([true, false, false])
  })
  test('požadavek bez uzlu: vedení ano, ostatní ne (ani vlastník nějakého uzlu)', async () => {
    const noNode = (role: string) => (call: QueryCall) =>
      call.table === 'approval_request'
        ? ok({ id: 5, case_id: null, node: null, status: 'pending', requested_level: 'L2', requested_by: `user:${OTHER}`, expires_at: null, work_case: null })
        : world({ caseNode: 'obchod', owner: USER, role })(call)
    const member = setup(noNode('obchodnik'))
    expect((await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).success).toBe(false)
    expect(member.rpc).not.toHaveBeenCalled()
    const vedeni = setup(noNode('vedeni'), () => ok('approved'))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).toEqual({ success: true })
    expect(vedeni.rpc).toHaveBeenCalled()
  })

  test('inbox: case_node = snímek ze žádosti, ne aktuální uzel případu', async () => {
    setup((call) =>
      call.table === 'approval_request'
        ? ok([{ id: 1, case_id: 3, node: 'vedeni', action_kind: 'external_commitment', requested_level: 'L2', requested_by: 'user:x', created_at: '2026-09-01T00:00:00Z', expires_at: null, work_case: { title: 'A', node: 'obchod' } }])
        : ok([]),
    )
    const res = await getDecisionInbox(new Date('2026-09-28T00:00:00Z'))
    expect(res.state).toBe('ok')
    if (res.state === 'ok') expect(res.approvals[0].case_node).toBe('vedeni')
  })
})

describe('viewerCanDecide bez uzlu = jen vedení (jako SQL)', () => {
  const req = (level: string) => ({ requested_by: actorOf(OTHER), requested_level: level, case_node: null })
  test('řadový člen ani na L1', () => {
    expect(viewerCanDecide(req('L1'), { id: USER, teamRole: 'obchodnik' }, [])).toBe(false)
  })
  test('vedení až L4', () => {
    expect(viewerCanDecide(req('L4'), { id: USER, teamRole: 'vedeni' }, [])).toBe(true)
  })
  test('vlastník nějakého uzlu bez vedení ne', () => {
    const rows = [{ node: 'obchod', owner_id: USER, deputy_id: null }]
    expect(viewerCanDecide(req('L2'), { id: USER, teamRole: 'obchodnik' }, rows)).toBe(false)
  })
})

describe('obchody v Loop Core jen pro Byznys', () => {
  test('nova: bez Byznysu žádné obchody a na deal se nesahá', async () => {
    vi.mocked(canCurrentUserSeeSales).mockResolvedValue(false)
    const fake = setup(() => ok([{ id: 1, title: 'Tajný obchod', account_id: 2 }]))
    expect(await listCaseDealOptions()).toEqual([])
    expect(fake.from).not.toHaveBeenCalled()
  })
  test('nova: s Byznysem obchody načte', async () => {
    const fake = setup(() => ok([{ id: 1, title: 'Obchod', account_id: 2 }]))
    expect(await listCaseDealOptions()).toEqual([{ id: 1, title: 'Obchod', account_id: 2 }])
    expect(fake.from).toHaveBeenCalledWith('deal')
  })
  const CASE_ROW = { id: 3, title: 'A', node: 'obchod', status: 'open', created_at: 'x', updated_at: 'x', created_by: null, lead_owner_id: null, account_id: 2, deal_id: 9, lead_owner: null, deputy: null, account: { name: 'K' } }
  test('detail bez includeDeal: deal se nejoinuje, obchod bez deal_public → název null', async () => {
    const fake = setup((call) => (call.table === 'work_case' ? ok(CASE_ROW) : ok([])))
    const res = await getWorkCase(3)
    const wc = fake.calls.find((c) => c.table === 'work_case')!
    expect(selectCols(wc)).not.toMatch(/deal\(/)
    expect(res.state === 'ok' && res.case.deal_title).toBeNull()
  })
  test('detail bez includeDeal (projekťák): název obchodu z deal_public, na tabulku deal nesahá', async () => {
    const fake = setup(
      (call) => (call.table === 'work_case' ? ok(CASE_ROW) : ok([])),
      (name) => (name === 'deal_public' ? ok([{ id: 9, account_id: 2, title: 'Copilot pilot', is_won: true }]) : ok(null)),
    )
    const res = await getWorkCase(3)
    expect(fake.rpc).toHaveBeenCalledWith('deal_public', { p_account_id: 2 })
    expect(fake.calls.some((c) => c.table === 'deal')).toBe(false)
    expect(res.state === 'ok' && [res.case.deal_title, res.case.deal_account_id]).toEqual(['Copilot pilot', 2])
  })
  test('detail bez includeDeal: deal_public selže → název null, detail se načte', async () => {
    setup(
      (call) => (call.table === 'work_case' ? ok(CASE_ROW) : ok([])),
      () => ({ data: null, error: { code: '42501', message: 'AAL2' } }),
    )
    const res = await getWorkCase(3)
    expect(res.state).toBe('ok')
    expect(res.state === 'ok' && res.case.deal_title).toBeNull()
  })
  test('detail bez includeDeal před 0058 (PGRST202) → název z přímého čtení deal', async () => {
    const fake = setup(
      (call) => (call.table === 'work_case' ? ok(CASE_ROW) : call.table === 'deal' ? ok([{ id: 9, account_id: 2, title: 'Starý', stage: 'kvalifikace' }]) : ok([])),
      () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }),
    )
    const res = await getWorkCase(3)
    expect(res.state === 'ok' && res.case.deal_title).toBe('Starý')
    expect(fake.calls.find((c) => c.table === 'deal')!.ops).toContainEqual({ method: 'eq', args: ['account_id', 2] })
  })
  test('detail s includeDeal: deal_public se nevolá', async () => {
    const fake = setup((call) => (call.table === 'work_case' ? ok({ ...CASE_ROW, deal: { title: 'Obchod', account_id: 2 } }) : ok([])))
    await getWorkCase(3, { includeDeal: true })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
  test('detail: s includeDeal název obchodu', async () => {
    const fake = setup((call) =>
      call.table === 'work_case'
        ? ok({ id: 3, title: 'A', node: 'obchod', status: 'open', created_at: 'x', updated_at: 'x', created_by: null, lead_owner_id: null, account_id: 2, deal_id: 9, lead_owner: null, deputy: null, account: { name: 'K' }, deal: { title: 'Obchod', account_id: 2 } })
        : ok([]),
    )
    const res = await getWorkCase(3, { includeDeal: true })
    expect(selectCols(fake.calls.find((c) => c.table === 'work_case')!)).toMatch(/deal\(title, account_id\)/)
    expect(res.state === 'ok' && res.case.deal_title).toBe('Obchod')
  })
  test('createWorkCase: obchod bez Byznysu = chyba pole, do DB nic', async () => {
    vi.mocked(canCurrentUserSeeSales).mockResolvedValue(false)
    const fake = setup()
    const res = await createWorkCase(null, form({ title: 'X', node: 'obchod', deal_id: '9' }))
    expect(res).toMatchObject({ success: false, fieldErrors: { deal_id: expect.any(String) } })
    expect(fake.from).not.toHaveBeenCalled()
  })
})
