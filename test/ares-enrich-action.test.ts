import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import {
  ARES_MIGRATION_MISSING_MESSAGE,
  runAresEnrichment,
  supabaseAresEnrichDb,
} from '@/domain/crm/aresEnrich'
import { runAresEnrichBatch } from '@/app/cockpit/clients/doplnit-ico/actions'
import { createSupabaseFake } from './helpers/supabaseFake'

// „Doplnit automaticky (dávka 40)" — jen admin (AAL2 + is_admin z DB),
// stejný zámek jako cron, aktér = admin. Dávka i Supabase jsou podvržené.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/crm/aresEnrich', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/aresEnrich')>()),
  runAresEnrichment: vi.fn(),
  supabaseAresEnrichDb: vi.fn(() => ({})),
}))

const ME = '11111111-1111-4111-8111-111111111111'
const STATS = {
  processed: 40, assigned: 3, ambiguous: 10, notFound: 25, errors: 2, skipped: 0,
  backfillChecked: 0, regionFilled: 0, notStarted: 0, budgetExhausted: false, durationMs: 9000,
}

function setup({ user = true, isAdmin = true, lock = 7 as number | null } = {}) {
  vi.mocked(tryRequireUser).mockResolvedValue(user ? ({ id: ME } as never) : null)
  const gate = createSupabaseFake({ resolve: () => ({ data: { is_admin: isAdmin }, error: null }) })
  vi.mocked(createClient).mockResolvedValue(gate.client as never)
  const rpc = vi.fn(async (name: string) => (name === 'try_acquire_job_lock' ? { data: lock, error: null } : { data: null, error: null }))
  const admin = { rpc, from: vi.fn() }
  vi.mocked(createAdminClient).mockReturnValue(admin as never)
  vi.mocked(runAresEnrichment).mockResolvedValue(STATS)
  return { gate, rpc, admin }
}

beforeEach(() => vi.clearAllMocks())

describe('runAresEnrichBatch — jen admin', () => {
  test('bez přihlášení (AAL2) nic nespustí', async () => {
    setup({ user: false })
    expect(await runAresEnrichBatch()).toEqual({ ok: false, error: 'auth' })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(runAresEnrichment).not.toHaveBeenCalled()
  })

  test('přihlášený ne-admin nic nespustí; admin se čte z DB řádku', async () => {
    const { gate } = setup({ isAdmin: false })
    expect(await runAresEnrichBatch()).toEqual({ ok: false, error: 'Nemáš oprávnění.' })
    expect(gate.calls[0].table).toBe('team_member')
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(runAresEnrichment).not.toHaveBeenCalled()
  })

  test('admin spustí dávku pod zámkem ares-enrich, aktér = admin, vrátí souhrn', async () => {
    const { rpc, admin } = setup()
    const r = await runAresEnrichBatch()
    expect(r).toEqual({
      ok: true,
      summary: 'Přiřazeno 3 · nejednoznačné 10 · nenalezeno 25 · chyby 2.',
      stats: STATS,
    })
    expect(rpc).toHaveBeenCalledWith('try_acquire_job_lock', { job_name: 'ares-enrich', ttl_seconds: 120 })
    expect(supabaseAresEnrichDb).toHaveBeenCalledWith(admin, { type: 'user', id: ME })
  })

  test('souběh s cronem → srozumitelná hláška, dávka neběží', async () => {
    setup({ lock: null })
    const r = await runAresEnrichBatch()
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ error: expect.stringContaining('už právě běží') })
    expect(runAresEnrichment).not.toHaveBeenCalled()
  })

  test('bez migrace 0065 klidná hláška místo obecné chyby', async () => {
    setup()
    vi.mocked(runAresEnrichment).mockRejectedValueOnce(new Error(ARES_MIGRATION_MISSING_MESSAGE))
    expect(await runAresEnrichBatch()).toEqual({ ok: false, error: ARES_MIGRATION_MISSING_MESSAGE })
  })
})
