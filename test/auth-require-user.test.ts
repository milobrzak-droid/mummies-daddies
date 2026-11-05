import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getUser = vi.fn()
const getAAL = vi.fn()
// Řádek člena (0082: requireUser čte roli); výchozí = interní role.
let memberRole: string | null = 'vedeni'
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser, mfa: { getAuthenticatorAssuranceLevel: getAAL } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: memberRole === null ? null : { role: memberRole }, error: null }) }) }) }),
  }),
}))

import { requireUser, tryRequireUser, AuthError } from '@/lib/auth/requireUser'

const user = { id: 'u1' }

describe('requireUser', () => {
  beforeEach(() => { memberRole = 'vedeni'; getUser.mockReset(); getAAL.mockReset(); delete process.env.MFA_ENFORCED })
  afterEach(() => { delete process.env.MFA_ENFORCED })

  it('odmítne nepřihlášeného', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null })
    await expect(requireUser()).rejects.toBeInstanceOf(AuthError)
  })

  it('pustí AAL2', async () => {
    getUser.mockResolvedValue({ data: { user }, error: null })
    getAAL.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null })
    await expect(requireUser({ aal2: true })).resolves.toBe(user)
  })

  it('odmítne AAL1 při aal2', async () => {
    getUser.mockResolvedValue({ data: { user }, error: null })
    getAAL.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    await expect(requireUser({ aal2: true })).rejects.toBeInstanceOf(AuthError)
    expect(await tryRequireUser({ aal2: true })).toBeNull()
  })

  it('selže zavřeně při výjimce z AAL', async () => {
    getUser.mockResolvedValue({ data: { user }, error: null })
    getAAL.mockRejectedValue(new Error('network'))
    await expect(requireUser({ aal2: true })).rejects.toBeInstanceOf(AuthError)
  })

  it('MFA_ENFORCED=false vypne AAL2 kontrolu a varuje', async () => {
    process.env.MFA_ENFORCED = 'false'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getUser.mockResolvedValue({ data: { user }, error: null })
    await expect(requireUser({ aal2: true })).resolves.toBe(user)
    expect(getAAL).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
