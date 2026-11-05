import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { getWaitingItems } from '@/domain/delivery/queries/waiting'
import { createReminderTask } from '@/domain/delivery/actions/waiting'
import { reminderTaskTitle } from '@/domain/delivery/waiting'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Čtení „Čeká na klienta“ a akce „Připomenout klientovi“ nad zamockovaným
// Supabase: AAL2 brána, jen milník, který opravdu čeká, idempotence a to, že
// se nikdy nic neodesílá (akce píše jen do tabulky task).

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => { throw new Error('admin klient se tu nesmí použít') }) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<typeof import('@/lib/pragueDate')>()), pragueToday: () => '2026-09-29' }))

const USER = { id: '00000000-0000-4000-8000-000000000001' }
const OWNER = '00000000-0000-4000-8000-0000000000aa'

const MILESTONE = {
  id: 5, engagement_id: 3, title: 'Procesní mapa', owner_id: OWNER, status: 'ceka_na_schvaleni', due_on: '2026-09-20',
  updated_at: '2026-09-27T08:00:00Z', created_at: '2026-09-01T08:00:00Z',
  engagement: { id: 3, account_id: 1, kind: 'it', phase: 'pilot', account: { name: 'ALFATECH' } },
}

type Route = (c: QueryCall) => QueryResult | undefined
function fakeWith(...routes: Route[]) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      for (const r of routes) {
        const out = r(call)
        if (out) return out
      }
      return { data: [], error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}
const table = (name: string, result: QueryResult): Route => (c) => (c.table === name && !hasOp(c, 'insert') ? result : undefined)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue(USER as never)
})

describe('getWaitingItems', () => {
  test('předaný klient (provozní přehled pro cron) se použije místo session', async () => {
    const own = createSupabaseFake({ resolve: (c) => (c.table === 'engagement_milestone' ? { data: [MILESTONE], error: null } : { data: [], error: null }) })
    const res = await getWaitingItems({ today: '2026-09-29', db: own.client as never })
    expect(createClient).not.toHaveBeenCalled()
    expect(res).toMatchObject({ state: 'ok', items: [expect.objectContaining({ milestoneId: 5, accountName: 'ALFATECH' })] })
  })

  test('dotazuje jen stavy čekání a skládá položku i s auditem, kontaktem a otevřenou připomínkou', async () => {
    const fake = fakeWith(
      table('engagement_milestone', { data: [MILESTONE], error: null }),
      table('audit_event', { data: [{ entity_id: 5, action: 'engagement_milestone.updated', occurred_at: '2026-09-22T08:00:00Z', after: { _columns: ['status'] } }], error: null }),
      table('task', { data: [{ engagement_id: 3, title: reminderTaskTitle('Procesní mapa') }], error: null }),
      table('engagement', { data: [{ id: 3, client_sponsor_contact_id: 9 }], error: null }),
      table('contact', { data: [{ id: 9, full_name: 'Jana Nováková', email: 'jana@firma.cz' }], error: null }),
    )
    const res = await getWaitingItems({ engagementId: 3 })
    expect(res.state).toBe('ok')
    if (res.state !== 'ok') return
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({
      milestoneId: 5, accountName: 'ALFATECH', daysWaiting: 7, daysOverdue: 9, reminderOpen: true,
      contact: { name: 'Jana Nováková', email: 'jana@firma.cz' },
    })
    expect(res.items[0].signals).toEqual(['overdue', 'quiet'])
    const ms = fake.calls.find((c) => c.table === 'engagement_milestone')!
    expect(opArgs(ms, 'in')).toEqual(['status', ['ceka_na_vstup', 'ceka_na_schvaleni']])
    expect(opArgs(ms, 'eq')).toEqual(['engagement_id', 3])
    expect(fake.calls.every((c) => !hasOp(c, 'insert') && !hasOp(c, 'update') && !hasOp(c, 'delete'))).toBe(true)
  })

  test('nic nečeká: prázdný seznam a žádné další dotazy', async () => {
    const fake = fakeWith(table('engagement_milestone', { data: [], error: null }))
    expect(await getWaitingItems()).toEqual({ state: 'ok', items: [] })
    expect(fake.calls).toHaveLength(1)
  })

  test('chybí tabulka milníků: stav „čeká na migraci“, ne chyba', async () => {
    fakeWith(table('engagement_milestone', { data: null, error: { code: '42P01', message: 'relation does not exist' } }))
    expect(await getWaitingItems()).toEqual({ state: 'missing_migration' })
  })

  test('jiná chyba hlavního dotazu se vrátí jako chyba', async () => {
    fakeWith(table('engagement_milestone', { data: null, error: { code: 'XX000', message: 'boom' } }))
    expect(await getWaitingItems()).toEqual({ state: 'error', message: 'boom' })
  })

  test('selže audit i úkoly: karta se ukáže dál, čas čekání z updated_at', async () => {
    fakeWith(
      table('engagement_milestone', { data: [MILESTONE], error: null }),
      table('audit_event', { data: null, error: { code: 'XX000', message: 'audit' } }),
      table('task', { data: null, error: { code: 'XX000', message: 'task' } }),
      table('engagement', { data: null, error: { code: '42703', message: 'no column' } }),
    )
    const res = await getWaitingItems()
    expect(res.state).toBe('ok')
    if (res.state !== 'ok') return
    expect(res.items[0]).toMatchObject({ since: '2026-09-27T08:00:00Z', reminderOpen: false, contact: null })
  })

  test('uzavřená dodávka se vyřadí', async () => {
    fakeWith(table('engagement_milestone', { data: [{ ...MILESTONE, engagement: { ...MILESTONE.engagement, phase: 'uzavreno' } }], error: null }))
    expect(await getWaitingItems()).toEqual({ state: 'ok', items: [] })
  })

  test('předaný klient (portfolio pro API): čte se jím, klient přihlášeného se nevytváří', async () => {
    const own = createSupabaseFake({ resolve: () => ({ data: [MILESTONE], error: null }) })
    const res = await getWaitingItems({ db: own.client as never })
    expect(res.state).toBe('ok')
    expect(createClient).not.toHaveBeenCalled()
    expect(own.calls.map((c) => c.table)).toContain('engagement_milestone')
  })
})

