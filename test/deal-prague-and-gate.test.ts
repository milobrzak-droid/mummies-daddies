// Opravy z review obchodů (kap. 5):
//  - kalendářní dny v pásmu Europe/Prague (00:30 Praha 1. 10. = 30. 9. UTC),
//  - import vyhrané nabídky nastaví won_at/closed_at/forecast_category,
//  - sales gate v createDeal/updateDeal,
//  - přetažení v pipeline nesmaže ručně nastavenou pravděpodobnost.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'
import { createDeal, updateDeal } from '@/domain/crm/actions/deals'
import { updateDealStage } from '@/domain/crm/actions/sales'
import { confirmOfferProposal, proposeOffersFromPdfs } from '@/domain/crm/actions/offers'
import { planMeeting } from '@/domain/crm/actions/planMeeting'
import { endSubscription } from '@/domain/finance/actions/subscriptions'
import { getOverdueEngagements } from '@/lib/queries/dashboard'
import { buildSalesDashboard, buildSalesFocus, hasManualProbability, type SalesDealLike } from '@/domain/crm/sales'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { sanitizeExtraction } from '@/domain/crm/offer-extract'
import { createMeetingEvent } from '@/connectors/graph'
import type { DealStage } from '@/lib/types'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/connectors/cnb', () => ({ czkPerEur: vi.fn(async () => 25) }))
vi.mock('@/connectors/ares', () => ({ aresSearchByName: vi.fn(async () => []), pickAresMatch: vi.fn(() => null) }))
vi.mock('@/connectors/anthropic', () => ({ OFFER_PDF_TIMEOUT_MS: 50_000, extractOfferFromPdf: vi.fn(async () => ({})) }))
// Denní strop čtení PDF (audit_event) má vlastní test (test/import-limits.test.ts); tady je vždy volno.
vi.mock('@/domain/crm/aiQuota', () => ({ takeAiPdfQuota: vi.fn(async () => ({ ok: true, used: 1, limit: 40 })) }))
vi.mock('@/domain/crm/offer-extract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/offer-extract')>()),
  sanitizeExtraction: vi.fn(),
}))
vi.mock('@/connectors/graph', () => ({
  graphTokenForCurrentUser: vi.fn(async () => ({ ok: true, accessToken: 'tok' })),
  createMeetingEvent: vi.fn(async () => ({ id: 'ev-1', joinUrl: null })),
}))
vi.mock('@/core/connectorState', () => ({ recordConnectorError: vi.fn(), recordConnectorSuccess: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(async () => ({ user: { id: 'user-1' }, member: { role: 'vedeni' } })),
  memberSeesSales: vi.fn((member: { role?: string | null } | null) => member?.role === 'vedeni' || member?.role === 'obchodnik'),
}))

// 1. 10. 2026 00:30 v Praze (CEST, UTC+2) = 30. 9. 22:30 UTC.
const PRAGUE_0030_ON_THE_1ST = new Date('2026-09-30T22:30:00.000Z')
const PRAGUE_DAY = '2026-10-01'

function fake(resolve: (call: QueryCall) => QueryResult) {
  const f = createSupabaseFake({ user: { id: 'user-1' }, resolve })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

const updateRow = (f: ReturnType<typeof fake>) =>
  opArgs(f.calls.find((c) => c.table === 'deal' && hasOp(c, 'update'))!, 'update')?.[0] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(PRAGUE_0030_ON_THE_1ST)
})
afterEach(() => { vi.useRealTimers() })

const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries({ title: 'Obchod', revenue_line: 'svatebni_hostina', ...fields })) fd.set(k, v)
  return fd
}

