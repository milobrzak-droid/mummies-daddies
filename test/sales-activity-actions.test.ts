import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { aresByIco } from '@/connectors/ares'
import { createSalesActivity, updateDealNextStep } from '@/domain/crm/actions/sales'
import { setAccountIco } from '@/domain/crm/actions/accounts'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Zápis obchodní aktivity a dalšího kroku (sales-only, 0058) a doplnění IČO
// přes ARES. Supabase je fake, ARES mockovaný.

vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/connectors/ares', () => ({
  aresByIco: vi.fn(),
  aresRegionValue: (c: { city: string | null; region: string | null }) => {
    const v = (c.city ?? c.region ?? '').trim()
    return v || null
  },
}))

const ok = (data: unknown): QueryResult => ({ data, error: null })
let role: string | null
let rows: Record<string, unknown>
let writeError: unknown

function fake() {
  const f = createSupabaseFake({
    user: { id: 'user-1' },
    resolve: (c: QueryCall) => {
      if (c.table === 'team_member') return ok(role === null ? null : { role })
      if (hasOp(c, 'insert') || hasOp(c, 'update')) return { data: null, error: writeError }
      return ok(rows[c.table] ?? null)
    },
  })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}
const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}
const ACTIVITY = { account_id: '5', kind: 'call', subject: 'Discovery', occurred_at: '2026-09-28T10:00' }

beforeEach(() => {
  vi.clearAllMocks()
  role = 'obchodnik'
  rows = {}
  writeError = null
})

