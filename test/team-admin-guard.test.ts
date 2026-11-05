import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { deactivateParticipant, setParticipantAdmin, setParticipantRole } from '@/lib/actions/team'
import { createSupabaseFake, hasOp, opArgs, type QueryCall } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const LAST = 'Nelze odebrat posledního administrátora — nejdřív udělej administrátorem někoho jiného.'

const MISSING_FN = { code: 'PGRST202', message: 'Could not find the function public.set_team_member_admin' }

// Tabulky otevřené práce (lib/queries/memberWork.ts) — kontrola před deaktivací.
const WORK_TABLES = ['account', 'deal', 'target_list', 'engagement', 'engagement_milestone', 'task', 'work_case', 'allocation', 'loop_node']

// Výchozí rpc = funkce neexistuje → testuje se fallback (check-then-update).
function setup(
  adminIds: string[],
  rpcResult: { data: unknown; error: unknown } = { data: null, error: MISSING_FN },
  openWork: Record<string, unknown[]> = {},
) {
  const gateFake = createSupabaseFake({
    resolve: () => ({ data: { is_admin: true }, error: null }),
    rpc: () => rpcResult,
  })
  const adminFake = createSupabaseFake({
    resolve: (c: QueryCall) =>
      WORK_TABLES.includes(c.table)
        ? { data: openWork[c.table] ?? [], error: null }
        : hasOp(c, 'select') ? { data: adminIds.map(id => ({ id })), error: null } : { data: null, error: null },
  })
  const updateUserById = vi.fn(async () => ({ error: null }))
  vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
  vi.mocked(createClient).mockResolvedValue(gateFake.client as never)
  vi.mocked(createAdminClient).mockReturnValue({ ...adminFake.client, auth: { admin: { updateUserById } } } as never)
  const updates = () => adminFake.calls.filter(c => c.table === 'team_member' && hasOp(c, 'update'))
  const keyRevokes = () => adminFake.calls.filter(c => c.table === 'api_key' && hasOp(c, 'update'))
  const audits = () => adminFake.calls.filter(c => c.table === 'audit_event' && hasOp(c, 'insert'))
  return { updates, keyRevokes, updateUserById, rpc: gateFake.rpc, audits }
}

beforeEach(() => vi.clearAllMocks())

describe('setParticipantAdmin — poslední admin (fallback bez 0045)', () => {
  test('odmítne sebe-degradaci posledního admina', async () => {
    const { updates } = setup([ME])
    expect(await setParticipantAdmin(ME, false)).toEqual({ success: false, error: LAST })
    expect(updates()).toHaveLength(0)
  })

  test('odmítne degradaci jiného posledního admina', async () => {
    const { updates } = setup([OTHER])
    expect(await setParticipantAdmin(OTHER, false)).toEqual({ success: false, error: LAST })
    expect(updates()).toHaveLength(0)
  })

  test('povolí sebe-degradaci, když zbývá jiný admin', async () => {
    const { updates } = setup([ME, OTHER])
    expect(await setParticipantAdmin(ME, false)).toEqual({ success: true })
    expect(opArgs(updates()[0], 'update')).toEqual([{ is_admin: false }])
  })

  test('degradace ne-admina guard neblokuje', async () => {
    const { updates } = setup([ME])
    expect(await setParticipantAdmin(OTHER, false)).toEqual({ success: true })
    expect(updates()).toHaveLength(1)
  })

  test('povýšení nečte počet adminů', async () => {
    const { updates } = setup([ME])
    expect(await setParticipantAdmin(OTHER, true)).toEqual({ success: true })
    expect(updates()).toHaveLength(1)
  })

  test.each(['', 'abc', '1', "x' or 1=1"])('neplatné userId %j odmítne', async bad => {
    const { updates } = setup([ME, OTHER])
    expect(await setParticipantAdmin(bad, false)).toEqual({ success: false, error: 'Neplatný uživatel.' })
    expect(updates()).toHaveLength(0)
  })

  test('bez admin práv nic nedělá', async () => {
    const { updates } = setup([ME, OTHER])
    vi.mocked(createClient).mockResolvedValue(
      createSupabaseFake({ resolve: () => ({ data: { is_admin: false }, error: null }) }).client as never,
    )
    expect(await setParticipantAdmin(OTHER, false)).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(updates()).toHaveLength(0)
  })
})

