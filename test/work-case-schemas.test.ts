import { describe, expect, test } from 'vitest'
import { NODES } from '@/core/workCase'
import {
  ACTIVE_CASE_STATUSES, approvalStatusLabel, caseStatusLabel, nodeLabel, NODE_LABELS, stepStatusLabel,
} from '@/core/workCaseFlow'
import {
  addStepSchema, caseStatusSchema, createCaseSchema, decideApprovalSchema, recordDecisionSchema,
  requestApprovalSchema, resolveDecisionSchema, stepStatusSchema,
} from '@/core/workCaseSchemas'

// Vstupy formulářů pracovních případů (core/workCaseSchemas.ts) a popisky
// stavů (core/workCaseFlow.ts). Hodnoty přicházejí z FormData jako řetězce.

const UUID = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'

describe('popisky', () => {
  test('známé hodnoty česky, neznámé beze změny (UI nespadne na nové hodnotě z DB)', () => {
    expect(nodeLabel(NODES[0])).toBe(NODE_LABELS[NODES[0]])
    expect(nodeLabel('neznamy_uzel')).toBe('neznamy_uzel')
    expect(caseStatusLabel('waiting')).toBe('Čeká')
    expect(caseStatusLabel('archived')).toBe('archived')
    expect(stepStatusLabel('blocked')).toBe('Blokováno')
    expect(stepStatusLabel('x')).toBe('x')
    expect(approvalStatusLabel('expired')).toBe('Vypršelo')
    expect(approvalStatusLabel('')).toBe('')
  })
  test('aktivní stavy = vše kromě done/cancelled', () => {
    expect([...ACTIVE_CASE_STATUSES].sort()).toEqual(['in_progress', 'open', 'waiting'])
  })
})

describe('createCaseSchema', () => {
  test('prázdná volitelná pole = null, id z řetězce', () => {
    const r = createCaseSchema.parse({ title: ' Nový klient ', node: NODES[0], account_id: '12', deal_id: '', lead_owner_id: '  ', template: '' })
    expect(r).toEqual({ title: 'Nový klient', node: NODES[0], account_id: 12, deal_id: null, lead_owner_id: null, template: null })
  })
  test('chybějící volitelná pole mají výchozí null', () => {
    expect(createCaseSchema.parse({ title: 'x', node: NODES[0] })).toMatchObject({ account_id: null, deal_id: null, lead_owner_id: null, template: null })
  })
  test('neznámý uzel, prázdný název, špatné UUID nebo nekladné id neprojde', () => {
    expect(createCaseSchema.safeParse({ title: 'x', node: 'marketing' }).error?.issues[0].message).toBe('Vyberte uzel.')
    expect(createCaseSchema.safeParse({ title: '   ', node: NODES[0] }).error?.issues[0].message).toBe('Vyplňte název.')
    expect(createCaseSchema.safeParse({ title: 'x'.repeat(301), node: NODES[0] }).success).toBe(false)
    expect(createCaseSchema.safeParse({ title: 'x', node: NODES[0], lead_owner_id: 'user-1' }).success).toBe(false)
    expect(createCaseSchema.safeParse({ title: 'x', node: NODES[0], lead_owner_id: UUID }).success).toBe(true)
    expect(createCaseSchema.safeParse({ title: 'x', node: NODES[0], account_id: '0' }).success).toBe(false)
    expect(createCaseSchema.safeParse({ title: 'x', node: NODES[0], account_id: '-3' }).success).toBe(false)
    expect(createCaseSchema.safeParse({ title: 'x', node: NODES[0], template: 'x'.repeat(65) }).success).toBe(false)
  })
})

