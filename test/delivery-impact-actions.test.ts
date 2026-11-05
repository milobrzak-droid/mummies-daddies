import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { recordEvidence } from '@/core/evidence'
import {
  createMetricObservation,
  deleteMetricObservation,
  recordReferenceConsent,
  updateEngagementOwnership,
  withdrawReferenceConsent,
} from '@/domain/delivery/actions/impact'
import { createReferenceCard } from '@/domain/delivery/actions/reference-cards'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }))
vi.mock('@/core/evidence', () => ({ recordEvidence: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

function setup(resolve: (c: QueryCall) => QueryResult) {
  const fake = createSupabaseFake({ resolve })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const engagementOk = (c: QueryCall): QueryResult | null =>
  c.table === 'engagement' && hasOp(c, 'maybeSingle') ? { data: { id: 2, account_id: 1 }, error: null } : null

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(recordEvidence).mockResolvedValue({ ok: true, id: 77 })
})

describe('brána AAL2', () => {
  test.each([
    ['createMetricObservation', () => createMetricObservation(1, 2, null, fd({}))],
    ['deleteMetricObservation', () => deleteMetricObservation(1, 2, 3)],
    ['updateEngagementOwnership', () => updateEngagementOwnership(1, 2, null, fd({}))],
    ['recordReferenceConsent', () => recordReferenceConsent(1, 2, 3, null, fd({}))],
    ['withdrawReferenceConsent', () => withdrawReferenceConsent(1, 2, 3)],
  ])('%s bez uživatele nic nezapíše', async (_n, run) => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = setup(() => ({ data: null, error: null }))
    expect(await run()).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('createMetricObservation', () => {
  const valid = { metric: 'Doba zpracování', unit: 'min', baseline: '20', actual: '15', observed_on: '2026-09-01' }

  test('zapíše měření bez created_by, s dokladem přes evidence', async () => {
    const fake = setup((c) => engagementOk(c)
      ?? (c.table === 'engagement_document' ? { data: { id: 9, url: 'https://mummiesdaddies.sharepoint.com/d' }, error: null } : { data: null, error: null }))
    const r = await createMetricObservation(1, 2, null, fd({ ...valid, document_id: '9' }))
    expect(r).toEqual({ success: true })
    expect(recordEvidence).toHaveBeenCalledWith({ admin: true }, { kind: 'file', sourceId: 'engagement_document:9', webLink: 'https://mummiesdaddies.sharepoint.com/d' }, 'user:user-1')
    const ins = fake.calls.find((c) => c.table === 'metric_observation' && hasOp(c, 'insert'))!
    const row = opArgs(ins, 'insert')![0] as Record<string, unknown>
    expect(row).toMatchObject({ engagement_id: 2, baseline: 20, actual: 15, evidence_id: 77 })
    expect(row).not.toHaveProperty('created_by')
  })

  test('měna v jednotce → chyba pole, DB nedotčená', async () => {
    const fake = setup(() => ({ data: null, error: null }))
    const r = await createMetricObservation(1, 2, null, fd({ ...valid, unit: 'Kč' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.unit).toMatch(/Peníze/)
    expect(fake.calls).toHaveLength(0)
  })

  test('cizí dodávka', async () => {
    setup((c) => (c.table === 'engagement' ? { data: { id: 2, account_id: 99 }, error: null } : { data: null, error: null }))
    const r = await createMetricObservation(1, 2, null, fd(valid))
    expect(r).toEqual({ success: false, error: 'Dodávka nebyla nalezena.' })
  })

  test('nenasazená 0061 → klidná hláška', async () => {
    setup((c) => engagementOk(c) ?? { data: null, error: { code: '42P01', message: 'relation does not exist' } })
    const r = await createMetricObservation(1, 2, null, fd(valid))
    expect(r.error).toMatch(/0061/)
  })

  test('nenasazená 0061 s dokladem → žádná osiřelá evidence', async () => {
    const fake = setup((c) => engagementOk(c)
      ?? (c.table === 'metric_observation' ? { data: null, error: { code: '42P01', message: 'x' } }
      : { data: { id: 9, url: 'https://mummiesdaddies.sharepoint.com/d' }, error: null }))
    const r = await createMetricObservation(1, 2, null, fd({ ...valid, document_id: '9' }))
    expect(r.error).toMatch(/0061/)
    expect(recordEvidence).not.toHaveBeenCalled()
    expect(fake.calls.some((c) => c.table === 'engagement_document')).toBe(false)
  })
})

describe('updateEngagementOwnership', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  test('uloží vlastníka a tým', async () => {
    const fake = setup(() => ({ data: [{ id: 2 }], error: null }))
    const r = await updateEngagementOwnership(1, 2, null, fd({ owner_id: a, deputy_id: '', delivery_team: 'cukrarna' }))
    expect(r).toEqual({ success: true })
    expect(opArgs(fake.calls[0], 'update')![0]).toEqual({ owner_id: a, deputy_id: null, delivery_team: 'cukrarna' })
  })
  test('chybějící sloupec (PGRST204) → klidná hláška', async () => {
    setup(() => ({ data: null, error: { code: 'PGRST204', message: 'x' } }))
    const r = await updateEngagementOwnership(1, 2, null, fd({ owner_id: a }))
    expect(r.error).toMatch(/0061/)
  })
})

describe('souhlas s referencí', () => {
  test('bez dokladu neprojde', async () => {
    const fake = setup(() => ({ data: null, error: null }))
    const r = await recordReferenceConsent(1, 2, 3, null, fd({ consent_on: '2026-09-01' }))
    expect(r.fieldErrors?.document_id).toBeTruthy()
    expect(fake.calls).toHaveLength(0)
  })
  test('s dokladem schválí kartu s evidencí a datem', async () => {
    const fake = setup((c) => engagementOk(c)
      ?? (c.table === 'reference_card' && hasOp(c, 'maybeSingle') ? { data: { id: 3 }, error: null }
      : c.table === 'engagement_document' ? { data: { id: 9, url: 'https://mummiesdaddies.sharepoint.com/s' }, error: null }
      : { data: [{ id: 3 }], error: null }))
    const r = await recordReferenceConsent(1, 2, 3, null, fd({ consent_on: '2026-09-01', document_id: '9' }))
    expect(r).toEqual({ success: true })
    const upd = fake.calls.find((c) => c.table === 'reference_card' && hasOp(c, 'update'))!
    expect(opArgs(upd, 'update')![0]).toEqual({ approved_public: true, consent_evidence_id: 77, consent_at: '2026-09-01T12:00:00Z' })
  })
  test('nenasazená 0061 → žádný nový dokument ani evidence', async () => {
    const fake = setup((c) => engagementOk(c)
      ?? (c.table === 'reference_card' ? { data: null, error: { code: '42703', message: 'x' } } : { data: { id: 9, url: 'https://mummiesdaddies.sharepoint.com/s' }, error: null }))
    const r = await recordReferenceConsent(1, 2, 3, null, fd({ consent_on: '2026-09-01', new_title: 'Souhlas', new_url: 'https://mummiesdaddies.sharepoint.com/s' }))
    expect(r.error).toMatch(/0061/)
    expect(recordEvidence).not.toHaveBeenCalled()
    expect(fake.calls.some((c) => c.table === 'engagement_document')).toBe(false)
  })
  test('nová karta je vždy neschválená', async () => {
    const fake = setup(() => ({ data: null, error: null }))
    await createReferenceCard(1, 2, null, fd({ headline: 'X', approved_public: 'on' }))
    expect(opArgs(fake.calls[0], 'insert')![0]).toMatchObject({ approved_public: false })
  })
})
