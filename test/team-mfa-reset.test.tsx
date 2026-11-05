import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { renderToStaticMarkup } from 'react-dom/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { revalidatePath } from 'next/cache'
import { resetParticipantMfa } from '@/lib/actions/team'
import { getMfaStatusByMember } from '@/lib/queries/team'
import { ParticipantActions, mfaResetConfirmText } from '@/components/ParticipantActions'
import { updateSession } from '@/lib/supabase/middleware'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Zrušení dvoufázového ověření po ztrátě telefonu (Tým a nastavení → Tým):
// jen správce, nikdy na vlastním účtu, jen člen týmu, přes Supabase Admin
// API (auth.admin.mfa.listFactors / deleteFactor) a se zápisem do auditu
// (aktér = správce). Po zrušení proxy pošle člověka na nové nastavení
// Authenticatoru — MFA zůstává povinné.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/queries/currentMember', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
const getUser = vi.fn()
const getAAL = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser, mfa: { getAuthenticatorAssuranceLevel: getAAL } } }),
}))
vi.mock('@/lib/supabase/env', () => ({ supabaseUrl: 'http://x', supabaseAnonKey: 'k', supabaseSecretKey: 's' }))

const ADMIN = '11111111-1111-4111-8111-111111111111'
const LOST_PHONE = '22222222-2222-4222-8222-222222222222'
const FACTORS = [
  { id: '33333333-3333-4333-8333-333333333333', factor_type: 'totp', status: 'verified', created_at: '', updated_at: '' },
  { id: '44444444-4444-4444-8444-444444444444', factor_type: 'totp', status: 'unverified', created_at: '', updated_at: '' },
]

type Setup = {
  isAdmin?: boolean
  member?: boolean
  auditColumn?: boolean
  factors?: typeof FACTORS
  deleteFailsAt?: number
}

function setup(opts: Setup = {}) {
  const { isAdmin = true, member = true, auditColumn = true, factors = FACTORS, deleteFailsAt } = opts
  vi.mocked(tryRequireUser).mockResolvedValue({ id: ADMIN } as never)
  vi.mocked(createClient).mockResolvedValue(
    createSupabaseFake({ resolve: () => ({ data: { is_admin: isAdmin }, error: null }) }).client as never,
  )
  const adminFake = createSupabaseFake({
    resolve: (c: QueryCall): QueryResult => {
      if (c.table === 'team_member') return { data: member ? { id: LOST_PHONE } : null, error: null }
      if (c.table === 'audit_event' && hasOp(c, 'select')) {
        return auditColumn ? { data: [], error: null } : { data: null, error: { code: '42703', message: 'column audit_event.entity_ref does not exist' } }
      }
      return { data: null, error: null }
    },
  })
  let calls = 0
  const listFactors = vi.fn(async () => ({ data: { factors }, error: null }))
  const deleteFactor = vi.fn(async ({ id }: { id: string; userId: string }) => {
    calls++
    return deleteFailsAt === calls ? { data: null, error: { message: 'boom', status: 500 } } : { data: { id }, error: null }
  })
  vi.mocked(createAdminClient).mockReturnValue({ ...adminFake.client, auth: { admin: { mfa: { listFactors, deleteFactor } } } } as never)
  const auditInserts = () => adminFake.calls.filter((c) => c.table === 'audit_event' && hasOp(c, 'insert'))
  const failureDeletes = () => adminFake.calls.filter((c) => c.table === 'mfa_failure' && hasOp(c, 'delete'))
  return { listFactors, deleteFactor, auditInserts, failureDeletes, adminFake }
}

beforeEach(() => vi.clearAllMocks())

describe('resetParticipantMfa — kdo smí', () => {
  test('bez přihlášení s AAL2 nic', async () => {
    const { listFactors } = setup()
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    expect(await resetParticipantMfa(LOST_PHONE)).toEqual({ success: false, error: 'auth' })
    expect(listFactors).not.toHaveBeenCalled()
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
  })

  test('jen správce (is_admin z databáze)', async () => {
    const { listFactors, deleteFactor, auditInserts } = setup({ isAdmin: false })
    expect(await resetParticipantMfa(LOST_PHONE)).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(listFactors).not.toHaveBeenCalled()
    expect(deleteFactor).not.toHaveBeenCalled()
    expect(auditInserts()).toHaveLength(0)
  })

  test('nikdy na vlastním účtu', async () => {
    const { listFactors, deleteFactor } = setup()
    const r = await resetParticipantMfa(ADMIN)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Vlastní dvoufázové ověření/)
    expect(listFactors).not.toHaveBeenCalled()
    expect(deleteFactor).not.toHaveBeenCalled()
  })

  test.each(['', 'nope', "x' or 1=1"])('neplatné id %j', async (bad) => {
    const { listFactors } = setup()
    expect(await resetParticipantMfa(bad)).toEqual({ success: false, error: 'Neplatný uživatel.' })
    expect(listFactors).not.toHaveBeenCalled()
  })

  test('jen člen týmu, ne libovolný účet v Auth', async () => {
    const { listFactors } = setup({ member: false })
    expect(await resetParticipantMfa(LOST_PHONE)).toEqual({ success: false, error: 'Neplatný uživatel.' })
    expect(listFactors).not.toHaveBeenCalled()
  })
})