describe('kroky a stavy', () => {
  test('addStepSchema vyžaduje kladné case_id a název', () => {
    expect(addStepSchema.parse({ case_id: '5', title: 'Krok' })).toEqual({ case_id: 5, title: 'Krok' })
    expect(addStepSchema.safeParse({ case_id: 'abc', title: 'Krok' }).success).toBe(false)
    expect(addStepSchema.safeParse({ case_id: '5', title: '' }).success).toBe(false)
  })
  test('stavy kroku a případu jen z číselníku', () => {
    expect(stepStatusSchema.safeParse({ step_id: '1', to: 'done' }).success).toBe(true)
    expect(stepStatusSchema.safeParse({ step_id: '1', to: 'cancelled' }).success).toBe(false)
    expect(caseStatusSchema.safeParse({ case_id: '1', to: 'cancelled' }).success).toBe(true)
    expect(caseStatusSchema.safeParse({ case_id: '1', to: 'blocked' }).success).toBe(false)
  })
})

describe('requestApprovalSchema', () => {
  test('action_kind: snake_case od písmene, max 64 znaků', () => {
    expect(requestApprovalSchema.safeParse({ case_id: '1', action_kind: 'external_commitment' }).success).toBe(true)
    expect(requestApprovalSchema.safeParse({ case_id: '1', action_kind: 'a'.repeat(64) }).success).toBe(true)
    for (const bad of ['a'.repeat(65), '1abc', 'External', 'drop table', 'x-y', '']) {
      expect(requestApprovalSchema.safeParse({ case_id: '1', action_kind: bad }).success, bad).toBe(false)
    }
  })
  test('expires_on: prázdné = bez platnosti, jinak ISO datum', () => {
    expect(requestApprovalSchema.parse({ case_id: '1', action_kind: 'x', expires_on: '' }).expires_on).toBeNull()
    expect(requestApprovalSchema.parse({ case_id: '1', action_kind: 'x', expires_on: '2026-09-30' }).expires_on).toBe('2026-09-30')
    expect(requestApprovalSchema.safeParse({ case_id: '1', action_kind: 'x', expires_on: '30. 9. 2026' }).error?.issues[0].message).toBe('Neplatné datum.')
    expect(requestApprovalSchema.safeParse({ case_id: '1', action_kind: 'x', expires_on: '2026-02-30' }).success).toBe(false)
  })
})

describe('rozhodnutí a schválení', () => {
  test('recordDecisionSchema: otázka povinná, možnosti výchozí prázdné', () => {
    expect(recordDecisionSchema.parse({ case_id: '1', question: 'Kdo?' }).options).toBe('')
    expect(recordDecisionSchema.safeParse({ case_id: '1', question: ' ' }).error?.issues[0].message).toBe('Vyplňte otázku.')
    expect(recordDecisionSchema.safeParse({ case_id: '1', question: 'x'.repeat(1001) }).success).toBe(false)
    expect(recordDecisionSchema.safeParse({ case_id: '1', question: 'x', options: 'o'.repeat(2001) }).success).toBe(false)
  })
  test('resolveDecisionSchema: zvolená možnost povinná', () => {
    expect(resolveDecisionSchema.safeParse({ decision_id: '2', chosen: '' }).error?.issues[0].message).toBe('Vyberte možnost.')
    expect(resolveDecisionSchema.parse({ decision_id: '2', chosen: ' A ' }).chosen).toBe('A')
  })
  test('decideApprovalSchema: approve jen 1/0, prázdná poznámka = null', () => {
    expect(decideApprovalSchema.parse({ request_id: '3', approve: '1', note: '' })).toEqual({ request_id: 3, approve: '1', note: null })
    expect(decideApprovalSchema.parse({ request_id: '3', approve: '0', note: ' ok ' }).note).toBe('ok')
    for (const bad of ['true', 'yes', '', '2']) {
      expect(decideApprovalSchema.safeParse({ request_id: '3', approve: bad }).success, bad).toBe(false)
    }
    expect(decideApprovalSchema.safeParse({ request_id: '3', approve: '1', note: 'x'.repeat(2001) }).success).toBe(false)
  })
})