describe('createDeal / updateDeal — pražský den a sales gate', () => {
  const existing = (stage: string) => (call: QueryCall): QueryResult => {
    if (call.table === 'deal' && hasOp(call, 'maybeSingle')) {
      return { data: { account_id: 5, stage, closed_at: null, won_at: null, currency: 'CZK', amount_one_time: 0, amount_one_time_original: null, fx_rate: null }, error: null }
    }
    return { data: null, error: null }
  }

  test('výhra v 00:30 Praha 1. dne zapíše won_at/closed_at jako pražský den (update)', async () => {
    const f = fake(existing('rozhodovani'))
    await updateDeal(5, 7, null, form({ stage: 'vyhráno' }))
    const row = updateRow(f)
    expect(row.won_at).toBe(PRAGUE_DAY)
    expect(row.closed_at).toBe(PRAGUE_DAY)
    expect(row.forecast_category).toBe('closed')
  })

  test('výhra v 00:30 Praha 1. dne zapíše pražský den (create)', async () => {
    const f = fake(() => ({ data: null, error: null }))
    await createDeal(5, null, form({ stage: 'vyhráno', owner_id: '11111111-1111-4111-8111-111111111111' }))
    const insert = f.calls.find((c) => c.table === 'deal' && hasOp(c, 'insert'))
    const row = opArgs(insert!, 'insert')?.[0] as Record<string, unknown>
    expect(row.won_at).toBe(PRAGUE_DAY)
    expect(row.closed_at).toBe(PRAGUE_DAY)
  })

  test('createDeal odmítne uživatele bez sales CRM a nic nezapíše', async () => {
    vi.mocked(getCurrentMember).mockResolvedValueOnce({ user: { id: 'u' } as never, member: { role: 'lektor', full_name: null, is_admin: false } })
    const f = fake(() => ({ data: null, error: null }))
    const res = await createDeal(5, null, form({}))
    expect(res).toEqual({ success: false, error: 'Nemáš přístup k sales CRM.' })
    expect(f.calls).toHaveLength(0)
  })

  test('updateDeal odmítne uživatele bez sales CRM a nic nečte ani nezapíše', async () => {
    vi.mocked(getCurrentMember).mockResolvedValueOnce({ user: { id: 'u' } as never, member: { role: 'projektak', full_name: null, is_admin: false } })
    const f = fake(existing('kvalifikace'))
    const res = await updateDeal(5, 7, null, form({}))
    expect(res).toEqual({ success: false, error: 'Nemáš přístup k sales CRM.' })
    expect(f.calls).toHaveLength(0)
  })

  test('bez přihlášení (AAL2) vrátí auth chybu dřív než gate', async () => {
    const { tryRequireUser } = await import('@/lib/auth/requireUser')
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const res = await updateDeal(5, 7, null, form({}))
    expect(res).toEqual({ success: false, error: 'auth' })
    expect(getCurrentMember).not.toHaveBeenCalled()
  })
})

describe('updateDealStage — pražský den a pravděpodobnost', () => {
  const withDeal = (deal: Record<string, unknown>) => fake((call) => call.table === 'team_member'
    ? { data: { role: 'vedeni' }, error: null }
    : hasOp(call, 'maybeSingle')
      ? { data: { account_id: 5, decision_maker: 'CFO', decision_due: '2026-10-15', ...deal }, error: null }
      : { data: null, error: null })

  test('výhra v 00:30 Praha 1. dne → won_at/closed_at pražský den', async () => {
    const f = withDeal({ stage: 'rozhodovani', probability_pct: 75 })
    expect(await updateDealStage(7, 'vyhráno')).toEqual({ success: true })
    const row = updateRow(f)
    expect(row.won_at).toBe(PRAGUE_DAY)
    expect(row.closed_at).toBe(PRAGUE_DAY)
  })

  test('výchozí pravděpodobnost staré fáze se nahradí výchozí novou', async () => {
    const f = withDeal({ stage: 'kvalifikace', probability_pct: 10 })
    await updateDealStage(7, 'rozsah_nabidka')
    expect(updateRow(f).probability_pct).toBe(55)
  })

  test('prázdná pravděpodobnost se doplní výchozí novou', async () => {
    const f = withDeal({ stage: 'kvalifikace', probability_pct: null })
    await updateDealStage(7, 'diagnostika')
    expect(updateRow(f).probability_pct).toBe(30)
  })

  test('ručně nastavená pravděpodobnost se přetažením nezmění', async () => {
    const f = withDeal({ stage: 'kvalifikace', probability_pct: 40 })
    await updateDealStage(7, 'rozsah_nabidka')
    expect(updateRow(f)).not.toHaveProperty('probability_pct')
  })

  test('uzavření srovná i ruční pravděpodobnost na 100 / 0', async () => {
    const won = withDeal({ stage: 'rozhodovani', probability_pct: 60 })
    await updateDealStage(7, 'vyhráno')
    expect(updateRow(won).probability_pct).toBe(100)
    const lost = withDeal({ stage: 'rozhodovani', probability_pct: 60 })
    await updateDealStage(7, 'prohráno', 'Rozpočet')
    expect(updateRow(lost).probability_pct).toBe(0)
  })

  test('hasManualProbability: stará fáze (před 0050) s její výchozí hodnotou není ruční', () => {
    expect(hasManualProbability({ stage: 'kvalifikace', probability_pct: null })).toBe(false)
    expect(hasManualProbability({ stage: 'kvalifikace', probability_pct: 10 })).toBe(false)
    expect(hasManualProbability({ stage: 'kvalifikace', probability_pct: '10' })).toBe(false)
    expect(hasManualProbability({ stage: 'kvalifikace', probability_pct: 25 })).toBe(true)
  })
})