describe('resetParticipantMfa — co udělá', () => {
  test('smaže všechny faktory přes Admin API, vynuluje počítadlo chyb a zapíše audit s aktérem správcem', async () => {
    const { listFactors, deleteFactor, auditInserts, failureDeletes } = setup()
    expect(await resetParticipantMfa(LOST_PHONE)).toEqual({ success: true })
    expect(listFactors).toHaveBeenCalledWith({ userId: LOST_PHONE })
    expect(deleteFactor.mock.calls.map((c) => c[0])).toEqual(FACTORS.map((f) => ({ id: f.id, userId: LOST_PHONE })))
    expect(opArgs(failureDeletes()[0], 'eq')).toEqual(['user_id', LOST_PHONE])
    expect(auditInserts()).toHaveLength(1)
    expect(opArgs(auditInserts()[0], 'insert')).toEqual([{
      actor_type: 'user',
      actor_id: ADMIN,
      action: 'team_member.mfa_reset',
      entity_table: 'team_member',
      entity_ref: LOST_PHONE,
      before: { factors: 2, verified: 1 },
      after: { factors: 0 },
    }])
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/tym')
  })

  test('bez nastaveného 2FA nic nemění a řekne to', async () => {
    const { deleteFactor, auditInserts } = setup({ factors: [] })
    const r = await resetParticipantMfa(LOST_PHONE)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/nemá nastavené/)
    expect(deleteFactor).not.toHaveBeenCalled()
    expect(auditInserts()).toHaveLength(0)
  })

  test('bez sloupce audit_event.entity_ref (0082) se 2FA nesahá', async () => {
    const { listFactors, deleteFactor } = setup({ auditColumn: false })
    const r = await resetParticipantMfa(LOST_PHONE)
    expect(r).toEqual({ success: false, error: 'Zrušení dvoufázového ověření čeká na migraci 0082 (zápis do auditu).' })
    expect(listFactors).not.toHaveBeenCalled()
    expect(deleteFactor).not.toHaveBeenCalled()
  })

  test('selhání druhého faktoru: audit zapíše, co se opravdu smazalo, a hlásí chybu', async () => {
    const { auditInserts } = setup({ deleteFailsAt: 2 })
    const r = await resetParticipantMfa(LOST_PHONE)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Část dvoufázového ověření/)
    expect((opArgs(auditInserts()[0], 'insert')![0] as { after: unknown }).after).toEqual({ factors: 1 })
  })

  test('selhání hned prvního faktoru: nic se nezměnilo, žádný audit', async () => {
    const { auditInserts } = setup({ deleteFailsAt: 1 })
    expect((await resetParticipantMfa(LOST_PHONE)).success).toBe(false)
    expect(auditInserts()).toHaveLength(0)
  })
})

describe('po zrušení je MFA dál povinné', () => {
  test('přihlášený bez faktoru jde na nové nastavení Authenticatoru, ne k datům', async () => {
    getUser.mockResolvedValue({ data: { user: { id: LOST_PHONE } } })
    getAAL.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null })
    const res = await updateSession(new NextRequest('https://cockpit.example.cz/cockpit/clients'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/auth/mfa/enroll')
  })
})

describe('stav 2FA na stránce Tým', () => {
  test('jen pro správce; ověřený faktor = nastavené', async () => {
    const listUsers = vi.fn(async () => ({
      data: {
        users: [
          { id: ADMIN, factors: [FACTORS[0]] },
          { id: LOST_PHONE, factors: [FACTORS[1]] },
          { id: 'bez-faktoru' },
        ],
      },
      error: null,
    }))
    vi.mocked(createAdminClient).mockReturnValue({ auth: { admin: { listUsers } } } as never)
    vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: ADMIN }, member: { is_admin: true, role: 'vedeni', full_name: 'Viktor' } } as never)
    const map = await getMfaStatusByMember()
    expect(map?.get(ADMIN)).toBe(true)
    expect(map?.get(LOST_PHONE)).toBe(false)
    expect(map?.get('bez-faktoru')).toBe(false)

    vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: ADMIN }, member: { is_admin: false, role: 'vedeni', full_name: 'Viktor' } } as never)
    listUsers.mockClear()
    expect(await getMfaStatusByMember()).toBeNull()
    expect(listUsers).not.toHaveBeenCalled()
  })
})

describe('Spravovat účet: tlačítko a potvrzení', () => {
  const render = (p: { isSelf: boolean; mfa: boolean | null }) =>
    renderToStaticMarkup(
      <ParticipantActions userId={LOST_PHONE} isAdmin={false} role="projektak" fullName="Lenka" displayName="Lenka" {...p} />,
    )

  test('u cizího účtu s 2FA je Zrušit dvoufázové ověření', () => {
    const html = render({ isSelf: false, mfa: true })
    expect(html).toContain('Zrušit dvoufázové ověření')
    expect(html).toContain('Nastavené')
  })

  test('na vlastním účtu tlačítko není', () => {
    const html = render({ isSelf: true, mfa: true })
    expect(html).not.toContain('>Zrušit dvoufázové ověření<')
    expect(html).toContain('Svoje dvoufázové ověření si tady zrušit nemůžeš')
  })

  test('bez nastaveného 2FA není co rušit; nezjištěný stav tlačítko nechá', () => {
    expect(render({ isSelf: false, mfa: false })).not.toContain('>Zrušit dvoufázové ověření<')
    expect(render({ isSelf: false, mfa: null })).toContain('>Zrušit dvoufázové ověření<')
  })

  test('potvrzení jmenuje člověka a říká, co se stane', () => {
    const t = mfaResetConfirmText('Lenka')
    expect(t).toContain('Lenka')
    expect(t).toContain('Odhlásí se ze všech zařízení')
    expect(t).toContain('nový QR kód')
  })
})
