import { beforeEach, describe, expect, test, vi } from 'vitest'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { recordAudit } from '@/core/audit'
import { createAccount, updateAccount } from '@/domain/crm/actions/accounts'
import { addRegistration, createPartner, updatePartner } from '@/domain/crm/actions/partners'
import { createContact, createPartnerContact } from '@/domain/crm/actions/contacts'
import { createReferenceCard } from '@/domain/delivery/actions/reference-cards'
import { updateEngagement } from '@/domain/delivery/actions/engagements'
import { resetParticipantPassword } from '@/lib/actions/team'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Formulářové server akce, které zakládají/mění záznamy: id z argumentu
// (z cesty stránky) má přednost před polem ve formuláři, audit přeobsazení
// klienta, partnerské role z více checkboxů a admin brána u resetu hesla.

vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn(async () => {}) }))
vi.mock('@/connectors/ares', () => ({ aresByIco: vi.fn() }))
vi.mock('@/lib/queries/team', () => ({ isCurrentUserAdmin: vi.fn(async () => true) }))

const ok = (data: unknown): QueryResult => ({ data, error: null })
let resolve: (c: QueryCall) => QueryResult
function fake() {
  const f = createSupabaseFake({ user: { id: 'user-1' }, resolve: (c) => resolve(c) })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}
const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) fd.append(k, one)
  return fd
}
const written = (f: ReturnType<typeof fake>, table: string, method: 'insert' | 'update') =>
  opArgs(f.calls.find((c) => c.table === table && hasOp(c, method))!, method)![0] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  resolve = () => ok(null)
})

