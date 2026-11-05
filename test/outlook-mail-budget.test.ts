// @vitest-environment node
// Cron pošty: jeden společný deadline pro všechny kroky. Součet rozpočtů se
// musí vejít do maxDuration route (i stránky Nastavení, odkud jde ruční běh),
// a i když každý krok spotřebuje celý svůj rozpočet, běh skončí do 55 s;
// co se nestihne, je v `deferred` a odloží se na další běh.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeadline } from '@/worker/deadline'
import {
  AFTER_SYNC_RESERVE_MS, ARES_BUDGET_MAX_MS, ARES_BUDGET_MIN_MS, ARES_REQUEST_TIMEOUT_MS, CONTENT_BUDGET_MAX_MS,
  CONTENT_BUDGET_MIN_MS, FINISH_RESERVE_MS, MAIL_TO_CASE_RESERVE_MS, MIN_SYNC_BUDGET_MS, OUTLOOK_MAIL_HARD_TIMEOUT_MS,
  OUTLOOK_MAIL_MAX_DURATION_S, OUTLOOK_MAIL_ROUTE_BUDGET_MS, WEBHOOK_BUDGET_MAX_MS, runOutlookMailJobBody,
} from '@/worker/outlookMailSync'
import { REQUEST_RESERVE_MS } from '@/domain/crm/mailSync'
import { runOutlookMailConnector } from '@/domain/crm/mailConnector'
import { maintainSubscriptionsSafely } from '@/domain/crm/mailSyncService'
import { runMailContentIntakeLive, purgeMailContent } from '@/domain/crm/mailContentService'
import { runAresForNewAccounts, runAutoIntakeLive } from '@/domain/crm/autoIntakeService'
import { runMailToCase } from '@/domain/crm/mailToCase'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/connectorState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/connectorState')>()),
  recordConnectorError: vi.fn(async () => {}),
}))
vi.mock('@/core/agents/caseProposal', () => ({ caseProposalSink: vi.fn(() => ({})) }))
vi.mock('@/domain/crm/mailSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/mailSync')>()),
  resolveAccessToken: vi.fn(async () => 'access-token'),
}))
vi.mock('@/domain/crm/mailConnector', () => ({ runOutlookMailConnector: vi.fn() }))
vi.mock('@/domain/crm/mailSyncService', () => ({
  createMailSyncDb: vi.fn(() => ({})),
  createMailTokenDeps: vi.fn(() => ({})),
  createSubscriptionGraph: vi.fn(() => ({})),
  createSubscriptionStore: vi.fn(() => ({})),
  maintainSubscriptionsSafely: vi.fn(),
}))
vi.mock('@/domain/crm/mailContentService', () => ({ runMailContentIntakeLive: vi.fn(), purgeMailContent: vi.fn() }))
vi.mock('@/domain/crm/autoIntakeService', () => ({ runAutoIntakeLive: vi.fn(), runAresForNewAccounts: vi.fn() }))
vi.mock('@/domain/crm/mailToCase', () => ({ runMailToCase: vi.fn(), supabaseMailToCaseContext: vi.fn(() => ({})) }))

const maxDurationOf = (path: string) => Number(/export const maxDuration = (\d+)/.exec(readFileSync(path, 'utf8'))?.[1])

