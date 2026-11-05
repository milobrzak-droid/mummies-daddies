// deletePartnerContact dřív partnerId ignoroval: DELETE filtroval jen podle
// contactId, takže akce z formuláře partnera A mohla smazat kontakt
// partnera B (nebo kontakt firmy). Nově DELETE nese i partner_id.
// Totéž u deleteContact: DELETE nese account_id firmy z URL.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { deleteContact, deletePartnerContact } from '@/domain/crm/actions/contacts'
import { CONTACT_DELETE_FAILED_MESSAGE } from '@/domain/crm/deleteVerdict'
import { isCurrentUserAdmin } from '@/lib/queries/team'
import { createSupabaseFake, hasOp, type QueryCall } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('@/domain/crm/gdprSweep', () => ({ redactContactFromSalesActivity: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/queries/team', () => ({ isCurrentUserAdmin: vi.fn() }))

const EXISTING = { full_name: 'Jan Novák', email: 'jan@partner.cz', role: null, partner_id: 9 }

function eqArgs(call: QueryCall): unknown[][] {
  return call.ops.filter((o) => o.method === 'eq').map((o) => o.args)
}

function setup(deleteRows: unknown[], existing: unknown = EXISTING) {
  const fake = createSupabaseFake({
    user: { id: 'user-1' },
    resolve: (call) => {
      if (call.table !== 'contact') return { data: null, error: null }
      return hasOp(call, 'delete') ? { data: deleteRows, error: null } : { data: existing, error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isCurrentUserAdmin).mockResolvedValue(true)
})

describe('deletePartnerContact — DELETE je vázaný na partnerId', () => {
  test('DELETE filtruje id i partner_id', async () => {
    const fake = setup([{ id: 42 }])
    await deletePartnerContact(9, 42)
    const del = fake.calls.find((c) => c.table === 'contact' && hasOp(c, 'delete'))!
    expect(eqArgs(del)).toEqual([['id', 42], ['partner_id', 9]])
  })

  test('kontakt jiného partnera → DELETE vrátí 0 řádků → chyba, nic se netváří jako smazané', async () => {
    const fake = setup([])
    await expect(deletePartnerContact(8, 42)).rejects.toThrow(CONTACT_DELETE_FAILED_MESSAGE)
    const del = fake.calls.find((c) => c.table === 'contact' && hasOp(c, 'delete'))!
    expect(eqArgs(del)).toContainEqual(['partner_id', 8])
  })
})

describe('deleteContact — DELETE je vázaný na accountId', () => {
  const ACCOUNT_CONTACT = { full_name: 'Jana Nová', email: 'jana@firma.cz', role: null, account_id: 7 }

  test('DELETE filtruje id i account_id', async () => {
    const fake = setup([{ id: 42 }], ACCOUNT_CONTACT)
    await deleteContact(7, 42)
    const del = fake.calls.find((c) => c.table === 'contact' && hasOp(c, 'delete'))!
    expect(eqArgs(del)).toEqual([['id', 42], ['account_id', 7]])
  })

  test('kontakt jiné firmy → DELETE vrátí 0 řádků → chyba, nic se netváří jako smazané', async () => {
    const fake = setup([], ACCOUNT_CONTACT)
    await expect(deleteContact(8, 42)).rejects.toThrow(CONTACT_DELETE_FAILED_MESSAGE)
    const del = fake.calls.find((c) => c.table === 'contact' && hasOp(c, 'delete'))!
    expect(eqArgs(del)).toContainEqual(['account_id', 8])
  })
})
