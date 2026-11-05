import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import {
  addCaseStep,
  changeCaseStatus,
  changeStepStatus,
  createWorkCase,
  decideApprovalRequest,
  recordCaseDecision,
  requestCaseApproval,
  resolveCaseDecision,
} from '@/core/actions/workCases'
import { APPROVAL_FORBIDDEN_MESSAGE, MIGRATION_PENDING_MESSAGE } from '@/core/workCaseFlow'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: USER })),
  tryRequireUser: vi.fn(async () => ({ id: USER })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VIKTOR = '11111111-1111-4111-8111-111111111111'
const OTHER = '33333333-3333-4333-8333-333333333333'

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

const ok = (data: unknown): QueryResult => ({ data, error: null })
type Rpc = (name: string, args: unknown) => QueryResult
function setup(resolve: (call: QueryCall) => QueryResult = () => ok(null), rpc?: Rpc) {
  const fake = createSupabaseFake({ user: { id: USER }, resolve, rpc })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('auth guard: bez AAL2 uživatele se nesáhne do DB', () => {
  const cases: [string, (fd: FormData) => Promise<unknown>][] = [
    ['createWorkCase', (fd) => createWorkCase(null, fd)],
    ['addCaseStep', (fd) => addCaseStep(null, fd)],
    ['changeStepStatus', (fd) => changeStepStatus(null, fd)],
    ['changeCaseStatus', (fd) => changeCaseStatus(null, fd)],
    ['requestCaseApproval', (fd) => requestCaseApproval(null, fd)],
    ['recordCaseDecision', (fd) => recordCaseDecision(null, fd)],
    ['resolveCaseDecision', (fd) => resolveCaseDecision(null, fd)],
    ['decideApprovalRequest', (fd) => decideApprovalRequest(null, fd)],
  ]
  test.each(cases)('%s', async (_n, run) => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const fake = setup()
    expect(await run(form({}))).toEqual({ success: false, error: 'auth' })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(fake.from).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalled()
  })
})

describe('createWorkCase', () => {
  test('ze šablony: vlastník z loop_node, tři kroky, rozhodnutí ano/ne, přesměrování', async () => {
    const fake = setup(
      (call) => {
        if (call.table === 'loop_node') return ok([{ node: 'vedeni', owner_id: VIKTOR, deputy_id: null }])
        if (call.table === 'work_case' && hasOp(call, 'insert')) return ok({ id: 42 })
        return ok(null)
      },
      () => ok(7),
    )
    await expect(
      createWorkCase(null, form({ title: 'Acme', node: 'vedeni', template: 'nestandardni_nabidka' })),
    ).rejects.toThrow('NEXT_REDIRECT:/cockpit/pripady/42')

    const insert = fake.calls.find((c) => c.table === 'work_case' && hasOp(c, 'insert'))!
    expect(opArgs(insert, 'insert')?.[0]).toMatchObject({
      title: 'Acme', node: 'vedeni', status: 'open', lead_owner_id: VIKTOR,
    })
    // Autora doplní DB (DEFAULT loop_actor() + trigger, 0057) — TS ho neposílá.
    expect(opArgs(insert, 'insert')?.[0]).not.toHaveProperty('created_by')
    const steps = fake.calls.find((c) => c.table === 'case_step' && hasOp(c, 'insert'))!
    expect((opArgs(steps, 'insert')?.[0] as { title: string }[]).map((s) => s.title)).toEqual([
      'Posoudit výjimku', 'Připravit nabídku na míru', 'Schválit a odeslat',
    ])
    expect(fake.rpc).toHaveBeenCalledWith('record_decision', {
      p_case_id: 42, p_question: 'Nabídnout mimo standardní mapu?', p_options: ['ano', 'ne'],
    })
  })

  test('selhání rozhodnutí šablony polovičatý případ zruší (ne smaže — 0057)', async () => {
    const fake = setup(
      (call) => (call.table === 'work_case' && hasOp(call, 'insert') ? ok({ id: 42 }) : ok([])),
      () => ({ data: null, error: { code: '42501', message: 'Jen pro člena týmu' } }),
    )
    const res = await createWorkCase(null, form({ title: 'Acme', node: 'vedeni', template: 'nestandardni_nabidka' }))
    expect(res).toEqual({ success: false, error: 'Tuto akci může provést jen přihlášený člen týmu.' })
    expect(fake.calls.some((c) => c.table === 'work_case' && hasOp(c, 'delete'))).toBe(false)
    const cancel = fake.calls.find((c) => c.table === 'work_case' && hasOp(c, 'update'))!
    expect(opArgs(cancel, 'update')?.[0]).toEqual({ status: 'cancelled' })
    expect(cancel.ops.filter((o) => o.method === 'eq').map((o) => o.args)).toEqual([['id', 42], ['status', 'open']])
  })

  test('obchod jiného klienta = chyba pole', async () => {
    setup((call) => (call.table === 'deal' ? ok({ account_id: 5 }) : ok(null)))
    const res = await createWorkCase(null, form({ title: 'X', node: 'obchod', account_id: '4', deal_id: '9' }))
    expect(res).toEqual({ success: false, fieldErrors: { deal_id: 'Obchod nepatří vybranému klientovi.' } })
  })

  test('neplatný uzel = chyba pole, do DB nic', async () => {
    const fake = setup()
    const res = await createWorkCase(null, form({ title: 'X', node: 'hacker' }))
    expect(res).toMatchObject({ success: false, fieldErrors: { node: expect.any(String) } })
    expect(fake.from).not.toHaveBeenCalled()
  })

  test('před migrací 0039 klidná hláška', async () => {
    setup((call) => (call.table === 'loop_node' ? { data: null, error: { code: '42P01', message: 'relation "loop_node" does not exist' } } : ok(null)))
    const res = await createWorkCase(null, form({ title: 'X', node: 'obchod' }))
    expect(res).toEqual({ success: false, error: MIGRATION_PENDING_MESSAGE })
  })
})

describe('přechody kroků a případu', () => {
  test('krok done → doing je zakázaný, update se nevolá', async () => {
    const fake = setup((call) => {
      if (call.table === 'case_step') return ok({ id: 1, case_id: 3, status: 'done' })
      if (call.table === 'work_case') return ok({ id: 3, status: 'in_progress', node: 'obchod' })
      return ok(null)
    })
    const res = await changeStepStatus(null, form({ step_id: '1', to: 'doing' }))
    expect(res.success).toBe(false)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('krok todo → doing se zapíše podmíněně původním stavem', async () => {
    const fake = setup((call) => {
      if (call.table === 'case_step' && hasOp(call, 'update')) return ok([{ id: 1 }])
      if (call.table === 'case_step') return ok({ id: 1, case_id: 3, status: 'todo' })
      if (call.table === 'work_case') return ok({ id: 3, status: 'open', node: 'obchod' })
      return ok(null)
    })
    expect(await changeStepStatus(null, form({ step_id: '1', to: 'doing' }))).toEqual({ success: true })
    const up = fake.calls.find((c) => c.table === 'case_step' && hasOp(c, 'update'))!
    expect(up.ops.filter((o) => o.method === 'eq').map((o) => o.args)).toEqual([['id', 1], ['status', 'todo']])
  })

  test('kroky uzavřeného případu se nemění', async () => {
    setup((call) => {
      if (call.table === 'case_step') return ok({ id: 1, case_id: 3, status: 'todo' })
      if (call.table === 'work_case') return ok({ id: 3, status: 'done', node: 'obchod' })
      return ok(null)
    })
    const res = await changeStepStatus(null, form({ step_id: '1', to: 'doing' }))
    expect(res).toEqual({ success: false, error: 'Případ je uzavřený (Hotovo), už se nemění.' })
  })

  test('uzavření s nedokončeným krokem je odmítnuté (canCloseCase)', async () => {
    const fake = setup((call) => {
      if (call.table === 'work_case') return ok({ id: 3, status: 'in_progress' })
      if (call.table === 'case_step') return ok([{ status: 'done' }, { status: 'doing' }])
      return ok(null)
    })
    const res = await changeCaseStatus(null, form({ case_id: '3', to: 'done' }))
    expect(res).toEqual({ success: false, error: 'Případ zatím nejde uzavřít: nedokončené kroky: 1.' })
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('uzavření s hotovými kroky projde', async () => {
    setup((call) => {
      if (call.table === 'work_case' && hasOp(call, 'update')) return ok([{ id: 3 }])
      if (call.table === 'work_case') return ok({ id: 3, status: 'in_progress' })
      if (call.table === 'case_step') return ok([{ status: 'done' }, { status: 'skipped' }])
      return ok(null)
    })
    expect(await changeCaseStatus(null, form({ case_id: '3', to: 'done' }))).toEqual({ success: true })
  })
})

describe('requestCaseApproval', () => {
  const base = (level: string | null) => (call: QueryCall) => {
    if (call.table === 'work_case') return ok({ id: 3, status: 'open', node: 'obchod' })
    if (call.table === 'authority_policy') return ok(level ? [{ action_kind: 'external_commitment', level, active: true }] : [])
    return ok(null)
  }
  test('úroveň z authority_policy, ne z formuláře', async () => {
    const fake = setup(base('L3'), () => ok(9))
    const res = await requestCaseApproval(null, form({ case_id: '3', action_kind: 'external_commitment', requested_level: 'L1' }))
    expect(res).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('request_approval', {
      p_action_kind: 'external_commitment', p_requested_level: 'L3', p_case_id: 3, p_expires_at: null,
    })
  })
  test('bez pravidla výchozí L2; platnost do konce pražského dne', async () => {
    const fake = setup(base(null), () => ok(9))
    await requestCaseApproval(null, form({ case_id: '3', action_kind: 'nova_cinnost', expires_on: '2026-10-05' }))
    expect(fake.rpc).toHaveBeenCalledWith('request_approval', expect.objectContaining({
      p_requested_level: 'L2', p_expires_at: '2026-10-05T22:00:00.000Z',
    }))
  })
  test('L1 schválení nepotřebuje', async () => {
    const fake = setup(base('L1'))
    const res = await requestCaseApproval(null, form({ case_id: '3', action_kind: 'external_commitment' }))
    expect(res.success).toBe(false)
    expect(fake.rpc).not.toHaveBeenCalled()
  })
})

describe('resolveCaseDecision', () => {
  test('volba mimo nabízené možnosti se odmítne', async () => {
    const fake = setup((call) => (call.table === 'decision' ? ok({ id: 1, case_id: 3, options: ['ano', 'ne'], decided_at: null }) : ok(null)))
    const res = await resolveCaseDecision(null, form({ decision_id: '1', chosen: 'možná' }))
    expect(res).toEqual({ success: false, error: 'Vyberte jednu z nabízených možností.' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
  test('platná volba jde přes RPC resolve_decision', async () => {
    const fake = setup((call) => (call.table === 'decision' ? ok({ id: 1, case_id: 3, options: ['ano', 'ne'], decided_at: null }) : ok(null)))
    expect(await resolveCaseDecision(null, form({ decision_id: '1', chosen: 'ano' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('resolve_decision', { p_decision_id: 1, p_chosen: 'ano' })
  })
})

describe('decideApprovalRequest', () => {
  type Req = { status: string; requested_level: string; requested_by: string; expires_at: string | null; node: string }
  const world = (req: Req, opts: { owner?: string; role?: string } = {}) => (call: QueryCall) => {
    if (call.table === 'approval_request') {
      return ok({ id: 5, case_id: 3, status: req.status, requested_level: req.requested_level, requested_by: req.requested_by, expires_at: req.expires_at, work_case: { node: req.node } })
    }
    if (call.table === 'loop_node') return ok([{ node: req.node, owner_id: opts.owner ?? USER, deputy_id: null }])
    if (call.table === 'team_member') return ok({ role: opts.role ?? 'obchodnik' })
    return ok(null)
  }
  const pending: Req = { status: 'pending', requested_level: 'L2', requested_by: `user:${OTHER}`, expires_at: null, node: 'obchod' }

  test('vlastník uzlu schválí cizí požadavek přes RPC', async () => {
    const fake = setup(world(pending), () => ok('approved'))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1', note: 'ok' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('decide_approval', { p_request_id: 5, p_approve: true, p_note: 'ok' })
  })
  test('vlastní požadavek: čtyři oči, RPC se nevolá', async () => {
    const fake = setup(world({ ...pending, requested_by: `user:${USER}` }))
    const res = await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))
    expect(res).toEqual({ success: false, error: 'Vlastní požadavek nemůžete schválit ani zamítnout (čtyři oči).' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
  test('řadový člen na L2 nemá pravomoc (DB 0039 to nehlídá, akce ano)', async () => {
    const fake = setup(world(pending, { owner: VIKTOR, role: 'obchodnik' }))
    const res = await decideApprovalRequest(null, form({ request_id: '5', approve: '0' }))
    expect(res).toEqual({ success: false, error: 'Na schválení úrovně L2 nemáte v tomto uzlu pravomoc.' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
  test('vypršelý požadavek se nerozhoduje', async () => {
    const fake = setup(world({ ...pending, expires_at: '2000-01-01T00:00:00Z' }))
    const res = await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))
    expect(res).toEqual({ success: false, error: 'Požadavek vypršel, už o něm nejde rozhodnout.' })
    expect(fake.rpc).not.toHaveBeenCalled()
  })
  test('už rozhodnutý požadavek', async () => {
    setup(world({ ...pending, status: 'approved' }))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).toEqual({
      success: false, error: 'O požadavku už bylo rozhodnuto.',
    })
  })
  test.each([
    [{ code: '22023', message: 'Požadavek už není čekající (stav rejected)' }, 'O požadavku už bylo rozhodnuto.'],
    [{ code: '22023', message: 'Požadavek vypršel' }, 'Požadavek vypršel, už o něm nejde rozhodnout.'],
    [{ code: '42501', message: 'Vlastní požadavek nelze schválit ani zamítnout' }, 'Vlastní požadavek nemůžete schválit ani zamítnout (čtyři oči).'],
    [{ code: '42501', message: 'Nedostatečná role pro L2' }, APPROVAL_FORBIDDEN_MESSAGE],
    [{ code: 'XX000', message: 'internal boom on table approval_request' }, 'Operace se nezdařila. Zkuste to prosím znovu.'],
  ])('chyba RPC %j → česká hláška', async (err, msg) => {
    setup(world(pending), () => ({ data: null, error: err }))
    expect(await decideApprovalRequest(null, form({ request_id: '5', approve: '1' }))).toEqual({ success: false, error: msg })
  })
  test('neplatný vstup do DB nejde', async () => {
    const fake = setup()
    const res = await decideApprovalRequest(null, form({ request_id: 'abc', approve: 'yes' }))
    expect(res.success).toBe(false)
    expect(fake.from).not.toHaveBeenCalled()
  })
})