describe('rozpočty se vejdou do maxDuration', () => {
  it('route i stránka Nastavení mají maxDuration jako worker', () => {
    expect(maxDurationOf('app/api/cron/outlook-mail/route.ts')).toBe(OUTLOOK_MAIL_MAX_DURATION_S)
    expect(maxDurationOf('app/cockpit/nastaveni/page.tsx')).toBe(OUTLOOK_MAIL_MAX_DURATION_S)
  })

  it('deadline < pojistka runJob < maxDuration (s rezervou na zámek a zápis job_run)', () => {
    expect(OUTLOOK_MAIL_ROUTE_BUDGET_MS).toBeLessThan(OUTLOOK_MAIL_HARD_TIMEOUT_MS)
    expect(OUTLOOK_MAIL_HARD_TIMEOUT_MS + 2_000).toBeLessThanOrEqual(OUTLOOK_MAIL_MAX_DURATION_S * 1000)
  })

  it('součet nejdelších kroků před syncem + sync + rezerva ≤ deadline', () => {
    // Webhook a pošta s obsahem si berou jen to, co zbude po MIN_SYNC + rezervě.
    expect(WEBHOOK_BUDGET_MAX_MS + MIN_SYNC_BUDGET_MS + AFTER_SYNC_RESERVE_MS).toBeLessThanOrEqual(OUTLOOK_MAIL_ROUTE_BUDGET_MS)
    expect(CONTENT_BUDGET_MAX_MS + MIN_SYNC_BUDGET_MS + AFTER_SYNC_RESERVE_MS).toBeLessThanOrEqual(OUTLOOK_MAIL_ROUTE_BUDGET_MS)
    expect(MAIL_TO_CASE_RESERVE_MS + FINISH_RESERVE_MS).toBeLessThanOrEqual(AFTER_SYNC_RESERVE_MS)
    // Sync i pošta s obsahem s minimem stihnou aspoň jedno volání Graphu.
    expect(MIN_SYNC_BUDGET_MS).toBeGreaterThanOrEqual(REQUEST_RESERVE_MS)
    expect(CONTENT_BUDGET_MIN_MS).toBeGreaterThanOrEqual(REQUEST_RESERVE_MS)
    expect(CONTENT_BUDGET_MIN_MS).toBeLessThanOrEqual(CONTENT_BUDGET_MAX_MS)
    // ARES s minimem stihne aspoň jeden dotaz (timeout + 2 s rezervy na zápis).
    expect(ARES_BUDGET_MIN_MS).toBeGreaterThanOrEqual(ARES_REQUEST_TIMEOUT_MS + 2_000)
    expect(ARES_BUDGET_MIN_MS).toBeLessThanOrEqual(ARES_BUDGET_MAX_MS)
  })
})

