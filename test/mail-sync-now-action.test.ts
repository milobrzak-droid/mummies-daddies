// „Dotáhnout další část" (Nastavení → Pošta): server akce runMailSyncNow.
// Oprávnění (správce / obchodní role, AAL2), přepínače v prostředí, odstup
// mezi běhy, zámek proti souběhu s cronem a věta o výsledku. Sync i Supabase
// jsou podvržené.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidatePath } from 'next/cache'
import { runOutlookMailJobBody } from '@/worker/outlookMailSync'
import { runMailSyncNow } from '@/app/cockpit/nastaveni/actions'
import { MANUAL_RUN_MESSAGES } from '@/domain/crm/mailSyncProgress'
import { createSupabaseFake, opArgs, type QueryCall } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/queries/currentMember', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/crm/actions/calendar', () => ({ syncMyTasksToOutlook: vi.fn() }))
vi.mock('@/app/cockpit/schuzky/calendarCheck', () => ({ checkMyMeetingsInOutlook: vi.fn() }))
vi.mock('@/worker/outlookMailSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/worker/outlookMailSync')>()),
  runOutlookMailJobBody: vi.fn(),
}))

const fs = (over: object) => ({ outcome: 'more_pending', pages: 4, inserted: 180, matched: 9, skipped: {}, resyncs: 0, ...over })
const STATS = { pages: 5, missingScope: false, purged: null, folders: { inbox: fs({}), sent: fs({ outcome: 'caught_up', pages: 1, inserted: 12 }) } }

type Member = { is_admin: boolean; role: string | null } | null

function setup({
  user = true,
  member = { is_admin: true, role: 'projektak' } as Member,
  lock = 5 as number | null,
  lastRunStartedAt = null as string | null,
} = {}) {
  vi.mocked(tryRequireUser).mockResolvedValue(user ? ({ id: 'u1' } as never) : null)
  vi.mocked(getCurrentMember).mockResolvedValue({ user: user ? ({ id: 'u1' } as never) : null, member } as never)
  const admin = createSupabaseFake({
    resolve: () => ({ data: lastRunStartedAt ? [{ started_at: lastRunStartedAt }] : [], error: null }),
    rpc: (name) => (name === 'try_acquire_job_lock' ? { data: lock, error: null } : { data: null, error: null }),
  })
  vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
  vi.mocked(runOutlookMailJobBody).mockImplementation(async (o) => {
    o.onSyncStats?.(STATS as never)
    return { pages: 5 }
  })
  return admin
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'true')
  vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', 'member-1')
})
afterEach(() => vi.unstubAllEnvs())

describe('runMailSyncNow — oprávnění', () => {
  it('bez přihlášení / AAL2 nic nespustí', async () => {
    setup({ user: false })
    expect(await runMailSyncNow()).toEqual({ success: false, error: 'auth' })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(runOutlookMailJobBody).not.toHaveBeenCalled()
  })

  it('člen bez správcovské a obchodní role nic nespustí', async () => {
    setup({ member: { is_admin: false, role: 'projektak' } })
    expect(await runMailSyncNow()).toEqual({ success: false, error: MANUAL_RUN_MESSAGES.forbidden })
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(runOutlookMailJobBody).not.toHaveBeenCalled()
  })

  it('obchodní role smí (i bez správce)', async () => {
    setup({ member: { is_admin: false, role: 'obchodnik' } })
    const r = await runMailSyncNow()
    expect(r.success).toBe(true)
  })
})

describe('runMailSyncNow — prostředí', () => {
  it('bez OUTLOOK_MAIL_SYNC_ENABLED=true řekne, co chybí, a nesáhne na DB', async () => {
    setup()
    vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'false')
    expect(await runMailSyncNow()).toEqual({ success: false, error: MANUAL_RUN_MESSAGES.disabled })
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('bez OUTLOOK_MAIL_SYNC_MEMBER_ID řekne, co chybí', async () => {
    setup()
    vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', '')
    expect(await runMailSyncNow()).toEqual({ success: false, error: MANUAL_RUN_MESSAGES.memberMissing })
    expect(runOutlookMailJobBody).not.toHaveBeenCalled()
  })
})

describe('runMailSyncNow — běh', () => {
  it('spustí tělo úlohy v režimu manual pod zámkem outlook-mail-sync, vrátí větu o výsledku a překreslí Nastavení', async () => {
    const admin = setup()
    const r = await runMailSyncNow()
    expect(admin.rpc).toHaveBeenCalledWith('try_acquire_job_lock', { job_name: 'outlook-mail-sync', ttl_seconds: 120 })
    expect(runOutlookMailJobBody).toHaveBeenCalledWith(expect.objectContaining({ mode: 'manual', memberId: 'member-1' }))
    expect(r).toMatchObject({ success: true })
    expect(r.note).toContain('Doručená: načtena další část (4 str., 180 nových zpráv), zbývá ještě část.')
    expect(r.note).toContain('Odeslaná: dotažena (1 str., 12 nových zpráv).')
    expect(admin.rpc).toHaveBeenCalledWith('finish_job_run', expect.objectContaining({ status: 'succeeded' }))
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/nastaveni')
  })

  it('odstup: běh, který začal před 20 s, blokuje další (rate limit), nic se nespustí', async () => {
    const admin = setup({ lastRunStartedAt: new Date(Date.now() - 20_000).toISOString() })
    const r = await runMailSyncNow()
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/za \d+ s/)
    expect(admin.rpc).not.toHaveBeenCalled()
    expect(runOutlookMailJobBody).not.toHaveBeenCalled()
    // Dotaz počítá jen skutečné běhy, ne přeskočené pokusy.
    const call = admin.calls.find((c: QueryCall) => c.table === 'job_run')!
    expect(opArgs(call, 'eq')).toEqual(['job_name', 'outlook-mail-sync'])
    expect(opArgs(call, 'neq')).toEqual(['status', 'skipped'])
  })

  it('starý běh (před 2 minutami) odstup neblokuje', async () => {
    setup({ lastRunStartedAt: new Date(Date.now() - 120_000).toISOString() })
    expect((await runMailSyncNow()).success).toBe(true)
  })

  it('souběh s cronem (zámek drží jiný běh) → srozumitelná hláška, tělo neběží', async () => {
    setup({ lock: null })
    expect(await runMailSyncNow()).toEqual({ success: false, error: MANUAL_RUN_MESSAGES.locked })
    expect(runOutlookMailJobBody).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('chyba běhu (např. token) → chyba se zapíše jako failed a vrátí se čitelně', async () => {
    const admin = setup()
    vi.mocked(runOutlookMailJobBody).mockRejectedValue(new Error('Obnova tokenu selhala — znovu připojte Outlook'))
    const r = await runMailSyncNow()
    expect(r.success).toBe(false)
    expect(r.error).toContain('Obnova tokenu selhala')
    expect(admin.rpc).toHaveBeenCalledWith('finish_job_run', expect.objectContaining({ status: 'failed' }))
  })
})
