import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { recordAudit } from '@/core/audit'
import { GET } from '@/app/cockpit/kontakty/[id]/export/route'
import { createSupabaseFake, type QueryCall } from './helpers/supabaseFake'

// app/cockpit/kontakty/[id]/export/route.ts — hlavičky odpovědi. Test/gdpr-export-auth.test.ts
// už kryje autorizaci (401/403/400) a Content-Disposition na úspěšné cestě;
// tady doplňujeme, že Cache-Control: no-store je nastavené na VŠECH cestách
// (úspěch i chyby), protože export obsahuje osobní data a nesmí skončit
// v žádné mezipaměti (CDN, prohlížeč, proxy).

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const CONTACT = { id: 7, full_name: 'Jan Novák', email: 'jan.novak@firma.cz', account_id: 3, partner_id: null }

function setup(isAdmin: boolean) {
  const gate = createSupabaseFake({ resolve: () => ({ data: { is_admin: isAdmin }, error: null }) })
  const admin = createSupabaseFake({
    resolve: (c: QueryCall) => {
      if (c.table === 'contact') return { data: CONTACT, error: null }
      if (c.table === 'account') return { data: { name: 'Firma' }, error: null }
      return { data: [], error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(gate.client as never)
  vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
}

const req = (id: string) => GET(new Request('http://x'), { params: Promise.resolve({ id }) })

beforeEach(() => vi.clearAllMocks())

describe('GET export — Cache-Control: no-store na všech cestách', () => {
  test('200: no-store + přesná Content-Disposition příloha', async () => {
    setup(true)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    const r = await req('7')
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="gdpr-export-kontakt-7-\d{4}-\d{2}-\d{2}\.json"$/)
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('401 (nepřihlášený): no-store, žádná Content-Disposition', async () => {
    setup(true)
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const r = await req('7')
    expect(r.status).toBe(401)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-disposition')).toBeNull()
  })

  test('403 (ne-admin): no-store, žádná Content-Disposition', async () => {
    setup(false)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    const r = await req('7')
    expect(r.status).toBe(403)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-disposition')).toBeNull()
  })

  test('400 (neplatné id): no-store, žádná Content-Disposition, DB se nevolá', async () => {
    setup(true)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    const r = await req('abc')
    expect(r.status).toBe(400)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-disposition')).toBeNull()
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('desetinné/záporné id se chovají jako neplatné (regex ^\\d+$)', async () => {
    setup(true)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    expect((await req('7.5')).status).toBe(400)
    expect((await req('-7')).status).toBe(400)
    expect((await req('')).status).toBe(400)
  })
})