describe('createDeadline', () => {
  it('rozpočet = min(max, zbývá − rezerva); pod minimem 0', () => {
    let t = 1_000
    const d = createDeadline(10_000, () => t)
    expect(d.budget({ max: 4_000 })).toBe(4_000)
    expect(d.budget({ reserveAfter: 7_000 })).toBe(3_000)
    expect(d.budget({ min: 5_000, reserveAfter: 7_000 })).toBe(0)
    t = 9_500
    expect(d.remaining()).toBe(1_500)
    expect(d.passed(1_000)).toBe(false)
    expect(d.passed(2_000)).toBe(true)
    t = 20_000
    expect(d.budget({})).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Simulace: každý krok spotřebuje celý svůj rozpočet (hodiny posouvá mock).

const MEMBER = 'f6d18417-48ac-423b-b459-d09ee5a5103f'
const SYNC_STATS = {
  pages: 3, missingScope: false, purged: 0,
  folders: { inbox: { outcome: 'more_pending', pages: 2, inserted: 0 }, sent: { outcome: 'caught_up', pages: 1, inserted: 0 } },
}
const spend = (ms: number) => vi.setSystemTime(Date.now() + ms)

function wireSteps() {
  vi.mocked(maintainSubscriptionsSafely).mockImplementation(async (o) => {
    spend(o.budgetMs)
    return { migrationMissing: false, folders: {} } as never
  })
  vi.mocked(runMailContentIntakeLive).mockImplementation(async (o) => {
    spend(o.budgetMs)
    return { outcome: 'more_pending' } as never
  })
  vi.mocked(runOutlookMailConnector).mockImplementation(async (_deps, opt) => {
    spend(opt?.budgetMs ?? 0)
    return { stats: SYNC_STATS, results: { inbox: { events: [] }, sent: { events: [] } }, intake: [] } as never
  })
  vi.mocked(purgeMailContent).mockImplementation(async () => {
    spend(300)
    return { expired: 0, cleared: 0 } as never
  })
  // Auto-poptávky: každá zpráva trvá 1 s, dokud deadline nezastaví.
  vi.mocked(runAutoIntakeLive).mockImplementation(async (o) => {
    const total = 30
    for (let i = 0; i < total; i++) {
      if (o.shouldStop?.()) return { capability: 'auto_intake', created: i, createdAccountIds: [1, 2], deferred: total - i } as never
      spend(1_000)
    }
    return { capability: 'auto_intake', created: total, createdAccountIds: [1, 2] } as never
  })
  vi.mocked(runAresForNewAccounts).mockImplementation(async (_ids, o) => {
    spend(o?.budgetMs ?? 0)
    return { processed: 2 } as never
  })
  vi.mocked(runMailToCase).mockImplementation(async (o) => {
    const total = 50
    for (let i = 0; i < total; i++) {
      if (o.shouldStop?.()) return { capability: 'mail_to_case', events: total, deferred: total - i } as never
      spend(500)
    }
    return { capability: 'mail_to_case', events: total } as never
  })
}

const jobDb = {
  tryAcquireJobLock: vi.fn(async () => 7),
  finishJobRun: vi.fn(async () => {}),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-01T04:00:00Z'))
  vi.stubEnv('OUTLOOK_MAIL_WEBHOOK_ENABLED', 'true')
  vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'true')
  vi.stubEnv('APP_URL', 'https://cockpit.example')
  vi.stubEnv('MAIL_CONTENT_INTAKE_ENABLED', 'true')
  vi.stubEnv('CAPABILITY_AUTO_INTAKE_ENABLED', 'true')
  vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
  vi.stubEnv('CAPABILITY_MAIL_TO_CASE_ENABLED', 'true')
  wireSteps()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('runOutlookMailJobBody — společný deadline', () => {
  it('každý krok celý rozpočet: běh skončí do 55 s, zbytek je odložený', async () => {
    const start = Date.now()
    const out = await runOutlookMailJobBody({
      admin: {} as never, jobDb, memberId: MEMBER, secret: 's', mode: 'cron', logScope: 'test',
      deadline: createDeadline(OUTLOOK_MAIL_ROUTE_BUDGET_MS),
    })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThanOrEqual(OUTLOOK_MAIL_ROUTE_BUDGET_MS)
    expect(elapsed).toBeLessThan(OUTLOOK_MAIL_MAX_DURATION_S * 1000)
    // Webhook dostal svoje maximum, sync aspoň minimum.
    expect(vi.mocked(maintainSubscriptionsSafely).mock.calls[0][0].budgetMs).toBe(WEBHOOK_BUDGET_MAX_MS)
    expect(vi.mocked(runOutlookMailConnector).mock.calls[0][1]?.budgetMs).toBeGreaterThanOrEqual(MIN_SYNC_BUDGET_MS)
    // Po 15 s webhooku zbývá 40 s: obsah by vzal syncu minimum → přeskočí se.
    expect(runMailContentIntakeLive).not.toHaveBeenCalled()
    expect(out.mailContent).toEqual({ skipped: 'budget' })
    expect(out.deferred).toEqual(expect.arrayContaining(['mailContent', 'autoIntake', 'autoIntakeAres']))
    expect(out.autoIntakeAres).toEqual({ skipped: 'budget', deferred: 2 })
  })

  it('pomalý webhook (přetáhne o 20 s) neprodlouží běh: další kroky se zkrátí nebo odloží', async () => {
    vi.mocked(maintainSubscriptionsSafely).mockImplementation(async (o) => {
      spend(o.budgetMs + 20_000)
      return { migrationMissing: false, folders: {} } as never
    })
    const start = Date.now()
    const out = await runOutlookMailJobBody({
      admin: {} as never, jobDb, memberId: MEMBER, secret: 's', mode: 'cron', logScope: 'test',
      deadline: createDeadline(OUTLOOK_MAIL_ROUTE_BUDGET_MS),
    })
    expect(Date.now() - start).toBeLessThanOrEqual(OUTLOOK_MAIL_ROUTE_BUDGET_MS)
    expect(vi.mocked(runOutlookMailConnector).mock.calls[0][1]?.budgetMs).toBeLessThan(MIN_SYNC_BUDGET_MS)
    expect(out.deferred).toEqual(expect.arrayContaining(['mailContent', 'mailToCase']))
  })

  it('rychlé kroky: nic se neodkládá a ARES dostane rozpočet s kratším timeoutem dotazu', async () => {
    vi.mocked(maintainSubscriptionsSafely).mockImplementation(async () => ({ migrationMissing: false, folders: {} }) as never)
    vi.mocked(runMailContentIntakeLive).mockImplementation(async () => ({ outcome: 'caught_up' }) as never)
    vi.mocked(runOutlookMailConnector).mockImplementation(async () => {
      spend(5_000)
      return { stats: SYNC_STATS, results: { inbox: { events: [] }, sent: { events: [] } }, intake: [] } as never
    })
    vi.mocked(runAutoIntakeLive).mockResolvedValue({ capability: 'auto_intake', createdAccountIds: [9] } as never)
    vi.mocked(runMailToCase).mockResolvedValue({ capability: 'mail_to_case', events: 0 } as never)
    const out = await runOutlookMailJobBody({
      admin: {} as never, jobDb, memberId: MEMBER, secret: 's', mode: 'cron', logScope: 'test',
    })
    expect(out.deferred).toBeUndefined()
    expect(vi.mocked(runAresForNewAccounts).mock.calls[0][1]).toEqual({ budgetMs: ARES_BUDGET_MAX_MS, requestTimeoutMs: ARES_REQUEST_TIMEOUT_MS })
    expect(vi.mocked(runMailContentIntakeLive).mock.calls[0][0].budgetMs).toBe(CONTENT_BUDGET_MAX_MS)
  })
})