describe('createSalesActivity', () => {
  test('bez AAL2 → auth chyba, DB se nečte', async () => {
    const f = fake()
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    expect(await createSalesActivity(null, form(ACTIVITY))).toEqual({ success: false, error: 'auth' })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('neobchodní role (projekťák) nezapíše', async () => {
    role = 'projektak'
    const f = fake()
    expect(await createSalesActivity(null, form(ACTIVITY))).toEqual({ success: false, error: 'Nemáš přístup k sales CRM.' })
    expect(f.calls.some((c) => c.table === 'sales_activity')).toBe(false)
  })

  test('člen bez řádku v týmu nezapíše', async () => {
    role = null
    fake()
    expect((await createSalesActivity(null, form(ACTIVITY))).success).toBe(false)
  })

  test('neplatný formulář → chyby polí', async () => {
    fake()
    const r = await createSalesActivity(null, form({ ...ACTIVITY, subject: ' ', partner_id: '3' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors).toBeDefined()
  })

  test('obchod u partnerské aktivity neprojde', async () => {
    fake()
    const r = await createSalesActivity(null, form({ partner_id: '3', kind: 'call', subject: 'x', occurred_at: '2026-09-28', deal_id: '9' }))
    expect(r).toEqual({ success: false, fieldErrors: { deal_id: 'Obchod jde připojit jen k aktivitě u klienta.' } })
  })

  test('obchod jiného klienta neprojde', async () => {
    rows.deal = { account_id: 6 }
    const f = fake()
    const r = await createSalesActivity(null, form({ ...ACTIVITY, deal_id: '9' }))
    expect(r.fieldErrors).toEqual({ deal_id: 'Obchod nepatří vybranému klientovi.' })
    expect(f.calls.some((c) => c.table === 'sales_activity')).toBe(false)
  })

  test('kontakt musí patřit straně aktivity (klient / partner)', async () => {
    rows.contact = { account_id: 5, partner_id: null }
    fake()
    expect((await createSalesActivity(null, form({ ...ACTIVITY, contact_id: '2' }))).success).toBe(true)
    rows.contact = { account_id: 7, partner_id: null }
    expect((await createSalesActivity(null, form({ ...ACTIVITY, contact_id: '2' }))).fieldErrors)
      .toEqual({ contact_id: 'Kontakt nepatří vybrané firmě.' })
    rows.contact = { account_id: 5, partner_id: null }
    expect((await createSalesActivity(null, form({ partner_id: '3', kind: 'call', subject: 'x', occurred_at: '2026-09-28', contact_id: '2' }))).fieldErrors)
      .toEqual({ contact_id: 'Kontakt nepatří vybrané firmě.' })
    rows.contact = null
    expect((await createSalesActivity(null, form({ ...ACTIVITY, contact_id: '2' }))).success).toBe(false)
  })

  test('zápis nese autora ze sezení; follow-up u obchodu nastaví další krok', async () => {
    rows.deal = { account_id: 5 }
    const f = fake()
    const r = await createSalesActivity(null, form({ ...ACTIVITY, deal_id: '9', follow_up_on: '2026-10-05', created_by: 'podvrh' }))
    expect(r).toEqual({ success: true })
    const insert = f.calls.find((c) => c.table === 'sales_activity')!
    expect(opArgs(insert, 'insert')![0]).toMatchObject({ account_id: 5, deal_id: 9, created_by: 'user-1' })
    const dealUpdate = f.calls.find((c) => c.table === 'deal' && hasOp(c, 'update'))!
    expect(opArgs(dealUpdate, 'update')![0]).toEqual({ next_step: 'Discovery', next_step_due: '2026-10-05' })
    expect(opArgs(dealUpdate, 'eq')).toEqual(['id', 9])
  })

  test('bez follow-upu se obchod nemění', async () => {
    rows.deal = { account_id: 5 }
    const f = fake()
    await createSalesActivity(null, form({ ...ACTIVITY, deal_id: '9' }))
    expect(f.calls.some((c) => c.table === 'deal' && hasOp(c, 'update'))).toBe(false)
  })

  test('chyba zápisu aktivity → obecná hláška', async () => {
    writeError = { code: 'XX000', message: 'secret' }
    fake()
    expect(await createSalesActivity(null, form(ACTIVITY))).toEqual({ success: false, error: expect.stringMatching(/nezdařila/) })
  })
})

describe('updateDealNextStep', () => {
  test('validace před dotazem: id, prázdný krok, formát data', async () => {
    const f = fake()
    expect(await updateDealNextStep(0, 'x', '2026-10-01')).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(await updateDealNextStep(1, '   ', '2026-10-01')).toEqual({ success: false, error: 'Doplň další krok.' })
    expect(await updateDealNextStep(1, 'x', '1. 10. 2026')).toEqual({ success: false, error: 'Doplň platný termín.' })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('neobchodní role nezmění', async () => {
    role = 'lektor'
    const f = fake()
    expect((await updateDealNextStep(1, 'x', '2026-10-01')).success).toBe(false)
    expect(f.calls.some((c) => c.table === 'deal')).toBe(false)
  })

  test('neexistující obchod', async () => {
    fake()
    expect(await updateDealNextStep(1, 'x', '2026-10-01')).toEqual({ success: false, error: 'Obchod nenalezen.' })
  })

  test('úspěch uloží oříznutý krok a termín', async () => {
    rows.deal = { account_id: 5 }
    const f = fake()
    expect(await updateDealNextStep(3, '  Zavolat  ', '2026-10-01')).toEqual({ success: true })
    const update = f.calls.find((c) => c.table === 'deal' && hasOp(c, 'update'))!
    expect(opArgs(update, 'update')![0]).toEqual({ next_step: 'Zavolat', next_step_due: '2026-10-01' })
  })
})

describe('setAccountIco', () => {
  const company = { ico: '00012345', legalName: 'X', city: null, region: 'Jihomoravský kraj', address: null, founded: null, nace: [], industry: 'Obchod' }

  test('neplatné IČO se do ARESu ani DB nepošle', async () => {
    const f = fake()
    for (const ico of ['', 'abc', '123456789']) {
      expect(await setAccountIco(1, null, form({ ico }))).toEqual({ success: false, error: 'IČO musí být číslo, max. 8 číslic.' })
    }
    expect(aresByIco).not.toHaveBeenCalled()
    expect(f.from).not.toHaveBeenCalled()
  })

  test('neplatné id účtu', async () => {
    fake()
    expect(await setAccountIco(-1, null, form({ ico: '12345' }))).toEqual({ success: false, error: 'Neplatné ID.' })
  })

  test('IČO, které ARES nezná, se neuloží', async () => {
    vi.mocked(aresByIco).mockResolvedValueOnce(null)
    const f = fake()
    expect((await setAccountIco(1, null, form({ ico: '12 345' }))).error).toMatch(/ARES nezná/)
    expect(aresByIco).toHaveBeenCalledWith('12345')
    expect(f.from).not.toHaveBeenCalled()
  })

  test('uloží IČO z ARESu (doplněné nulami); sídlo (obec, ne kraj) jen když u klienta pořád chybí; obor se nedoplňuje', async () => {
    vi.mocked(aresByIco).mockResolvedValueOnce({ ...company, city: 'Brno' })
    rows.account = { region: null }
    const f = fake()
    expect(await setAccountIco(4, null, form({ ico: '12345' }))).toEqual({ success: true })
    const update = f.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(update, 'update')![0]).toEqual({ ico: '00012345', region: 'Brno' })
    expect(opArgs(update, 'eq')).toEqual(['id', 4])
    // Obor se nikdy nepíše — první kód NACE je náhoda (migrace 0030).
    expect(opArgs(update, 'update')![0]).not.toHaveProperty('industry')
  })

  test('bez sídla v ARESu (ani obec, ani kraj) se region nedoplní', async () => {
    vi.mocked(aresByIco).mockResolvedValueOnce({ ...company, region: null })
    rows.account = { region: null }
    const g = fake()
    await setAccountIco(4, null, form({ ico: '12345' }))
    const update = g.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(update, 'update')![0]).toEqual({ ico: '00012345' })
  })

  test('klient už má sídlo vyplněné ručně — ARES ho nepřepíše', async () => {
    vi.mocked(aresByIco).mockResolvedValueOnce({ ...company, city: 'Brno' })
    rows.account = { region: 'Kladno' }
    const h = fake()
    await setAccountIco(4, null, form({ ico: '12345' }))
    const update = h.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(update, 'update')![0]).toEqual({ ico: '00012345' })
  })
})
