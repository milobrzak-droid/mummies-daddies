import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { revalidatePath } from 'next/cache'
import { logError } from '@/lib/log'
import {
  addCompanyAlias,
  addRelationship,
  removeCompanyAlias,
  removeRelationship,
} from '@/domain/crm/actions/companyRelationships'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const INVALID_ID_MESSAGE = 'Neplatný odkaz na firmu. Obnov stránku a zkus to znovu.'
const GENERIC_SAVE_MESSAGE = 'Uložení se nepodařilo. Zkus to znovu.'
const GENERIC_DELETE_MESSAGE = 'Smazání se nepodařilo. Zkus to znovu.'
const RAW_MESSAGE = 'duplicate key value violates unique constraint "relationship_parent_child_key"'
const ACTOR = { type: 'user', id: 'user-1' }

// Neplatná id: nula, záporné, NaN, řetězec (i číselný) a desetinné číslo.
const BAD_IDS: [string, number][] = [
  ['0', 0],
  ['-3', -3],
  ['NaN', Number.NaN],
  ['"5" (string)', '5' as unknown as number],
  ['1.5', 1.5],
]

function form(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

type Resolver = (call: QueryCall) => QueryResult
function setup(resolve?: Resolver) {
  const fake = createSupabaseFake({ user: { id: 'user-1' }, resolve })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(dbAuditActive).mockResolvedValue(false)
})

