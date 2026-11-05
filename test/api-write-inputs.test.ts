import { beforeEach, describe, expect, test, vi } from 'vitest'

// Vstupy zápisových nástrojů pro Cowork/MCP (domain/crm/apiWrite.ts) a jejich
// chybové cesty. Supabase admin je mockovaný — žádná síť, žádná DB.

type Result = { data: unknown; error: unknown }
const calls: { table: string; method: string; args: unknown[] }[] = []
let nextResult: Result = { data: null, error: null }

function chain(table: string) {
  const q: Record<string, unknown> = {}
  for (const m of ['insert', 'update', 'select', 'eq']) {
    q[m] = (...args: unknown[]) => { calls.push({ table, method: m, args }); return q }
  }
  q.single = async () => nextResult
  q.maybeSingle = async () => nextResult
  return q
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/evidence', () => ({ recordAuditWithEvidence: vi.fn() }))

import { activityInput, createTask, nextStepInput, setNextStep, taskInput } from '@/domain/crm/apiWrite'
import { GENERIC_ACTION_ERROR } from '@/lib/actionResult'
import { EVIDENCE_SOURCE_ID_MAX } from '@/core/informationState'

beforeEach(() => {
  calls.length = 0
  nextResult = { data: null, error: null }
})

describe('activityInput', () => {
  test('výchozí kind/outcome a prázdná volitelná pole = null', () => {
    const r = activityInput.parse({ account_id: 3, subject: '  Telefonát  ' })
    expect(r.kind).toBe('note')
    expect(r.outcome).toBe('completed')
    expect(r.subject).toBe('Telefonát')
    expect(r.partner_id).toBeNull()
    expect(r.body).toBeNull()
    expect(r.source_url).toBeNull()
    expect(r.source_id).toBeNull()
  })

  test('právě jedno z account_id / partner_id', () => {
    expect(activityInput.safeParse({ partner_id: 2, subject: 'x' }).success).toBe(true)
    const both = activityInput.safeParse({ account_id: 1, partner_id: 2, subject: 'x' })
    expect(both.success).toBe(false)
    expect(both.error?.issues[0].message).toMatch(/právě jedno/)
    expect(activityInput.safeParse({ subject: 'x' }).success).toBe(false)
    expect(activityInput.safeParse({ account_id: null, partner_id: null, subject: 'x' }).success).toBe(false)
  })

  test('prázdný nebo bílý subject neprojde', () => {
    const r = activityInput.safeParse({ account_id: 1, subject: '   ' })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].message).toBe('subject je povinný')
  })

  test('neznámý kind / outcome a necelé id jsou odmítnuté', () => {
    expect(activityInput.safeParse({ account_id: 1, subject: 'x', kind: 'sms' }).success).toBe(false)
    expect(activityInput.safeParse({ account_id: 1, subject: 'x', outcome: 'won' }).success).toBe(false)
    expect(activityInput.safeParse({ account_id: 1.5, subject: 'x' }).success).toBe(false)
    expect(activityInput.safeParse({ account_id: '1', subject: 'x' }).success).toBe(false)
  })

  test('source_url jen z allow-listu, source_id s horní mezí', () => {
    const ok = activityInput.safeParse({
      account_id: 1, subject: 'x', kind: 'meeting',
      source_url: 'https://notes.wisprflow.ai/n/1', source_id: 'abc',
    })
    expect(ok.success).toBe(true)
    expect(activityInput.safeParse({ account_id: 1, subject: 'x', source_url: 'https://evil.example/n/1' }).success).toBe(false)
    expect(activityInput.safeParse({ account_id: 1, subject: 'x', source_id: 'a'.repeat(EVIDENCE_SOURCE_ID_MAX) }).success).toBe(true)
    expect(activityInput.safeParse({ account_id: 1, subject: 'x', source_id: 'a'.repeat(EVIDENCE_SOURCE_ID_MAX + 1) }).success).toBe(false)
  })
})

