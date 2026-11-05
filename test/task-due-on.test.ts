import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { revalidatePath } from 'next/cache'
import { createSupabaseFake, hasOp, opArgs, type QueryResult } from './helpers/supabaseFake'
import { updateTaskDueOn } from '@/domain/crm/actions/tasks'
import { isRealDay, taskDueOn } from '@/lib/validation/schemas'

// Posun termínu úkolu (Dnes → Po termínu, karta úkolu): AAL2, platné id a
// datum, oprávnění drží RLS (update bez zásahu = chyba, ne tichý úspěch),
// audit jen jako záloha za DB trigger, Zpět = stejná akce s původním termínem.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

type Call = Parameters<NonNullable<Parameters<typeof createSupabaseFake>[0]>['resolve'] & object>[0]

function fake(opts: { before?: Record<string, unknown> | null; updated?: unknown[] | null; readError?: unknown; updateError?: unknown } = {}) {
  const before = opts.before === undefined ? { id: 5, due_on: '2026-09-25', account_id: 3, deal_id: null } : opts.before
  const f = createSupabaseFake({
    user: { id: 'user-1' },
    resolve: (call: Call): QueryResult => {
      if (hasOp(call, 'update')) return { data: opts.updated === undefined ? [{ id: 5 }] : opts.updated, error: opts.updateError ?? null }
      return { data: before, error: opts.readError ?? null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(dbAuditActive).mockResolvedValue(false)
})

describe('updateTaskDueOn – vstupy a oprávnění', () => {
  test('bez přihlášení / bez AAL2 se nedotkne databáze', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null as never)
    const f = fake()
    expect(await updateTaskDueOn(5, '2026-10-01')).toEqual({ success: false, error: 'auth' })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(f.from).not.toHaveBeenCalled()
  })

  test.each([0, -1, 1.5, NaN, Infinity])('neplatné id %s', async (id) => {
    const f = fake()
    expect(await updateTaskDueOn(id, '2026-10-01')).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(f.from).not.toHaveBeenCalled()
  })

  test.each(['', '2026-02-30', '2026-13-01', '1900-01-01', '2026-9-1', 'zítra', '2026-10-01T10:00'])('neplatné datum „%s“', async (d) => {
    const f = fake()
    expect(await updateTaskDueOn(5, d)).toEqual({ success: false, error: 'Doplň platný termín.' })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('undefined termín (ne string ani null) se odmítne', async () => {
    const f = fake()
    expect(await updateTaskDueOn(5, undefined as never)).toEqual({ success: false, error: 'Doplň platný termín.' })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('úkol, který RLS neukáže (cizí / neexistující), je „nenalezen“ a nic se nezapíše', async () => {
    const f = fake({ before: null })
    const r = await updateTaskDueOn(5, '2026-10-01')
    expect(r.success).toBe(false)
    expect(r.error).toContain('Úkol nebyl nalezen')
    expect(f.calls.some((c) => hasOp(c, 'update'))).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('update, který RLS zahodí (0 řádků), se nehlásí jako úspěch a neauditují se', async () => {
    fake({ updated: [] })
    const r = await updateTaskDueOn(5, '2026-10-01')
    expect(r.success).toBe(false)
    expect(r.error).toContain('Úkol nebyl nalezen')
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('chyba databáze se vrátí jako chyba, ne jako výjimka', async () => {
    fake({ updateError: { message: 'boom', code: 'XX000' } })
    const r = await updateTaskDueOn(5, '2026-10-01')
    expect(r.success).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('chyba čtení se vrátí jako chyba', async () => {
    fake({ readError: { message: 'boom', code: 'XX000' }, before: null })
    expect((await updateTaskDueOn(5, '2026-10-01')).success).toBe(false)
  })
})

describe('updateTaskDueOn – zápis, audit a Zpět', () => {
  test('změní jen due_on daného úkolu, revaliduje Úkoly, Dnes a klienta', async () => {
    const f = fake()
    expect(await updateTaskDueOn(5, '2026-10-01')).toEqual({ success: true })
    const upd = f.calls.find((c) => hasOp(c, 'update'))!
    expect(upd.table).toBe('task')
    expect(opArgs(upd, 'update')).toEqual([{ due_on: '2026-10-01' }])
    expect(opArgs(upd, 'eq')).toEqual(['id', 5])
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(['/cockpit/tasks', '/cockpit', '/cockpit/clients/3'])
  })

  test('audit (záloha za trigger): task.updated s původním a novým termínem', async () => {
    fake()
    await updateTaskDueOn(5, '2026-10-01')
    expect(recordAudit).toHaveBeenCalledTimes(1)
    const [entity, id, action, before, after, actor] = vi.mocked(recordAudit).mock.calls[0]
    expect([entity, id, action]).toEqual(['task', 5, 'task.updated'])
    expect(before).toEqual({ due_on: '2026-09-25' })
    expect(after).toMatchObject({ due_on: '2026-10-01' })
    expect(actor).toEqual({ type: 'user', id: 'user-1' })
  })

  test('audit zapisuje DB trigger → appka nezapisuje podruhé', async () => {
    vi.mocked(dbAuditActive).mockResolvedValue(true)
    fake()
    expect(await updateTaskDueOn(5, '2026-10-01')).toEqual({ success: true })
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('stejný termín → bez auditu (nic se nezměnilo)', async () => {
    fake()
    expect(await updateTaskDueOn(5, '2026-09-25')).toEqual({ success: true })
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('selhání auditu změnu termínu nestrhne', async () => {
    vi.mocked(recordAudit).mockRejectedValueOnce(new Error('audit down'))
    fake()
    expect(await updateTaskDueOn(5, '2026-10-01')).toEqual({ success: true })
  })

  test('Zpět: původní termín se vrací stejnou akcí, null termín smaže', async () => {
    const f = fake({ before: { id: 5, due_on: '2026-10-01', account_id: null, deal_id: null } })
    expect(await updateTaskDueOn(5, '2026-09-25')).toEqual({ success: true })
    expect(opArgs(f.calls.find((c) => hasOp(c, 'update'))!, 'update')).toEqual([{ due_on: '2026-09-25' }])

    const g = fake({ before: { id: 5, due_on: '2026-10-01', account_id: null, deal_id: null } })
    expect(await updateTaskDueOn(5, null)).toEqual({ success: true })
    expect(opArgs(g.calls.find((c) => hasOp(c, 'update'))!, 'update')).toEqual([{ due_on: null }])
    expect(vi.mocked(recordAudit).mock.calls.at(-1)?.[3]).toEqual({ due_on: '2026-10-01' })
  })
})

describe('taskDueOn / isRealDay', () => {
  test('skutečné dny a null', () => {
    expect(taskDueOn.safeParse('2026-02-28').success).toBe(true)
    expect(taskDueOn.safeParse('2028-02-29').success).toBe(true)
    expect(taskDueOn.safeParse(null).success).toBe(true)
  })
  test('nesmysly', () => {
    for (const v of ['2027-02-29', '2026-00-10', '2026-04-31', '2101-01-01', 20260101, {}, '']) {
      expect(taskDueOn.safeParse(v).success).toBe(false)
    }
    expect(isRealDay('2026-12-31')).toBe(true)
    expect(isRealDay(undefined)).toBe(false)
  })
})