describe('invalid ids never reach the database', () => {
  test.each(BAD_IDS)('addRelationship(%s) returns the invalid-id error', async (_label, id) => {
    const fake = setup()
    const res = await addRelationship(id, null, form({ direction: 'parent_of', other_account_id: '2' }))
    expect(res).toEqual({ success: false, error: INVALID_ID_MESSAGE })
    expect(createClient).not.toHaveBeenCalled()
    expect(fake.from).not.toHaveBeenCalled()
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test.each(BAD_IDS)('addCompanyAlias(%s) returns the invalid-id error', async (_label, id) => {
    const fake = setup()
    const res = await addCompanyAlias(id, null, form({ alias_domain: 'firma.cz' }))
    expect(res).toEqual({ success: false, error: INVALID_ID_MESSAGE })
    expect(createClient).not.toHaveBeenCalled()
    expect(fake.from).not.toHaveBeenCalled()
  })

  test.each(BAD_IDS)('removeRelationship: bad account id %s returns silently', async (_label, id) => {
    const fake = setup()
    await expect(removeRelationship(id, 5)).resolves.toBeUndefined()
    expect(createClient).not.toHaveBeenCalled()
    expect(fake.from).not.toHaveBeenCalled()
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test.each(BAD_IDS)('removeRelationship: bad relationship id %s returns silently', async (_label, id) => {
    const fake = setup()
    await expect(removeRelationship(1, id)).resolves.toBeUndefined()
    expect(createClient).not.toHaveBeenCalled()
    expect(fake.from).not.toHaveBeenCalled()
  })

  test.each(BAD_IDS)('removeCompanyAlias: bad ids (%s) return silently', async (_label, id) => {
    const fake = setup()
    await expect(removeCompanyAlias(id, 5)).resolves.toBeUndefined()
    await expect(removeCompanyAlias(1, id)).resolves.toBeUndefined()
    expect(createClient).not.toHaveBeenCalled()
    expect(fake.from).not.toHaveBeenCalled()
  })

  test.each(['0', '-1', '1.5', 'abc', ''])('addRelationship with other_account_id %j from the form returns field errors, no DB call', async other => {
    const fake = setup()
    const res = await addRelationship(1, null, form({ direction: 'parent_of', other_account_id: other }))
    expect(res).toMatchObject({ success: false, fieldErrors: expect.any(Object) })
    expect(fake.from).not.toHaveBeenCalled()
  })

  test('addRelationship rejects a relationship of a company with itself before the DB', async () => {
    const fake = setup()
    const res = await addRelationship(4, null, form({ direction: 'child_of', other_account_id: '4' }))
    expect(res).toMatchObject({ success: false, fieldErrors: { other_account_id: expect.any(String) } })
    expect(fake.from).not.toHaveBeenCalled()
  })
})

describe('addRelationship', () => {
  const resolveWith = (insert: QueryResult, reverse: unknown = null): Resolver => call => {
    if (call.table !== 'relationship') return { data: null, error: null }
    return hasOp(call, 'insert') ? insert : { data: reverse, error: null }
  }

  test('23505 unique violation yields the specific message, not the raw DB text', async () => {
    setup(resolveWith({ data: null, error: { code: '23505', message: RAW_MESSAGE } }))
    const res = await addRelationship(1, null, form({ direction: 'parent_of', other_account_id: '2' }))
    expect(res).toEqual({ success: false, error: 'Tenhle vztah mezi firmami už existuje.' })
    expect(JSON.stringify(res)).not.toContain('relationship_parent_child_key')
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('another DB error yields the generic message, never leaks error.message, and is logged', async () => {
    const dbError = { code: '42501', message: 'permission denied for table relationship' }
    setup(resolveWith({ data: null, error: dbError }))
    const res = await addRelationship(1, null, form({ direction: 'parent_of', other_account_id: '2' }))
    expect(res).toEqual({ success: false, error: GENERIC_SAVE_MESSAGE })
    expect(JSON.stringify(res)).not.toContain('permission denied')
    expect(logError).toHaveBeenCalledWith('relationship.insert', dbError, { parent_account_id: 1, child_account_id: 2 })
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('an error without a code is treated as generic (not as a unique violation)', async () => {
    setup(resolveWith({ data: null, error: { message: 'boom' } }))
    const res = await addRelationship(1, null, form({ direction: 'parent_of', other_account_id: '2' }))
    expect(res).toEqual({ success: false, error: GENERIC_SAVE_MESSAGE })
  })

  test('direction decides which side is parent; success audits and revalidates both companies', async () => {
    const fake = setup(resolveWith({ data: { id: 11 }, error: null }))
    const res = await addRelationship(1, null, form({ direction: 'child_of', other_account_id: '2' }))
    expect(res).toEqual({ success: true })
    const insert = fake.calls.find(c => hasOp(c, 'insert'))!
    expect(opArgs(insert, 'insert')).toEqual([{ parent_account_id: 2, child_account_id: 1 }])
    expect(recordAudit).toHaveBeenCalledWith(
      'relationship', 11, 'relationship.created', null, { parent_account_id: 2, child_account_id: 1 }, ACTOR,
    )
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/2')
  })

  test('an existing reverse relationship is refused as a direct cycle without inserting', async () => {
    const fake = setup(resolveWith(
      { data: { id: 11 }, error: null },
      { parent_account_id: 2, child_account_id: 1 },
    ))
    const res = await addRelationship(1, null, form({ direction: 'parent_of', other_account_id: '2' }))
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('cyklus') })
    expect(fake.calls.some(c => hasOp(c, 'insert'))).toBe(false)
  })

  test('an audit failure does not fail the action', async () => {
    setup(resolveWith({ data: { id: 11 }, error: null }))
    vi.mocked(recordAudit).mockRejectedValueOnce(new Error('audit down'))
    await expect(addRelationship(1, null, form({ direction: 'parent_of', other_account_id: '2' })))
      .resolves.toEqual({ success: true })
  })
})

describe('addCompanyAlias', () => {
  const aliasResolver = (insert: QueryResult): Resolver => call => (hasOp(call, 'insert') ? insert : { data: null, error: null })

  test('23505 yields the specific message', async () => {
    setup(aliasResolver({ data: null, error: { code: '23505', message: 'company_alias_domain_key' } }))
    const res = await addCompanyAlias(1, null, form({ alias_domain: 'firma.cz' }))
    expect(res).toEqual({ success: false, error: 'Tenhle alias už u firmy existuje.' })
  })

  test('another DB error yields the generic message and never leaks error.message', async () => {
    const dbError = { code: 'XX000', message: 'relation "company_alias" internal detail' }
    setup(aliasResolver({ data: null, error: dbError }))
    const res = await addCompanyAlias(1, null, form({ alias_domain: 'firma.cz' }))
    expect(res).toEqual({ success: false, error: GENERIC_SAVE_MESSAGE })
    expect(JSON.stringify(res)).not.toContain('internal detail')
    expect(logError).toHaveBeenCalledWith('company_alias.insert', dbError, { accountId: 1 })
  })

  test('success inserts with the account id and audits', async () => {
    const fake = setup(aliasResolver({ data: { id: 8 }, error: null }))
    const res = await addCompanyAlias(1, null, form({ alias_domain: 'Firma.CZ' }))
    expect(res).toEqual({ success: true })
    const insert = fake.calls.find(c => hasOp(c, 'insert'))!
    expect(opArgs(insert, 'insert')).toEqual([expect.objectContaining({ account_id: 1, alias_domain: 'firma.cz' })])
    expect(recordAudit).toHaveBeenCalledWith('company_alias', 8, 'company_alias.created', null, expect.objectContaining({ account_id: 1 }), ACTOR)
  })
})

describe('removeRelationship', () => {
  const ROW = { id: 5, parent_account_id: 1, child_account_id: 2 }
  // Výchozí delete výsledek odpovídá přesně jednomu smazanému řádku —
  // .select('id') po DELETE vrací pole nalezených id.
  const rowResolver = (row: unknown, deleteResult: QueryResult = { data: [{ id: 5 }], error: null }): Resolver => call => {
    if (call.table !== 'relationship') return { data: null, error: null }
    return hasOp(call, 'delete') ? deleteResult : { data: row, error: null }
  }

  test.each([
    ['parent', 1, '/cockpit/clients/2'],
    ['child', 2, '/cockpit/clients/1'],
  ])('account that is the %s may remove it; the other side is revalidated too', async (_role, accountId, otherPath) => {
    const fake = setup(rowResolver(ROW))
    await removeRelationship(accountId, 5)
    const del = fake.calls.find(c => hasOp(c, 'delete'))!
    expect(del.ops.filter(o => o.method === 'eq').map(o => o.args)).toEqual([
      ['id', 5],
      ['parent_account_id', ROW.parent_account_id],
      ['child_account_id', ROW.child_account_id],
    ])
    expect(revalidatePath).toHaveBeenCalledWith(`/cockpit/clients/${accountId}`)
    expect(revalidatePath).toHaveBeenCalledWith(otherPath)
    expect(recordAudit).toHaveBeenCalledWith('relationship', 5, 'relationship.deleted', ROW, null, ACTOR)
  })

  test('an account that is neither parent nor child: no delete, no audit, no revalidation', async () => {
    const fake = setup(rowResolver(ROW))
    await expect(removeRelationship(3, 5)).resolves.toBeUndefined()
    expect(fake.calls.some(c => hasOp(c, 'delete'))).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('relationship not found: no delete, no audit', async () => {
    const fake = setup(rowResolver(null))
    await expect(removeRelationship(1, 5)).resolves.toBeUndefined()
    expect(fake.calls.some(c => hasOp(c, 'delete'))).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('delete error throws the generic message (no raw text), logs, and skips audit', async () => {
    const dbError = { message: 'FK violation on secret_table' }
    setup(rowResolver(ROW, { data: null, error: dbError }))
    const err = await removeRelationship(1, 5).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe(GENERIC_DELETE_MESSAGE)
    expect((err as Error).message).not.toContain('secret_table')
    expect(logError).toHaveBeenCalledWith('relationship.delete', dbError, { accountId: 1, relationshipId: 5, reason: 'db_error' })
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('DELETE removes zero rows (RLS/AAL1 silently rejected it): throws, no audit, no revalidate', async () => {
    setup(rowResolver(ROW, { data: [], error: null }))
    const err = await removeRelationship(1, 5).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe(GENERIC_DELETE_MESSAGE)
    expect(logError).toHaveBeenCalledWith('relationship.delete', expect.any(Error), { accountId: 1, relationshipId: 5, reason: 'not_deleted' })
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('DELETE removes more than one row: throws, no audit, no revalidate', async () => {
    setup(rowResolver(ROW, { data: [{ id: 5 }, { id: 6 }], error: null }))
    const err = await removeRelationship(1, 5).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe(GENERIC_DELETE_MESSAGE)
    expect(logError).toHaveBeenCalledWith('relationship.delete', expect.any(Error), { accountId: 1, relationshipId: 5, reason: 'unexpected_count' })
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('DELETE removes exactly one row: audits once and revalidates both sides', async () => {
    const fake = setup(rowResolver(ROW, { data: [{ id: 5 }], error: null }))
    await removeRelationship(1, 5)
    expect(recordAudit).toHaveBeenCalledTimes(1)
    expect(recordAudit).toHaveBeenCalledWith('relationship', 5, 'relationship.deleted', ROW, null, ACTOR)
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/2')
    const del = fake.calls.find(c => hasOp(c, 'delete'))!
    expect(del.ops.filter(o => o.method === 'eq').map(o => o.args)).toEqual([
      ['id', 5],
      ['parent_account_id', ROW.parent_account_id],
      ['child_account_id', ROW.child_account_id],
    ])
  })
})

describe('removeCompanyAlias', () => {
  const ALIAS_ROW = { id: 8, account_id: 1, domain: 'firma.cz', name: null }
  const aliasResolver = (row: unknown, deleteResult: QueryResult = { data: [{ id: 8 }], error: null }): Resolver => call =>
    (hasOp(call, 'delete') ? deleteResult : { data: row, error: null })

  test('reads and deletes scoped by both alias id and account id, then audits the pre-read row', async () => {
    const fake = setup(aliasResolver(ALIAS_ROW))
    await removeCompanyAlias(1, 8)
    for (const call of fake.calls) {
      expect(call.ops.filter(o => o.method === 'eq').map(o => o.args)).toEqual([['id', 8], ['account_id', 1]])
    }
    expect(recordAudit).toHaveBeenCalledWith('company_alias', 8, 'company_alias.deleted', ALIAS_ROW, null, ACTOR)
  })

  test('delete error throws the generic message without leaking the raw text', async () => {
    setup(aliasResolver(ALIAS_ROW, { data: null, error: { message: 'raw secret detail' } }))
    const err = await removeCompanyAlias(1, 8).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe(GENERIC_DELETE_MESSAGE)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('DELETE removes zero rows (RLS/AAL1 silently rejected it): throws, no audit, no revalidate', async () => {
    setup(aliasResolver(ALIAS_ROW, { data: [], error: null }))
    const err = await removeCompanyAlias(1, 8).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe(GENERIC_DELETE_MESSAGE)
    expect(logError).toHaveBeenCalledWith('company_alias.delete', expect.any(Error), { accountId: 1, aliasId: 8, reason: 'not_deleted' })
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('DELETE removes more than one row: throws, no audit, no revalidate', async () => {
    setup(aliasResolver(ALIAS_ROW, { data: [{ id: 8 }, { id: 9 }], error: null }))
    const err = await removeCompanyAlias(1, 8).then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe(GENERIC_DELETE_MESSAGE)
    expect(logError).toHaveBeenCalledWith('company_alias.delete', expect.any(Error), { accountId: 1, aliasId: 8, reason: 'unexpected_count' })
    expect(recordAudit).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('DELETE removes exactly one row: audits once and revalidates the account', async () => {
    setup(aliasResolver(ALIAS_ROW, { data: [{ id: 8 }], error: null }))
    await removeCompanyAlias(1, 8)
    expect(recordAudit).toHaveBeenCalledTimes(1)
    expect(recordAudit).toHaveBeenCalledWith('company_alias', 8, 'company_alias.deleted', ALIAS_ROW, null, ACTOR)
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1')
  })
})

// Po migraci 0064 zapisuje vznik a smazání aliasu i vztahu DB trigger —
// i při kaskádě ze smazání firmy. Appka pak nesmí psát podruhé.
describe('po migraci 0064 (DB audit trigger aktivní)', () => {
  beforeEach(() => vi.mocked(dbAuditActive).mockResolvedValue(true))

  test('addCompanyAlias i addRelationship zapíšou řádek, ale audit nepíšou', async () => {
    setup(call => (hasOp(call, 'insert') ? { data: { id: 8 }, error: null } : { data: null, error: null }))
    expect(await addCompanyAlias(1, null, form({ alias_domain: 'firma.cz' }))).toEqual({ success: true })
    expect(await addRelationship(1, null, form({ direction: 'parent_of', other_account_id: '2' }))).toEqual({ success: true })
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('removeCompanyAlias i removeRelationship smažou, ale audit nepíšou', async () => {
    setup(call => {
      if (hasOp(call, 'delete')) return { data: [{ id: call.table === 'relationship' ? 5 : 8 }], error: null }
      if (call.table === 'relationship') return { data: { id: 5, parent_account_id: 1, child_account_id: 2 }, error: null }
      return { data: { id: 8, account_id: 1, alias_domain: 'firma.cz', alias_name: null }, error: null }
    })
    await removeCompanyAlias(1, 8)
    await removeRelationship(1, 5)
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1')
    expect(recordAudit).not.toHaveBeenCalled()
  })
})
