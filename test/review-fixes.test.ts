import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { exportContactData } from '@/domain/crm/actions/gdprExport'
import { redactContactFromSalesActivity } from '@/domain/crm/gdprSweep'
import { setTargetItemStatus } from '@/domain/crm/actions/targetLists'
import { createSupabaseFake, hasOp, opArgs, type QueryCall } from './helpers/supabaseFake'

// Pokrývá bezpečnostní review z této session, rozdělené podle dotčeného
// souboru (viz komentáře jednotlivých describe bloků):
//   1) gdprExport.ts / gdprSweep.ts — stránkování přes .range() místo
//      nechráněného načtení (PostgREST bez .range() ořízne odpověď na 1000
//      řádků a starší data by tak z GDPR exportu/výmazu tiše zmizela)
//   2) targetLists.ts — chyba při zápisu aktivity nevrací syrové actErr.message
//
// Cross-site guard exportní route je v test/review-fixes-route.test.ts —
// samostatný soubor, protože ten mockuje `@/domain/crm/actions/gdprExport`
// (testuje jen route wrapper), zatímco tenhle soubor volá skutečnou
// exportContactData, aby ověřil stránkování.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

// ---------------------------------------------------------------------------
// 1) domain/crm/actions/gdprExport.ts — stránkování sales_activity/task

const CONTACT = { id: 7, full_name: 'Jan Novák', email: 'jan.novak@firma.cz', account_id: 3, partner_id: null }

/** Vytvoří admin fake, jehož `sales_activity` odpověď se stránkuje podle
 *  .range() argumentů zavolaného dotazu — simuluje reálný PostgREST cap. */
function pagedAdminFake(totalActivities: number) {
  return createSupabaseFake({
    resolve: (c: QueryCall) => {
      if (c.table === 'contact') return { data: CONTACT, error: null }
      if (c.table === 'account') return { data: { name: 'Firma' }, error: null }
      if (c.table === 'task') return { data: [], error: null }
      if (c.table === 'audit_event') return { data: [], error: null }
      if (c.table === 'mail_event') return { data: [], error: null }
      if (c.table === 'sales_activity') {
        const [from, to] = opArgs(c, 'range') as [number, number]
        const end = Math.min(to, totalActivities - 1)
        if (from > end) return { data: [], error: null }
        const data = Array.from({ length: end - from + 1 }, (_, i) => ({
          id: from + i + 1, contact_id: 7, kind: 'call', subject: `s${from + i + 1}`, body: null,
        }))
        return { data, error: null }
      }
      return { data: [], error: null }
    },
  })
}

describe('exportContactData — sales_activity/task se stránkují (jinak PostgREST ořízne na 1000)', () => {
  test('1500 aktivit se načtou celé přes dvě stránky .range()', async () => {
    const gate = createSupabaseFake({ resolve: () => ({ data: { is_admin: true }, error: null }) })
    const admin = pagedAdminFake(1500)
    vi.mocked(createClient).mockResolvedValue(gate.client as never)
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)

    const result = await exportContactData(7)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.aktivity).toHaveLength(1500)
    expect(result.document.poznamka).not.toMatch(/POZOR/)

    const activityCalls = admin.calls.filter((c) => c.table === 'sales_activity')
    expect(activityCalls).toHaveLength(2)
    expect(opArgs(activityCalls[0]!, 'range')).toEqual([0, 999])
    expect(opArgs(activityCalls[1]!, 'range')).toEqual([1000, 1999])
  })

  test('50 000+ aktivit narazí na strop exportu a poznámka to nahlásí', async () => {
    const gate = createSupabaseFake({ resolve: () => ({ data: { is_admin: true }, error: null }) })
    const admin = pagedAdminFake(51_000)
    vi.mocked(createClient).mockResolvedValue(gate.client as never)
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)

    const result = await exportContactData(7)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // strop je 50 000 řádků / tabulku, po 50 plných stránkách (1000×50) se
    // zastaví, aniž by si vyžádal 51. stránku
    expect(result.document.aktivity).toHaveLength(50_000)
    expect(result.document.poznamka).toMatch(/POZOR.*limitu exportu/)
    const activityCalls = admin.calls.filter((c) => c.table === 'sales_activity')
    expect(activityCalls).toHaveLength(50)
  })
})