describe('buildSalesFocus / buildSalesDashboard — dnešek v Praze', () => {
  const deal = (p: Partial<SalesDealLike> & { id: number; stage: DealStage }): SalesDealLike => ({
    amount_one_time: 1000, probability_pct: null, owner_id: null, won_at: null, closed_at: null,
    expected_close: null, next_step: 'Call', next_step_due: '2026-12-31',
    last_activity_at: '2026-09-30T20:00:00.000Z', created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z', account: null, owner: null, primary_contact: null, ...p,
  } as SalesDealLike)

  test('krok s termínem 30. 9. je v 00:30 Praha 1. 10. po termínu (UTC by řeklo „dnes")', () => {
    const d = deal({ id: 1, stage: 'kvalifikace', next_step_due: '2026-09-30' })
    expect(buildSalesFocus([d], PRAGUE_0030_ON_THE_1ST)[0]?.reason).toBe('overdue')
    expect(buildSalesDashboard([d], [], [], PRAGUE_0030_ON_THE_1ST).overdueDeals.map((x) => x.id)).toEqual([1])
  })

  test('okno „uzavření do 7 dní" a „30 dní" se počítá od pražského dne', () => {
    const soon = deal({ id: 2, stage: 'rozhodovani', expected_close: '2026-10-08' })
    expect(buildSalesFocus([soon], PRAGUE_0030_ON_THE_1ST)[0]?.reason).toBe('closing_soon')
    const in30 = deal({ id: 3, stage: 'rozhodovani', expected_close: '2026-10-31' })
    expect(buildSalesDashboard([in30], [], [], PRAGUE_0030_ON_THE_1ST).closing30d).toBe(1000)
  })

  test('výhra z 1. 10. (pražský den) spadá do října', () => {
    const won = deal({ id: 4, stage: 'vyhráno', won_at: PRAGUE_DAY, closed_at: PRAGUE_DAY })
    const lastMonth = deal({ id: 5, stage: 'vyhráno', won_at: '2026-09-30', closed_at: '2026-09-30' })
    expect(buildSalesDashboard([won, lastMonth], [], [], PRAGUE_0030_ON_THE_1ST).wonThisMonth).toBe(1000)
  })
})

