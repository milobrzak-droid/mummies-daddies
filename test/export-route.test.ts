import ExcelJS from 'exceljs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { recordAudit } from '@/core/audit'
import { logError } from '@/lib/log'
import { GET } from '@/app/cockpit/export/[prehled]/route'
import { GET as GET_OFFER } from '@/app/cockpit/export/nabidka/[verze]/route'
import { createSupabaseFake, type QueryCall } from './helpers/supabaseFake'
import { OWNER_JANA, OWNER_PETR, SAMPLE_DEALS } from './helpers/exportFixture'

// app/cockpit/export/[prehled]/route.ts a nabidka/[verze]/route.ts: brána
// (cross-site, přihlášení + AAL2, obchodní role), čtení přes RLS klienta
// uživatele (nikdy service role), audit bez obsahu, hlavičky souboru.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => { throw new Error('service role se v exportu nepoužívá') }) }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn() }))
vi.mock('@/lib/queries/currentMember', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const SCOPE_VERSION = {
  id: 55, deal_id: 2, version: 2, scope: 'Svatební hostina pro 120 hostů.', amount_one_time: '245500.00', expected_mrr: '0',
  currency: 'CZK', status: 'sent', sent_at: '2026-11-03T09:00:00Z', decided_at: null, evidence_id: null, created_by: null,
  created_at: '2026-11-02T09:00:00Z',
  deal: { id: 2, title: 'Svatební hostina Novákovi', account: { id: 20, name: 'Kateřina Nováková' }, primary_contact: null },
}

let fake: ReturnType<typeof createSupabaseFake>
function setup(opts: { role?: string; version?: unknown; fail?: boolean } = {}) {
  fake = createSupabaseFake({
    resolve: (c: QueryCall) => {
      if (opts.fail) return { data: null, error: { code: 'XX000', message: 'boom' } }
      if (c.table === 'deal') return { data: SAMPLE_DEALS, error: null }
      if (c.table === 'team_member') return { data: [OWNER_JANA, OWNER_PETR], error: null }
      if (c.table === 'deal_scope_version') return { data: opts.version === undefined ? SCOPE_VERSION : opts.version, error: null }
      return { data: [], error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  vi.mocked(tryRequireUser).mockResolvedValue({ id: OWNER_JANA.id } as never)
  vi.mocked(getCurrentMember).mockResolvedValue({
    user: { id: OWNER_JANA.id } as never,
    member: { full_name: OWNER_JANA.full_name, is_admin: false, role: opts.role ?? 'obchodnik' },
  })
}

// Sec-Fetch-* je v konstruktoru Request zakázaná hlavička (happy-dom ji zahodí), proto set() až potom.
function req(path: string, headers: Record<string, string> = {}) {
  const r = new Request(`http://localhost${path}`)
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v)
  return r
}
const get = (prehled: string, qs: string, headers?: Record<string, string>) =>
  GET(req(`/cockpit/export/${prehled}?${qs}`, headers), { params: Promise.resolve({ prehled }) })
const getOffer = (verze: string) => GET_OFFER(req(`/cockpit/export/nabidka/${verze}`), { params: Promise.resolve({ verze }) })

beforeEach(() => vi.clearAllMocks())

describe('brána exportu', () => {
  test('cross-site požadavek se odmítne dřív, než se sáhne na přihlášení', async () => {
    setup()
    const r = await get('pipeline', 'format=xlsx', { 'sec-fetch-site': 'cross-site' })
    expect(r.status).toBe(403)
    expect(tryRequireUser).not.toHaveBeenCalled()
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  test('neznámý přehled 404, neznámý formát 400', async () => {
    setup()
    expect((await get('hesla', 'format=xlsx')).status).toBe(404)
    expect((await get('pipeline', 'format=csv')).status).toBe(400)
  })

  test('nepřihlášený (nebo bez AAL2) dostane 401 a nic se nečte', async () => {
    setup()
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const r = await get('pipeline', 'format=xlsx')
    expect(r.status).toBe(401)
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(fake.from).not.toHaveBeenCalled()
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('ne-obchodní role obchodní přehled nestáhne (403), úkoly ano', async () => {
    setup({ role: 'lektor' })
    expect((await get('pipeline', 'format=pdf')).status).toBe(403)
    expect((await get('tydenni-prehled', 'format=pdf')).status).toBe(403)
    expect((await get('ukoly', 'format=xlsx&view=team')).status).toBe(200)
  })
})

describe('export obchodů', () => {
  test('xlsx se stejnými filtry jako tabule, přes RLS klienta, s auditem bez obsahu', async () => {
    setup()
    const r = await get('pipeline', 'format=xlsx&state=prohr%C3%A1no&q=Grilov%C3%A1n%C3%AD')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="obchody-\d{4}-\d{2}-\d{2}\.xlsx"/)
    expect(r.headers.get('cache-control')).toBe('no-store')

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await r.arrayBuffer())
    const ws = wb.getWorksheet('Obchody')!
    expect(ws.getRow(2).getCell(1).value).toBe('Grilování pro tým')
    expect(ws.getRow(3).getCell(1).value).toBe('Celkem') // jen jeden obchod prošel filtrem

    expect(createAdminClient).not.toHaveBeenCalled()
    expect(fake.calls.map((c) => c.table)).toContain('deal')
    expect(recordAudit).toHaveBeenCalledTimes(1)
    const [table, id, action, before, after, actor] = vi.mocked(recordAudit).mock.calls[0]
    expect([table, id, action, before]).toEqual(['export', 0, 'export.downloaded', null])
    expect(after).toEqual({ prehled: 'pipeline', format: 'xlsx', rows: 1, filters: ['Stav', 'Hledání'] })
    expect(JSON.stringify(after)).not.toContain('Grilov')
    expect(actor).toEqual({ type: 'user', id: OWNER_JANA.id })
  })

  test('pdf', async () => {
    setup()
    const r = await get('pipeline', 'format=pdf')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    const bytes = new Uint8Array(await r.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })

  test('chyba čtení → 500, do logu jen přehled a formát (žádné filtry ani data)', async () => {
    setup({ fail: true })
    const r = await get('pipeline', 'format=xlsx&q=Nov%C3%A1kov%C3%A1')
    expect(r.status).toBe(500)
    expect(recordAudit).not.toHaveBeenCalled()
    expect(vi.mocked(logError).mock.calls[0][2]).toEqual({ prehled: 'pipeline', format: 'xlsx' })
  })
})

describe('PDF nabídky z verze', () => {
  test('neplatné číslo 400, cizí role 403, neexistující 404, nahrazená 409', async () => {
    setup()
    expect((await getOffer('abc')).status).toBe(400)
    setup({ version: null })
    expect((await getOffer('55')).status).toBe(404)
    setup({ version: { ...SCOPE_VERSION, status: 'superseded' } })
    expect((await getOffer('55')).status).toBe(409)
    setup({ role: 'projektak' })
    expect((await getOffer('55')).status).toBe(403)
  })

  test('PDF ke stažení, audit s id obchodu a verze', async () => {
    setup()
    const r = await getOffer('55')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    expect(r.headers.get('content-disposition')).toMatch(/filename="nabidka-2026-11-03-2-v2\.pdf"/)
    const call = fake.calls.find((c) => c.table === 'deal_scope_version')!
    expect(call.ops.find((o) => o.method === 'eq')?.args).toEqual(['id', 55])
    expect(vi.mocked(recordAudit).mock.calls[0][4]).toEqual({ prehled: 'nabidka-pdf', format: 'pdf', rows: null, filters: [], deal_id: 2, version_id: 55 })
    expect(createAdminClient).not.toHaveBeenCalled()
  })
})
