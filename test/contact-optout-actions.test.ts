import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DO_NOT_CONTACT_REASON_MAX } from '@/lib/domain'
import { createClient } from '@/lib/supabase/server'
import { createContact, createPartnerContact, updateContact } from '@/domain/crm/actions/contacts'
import {
  OPT_OUT_MISSING_MIGRATION_MESSAGE,
  isMissingOptOutColumn,
  withoutOptOutFields,
  writeContactWithOptOut,
} from '@/domain/crm/contactOptOut'
import { contactSchema } from '@/lib/validation/schemas'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Políčko „Nesouhlasí s oslovením" (0087) ve formuláři kontaktu: co se
// zapíše, co doplní databáze (kdy a kdo — z formuláře nikdy) a jak se akce
// chovají, dokud migrace 0087 v databázi není.

vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn(async () => {}) }))
vi.mock('@/lib/queries/team', () => ({ isCurrentUserAdmin: vi.fn(async () => true) }))

const MISSING = { code: 'PGRST204', message: "Could not find the 'do_not_contact' column of 'contact' in the schema cache" }

let resolve: (c: QueryCall) => QueryResult
function fake() {
  const f = createSupabaseFake({ user: { id: 'user-1' }, resolve: (c) => resolve(c) })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}
const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}
const writes = (f: ReturnType<typeof fake>, method: 'insert' | 'update') =>
  f.calls.filter((c) => c.table === 'contact' && hasOp(c, method)).map((c) => opArgs(c, method)![0] as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  resolve = () => ({ data: { account_id: 5, partner_id: null }, error: null })
})

describe('contactSchema: nesouhlas s oslovením', () => {
  test('zaškrtnuté + důvod (ořezaný); kdy a kdo z formuláře neprojdou', () => {
    const d = contactSchema.parse({
      full_name: 'Jan', do_not_contact: 'on', do_not_contact_reason: '  řekl na veletrhu  ',
      do_not_contact_at: '2001-01-01', do_not_contact_by: 'cizi-uuid',
    })
    expect(d).toMatchObject({ do_not_contact: true, do_not_contact_reason: 'řekl na veletrhu' })
    expect(d).not.toHaveProperty('do_not_contact_at')
    expect(d).not.toHaveProperty('do_not_contact_by')
  })

  test('bez zaškrtnutí se důvod zahodí; výchozí je souhlas', () => {
    expect(contactSchema.parse({ full_name: 'Jan', do_not_contact_reason: 'něco' }))
      .toMatchObject({ do_not_contact: false, do_not_contact_reason: null })
    expect(contactSchema.parse({ full_name: 'Jan' })).toMatchObject({ do_not_contact: false, do_not_contact_reason: null })
    expect(contactSchema.parse({ full_name: 'Jan', do_not_contact: 'on', do_not_contact_reason: '   ' }).do_not_contact_reason).toBeNull()
  })

  test('limit důvodu sedí s CHECK v migraci 0087', () => {
    const sql = readFileSync('supabase/migrations/0087_contact_opt_out.sql', 'utf8')
    expect(sql).toContain(`char_length(do_not_contact_reason) <= ${DO_NOT_CONTACT_REASON_MAX}`)
  })

  test('důvod nejvýš 300 znaků', () => {
    const r = contactSchema.safeParse({ full_name: 'Jan', do_not_contact: 'on', do_not_contact_reason: 'x'.repeat(301) })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].message).toMatch(/300 znaků/)
    expect(contactSchema.safeParse({ full_name: 'Jan', do_not_contact: 'on', do_not_contact_reason: 'x'.repeat(300) }).success).toBe(true)
  })
})

describe('contactOptOut: zápis před migrací 0087', () => {
  test('isMissingOptOutColumn: jen chybějící sloupec nesouhlasu', () => {
    expect(isMissingOptOutColumn(MISSING)).toBe(true)
    expect(isMissingOptOutColumn({ code: '42703', message: 'column "do_not_contact" of relation "contact" does not exist' })).toBe(true)
    expect(isMissingOptOutColumn({ code: '42703', message: 'column "phone" does not exist' })).toBe(false)
    expect(isMissingOptOutColumn({ code: '23505', message: 'do_not_contact' })).toBe(false)
    expect(isMissingOptOutColumn(null)).toBe(false)
  })

  test('withoutOptOutFields odebere jen pole nesouhlasu', () => {
    expect(withoutOptOutFields({ full_name: 'Jan', do_not_contact: false, do_not_contact_reason: null, phone: '1' }))
      .toEqual({ full_name: 'Jan', phone: '1' })
  })

  test('writeContactWithOptOut: chyba jiného druhu se neopakuje', async () => {
    const write = vi.fn(async () => ({ error: { code: '23505', message: 'dup' } }))
    const r = await writeContactWithOptOut({ full_name: 'Jan', do_not_contact: false }, write)
    expect(write).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ optOutBlocked: false, result: { error: { code: '23505' } } })
  })
})