describe('nextStepInput a taskInput', () => {
  test('nextStepInput vyžaduje celočíselné deal_id; chybějící/null text = null', () => {
    expect(nextStepInput.safeParse({ next_step: 'x' }).success).toBe(false)
    expect(nextStepInput.safeParse({ deal_id: '5' }).success).toBe(false)
    const r = nextStepInput.parse({ deal_id: 5, next_step: null })
    expect(r).toEqual({ deal_id: 5, next_step: null, next_step_due: null })
  })

  test('bílý text se neukládá jako prázdný krok — vymazání jen přes null', () => {
    expect(nextStepInput.safeParse({ deal_id: 5, next_step: '   ' }).success).toBe(false)
  })

  test('taskInput: title povinný, priority výchozí normal, neznámá odmítnutá', () => {
    expect(taskInput.safeParse({ title: '' }).error?.issues[0].message).toBe('title je povinný')
    const r = taskInput.parse({ title: ' Zavolat ' })
    expect(r).toMatchObject({ title: 'Zavolat', priority: 'normal', account_id: null, assignee_id: null })
    expect(taskInput.safeParse({ title: 'x', priority: 'urgent' }).success).toBe(false)
  })
})

describe('setNextStep', () => {
  test('neplatný vstup → 400 bez dotazu do DB', async () => {
    const r = await setNextStep({ deal_id: 'abc' }, 'u1')
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(calls).toHaveLength(0)
  })

  test('mění jen next_step a next_step_due', async () => {
    nextResult = { data: { id: 5 }, error: null }
    const r = await setNextStep({ deal_id: 5, next_step: 'Poslat nabídku', next_step_due: '2026-10-01', stage: 'vyhráno', amount_one_time: 1 }, 'u1')
    expect(r).toEqual({ ok: true, data: { id: 5 } })
    const update = calls.find((c) => c.method === 'update')
    expect(update?.table).toBe('deal')
    expect(update?.args[0]).toEqual({ next_step: 'Poslat nabídku', next_step_due: '2026-10-01' })
    expect(calls.find((c) => c.method === 'eq')?.args).toEqual(['id', 5])
  })

  test('neexistující obchod → 404', async () => {
    nextResult = { data: null, error: null }
    expect(await setNextStep({ deal_id: 99 }, 'u1')).toEqual({ ok: false, status: 404, error: 'Obchod nenalezen.' })
  })

  test('chyba DB → 500 s obecnou hláškou (bez surového textu)', async () => {
    nextResult = { data: null, error: { code: 'XX000', message: 'relation "deal" secret detail' } }
    expect(await setNextStep({ deal_id: 1 }, 'u1')).toEqual({ ok: false, status: 500, error: GENERIC_ACTION_ERROR })
  })
})

describe('createTask', () => {
  test('neplatný vstup → 400 s první hláškou', async () => {
    expect(await createTask({ title: '' }, 'u1', true)).toEqual({ ok: false, status: 400, error: 'title je povinný' })
    expect(calls).toHaveLength(0)
  })

  test('vždy status todo a created_by od volajícího (nelze podstrčit)', async () => {
    nextResult = { data: { id: 8 }, error: null }
    const r = await createTask({ title: 'Úkol', status: 'done', created_by: 'someone-else' }, 'owner-1', true)
    expect(r).toEqual({ ok: true, data: { id: 8 } })
    const insert = calls.find((c) => c.method === 'insert')
    expect(insert?.table).toBe('task')
    expect(insert?.args[0]).toMatchObject({ title: 'Úkol', status: 'todo', created_by: 'owner-1' })
  })

  test('chyba DB → 500', async () => {
    nextResult = { data: null, error: { code: '23503' } }
    const r = await createTask({ title: 'x', account_id: 12345 }, null, true)
    expect(r).toMatchObject({ ok: false, status: 500 })
  })
})
