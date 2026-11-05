// @vitest-environment node
// loadDigestAsService (cron, service role): ranní souhrn ('daily') je krátký —
// „Firmy k oslovení" se pro něj vůbec nečtou a nerozhodují o odeslání.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadDigestAsService } from '@/domain/crm/digestDelivery'
import { loadOpsReport } from '@/domain/crm/queries/opsReport'
import { logError } from '@/lib/log'
import { createSupabaseFake, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
// Session klient cron nemá: provozní přehled musí jít přes předaného servisního klienta.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => { throw new Error('session klient v cronu není') }) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/crm/queries/opsReport', async (orig) => {
  const real = await orig<typeof import('@/domain/crm/queries/opsReport')>()
  return { ...real, loadOpsReport: vi.fn(real.loadOpsReport) }
})

const NOW = new Date('2026-09-30T05:00:00Z')

function setup() {
  const fake = createSupabaseFake({
    resolve: (call: QueryCall): QueryResult => {
      if (call.table === 'connector_state') return { data: null, error: null }
      if (call.table === 'account') {
        // Dlouho mlčící firma bez otevřeného obchodu — do fronty oslovování patří.
        return { data: [{ id: 9, name: 'Tichá s.r.o.', last_inbound_at: null, last_outbound_at: '2025-01-01T00:00:00Z', nudged_on: null, snooze_until: null }], error: null }
      }
      return { data: [], error: null }
    },
  })
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
  return fake
}

beforeEach(() => vi.clearAllMocks())

describe('loadDigestAsService', () => {
  it('přehled týdne čte i firmy k oslovení', async () => {
    const fake = setup()
    const { digest, source } = await loadDigestAsService(NOW, 'weekly')
    expect(fake.calls.some((c) => c.table === 'account')).toBe(true)
    expect(source.outreach.map((o) => o.account_id)).toEqual([9])
    expect(digest.sections.map((s) => s.title)).toEqual(['Firmy k oslovení'])
    expect(digest.isEmpty).toBe(false)
  })

  it('ranní souhrn: firmy k oslovení nečte, digest bez nich je prázdný (o odeslání rozhodnou jen zdroje)', async () => {
    const fake = setup()
    const { digest, source } = await loadDigestAsService(NOW, 'daily')
    expect(fake.calls.some((c) => c.table === 'account')).toBe(false)
    expect(source.outreach).toEqual([])
    expect(digest.sections).toEqual([])
    expect(digest.isEmpty).toBe(true)
    // nikdy nepoužitý kalendář a žádný zápis schůzky nejsou porucha a sync
    // pošty je tu vypnutý → žádný alert, ranní souhrn by neodešel
    expect(digest.sourceAlerts).toBe(0)
  })

  it('přehled týdne skládá i provozní přehled přes servisního klienta (bez rpc deal_public)', async () => {
    const fake = setup()
    const { report } = await loadDigestAsService(NOW, 'weekly')
    expect(report).toBeTruthy()
    expect(report!.sections.map((s) => s.key)).toContain('obchody')
    expect(report!.sources?.title).toBe('Stav zdrojů')
    // follow-upy a firmy k oslovení z téhož přehledu → provozní přehled je nemusí číst znovu
    expect(report!.sections.find((s) => s.key === 'na-nas')!.items.map((i) => i.key)).toEqual(['oslovovani'])
    expect(fake.rpc).not.toHaveBeenCalledWith('deal_public', expect.anything())
    expect(vi.mocked(loadOpsReport).mock.calls[0][0]).toMatchObject({ canSeeSales: true, asService: true, db: fake.client, week: 'minuly' })
    expect(logError).not.toHaveBeenCalled()
  })

  it('v pátek je provozní přehled za tento týden, v pondělí za minulý', async () => {
    setup()
    await loadDigestAsService(new Date('2026-10-02T05:00:00Z'), 'weekly')
    await loadDigestAsService(new Date('2026-10-05T05:00:00Z'), 'weekly')
    expect(vi.mocked(loadOpsReport).mock.calls.map((c) => [c[0].week, c[0].now.toISOString()])).toEqual([
      ['tento', '2026-10-02T05:00:00.000Z'],
      ['minuly', '2026-10-05T05:00:00.000Z'],
    ])
  })

  it('ranní souhrn provozní přehled nečte', async () => {
    setup()
    const loaded = await loadDigestAsService(NOW, 'daily')
    expect(loaded.report).toBeUndefined()
    expect(loadOpsReport).not.toHaveBeenCalled()
  })

  it('selhání provozního přehledu se zaloguje a přehled týdne se vrátí bez něj', async () => {
    setup()
    vi.mocked(loadOpsReport).mockRejectedValueOnce(new Error('boom'))
    const loaded = await loadDigestAsService(NOW, 'weekly')
    expect(loaded.report).toBeNull()
    expect(loaded.digest.sections.map((s) => s.title)).toEqual(['Firmy k oslovení'])
    expect(logError).toHaveBeenCalledWith('cron.weeklyDigest.opsReport', expect.any(Error))
  })

  it('bez druhu = přehled týdne (zpětná kompatibilita)', async () => {
    const fake = setup()
    await loadDigestAsService(NOW)
    expect(fake.calls.some((c) => c.table === 'account')).toBe(true)
  })
})
