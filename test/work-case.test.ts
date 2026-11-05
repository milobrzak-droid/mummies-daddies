import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  CASE_STATUSES,
  NODES,
  STEP_STATUSES,
  assertCaseTransition,
  assertStepTransition,
  canCloseCase,
  canTransitionCase,
  canTransitionStep,
  caseCloseIssues,
  isCaseStatus,
  isNode,
  isStepStatus,
  isTerminalCase,
  isTerminalStep,
  nextCaseStatuses,
  nextStepStatuses,
  ownershipIssues,
  type CaseStatus,
  type StepStatus,
} from '@/core/workCase'

const sql = readFileSync('supabase/migrations/0039_loop_core.sql', 'utf8')

function checkValues(name: string): string[] {
  const m = sql.match(new RegExp(`CONSTRAINT ${name}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)`))
  if (!m) throw new Error(`CHECK ${name} nenalezen`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

describe('synchronizace s migrací 0039', () => {
  test('uzly', () => expect(checkValues('work_case_node_check')).toEqual([...NODES]))
  test('stavy případu', () => expect(checkValues('work_case_status_check')).toEqual([...CASE_STATUSES]))
  test('stavy kroku', () => expect(checkValues('case_step_status_check')).toEqual([...STEP_STATUSES]))
  test('uzly v loop_node sedí s NODES', () => expect(checkValues('loop_node_node_check')).toEqual([...NODES]))
  test('seed loop_node pokrývá všechny uzly', () => {
    const m = sql.match(/FROM \(VALUES ([^;]*?)\) AS n\(node\)/)
    expect(m).not.toBeNull()
    expect([...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])).toEqual([...NODES])
  })
  test('migrace nezakládá případy ani členy týmu', () => {
    expect(sql).not.toMatch(/INSERT INTO (work_case|team_member)/)
  })
  test('vlastník a zástupce jsou nullable', () => {
    expect(sql).toMatch(/lead_owner_id\s+uuid REFERENCES/)
    expect(sql).toMatch(/deputy_id\s+uuid REFERENCES/)
    expect(sql).not.toMatch(/lead_owner_id\s+uuid NOT NULL/)
  })
})

describe('guardy', () => {
  test('isNode', () => {
    expect(isNode('obchod')).toBe(true)
    expect(isNode('obchod_x')).toBe(false)
    expect(isNode(null)).toBe(false)
  })
  test('isCaseStatus / isStepStatus', () => {
    expect(isCaseStatus('waiting')).toBe(true)
    expect(isCaseStatus('todo')).toBe(false)
    expect(isStepStatus('todo')).toBe(true)
    expect(isStepStatus(3)).toBe(false)
  })
})

describe('přechody případu', () => {
  const allowed: [CaseStatus, CaseStatus][] = [
    ['open', 'in_progress'], ['open', 'waiting'], ['open', 'cancelled'],
    ['in_progress', 'waiting'], ['in_progress', 'done'], ['in_progress', 'cancelled'],
    ['waiting', 'in_progress'], ['waiting', 'cancelled'],
  ]
  test('úplná matice odpovídá seznamu povolených', () => {
    for (const from of CASE_STATUSES) {
      for (const to of CASE_STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to)
        expect(canTransitionCase(from, to), `${from}→${to}`).toBe(expected)
      }
    }
  })
  test('open → done je zakázané', () => expect(canTransitionCase('open', 'done')).toBe(false))
  test('done a cancelled jsou konečné', () => {
    expect(isTerminalCase('done')).toBe(true)
    expect(isTerminalCase('cancelled')).toBe(true)
    expect(nextCaseStatuses('done')).toEqual([])
    expect(isTerminalCase('waiting')).toBe(false)
  })
  test('assert hází na zakázaný přechod', () => {
    expect(() => assertCaseTransition('done', 'open')).toThrow(/done → open/)
    expect(() => assertCaseTransition('open', 'in_progress')).not.toThrow()
  })
  test('sám na sebe nejde', () => {
    for (const s of CASE_STATUSES) expect(canTransitionCase(s, s)).toBe(false)
  })
})

describe('přechody kroku', () => {
  const allowed: [StepStatus, StepStatus][] = [
    ['todo', 'doing'], ['todo', 'blocked'], ['todo', 'skipped'],
    ['doing', 'todo'], ['doing', 'blocked'], ['doing', 'done'],
    ['blocked', 'doing'], ['blocked', 'skipped'],
  ]
  test('úplná matice', () => {
    for (const from of STEP_STATUSES) {
      for (const to of STEP_STATUSES) {
        const expected = allowed.some(([a, b]) => a === from && b === to)
        expect(canTransitionStep(from, to), `${from}→${to}`).toBe(expected)
      }
    }
  })
  test('todo → done přeskočením práce nejde', () => expect(canTransitionStep('todo', 'done')).toBe(false))
  test('konečné stavy', () => {
    expect(isTerminalStep('done')).toBe(true)
    expect(isTerminalStep('skipped')).toBe(true)
    expect(nextStepStatuses('skipped')).toEqual([])
    expect(isTerminalStep('blocked')).toBe(false)
  })
  test('assert', () => {
    expect(() => assertStepTransition('done', 'doing')).toThrow()
    expect(() => assertStepTransition('blocked', 'doing')).not.toThrow()
  })
})

describe('uzavření případu', () => {
  test('in_progress se všemi kroky hotovými lze zavřít', () => {
    expect(canCloseCase('in_progress', [{ status: 'done' }, { status: 'skipped' }])).toBe(true)
  })
  test('in_progress bez kroků lze zavřít', () => {
    expect(canCloseCase('in_progress', [])).toBe(true)
  })
  test('rozpracovaný krok brání', () => {
    expect(caseCloseIssues('in_progress', [{ status: 'done' }, { status: 'blocked' }])).toEqual([
      'nedokončené kroky: 1',
    ])
  })
  test('samé skipped není hotový výsledek', () => {
    expect(caseCloseIssues('in_progress', [{ status: 'skipped' }])).toEqual(['žádný krok není done'])
  })
  test('ze stavu open nebo waiting nejde', () => {
    expect(canCloseCase('open', [])).toBe(false)
    expect(canCloseCase('waiting', [{ status: 'done' }])).toBe(false)
  })
  test('víc důvodů najednou', () => {
    expect(caseCloseIssues('cancelled', [{ status: 'todo' }])).toHaveLength(3)
  })
})

describe('vlastnictví', () => {
  test('oba null je v pořádku (případ bez vlastníka)', () => {
    expect(ownershipIssues(null, null)).toEqual([])
  })
  test('různé osoby OK, stejná osoba ne', () => {
    expect(ownershipIssues('a', 'b')).toEqual([])
    expect(ownershipIssues('a', 'a')).toEqual(['zástupce nesmí být vlastník'])
    expect(ownershipIssues(null, 'a')).toEqual([])
  })
})
