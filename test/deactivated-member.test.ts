import { describe, it, expect, vi, beforeEach } from 'vitest'

// Bezpečnostní revize S3: deaktivovaný člen (deactivated_at) neprojde bránou
// requireUser, getCurrentMember ani memberSeesSales, i když má ještě platný JWT
// a díky team_self_read (0082) vidí vlastní řádek. Sloupec může chybět (před 0069).

type Row = { role?: string | null; is_admin?: boolean; full_name?: string; deactivated_at?: string | null }
const state = {
  user: { id: 'u1' } as { id: string } | null,
  row: { role: 'vedeni', is_admin: true, full_name: 'X', deactivated_at: null } as Row | null,
  columnMissing: false,
  error: null as unknown,
  selects: [] as string[],
  aal: 'aal2',
}
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal }, error: null }) },
    },
    from: () => ({
      select: (cols: string) => ({
        eq: () => ({
          maybeSingle: async () => {
            state.selects.push(cols)
            if (state.error) return { data: null, error: state.error }
            if (state.columnMissing && cols.includes('deactivated_at')) {
              return { data: null, error: { code: '42703', message: 'column team_member.deactivated_at does not exist' } }
            }
            if (!state.row) return { data: null, error: null }
            const out: Record<string, unknown> = {}
            for (const c of cols.split(',').map((x) => x.trim())) out[c] = (state.row as Record<string, unknown>)[c]
            return { data: out, error: null }
          },
        }),
      }),
    }),
  }),
}))
vi.mock('@/lib/auth/mfa', () => ({ mfaEnforced: () => true }))

import { requireUser, tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember, memberSeesSales, memberIsAdmin } from '@/lib/queries/currentMember'

const DEACT = '2026-09-01T10:00:00Z'

beforeEach(() => {
  state.user = { id: 'u1' }
  state.row = { role: 'vedeni', is_admin: true, full_name: 'X', deactivated_at: null }
  state.columnMissing = false
  state.error = null
  state.selects = []
  state.aal = 'aal2'
})

describe('requireUser a deaktivace', () => {
  it('aktivní interní člen projde', async () => {
    await expect(requireUser({ aal2: true })).resolves.toMatchObject({ id: 'u1' })
  })

  it('deaktivovaný člen neprojde (ani s AAL2, ani s obchodní rolí)', async () => {
    state.row = { role: 'vedeni', deactivated_at: DEACT }
    expect(await tryRequireUser({ aal2: true })).toBeNull()
    expect(await tryRequireUser()).toBeNull()
  })

  it('deaktivovaný neprojde ani s allowExternal (správa vlastního účtu servisním klíčem)', async () => {
    state.row = { role: 'lektor', deactivated_at: DEACT }
    expect(await tryRequireUser({ allowExternal: true })).toBeNull()
  })

  it('Partner: bez allowExternal neprojde, s allowExternal ano (chování zachováno)', async () => {
    state.row = { role: 'partner', deactivated_at: null }
    expect(await tryRequireUser()).toBeNull()
    await expect(requireUser({ allowExternal: true })).resolves.toMatchObject({ id: 'u1' })
  })

  it('starší schéma bez sloupce: dotaz se zopakuje bez něj a interní člen projde', async () => {
    state.columnMissing = true
    state.row = { role: 'obchodnik' }
    await expect(requireUser({ aal2: true })).resolves.toMatchObject({ id: 'u1' })
    expect(state.selects).toEqual(['role, deactivated_at', 'role'])
  })

  it('fail closed: chyba dotazu, chybějící řádek (bez allowExternal)', async () => {
    state.error = { code: '500', message: 'boom' }
    expect(await tryRequireUser()).toBeNull()
    expect(await tryRequireUser({ allowExternal: true })).toBeNull()
    state.error = null
    state.row = null
    expect(await tryRequireUser()).toBeNull()
  })
})

describe('getCurrentMember a memberSeesSales', () => {
  it('aktivní člen: řádek se vrátí', async () => {
    const { member } = await getCurrentMember()
    expect(member).toMatchObject({ role: 'vedeni', is_admin: true })
  })

  it('deaktivovaný: member = null, tedy ani admin ani obchodní data', async () => {
    state.row = { role: 'vedeni', is_admin: true, full_name: 'X', deactivated_at: DEACT }
    const { user, member } = await getCurrentMember()
    expect(user).toMatchObject({ id: 'u1' })
    expect(member).toBeNull()
    expect(memberIsAdmin(member)).toBe(false)
    expect(memberSeesSales(member)).toBe(false)
  })

  it('bez sloupce (0069 nenasazena) se čte bez deactivated_at', async () => {
    state.columnMissing = true
    const { member } = await getCurrentMember()
    expect(member).toMatchObject({ role: 'vedeni' })
  })

  it('memberSeesSales: řádek s deactivated_at nikdy nevidí obchod', () => {
    expect(memberSeesSales({ role: 'vedeni', deactivated_at: DEACT })).toBe(false)
    expect(memberSeesSales({ role: 'vedeni', deactivated_at: null })).toBe(true)
    expect(memberSeesSales({ role: 'vedeni' })).toBe(true)
  })
})