describe('import nabídky (návrh AI → potvrzení) — vyhraná nabídka', () => {
  const pdf = () => {
    const fd = new FormData()
    fd.append('pdf', new File([new TextEncoder().encode('%PDF-1.4')], 'nabidka.pdf', { type: 'application/pdf' }))
    return fd
  }
  const admin = () => {
    const f = createSupabaseFake({
      resolve: (call) => call.table === 'account' && hasOp(call, 'ilike')
        ? { data: [{ id: 5, name: 'Spolchemie' }], error: null }
        : call.table === 'deal' && hasOp(call, 'insert') ? { data: { id: 9 }, error: null } : { data: null, error: null },
    })
    const files = new Map<string, string>()
    const storage = {
      from: () => ({
        upload: async (path: string, body: Buffer) => { files.set(path, body.toString('utf8')); return { error: null } },
        download: async (path: string) => (files.has(path)
          ? { data: new Blob([files.get(path)!]), error: null }
          : { data: null, error: { message: 'not found' } }),
        remove: async () => ({ data: [], error: null }),
      }),
    }
    vi.mocked(createAdminClient).mockReturnValue({ ...f.client, storage } as never)
    return f
  }
  const fields = (phase: string) => ({
    fields: {
      account_name: 'Spolchemie', title: 'Nasazení', pillar: 'cheesecaky', phase, revenue_line: 'svatebni_hostina',
      currency: 'CZK', amount_one_time: 100000, cogs_one_time: 40000, estimate_md: null, expected_close: null,
    },
    warnings: [],
    flags: [],
  })
  // Krok 1 (návrh) + krok 2 (potvrzení beze změn) → řádek vloženého obchodu.
  const importAndConfirm = async (phase: string) => {
    vi.mocked(sanitizeExtraction).mockReturnValue(fields(phase) as never)
    const f = admin()
    const proposed = await proposeOffersFromPdfs(null, pdf())
    const r = proposed!.results[0]
    if (!r.success) throw new Error(r.error)
    expect(f.calls.some((c) => c.table === 'deal' && hasOp(c, 'insert'))).toBe(false)
    const fd = new FormData()
    for (const [k, v] of Object.entries({ proposal_id: r.proposal.proposalId, ...fields(phase).fields })) fd.set(k, v == null ? '' : String(v))
    const res = await confirmOfferProposal(null, fd)
    expect(res?.ok).toBe(true)
    return opArgs(f.calls.find((c) => c.table === 'deal' && hasOp(c, 'insert'))!, 'insert')?.[0] as Record<string, unknown>
  }

  test('fáze „objednáno" (vyhráno) → won_at, closed_at = pražský den, forecast closed', async () => {
    const row = await importAndConfirm('potvrzeno')
    expect(row).toMatchObject({ stage: 'vyhráno', won_at: PRAGUE_DAY, closed_at: PRAGUE_DAY, forecast_category: 'closed' })
  })

  test('role bez obchodu (projekťák) nabídku nenahraje — admin klient se nepoužije', async () => {
    vi.mocked(getCurrentMember).mockResolvedValueOnce({ user: { id: 'u' } as never, member: { role: 'projektak', full_name: null, is_admin: false } })
    vi.mocked(sanitizeExtraction).mockReturnValue(fields('potvrzeno') as never)
    const f = admin()
    const res = await proposeOffersFromPdfs(null, pdf())
    expect(res?.results).toEqual([{ fileName: '', success: false, error: 'Nahrát nabídku může jen člen s přístupem k obchodu.' }])
    expect(f.calls).toHaveLength(0)
  })

  test('otevřená fáze won_at/closed_at nenastavuje', async () => {
    const row = await importAndConfirm('poptavka')
    expect(row.stage).toBe('kvalifikace')
    expect(row).not.toHaveProperty('won_at')
    expect(row).not.toHaveProperty('closed_at')
    expect(row).not.toHaveProperty('forecast_category')
  })
})

describe('další pražské dny', () => {
  test('getOverdueEngagements porovnává due_on s pražským dnem', async () => {
    // supabaseFake nezná .lt() — malý vlastní builder, který si volání zapíše.
    const ops: { method: string; args: unknown[] }[] = []
    const builder: Record<string, unknown> = {
      then: (ok: (v: QueryResult) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
    }
    for (const m of ['select', 'lt', 'neq', 'order']) {
      builder[m] = (...args: unknown[]) => { ops.push({ method: m, args }); return builder }
    }
    vi.mocked(createClient).mockResolvedValue({ from: () => builder } as never)
    await getOverdueEngagements()
    expect(ops.find((o) => o.method === 'lt')?.args).toEqual(['due_on', PRAGUE_DAY])
  })

  test('endSubscription zapíše ended_on jako pražský den', async () => {
    const f = fake(() => ({ data: null, error: null }))
    await endSubscription(5, 3)
    expect(opArgs(f.calls[0], 'update')?.[0]).toEqual({ ended_on: PRAGUE_DAY })
  })

  test('planMeeting: follow-up = den konce schůzky v Outlooku + N kalendářních dnů', async () => {
    const f = createSupabaseFake({
      resolve: (call) => call.table === 'sales_activity'
        ? { data: { id: 1 }, error: null }
        : call.table === 'deal' && hasOp(call, 'maybeSingle') ? { data: { id: 9 }, error: null } : { data: null, error: null },
    })
    vi.mocked(createAdminClient).mockReturnValue(f.client as never)
    const fd = new FormData()
    for (const [k, v] of Object.entries({ account_id: '5', title: 'Kickoff', start: '2026-10-24T23:30', duration_min: '60', follow_up_days: '10' })) fd.set(k, v)
    const res = await planMeeting(null, fd)
    expect(res.ok).toBe(true)
    const endDay = (vi.mocked(createMeetingEvent).mock.calls[0][1] as { end: { dateTime: string } }).end.dateTime.slice(0, 10)
    const expected = new Date(Date.parse(`${endDay}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10)
    const activity = opArgs(f.calls.find((c) => c.table === 'sales_activity')!, 'insert')?.[0] as Record<string, unknown>
    expect(activity.follow_up_on).toBe(expected)
    const dealUpdate = opArgs(f.calls.find((c) => c.table === 'deal' && hasOp(c, 'update'))!, 'update')?.[0] as Record<string, unknown>
    expect(dealUpdate.next_step_due).toBe(expected)
  })
})
