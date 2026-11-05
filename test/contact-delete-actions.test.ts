import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { redactContactFromSalesActivity } from '@/domain/crm/gdprSweep'
import { revalidatePath } from 'next/cache'
import { logError } from '@/lib/log'
import { deleteContact, deletePartnerContact } from '@/domain/crm/actions/contacts'
import { CONTACT_DELETE_FAILED_MESSAGE, NOT_ADMIN_MESSAGE } from '@/domain/crm/deleteVerdict'
import { isCurrentUserAdmin } from '@/lib/queries/team'
import { createSupabaseFake, hasOp, type QueryResult } from './helpers/supabaseFake'

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
// Mazání kontaktu je admin-only (rozhodnutí majitele 2026-09-28) — stejný
// helper jako u GDPR exportu, mockovaný samostatně, aby testy nemusely
// simulovat celý team_member dotaz přes supabaseFake.
vi.mock('@/lib/queries/team', () => ({ isCurrentUserAdmin: vi.fn() }))

const ACTOR = { type: 'user', id: 'user-1' }
const RAW_ERROR = 'update or delete on table "contact" violates foreign key constraint "secret_fk_name"'

// Přečtený řádek `contact` před smazáním a odpověď DELETE ... RETURNING id.
function setup(existing: unknown, deleteResult: QueryResult) {
  const fake = createSupabaseFake({
    user: { id: 'user-1' },
    resolve: call => {
      if (call.table !== 'contact') return { data: null, error: null }
      return hasOp(call, 'delete') ? deleteResult : { data: existing, error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

// Klíče všude v hloubce, aby šlo ověřit, že osobní pole v auditu vůbec nejsou.
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys)
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)])
  }
  return []
}

const CASES = [
  {
    name: 'deleteContact',
    run: () => deleteContact(7, 42),
    existing: { full_name: 'Jan Novák', email: 'jan.novak@firma.cz', role: 'paní Dvořáková', account_id: 7 },
    scope: { accountId: 7 },
    path: '/cockpit/clients/7',
  },
  {
    name: 'deletePartnerContact',
    run: () => deletePartnerContact(9, 42),
    existing: { full_name: 'Jan Novák', email: 'jan.novak@firma.cz', role: 'paní Dvořáková', partner_id: 9 },
    scope: { partnerId: 9 },
    path: '/cockpit/partners/9/edit',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  // Výchozí: admin, aby stávající testy (které ověřují úspěšný delete flow)
  // nemusely samy nastavovat oprávnění. Non-admin testy si to přepíší.
  vi.mocked(isCurrentUserAdmin).mockResolvedValue(true)
  vi.mocked(dbAuditActive).mockResolvedValue(false)
})

