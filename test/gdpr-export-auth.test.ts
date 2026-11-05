import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { recordAudit } from '@/core/audit'
import { exportContactData } from '@/domain/crm/actions/gdprExport'
import { GET } from '@/app/cockpit/kontakty/[id]/export/route'
import { createSupabaseFake, type QueryCall } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const CONTACT = { id: 7, full_name: 'Jan Novák', email: 'jan.novak@firma.cz', account_id: 3, partner_id: null }

function setup(isAdmin: boolean, mailMissing = false) {
  const gate = createSupabaseFake({ resolve: () => ({ data: { is_admin: isAdmin }, error: null }) })
  const admin = createSupabaseFake({
    resolve: (c: QueryCall) => {
      if (c.table === 'contact') return { data: CONTACT, error: null }
      if (c.table === 'account') return { data: { name: 'Firma' }, error: null }
      if (c.table === 'mail_event' && mailMissing) return { data: null, error: { code: 'PGRST205' } }
      if (c.table === 'sales_activity') return { data: [{ id: 1, contact_id: 7, kind: 'call', subject: 's' }], error: null }
      return { data: [], error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(gate.client as never)
  vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
  return { admin }
}

const req = (id: string) => GET(new Request('http://x'), { params: Promise.resolve({ id }) })

beforeEach(() => vi.clearAllMocks())

describe('exportContactData — autorizace', () => {
  test('nepřihlášený / bez AAL2 → 401, na data se nesahá', async () => {
    const { admin } = setup(true)
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    expect(await exportContactData(7)).toMatchObject({ ok: false, status: 401 })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(admin.calls).toHaveLength(0)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('ne-admin → 403, na data se nesahá', async () => {
    const { admin } = setup(false)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    expect(await exportContactData(7)).toMatchObject({ ok: false, status: 403 })
    expect(admin.calls).toHaveLength(0)
  })

  test('route vrací 401/403 JSON bez přílohy', async () => {
    setup(false)
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const r1 = await req('7')
    expect(r1.status).toBe(401)
    expect(r1.headers.get('content-disposition')).toBeNull()
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    expect((await req('7')).status).toBe(403)
  })

  test('admin: příloha JSON, audit bez PII, chybějící mail_event nevadí', async () => {
    setup(true, true)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    const r = await req('7')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="gdpr-export-kontakt-7-/)
    const body = await r.json()
    expect(body.maily.dostupne).toBe(false)
    expect(body.aktivity).toHaveLength(1)
    expect(recordAudit).toHaveBeenCalledTimes(1)
    const args = vi.mocked(recordAudit).mock.calls[0]
    expect(args.slice(0, 3)).toEqual(['contact', 7, 'contact.exported'])
    expect(JSON.stringify(args)).not.toMatch(/Novák|jan\.novak/)
  })

  test('neplatné id → 400', async () => {
    setup(true)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    expect((await req('abc')).status).toBe(400)
  })
})