describe('createAccount / updateAccount', () => {
  test('bez AAL2 se nic nezapíše', async () => {
    const f = fake()
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    expect(await createAccount(null, form({ name: 'X' }))).toEqual({ success: false, error: 'auth' })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('createAccount: chybějící název → chyba pole; úspěch přesměruje na detail', async () => {
    fake()
    expect(await createAccount(null, form({ name: '' }))).toEqual({ success: false, fieldErrors: { name: 'Název je povinný.' } })
    resolve = () => ok({ id: 42 })
    await createAccount(null, form({ name: 'Acme', ms_licenses: '10' }))
    expect(redirect).toHaveBeenCalledWith('/cockpit/clients/42')
  })

  test('createAccount: chyba DB → obecná hláška, žádný redirect', async () => {
    resolve = () => ({ data: null, error: { code: '23505' } })
    fake()
    expect(await createAccount(null, form({ name: 'Acme' }))).toEqual({ success: false, error: 'Záznam se stejnými údaji už existuje.' })
    expect(redirect).not.toHaveBeenCalled()
  })

  test('updateAccount: změna vlastníka se zaudituje (i z null)', async () => {
    resolve = (c) => (hasOp(c, 'maybeSingle') ? ok({ owner_id: null }) : ok(null))
    fake()
    await updateAccount(7, null, form({ name: 'Acme', owner_id: 'u-2' }))
    expect(recordAudit).toHaveBeenCalledWith(
      'account', 7, 'account.owner_changed', { owner_id: null }, { owner_id: 'u-2' }, { type: 'user', id: 'user-1' },
    )
    expect(redirect).toHaveBeenCalledWith('/cockpit/clients/7')
  })

  test('updateAccount: stejný vlastník nebo nenalezený řádek → bez auditu', async () => {
    resolve = (c) => (hasOp(c, 'maybeSingle') ? ok({ owner_id: 'u-2' }) : ok(null))
    fake()
    await updateAccount(7, null, form({ name: 'Acme', owner_id: 'u-2' }))
    resolve = () => ok(null)
    await updateAccount(7, null, form({ name: 'Acme', owner_id: 'u-3' }))
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('updateAccount: selhání auditu nezastaví uložení', async () => {
    vi.mocked(recordAudit).mockRejectedValueOnce(new Error('audit down'))
    resolve = (c) => (hasOp(c, 'maybeSingle') ? ok({ owner_id: 'u-1' }) : ok(null))
    fake()
    await updateAccount(7, null, form({ name: 'Acme', owner_id: '' }))
    expect(redirect).toHaveBeenCalledWith('/cockpit/clients/7')
  })

  test('updateAccount: neplatné id a chyba update', async () => {
    const f = fake()
    expect(await updateAccount(0, null, form({ name: 'A' }))).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(f.from).not.toHaveBeenCalled()
    resolve = (c) => (hasOp(c, 'update') ? { data: null, error: { code: 'XX' } } : ok(null))
    expect((await updateAccount(7, null, form({ name: 'A' }))).success).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
  })
})

describe('partneři', () => {
  test('role z více checkboxů a is_referrer v souladu s rolemi', async () => {
    const f = fake()
    await createPartner(null, form({ name: 'TAUPARTNER', roles: ['reseller', 'referrer'] }))
    expect(written(f, 'partner', 'insert')).toMatchObject({ name: 'TAUPARTNER', roles: ['reseller', 'referrer'], is_referrer: true })
    expect(redirect).toHaveBeenCalledWith('/cockpit/partners')

    const g = fake()
    await updatePartner(3, null, form({ name: 'TAUPARTNER', roles: ['reseller'] }))
    expect(written(g, 'partner', 'update')).toMatchObject({ roles: ['reseller'], is_referrer: false })
    expect(opArgs(g.calls[0], 'eq')).toEqual(['id', 3])
  })

  test('updatePartner/addRegistration: neplatné id a chybějící název', async () => {
    const f = fake()
    expect(await updatePartner(-1, null, form({ name: 'X' }))).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(await addRegistration(1.5, null, form({ program: 'dodavatel_napoju' }))).toEqual({ success: false, error: 'Neplatné ID.' })
    expect((await createPartner(null, form({ name: '' }))).fieldErrors).toEqual({ name: 'Název je povinný.' })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('addRegistration: partner_id z argumentu, ne z formuláře', async () => {
    const f = fake()
    expect(await addRegistration(4, null, form({ program: 'dodavatel_napoju', partner_id: '999' }))).toEqual({ success: true })
    expect(written(f, 'partner_registration', 'insert')).toMatchObject({ partner_id: 4, program: 'dodavatel_napoju', status: 'none' })
  })

  test('addRegistration: neznámý program → chyba pole', async () => {
    fake()
    expect((await addRegistration(4, null, form({ program: 'x' }))).fieldErrors).toHaveProperty('program')
  })
})

describe('kontakty', () => {
  test('kontakt klienta: account_id z cesty a partner_id vždy null', async () => {
    const f = fake()
    expect(await createContact(5, null, form({ full_name: 'Jan', partner_id: '9', account_id: '999' }))).toEqual({ success: true })
    expect(written(f, 'contact', 'insert')).toMatchObject({ full_name: 'Jan', account_id: 5, partner_id: null })
  })

  test('kontakt partnera: partner_id z cesty a account_id vždy null', async () => {
    const f = fake()
    expect(await createPartnerContact(6, null, form({ full_name: 'Eva', account_id: '5' }))).toEqual({ success: true })
    expect(written(f, 'contact', 'insert')).toMatchObject({ partner_id: 6, account_id: null })
  })

  test('neplatné id, prázdné jméno, chyba DB', async () => {
    const f = fake()
    expect(await createContact(0, null, form({ full_name: 'Jan' }))).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(await createPartnerContact(0, null, form({ full_name: 'Jan' }))).toEqual({ success: false, error: 'Neplatné ID.' })
    expect((await createContact(5, null, form({ full_name: '' }))).fieldErrors).toEqual({ full_name: 'Jméno je povinné.' })
    expect(f.from).not.toHaveBeenCalled()
    resolve = () => ({ data: null, error: { code: '23503' } })
    expect((await createPartnerContact(6, null, form({ full_name: 'Eva' }))).error).toMatch(/souvisí s jinými daty/)
  })
})

describe('dodávka', () => {
  test('referenční karta: firma a dodávka z cesty; veřejné schválení jen výslovně', async () => {
    const f = fake()
    expect(await createReferenceCard(2, 3, null, form({ headline: 'Úspora 20 %', account_id: '99', engagement_id: '98' }))).toEqual({ success: true })
    expect(written(f, 'reference_card', 'insert')).toEqual({
      account_id: 2, engagement_id: 3, headline: 'Úspora 20 %', approved_public: false, is_ms_anchor: false,
    })
    expect(await createReferenceCard(2, 0, null, form({}))).toEqual({ success: false, error: 'Neplatné ID.' })
  })

  test('updateEngagement: brány bez odpovědi zůstanou nehodnocené; redirect na projekt', async () => {
    const f = fake()
    await updateEngagement(2, 8, null, form({ kind: 'edu', phase: 'pilot', gate_pack_delivered: 'on', account_id: '99' }))
    const row = written(f, 'engagement', 'update')
    expect(row).toMatchObject({ account_id: 2, gate_pack_delivered: true, gate_outputs_captured: null })
    expect(opArgs(f.calls[0], 'eq')).toEqual(['id', 8])
    expect(redirect).toHaveBeenCalledWith('/cockpit/clients/2?view=project')
  })

  test('updateEngagement: uložení formuláře nesmaže vazbu na obchod (u automaticky založené dodávky by obchod přišel o dodávku)', async () => {
    const f = fake()
    await updateEngagement(2, 8, null, form({ kind: 'edu', phase: 'pilot' }))
    expect(written(f, 'engagement', 'update')).not.toHaveProperty('deal_id')
    // Pole formuláře, které vazbu výslovně nese, se respektuje.
    const g = fake()
    await updateEngagement(2, 8, null, form({ kind: 'edu', phase: 'pilot', deal_id: '9' }))
    expect(written(g, 'engagement', 'update')).toMatchObject({ deal_id: 9 })
  })

  test('updateEngagement: neplatná fáze → chyba pole, bez zápisu', async () => {
    const f = fake()
    expect((await updateEngagement(2, 8, null, form({ kind: 'edu', phase: 'x' }))).fieldErrors).toHaveProperty('phase')
    expect(f.from).not.toHaveBeenCalled()
  })
})

describe('resetParticipantPassword (jen admin)', () => {
  const USER = '22222222-2222-4222-8222-222222222222'
  const updateUserById = vi.fn(async () => ({ error: null as unknown }))
  beforeEach(() => {
    updateUserById.mockClear()
    vi.mocked(createAdminClient).mockReturnValue({ auth: { admin: { updateUserById } } } as never)
  })

  test('ne-admin nesmí', async () => {
    resolve = () => ok({ is_admin: false })
    fake()
    expect(await resetParticipantPassword(USER, null, form({ password: '12345678' }))).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(updateUserById).not.toHaveBeenCalled()
  })

  test('bez AAL2 → auth', async () => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    fake()
    expect(await resetParticipantPassword(USER, null, form({ password: '12345678' }))).toEqual({ success: false, error: 'auth' })
  })

  test('neplatné id uživatele nebo krátké heslo', async () => {
    resolve = () => ok({ is_admin: true })
    fake()
    expect((await resetParticipantPassword('user-1', null, form({ password: '12345678' }))).success).toBe(false)
    expect((await resetParticipantPassword(USER, null, form({ password: 'short' }))).fieldErrors).toHaveProperty('password')
    expect(updateUserById).not.toHaveBeenCalled()
  })

  test('admin nastaví heslo; chyba Auth → obecná hláška', async () => {
    resolve = () => ok({ is_admin: true })
    fake()
    expect(await resetParticipantPassword(USER, null, form({ password: '12345678' }))).toEqual({ success: true })
    expect(updateUserById).toHaveBeenCalledWith(USER, { password: '12345678' })
    updateUserById.mockResolvedValueOnce({ error: { message: 'weak' } })
    expect((await resetParticipantPassword(USER, null, form({ password: '12345678' }))).error).toMatch(/nezdařila/)
  })
})