describe('updateContact / createContact: nesouhlas s oslovením', () => {
  test('úprava zapíše příznak a důvod, nikdy kdy a kdo (doplní DB)', async () => {
    const f = fake()
    const r = await updateContact(42, null, form({ full_name: 'Petra Nováková', do_not_contact: 'on', do_not_contact_reason: 'Odhlásila se e-mailem' }))
    expect(r).toEqual({ success: true })
    const [row] = writes(f, 'update')
    expect(row).toMatchObject({ do_not_contact: true, do_not_contact_reason: 'Odhlásila se e-mailem' })
    expect(Object.keys(row)).not.toContain('do_not_contact_at')
    expect(Object.keys(row)).not.toContain('do_not_contact_by')
  })

  test('odškrtnutí nesouhlas zruší (false, důvod null)', async () => {
    const f = fake()
    await updateContact(42, null, form({ full_name: 'Petra', do_not_contact_reason: 'zbytek' }))
    expect(writes(f, 'update')[0]).toMatchObject({ do_not_contact: false, do_not_contact_reason: null })
  })

  test('bez migrace a bez zaškrtnutí: kontakt se uloží bez polí nesouhlasu', async () => {
    let n = 0
    resolve = (c) => (hasOp(c, 'update') && n++ === 0 ? { data: null, error: MISSING } : { data: { account_id: 5, partner_id: null }, error: null })
    const f = fake()
    expect(await updateContact(42, null, form({ full_name: 'Petra', phone: '+420 1' }))).toEqual({ success: true })
    const rows = writes(f, 'update')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(expect.objectContaining({ full_name: 'Petra', phone: '+420 1' }))
    expect(Object.keys(rows[1]).filter((k) => k.startsWith('do_not_contact'))).toEqual([])
  })

  test('bez migrace se ZAŠKRTNUTÝM nesouhlasem: srozumitelná chyba, nic se tiše nezahodí', async () => {
    resolve = (c) => (hasOp(c, 'update') || hasOp(c, 'insert') ? { data: null, error: MISSING } : { data: null, error: null })
    const f = fake()
    expect(await updateContact(42, null, form({ full_name: 'Petra', do_not_contact: 'on' })))
      .toEqual({ success: false, error: OPT_OUT_MISSING_MIGRATION_MESSAGE })
    expect(writes(f, 'update')).toHaveLength(1)
    expect(await createContact(5, null, form({ full_name: 'Petra', do_not_contact: 'on' })))
      .toEqual({ success: false, error: OPT_OUT_MISSING_MIGRATION_MESSAGE })
    expect(await createPartnerContact(6, null, form({ full_name: 'Petra', do_not_contact: 'on' })))
      .toEqual({ success: false, error: OPT_OUT_MISSING_MIGRATION_MESSAGE })
    expect(writes(f, 'insert')).toHaveLength(2)
  })

  test('založení kontaktu rovnou s nesouhlasem', async () => {
    resolve = () => ({ data: null, error: null })
    const f = fake()
    expect(await createContact(5, null, form({ full_name: 'Karel', do_not_contact: 'on', do_not_contact_reason: 'GDPR námitka' }))).toEqual({ success: true })
    expect(writes(f, 'insert')[0]).toMatchObject({ account_id: 5, partner_id: null, do_not_contact: true, do_not_contact_reason: 'GDPR námitka' })
  })

  test('příliš dlouhý důvod = chyba pole, nic se nezapíše', async () => {
    const f = fake()
    const r = await updateContact(42, null, form({ full_name: 'Petra', do_not_contact: 'on', do_not_contact_reason: 'x'.repeat(301) }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.do_not_contact_reason).toMatch(/300 znaků/)
    expect(f.from).not.toHaveBeenCalled()
  })
})
