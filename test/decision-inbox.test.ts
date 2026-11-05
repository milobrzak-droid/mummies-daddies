import { describe, expect, test, vi } from 'vitest'
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
import { createClient } from '@/lib/supabase/server'
import { countPendingProposals, getDecisionInbox, isMissingRelation, shapeApprovals, shapeDecisions, type RawApproval } from '@/core/loopQueries'
import { createSupabaseFake } from './helpers/supabaseFake'

const now = new Date('2026-09-28T12:00:00Z')
const a = (id: number, created_at: string, expires_at: string | null = null): RawApproval => ({
  id, action_kind: 'external_commitment', requested_level: 'L2', requested_by: 'x', created_at, expires_at, case_title: null,
})

describe('decision inbox shaping', () => {
  test('approvals oldest first, age in days, expired flagged', () => {
    const out = shapeApprovals(
      [a(1, '2026-09-27T12:00:00Z', '2026-09-28T11:00:00Z'), a(2, '2026-09-20T12:00:00Z', '2026-10-01T00:00:00Z'), a(3, '2026-09-28T10:00:00Z')],
      now,
    )
    expect(out.map((r) => r.id)).toEqual([2, 1, 3])
    expect(out.map((r) => r.ageDays)).toEqual([8, 1, 0])
    expect(out.map((r) => r.expired)).toEqual([false, true, false])
  })

  test('decisions oldest first, options normalized', () => {
    const out = shapeDecisions(
      [
        { id: 1, question: 'Q1', options: ['a', { k: 1 }], created_at: '2026-09-28T00:00:00Z', case_title: 'C', evidence_link: 'https://x' },
        { id: 2, question: 'Q2', options: null, created_at: '2026-09-01T00:00:00Z', case_title: null, evidence_link: null },
      ],
      now,
    )
    expect(out.map((r) => r.id)).toEqual([2, 1])
    expect(out[1].options).toEqual(['a', '{"k":1}'])
    expect(out[0].options).toEqual([])
  })

  test('missing relation detection', () => {
    expect(isMissingRelation({ code: '42P01' })).toBe(true)
    expect(isMissingRelation({ code: 'PGRST205' })).toBe(true)
    expect(isMissingRelation({ message: 'relation "public.decision" does not exist' })).toBe(true)
    expect(isMissingRelation({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isMissingRelation(null)).toBe(false)
  })
})

describe('předaný klient (provozní přehled pro cron)', () => {
  test('getDecisionInbox a countPendingProposals čtou přes předaného klienta, ne přes session', async () => {
    const fake = createSupabaseFake({
      resolve: (c) => (c.table === 'approval_request'
        ? { data: [{ id: 7, case_id: 3, node: null, action_kind: 'external_commitment', requested_level: 'L2', requested_by: 'user:x', created_at: '2026-09-27T12:00:00Z', expires_at: null, work_case: { title: 'Závazek pro ALFATECH', node: null } }], error: null }
        : c.table === 'case_proposal' ? { data: null, error: null, count: 4 } : { data: [], error: null }),
    })
    const inbox = await getDecisionInbox(now, fake.client as never)
    expect(createClient).not.toHaveBeenCalled()
    expect(inbox.state).toBe('ok')
    if (inbox.state !== 'ok') return
    expect(inbox.approvals).toEqual([expect.objectContaining({ id: 7, case_title: 'Závazek pro ALFATECH', ageDays: 1, expired: false })])
    expect(await countPendingProposals(fake.client as never)).toBe(4)
    expect(fake.calls.map((c) => c.table)).toEqual(['approval_request', 'decision', 'case_proposal'])
  })
})
