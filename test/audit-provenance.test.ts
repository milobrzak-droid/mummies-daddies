import { beforeEach, expect, test, vi } from 'vitest'

const insert = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert }) }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { recordAudit } from '@/core/audit'
import { logError } from '@/lib/log'

const actor = { type: 'user' as const, id: 'u1' }

beforeEach(() => {
  insert.mockReset()
  insert.mockResolvedValue({ error: null })
  vi.mocked(logError).mockClear()
})

test('bez původu zůstává tvar insertu stejný jako dřív (žádné nové klíče)', async () => {
  await recordAudit('deal', 7, 'deal.stage_changed', { stage: 'a' }, { stage: 'b' }, actor)
  expect(insert).toHaveBeenCalledTimes(1)
  expect(insert.mock.calls[0][0]).toEqual({
    actor_type: 'user',
    actor_id: 'u1',
    action: 'deal.stage_changed',
    entity_table: 'deal',
    entity_id: 7,
    before: { stage: 'a' },
    after: { stage: 'b' },
  })
})

test('evidenceId a infoState se zapíšou do evidence_id a info_state', async () => {
  await recordAudit('deal', 7, 'deal.stage_changed', null, { stage: 'b' }, actor, {
    evidenceId: 42,
    infoState: 'human_confirmed',
  })
  expect(insert.mock.calls[0][0]).toMatchObject({ evidence_id: 42, info_state: 'human_confirmed' })
})

test('samotný infoState nepřidá evidence_id', async () => {
  await recordAudit('deal', 7, 'x', null, null, actor, { infoState: 'ai_suggestion' })
  const row = insert.mock.calls[0][0]
  expect(row.info_state).toBe('ai_suggestion')
  expect('evidence_id' in row).toBe(false)
})

test('neplatný infoState se vynechá, událost se zapíše a chyba se zaloguje', async () => {
  await recordAudit('deal', 7, 'x', null, null, actor, { infoState: 'nonsense' as never })
  const row = insert.mock.calls[0][0]
  expect('info_state' in row).toBe(false)
  expect(logError).toHaveBeenCalled()
})

test('selhání insertu dál jen loguje a nevyhazuje', async () => {
  insert.mockResolvedValue({ error: { message: 'boom' } })
  await expect(recordAudit('deal', 7, 'x', null, null, actor, { evidenceId: 1 })).resolves.toBeUndefined()
  expect(logError).toHaveBeenCalled()
})