describe('setParticipantAdmin — RPC set_team_member_admin', () => {
  test('úspěch přes RPC, bez fallback UPDATE', async () => {
    const { updates, rpc } = setup([ME, OTHER], { data: null, error: null })
    expect(await setParticipantAdmin(OTHER, false)).toEqual({ success: true })
    expect(rpc).toHaveBeenCalledWith('set_team_member_admin', { p_user_id: OTHER, p_is_admin: false })
    expect(updates()).toHaveLength(0)
  })

  test('last_admin z RPC → česká hláška', async () => {
    const { updates } = setup([ME], { data: null, error: { code: 'P0001', message: 'last_admin' } })
    expect(await setParticipantAdmin(ME, false)).toEqual({ success: false, error: LAST })
    expect(updates()).toHaveLength(0)
  })

  test('42501 z RPC → Nemáš oprávnění', async () => {
    const { updates } = setup([ME], { data: null, error: { code: '42501', message: 'forbidden' } })
    expect(await setParticipantAdmin(OTHER, true)).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(updates()).toHaveLength(0)
  })

  test('jiná chyba RPC nespadne do fallbacku', async () => {
    const { updates } = setup([ME, OTHER], { data: null, error: { code: 'XX000', message: 'boom' } })
    const r = await setParticipantAdmin(OTHER, false)
    expect(r.success).toBe(false)
    expect(updates()).toHaveLength(0)
  })

  test.each(['PGRST202', '42883'])('chybějící funkce (%s) → fallback', async code => {
    const { updates, rpc } = setup([ME, OTHER], { data: null, error: { code, message: 'missing' } })
    expect(await setParticipantAdmin(OTHER, false)).toEqual({ success: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(updates()).toHaveLength(1)
  })

  test('bez admin práv RPC nevolá', async () => {
    const { rpc } = setup([ME, OTHER], { data: null, error: null })
    vi.mocked(createClient).mockResolvedValue(
      createSupabaseFake({ resolve: () => ({ data: { is_admin: false }, error: null }) }).client as never,
    )
    expect(await setParticipantAdmin(OTHER, false)).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('odebrání admina a deaktivace zneplatní klíče', () => {
  test('odebrání admina přes RPC zneplatní jeho full klíče', async () => {
    const { keyRevokes } = setup([ME, OTHER], { data: null, error: null })
    expect(await setParticipantAdmin(OTHER, false)).toEqual({ success: true })
    expect(keyRevokes()).toHaveLength(1)
    const c = keyRevokes()[0]
    expect(c.ops.filter(o => o.method === 'eq').map(o => o.args)).toEqual([['created_by', OTHER], ['scope', 'full']])
    expect(opArgs(c, 'is')).toEqual(['revoked_at', null])
  })

  test('povýšení na admina klíče nemění', async () => {
    const { keyRevokes } = setup([ME], { data: null, error: null })
    expect(await setParticipantAdmin(OTHER, true)).toEqual({ success: true })
    expect(keyRevokes()).toHaveLength(0)
  })

  test('deaktivace: ban + zneplatnění všech klíčů + is_admin false + deactivated_at', async () => {
    const { keyRevokes, updates, updateUserById } = setup([ME, OTHER])
    expect(await deactivateParticipant(OTHER)).toEqual({ success: true })
    expect(updateUserById).toHaveBeenCalledWith(OTHER, { ban_duration: '876000h' })
    expect(keyRevokes()).toHaveLength(1)
    const revoke = keyRevokes()[0]
    expect(opArgs(revoke, 'eq')).toEqual(['created_by', OTHER])
    expect(revoke.ops.some(o => o.method === 'eq' && o.args[0] === 'scope')).toBe(false)
    expect(updates()).toHaveLength(1)
    const patch = opArgs(updates()[0], 'update')![0] as Record<string, unknown>
    expect(patch.is_admin).toBe(false)
    expect(typeof patch.deactivated_at).toBe('string')
    expect(opArgs(updates()[0], 'eq')).toEqual(['id', OTHER])
  })
})

describe('deaktivace a otevřená práce (revize 29. 9., zastupitelnost)', () => {
  const OPEN = { task: [{ id: 5, title: 'Poslat nabídku', due_on: null, status: 'todo' }], deal: [{ id: 7, title: 'AI agent', stage: 'rozhodovani', account_id: 1, account: null }] }

  test('s otevřenou prací bez potvrzení: nic se nestane, hláška a pole k potvrzení', async () => {
    const { updateUserById, updates, keyRevokes } = setup([ME, OTHER], undefined, OPEN)
    const r = await deactivateParticipant(OTHER)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/1 obchod, 1 úkol/)
    expect(r.fieldErrors?.confirm_open_work).toBeTruthy()
    expect(updateUserById).not.toHaveBeenCalled()
    expect(updates()).toHaveLength(0)
    expect(keyRevokes()).toHaveLength(0)
  })

  test('cílový seznam člověka je otevřená práce (0093) a deaktivaci bez potvrzení zablokuje', async () => {
    const { updateUserById } = setup([ME, OTHER], undefined, { target_list: [{ id: 2, name: 'Výroba', segment: 'Výroba' }] })
    const r = await deactivateParticipant(OTHER)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/1 seznam/)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  test('obchod ve Vyhráno otevřená práce není', async () => {
    const { updateUserById } = setup([ME, OTHER], undefined, { deal: [{ id: 7, title: 'x', stage: 'vyhráno', account_id: 1 }] })
    expect(await deactivateParticipant(OTHER)).toEqual({ success: true })
    expect(updateUserById).toHaveBeenCalled()
  })

  test('výslovné potvrzení: deaktivuje a zapíše do auditu, co zůstalo nepředané', async () => {
    const { updateUserById, audits } = setup([ME, OTHER], undefined, OPEN)
    const fd = new FormData()
    fd.set('confirm_open_work', 'on')
    expect(await deactivateParticipant(OTHER, null, fd)).toEqual({ success: true })
    expect(updateUserById).toHaveBeenCalledWith(OTHER, { ban_duration: '876000h' })
    const row = opArgs(audits()[0], 'insert')![0] as Record<string, unknown>
    expect(row).toMatchObject({
      actor_type: 'user', actor_id: ME, action: 'team_member.deactivated_with_open_work',
      entity_table: 'team_member', entity_id: null, entity_ref: OTHER,
    })
    expect((row.after as { counts: Record<string, number> }).counts).toMatchObject({ obchody: 1, ukoly: 1, klienti: 0 })
  })

  test('když práci nejde načíst (chyba), bez potvrzení neprojde', async () => {
    const { updateUserById } = setup([ME, OTHER])
    vi.mocked(createAdminClient).mockReturnValue({
      ...createSupabaseFake({ resolve: (c) => (c.table === 'task' ? { data: null, error: { code: '57014', message: 'timeout' } } : { data: [], error: null }) }).client,
      auth: { admin: { updateUserById } },
    } as never)
    const r = await deactivateParticipant(OTHER)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/nepodařilo načíst/)
    expect(updateUserById).not.toHaveBeenCalled()
  })
})

describe('ostatní týmové akce', () => {
  test('deaktivace sebe sama je zakázaná', async () => {
    const { updateUserById } = setup([ME])
    expect(await deactivateParticipant(ME)).toEqual({ success: false, error: 'Nemůžeš deaktivovat sám sebe.' })
    expect(updateUserById).not.toHaveBeenCalled()
  })

  test('deaktivace s neplatným id', async () => {
    const { updateUserById } = setup([ME])
    expect(await deactivateParticipant('nope')).toEqual({ success: false, error: 'Neplatný uživatel.' })
    expect(updateUserById).not.toHaveBeenCalled()
  })

  test('změna role s neplatným id', async () => {
    const { updates } = setup([ME])
    const fd = new FormData()
    fd.set('role', 'x')
    expect(await setParticipantRole('nope', null, fd)).toEqual({ success: false, error: 'Neplatný uživatel.' })
    expect(updates()).toHaveLength(0)
  })
})