describe.each(CASES)('$name', ({ run, existing, scope, path }) => {
  test.each([
    ['DB error', { data: null, error: { message: RAW_ERROR, code: '23503' } }],
    ['DB error even with rows present', { data: [{ id: 42 }], error: { message: RAW_ERROR } }],
    ['zero rows (RLS/AAL1 silently rejects)', { data: [], error: null }],
    ['null data', { data: null, error: null }],
    ['more than one row', { data: [{ id: 42 }, { id: 43 }], error: null }],
  ])('delete not confirmed (%s): throws, no audit, no redaction', async (_label, deleteResult) => {
    setup(existing, deleteResult)

    const err = await run().then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    // Klient dostane jen pevnou hlášku, ne text z databáze.
    expect((err as Error).message).toBe(CONTACT_DELETE_FAILED_MESSAGE)
    expect((err as Error).message).not.toContain('secret_fk_name')
    expect(recordAudit).not.toHaveBeenCalled()
    expect(redactContactFromSalesActivity).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('contact.delete', expect.anything(), expect.objectContaining({ contactId: 42 }))
  })

  test('exactly one row deleted: audit once with the narrowed payload, then redaction', async () => {
    const fake = setup(existing, { data: [{ id: 42 }], error: null })

    await run()

    const deleteCall = fake.calls.find(c => hasOp(c, 'delete'))
    // DELETE je vázaný na firmu/partnera z URL (jinak by smazal i kontakt
    // cizí firmy/partnera — viz test/sales-visibility-contact-delete.test.ts).
    const expectedEq = 'partnerId' in scope
      ? [['id', 42], ['partner_id', scope.partnerId]]
      : [['id', 42], ['account_id', scope.accountId]]
    expect(deleteCall?.ops.filter(o => o.method === 'eq').map(o => o.args)).toEqual(expectedEq)
    expect(recordAudit).toHaveBeenCalledTimes(1)
    const args = vi.mocked(recordAudit).mock.calls[0]
    const [table, id, action, before, after, actor] = args
    expect([table, id, action]).toEqual(['contact', 42, 'contact.deleted'])
    expect(before).toMatchObject({ had_email: true, pii_scrubbed: true })
    expect(Object.keys(before as object).sort()).toEqual(['account_id', 'had_email', 'pii_scrubbed'])
    expect(after).toBeNull()
    expect(actor).toEqual(ACTOR)

    // Žádný osobní klíč ani hodnota nikde v argumentech auditu.
    const keys = allKeys(args)
    for (const forbidden of ['email', 'full_name', 'name', 'role']) expect(keys).not.toContain(forbidden)
    const serialized = JSON.stringify(args)
    expect(serialized).not.toContain('jan.novak@firma.cz')
    expect(serialized).not.toContain('Jan Novák')
    expect(serialized).not.toContain('Dvořáková')

    expect(revalidatePath).toHaveBeenCalledWith(path)
    expect(redactContactFromSalesActivity).toHaveBeenCalledTimes(1)
    expect(redactContactFromSalesActivity).toHaveBeenCalledWith(
      scope,
      { email: 'jan.novak@firma.cz', name: 'Jan Novák' },
      ACTOR,
    )
  })

  test('after migration 0064 the DB trigger logs contact.deleted: no app audit, redaction still runs', async () => {
    vi.mocked(dbAuditActive).mockResolvedValue(true)
    setup(existing, { data: [{ id: 42 }], error: null })

    await run()

    expect(recordAudit).not.toHaveBeenCalled()
    expect(redactContactFromSalesActivity).toHaveBeenCalledTimes(1)
  })

  test('audit is written before redaction', async () => {
    setup(existing, { data: [{ id: 42 }], error: null })

    await run()

    const auditOrder = vi.mocked(recordAudit).mock.invocationCallOrder[0]
    const redactOrder = vi.mocked(redactContactFromSalesActivity).mock.invocationCallOrder[0]
    expect(auditOrder).toBeLessThan(redactOrder)
  })

  test('audit or redaction failure does not undo an already confirmed delete', async () => {
    setup(existing, { data: [{ id: 42 }], error: null })
    vi.mocked(recordAudit).mockRejectedValueOnce(new Error('audit down'))
    vi.mocked(redactContactFromSalesActivity).mockRejectedValueOnce(new Error('redaction down'))

    await expect(run()).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalledWith('gdpr', expect.any(Error), expect.objectContaining({ contactId: 42 }))
  })

  test('contact not found on pre-read: returns quietly, no delete, no audit, no redaction', async () => {
    const fake = setup(null, { data: [{ id: 42 }], error: null })

    await expect(run()).resolves.toBeUndefined()

    expect(fake.calls.some(c => hasOp(c, 'delete'))).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
    expect(redactContactFromSalesActivity).not.toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith(path)
  })

  test('non-admin: throws "Nemáš oprávnění", no delete, no audit, no redaction', async () => {
    vi.mocked(isCurrentUserAdmin).mockResolvedValue(false)
    const fake = setup(existing, { data: [{ id: 42 }], error: null })

    const err = await run().then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(NOT_ADMIN_MESSAGE)
    expect(fake.calls.some(c => hasOp(c, 'delete'))).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
    expect(redactContactFromSalesActivity).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('admin: delete proceeds (isCurrentUserAdmin checked after AAL2 guard)', async () => {
    vi.mocked(isCurrentUserAdmin).mockResolvedValue(true)
    setup(existing, { data: [{ id: 42 }], error: null })

    await expect(run()).resolves.toBeUndefined()

    expect(recordAudit).toHaveBeenCalledTimes(1)
    expect(redactContactFromSalesActivity).toHaveBeenCalledTimes(1)
  })
})