describe('createReminderTask', () => {
  const waitingRoutes = (over: Partial<Omit<typeof MILESTONE, 'owner_id' | 'due_on'>> & { owner_id?: string | null; due_on?: string | null } = {}, tasks: unknown[] = []): Route[] => [
    table('engagement_milestone', { data: [{ ...MILESTONE, ...over }], error: null }),
    table('audit_event', { data: [], error: null }),
    table('task', { data: tasks, error: null }),
    table('engagement', { data: [{ id: 3, client_sponsor_contact_id: null }], error: null }),
  ]
  const inserts = (fake: ReturnType<typeof fakeWith>) => fake.calls.filter((c) => c.table === 'task' && hasOp(c, 'insert'))

  test('bez přihlášení a AAL2 se nic nestane', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    expect(await createReminderTask(3, 5)).toEqual({ success: false, error: 'auth' })
    expect(createClient).not.toHaveBeenCalled()
  })

  test('neplatná id se odmítnou dřív než dotaz', async () => {
    expect((await createReminderTask(0, 5)).success).toBe(false)
    expect((await createReminderTask(3, Number.NaN)).success).toBe(false)
    expect(createClient).not.toHaveBeenCalled()
  })

  test('založí jeden úkol s návrhem e-mailu v popisu, přiřazený vlastníkovi milníku', async () => {
    const fake = fakeWith(...waitingRoutes())
    const res = await createReminderTask(3, 5)
    expect(res.success).toBe(true)
    const [ins] = inserts(fake)
    const row = opArgs(ins, 'insert')![0] as Record<string, unknown>
    expect(row).toMatchObject({
      title: reminderTaskTitle('Procesní mapa'), status: 'todo', priority: 'high', assignee_id: OWNER,
      due_on: '2026-09-29', account_id: 1, engagement_id: 3, created_by: USER.id,
    })
    expect(String(row.description)).toContain('nic se neodesílá automaticky')
    expect(String(row.description)).toContain('Předmět: Připomenutí: Procesní mapa')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/tasks')
  })

  test('milník bez vlastníka: úkol dostane ten, kdo klikl; bez signálu normální priorita', async () => {
    const fake = fakeWith(...waitingRoutes({ owner_id: null, due_on: null, updated_at: '2026-09-29T05:00:00Z' }))
    await createReminderTask(3, 5)
    const row = opArgs(inserts(fake)[0], 'insert')![0] as Record<string, unknown>
    expect(row).toMatchObject({ assignee_id: USER.id, priority: 'normal' })
  })

  test('idempotence: otevřená připomínka už existuje, nezakládá se druhá', async () => {
    const fake = fakeWith(...waitingRoutes({}, [{ engagement_id: 3, title: reminderTaskTitle('Procesní mapa') }]))
    const res = await createReminderTask(3, 5)
    expect(res).toMatchObject({ success: true })
    expect(res.note).toMatch(/už existuje/)
    expect(inserts(fake)).toHaveLength(0)
  })

  test('milník, který už na klienta nečeká (nebo neexistuje), se odmítne', async () => {
    const fake = fakeWith(table('engagement_milestone', { data: [], error: null }))
    const res = await createReminderTask(3, 5)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/už na klienta nečeká/)
    expect(inserts(fake)).toHaveLength(0)
  })

  test('cizí milník z jiné dodávky se nenajde (dotaz je zúžený na dodávku)', async () => {
    const fake = fakeWith(...waitingRoutes())
    const res = await createReminderTask(4, 5)
    expect(res.success).toBe(false)
    expect(inserts(fake)).toHaveLength(0)
  })

  test('chyba zápisu se vrátí česky bez názvů tabulek', async () => {
    fakeWith(
      ...waitingRoutes(),
      (c) => (c.table === 'task' && hasOp(c, 'insert') ? { data: null, error: { code: 'XX000', message: 'relation task secret' } } : undefined),
    )
    const res = await createReminderTask(3, 5)
    expect(res.success).toBe(false)
    expect(res.error).not.toMatch(/secret|relation/)
  })
})
