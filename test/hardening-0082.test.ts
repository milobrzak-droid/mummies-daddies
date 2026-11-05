// Role Partner (0082): SQL allowlist == INTERNAL_ROLES, brána requireUser,
// vlastník API klíče a obrazovka „bez přístupu“. Skutečné chování RLS ověřuje
// test/audit-0082-pglite.test.ts.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AUDIT_ACTOR_HEADER, AUDIT_ACTOR_RE } from '@/core/auditCoverage'
import { INTERNAL_ROLES, TEAM_ROLES, isInternalRole } from '@/lib/domain'

const sql = readFileSync('supabase/migrations/0082_audit_gaps_partner_lockdown.sql', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

const state = { user: { id: 'u1' } as { id: string } | null, role: 'partner' as string | null, memberError: null as unknown, aal: 'aal2' }
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal }, error: null }) },
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.role === null ? null : { role: state.role }, error: state.memberError }) }) }),
    }),
  }),
}))
vi.mock('@/lib/auth/mfa', () => ({ mfaEnforced: () => true }))

import { requireUser, tryRequireUser } from '@/lib/auth/requireUser'
import { loadKeyOwner } from '@/lib/apiKeyAuth'

beforeEach(() => {
  state.user = { id: 'u1' }
  state.role = 'partner'
  state.memberError = null
  state.aal = 'aal2'
})

describe('allowlist interních rolí', () => {
  test('is_team_member() a is_admin() v 0082 stojí na stejném seznamu jako INTERNAL_ROLES', () => {
    const lists = [...sql.matchAll(/role::text IN \(([^)]*)\)/g)].map((m) => m[1].match(/'(\w+)'/g)!.map((x) => x.slice(1, -1)))
    expect(lists).toHaveLength(2)
    for (const l of lists) expect(l).toEqual([...INTERNAL_ROLES])
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION is_team_member\(\)/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION is_admin\(\)/)
  })

  test('každá role z TEAM_ROLES kromě partnera je interní; partner a neznámé ne', () => {
    for (const r of TEAM_ROLES) expect(isInternalRole(r.key), r.key).toBe(r.key !== 'partner')
    expect(isInternalRole('partner')).toBe(false)
    expect(isInternalRole('nova_role')).toBe(false)
    expect(isInternalRole(null)).toBe(false)
    expect(isInternalRole(undefined)).toBe(false)
  })

  test('vlastní řádek team_member se čte přes team_self_read (jen SELECT, jen id = auth.uid())', () => {
    expect(sql).toMatch(/CREATE POLICY team_self_read ON team_member FOR SELECT USING \(id = auth\.uid\(\)\);/)
    expect(sql).not.toMatch(/CREATE POLICY team_self ON team_member/)
  })
})

describe('requireUser: role', () => {
  test('Partner neprojde (ani bez aal2), interní role ano', async () => {
    await expect(requireUser()).rejects.toThrow()
    await expect(requireUser({ aal2: true })).rejects.toThrow()
    for (const role of INTERNAL_ROLES) {
      state.role = role
      await expect(requireUser({ aal2: true })).resolves.toMatchObject({ id: 'u1' })
    }
  })

  test('fail closed: bez řádku člena, s chybou dotazu, s neznámou rolí, bez uživatele', async () => {
    state.role = null
    expect(await tryRequireUser()).toBeNull()
    state.role = 'vedeni'
    state.memberError = { message: 'boom' }
    expect(await tryRequireUser()).toBeNull()
    state.memberError = null
    state.role = 'nova_role'
    expect(await tryRequireUser()).toBeNull()
    state.role = 'vedeni'
    state.user = null
    expect(await tryRequireUser()).toBeNull()
  })

  test('allowExternal pustí Partnera jen ke správě vlastního účtu, aal2 dál platí', async () => {
    await expect(requireUser({ allowExternal: true })).resolves.toMatchObject({ id: 'u1' })
    state.aal = 'aal1'
    await expect(requireUser({ aal2: true, allowExternal: true })).rejects.toThrow()
  })

  test('allowExternal používá jen správa vlastního účtu (2FA, heslo, jméno)', () => {
    for (const f of ['lib/actions/mfa.ts', 'lib/actions/security.ts']) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/allowExternal: true/)
    }
    // Kopie názvu hlavičky v lib/actions/team.ts (lib/ nesmí importovat core/).
    const team = readFileSync('lib/actions/team.ts', 'utf8')
    expect(team).toContain(`const AUDIT_ACTOR_HEADER = '${AUDIT_ACTOR_HEADER}'`)
    expect(team).toContain('`user:${userId}`')
    expect(AUDIT_ACTOR_RE.test('user:11111111-1111-4111-8111-111111111111')).toBe(true)
    const users = ['lib/actions/team.ts', 'lib/actions/apiKeys.ts', 'lib/actions/oauth.ts']
    for (const f of users) expect(readFileSync(f, 'utf8'), f).not.toMatch(/allowExternal/)
  })
})

describe('klíč API vlastněný Partnerem', () => {
  const admin = (row: unknown) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
  }) as never
  test('aktivní a s obchody jen interní role; Partner neaktivní (API čte přes service role, RLS neplatí)', async () => {
    expect(await loadKeyOwner('u1', admin({ role: 'partner' }))).toEqual({ active: false, canSeeSales: false })
    expect(await loadKeyOwner('u1', admin({ role: 'projektak' }))).toEqual({ active: true, canSeeSales: false })
    expect(await loadKeyOwner('u1', admin({ role: 'obchodnik' }))).toEqual({ active: true, canSeeSales: true })
    expect(await loadKeyOwner('u1', admin({ role: 'vedeni', deactivated_at: '2026-01-01' }))).toEqual({ active: false, canSeeSales: false })
  })
})

describe('aplikace: layout', () => {
  test('layout pustí děti a menu jen interní roli, jinak „Bez přístupu“', () => {
    const src = readFileSync('app/cockpit/layout.tsx', 'utf8')
    expect(src).toContain('isInternalRole(member?.role)')
    expect(src.indexOf('Bez přístupu')).toBeLessThan(src.indexOf('<Sidebar'))
    expect(src.indexOf('isInternalRole')).toBeLessThan(src.indexOf('{children}'))
  })
})
