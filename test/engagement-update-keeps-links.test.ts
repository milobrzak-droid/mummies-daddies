import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { updateEngagement } from '@/domain/delivery/actions/engagements'
import { createSupabaseFake, opArgs } from './helpers/supabaseFake'

// Regrese: uložení formuláře „Údaje dodávky“ tiše mazalo vazbu na obchod
// (schválenou nabídku), a brány kvality nesmí zmizet, protože schéma chybějící pole
// změní na null/false a update posílal celý objekt.

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
})

describe('updateEngagement', () => {
  test('nezapisuje pole, která formulář neposlal (vazba na obchod)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await updateEngagement(1, 2, null, fd({ kind: 'copilot', phase: 'pilot', due_on: '2026-11-30' }))
    const call = fake.calls.find((c) => c.table === 'engagement')!
    const [payload] = opArgs(call, 'update') as [Record<string, unknown>]
    expect(payload).toMatchObject({ account_id: 1, kind: 'copilot', phase: 'pilot', due_on: '2026-11-30' })
    expect(payload).not.toHaveProperty('deal_id')
    // nezodpovězená brána zůstává „nehodnoceno“ (null), formulář je posílá vždy
    expect(payload.gate_outputs_captured).toBeNull()
  })

  test('nezaškrtnuté „hodné reference“ se zapíše jako false, prázdné číslo vymaže hodnotu', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await updateEngagement(1, 2, null, fd({ kind: 'copilot', phase: 'pilot', trained_count: '' }))
    const call = fake.calls.find((c) => c.table === 'engagement')!
    const [payload] = opArgs(call, 'update') as [Record<string, unknown>]
    expect(payload.reference_worthy).toBe(false)
    expect(payload.trained_count).toBeNull()
  })
})
