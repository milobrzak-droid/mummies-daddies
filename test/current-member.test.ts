import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import { CURRENT_MEMBER_COLUMNS, memberIsAdmin, memberSeesSales } from '@/lib/queries/currentMember'
import { seesByznys } from '@/lib/domain'

describe('memberIsAdmin', () => {
  test('only truthy is_admin counts', () => {
    expect(memberIsAdmin({ is_admin: true })).toBe(true)
    expect(memberIsAdmin({ is_admin: false })).toBe(false)
    expect(memberIsAdmin({ is_admin: null })).toBe(false)
    expect(memberIsAdmin(null)).toBe(false)
    expect(memberIsAdmin(undefined)).toBe(false)
  })
})

describe('memberSeesSales', () => {
  test('delegates to seesByznys(role), unchanged rule', () => {
    for (const role of ['admin', 'obchod', 'projektak', 'lektor', 'partner', '', null]) {
      expect(memberSeesSales({ role })).toBe(seesByznys(role))
    }
    expect(memberSeesSales(null)).toBe(seesByznys(undefined))
  })
})

test('select covers every column the call sites read', () => {
  const cols = CURRENT_MEMBER_COLUMNS.split(',').map((c) => c.trim())
  expect(cols).toEqual(expect.arrayContaining(['full_name', 'is_admin', 'role']))
})