// ---------------------------------------------------------------------------
// 2) domain/crm/gdprSweep.ts — redactContactFromSalesActivity se stránkuje

describe('redactContactFromSalesActivity — sales_activity se stránkuje', () => {
  test('redakce se aplikuje na řádky ze všech stránek', async () => {
    const TOTAL = 1200
    const fake = createSupabaseFake({
      resolve: (c: QueryCall) => {
        if (c.table !== 'sales_activity') return { data: null, error: null }
        if (hasOp(c, 'update')) return { data: null, error: null }
        const [from, to] = opArgs(c, 'range') as [number, number]
        const end = Math.min(to, TOTAL - 1)
        if (from > end) return { data: [], error: null }
        const data = Array.from({ length: end - from + 1 }, (_, i) => ({
          id: from + i + 1, subject: 'Volal jan.novak@firma.cz', body: null,
        }))
        return { data, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)

    const { redactedCount } = await redactContactFromSalesActivity(
      { accountId: 1 },
      { email: 'jan.novak@firma.cz', name: null },
      { type: 'user', id: 'u1' },
    )
    expect(redactedCount).toBe(TOTAL)
    const selectCalls = fake.calls.filter((c) => c.table === 'sales_activity' && !hasOp(c, 'update'))
    expect(selectCalls).toHaveLength(2)
    expect(opArgs(selectCalls[0]!, 'range')).toEqual([0, 999])
    expect(opArgs(selectCalls[1]!, 'range')).toEqual([1000, 1999])
    expect(fake.calls.filter((c) => hasOp(c, 'update'))).toHaveLength(TOTAL)
  })

  test('chyba na první stránce se zaloguje a vrátí redactedCount 0 (best-effort, nesmí shodit volajícího)', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: null, error: { message: 'boom' } }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const { logError } = await import('@/lib/log')
    const result = await redactContactFromSalesActivity({ partnerId: 5 }, { email: 'a@b.cz' }, { type: 'user', id: 'u1' })
    expect(result).toEqual({ redactedCount: 0 })
    expect(logError).toHaveBeenCalledWith('gdpr', expect.anything(), { scope: { partnerId: 5 } })
  })
})

// ---------------------------------------------------------------------------
// 3) targetLists.ts:91 — chyba při insertu aktivity nevrací syrové actErr.message

describe('setTargetItemStatus — chyba zápisu aktivity nevrací syrové DB hlášení', () => {
  const ITEM = {
    id: 1, list_id: 10, account_id: 7, contact_id: 3, reason: 'Roste',
    status: 'navrzeno', target_list: { name: 'Výroba Q4' },
  }

  test('actErr.message se nepropaguje do UI, ale zaloguje se', async () => {
    const fake = createSupabaseFake({
      resolve: (c: QueryCall) => {
        if (c.table === 'target_list_item') return hasOp(c, 'update') ? { data: [{ id: 1 }], error: null } : { data: ITEM, error: null }
        if (c.table === 'sales_activity') {
          return { data: null, error: { code: '23503', message: 'violates foreign key constraint "sales_activity_account_id_fkey" detail=secret' } }
        }
        return { data: null, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)

    const r = await setTargetItemStatus(1, 'osloveno')
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error).toContain('Stav je uložený, ale aktivita ne')
    expect(r.error).not.toContain('sales_activity_account_id_fkey')
    expect(r.error).not.toContain('secret')
    const { logError } = await import('@/lib/log')
    expect(logError).toHaveBeenCalledWith('action.targetOutreach', expect.objectContaining({ code: '23503' }))
    expect(revalidatePath).not.toHaveBeenCalledWith('/cockpit/aktivity')
  })
})
