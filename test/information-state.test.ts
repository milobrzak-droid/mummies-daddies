import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  INFORMATION_STATES,
  EVIDENCE_KINDS,
  assertTransition,
  canTransition,
  evidenceRefIssues,
  isInformationState,
  isValidEvidenceRef,
  nextStates,
  stateRequiresEvidence,
  type InformationState,
} from '@/core/informationState'

describe('přechody stavů údaje', () => {
  test('ai_suggestion se smí stát human_confirmed', () => {
    expect(canTransition('ai_suggestion', 'human_confirmed')).toBe(true)
  })

  test('ai_suggestion se nikdy potichu nestane source_fact ani actual_result', () => {
    expect(canTransition('ai_suggestion', 'source_fact')).toBe(false)
    expect(canTransition('ai_suggestion', 'actual_result')).toBe(false)
  })

  test('human_confirmed se nevrací na ai_suggestion ani source_fact', () => {
    expect(canTransition('human_confirmed', 'ai_suggestion')).toBe(false)
    expect(canTransition('human_confirmed', 'source_fact')).toBe(false)
  })

  test('human_confirmed → actual_result je povolené, actual_result je konečný', () => {
    expect(canTransition('human_confirmed', 'actual_result')).toBe(true)
    expect(nextStates('actual_result')).toEqual([])
    for (const to of INFORMATION_STATES) expect(canTransition('actual_result', to)).toBe(false)
  })

  test('source_fact lze potvrdit, ale ne degradovat na návrh ani přeskočit potvrzení', () => {
    expect(canTransition('source_fact', 'human_confirmed')).toBe(true)
    expect(canTransition('source_fact', 'ai_suggestion')).toBe(false)
    expect(canTransition('source_fact', 'actual_result')).toBe(false)
  })

  test('stejný stav není přechod', () => {
    for (const s of INFORMATION_STATES) expect(canTransition(s, s)).toBe(false)
  })

  test('assertTransition vyhodí na zakázaném přechodu a mlčí na povoleném', () => {
    expect(() => assertTransition('ai_suggestion', 'human_confirmed')).not.toThrow()
    expect(() => assertTransition('ai_suggestion', 'source_fact')).toThrow(/ai_suggestion -> source_fact/)
  })

  test('nextStates je konzistentní s canTransition', () => {
    for (const from of INFORMATION_STATES) {
      const allowed = nextStates(from)
      for (const to of INFORMATION_STATES) {
        expect(allowed.includes(to)).toBe(canTransition(from, to))
      }
    }
  })

  test('isInformationState přijímá jen čtyři hodnoty', () => {
    for (const s of INFORMATION_STATES) expect(isInformationState(s)).toBe(true)
    expect(isInformationState('confirmed')).toBe(false)
    expect(isInformationState(null)).toBe(false)
    expect(isInformationState(1)).toBe(false)
  })

  test('evidenci vyžaduje source_fact a actual_result', () => {
    const expected: Record<InformationState, boolean> = {
      source_fact: true,
      ai_suggestion: false,
      human_confirmed: false,
      actual_result: true,
    }
    for (const s of INFORMATION_STATES) expect(stateRequiresEvidence(s)).toBe(expected[s])
  })

  test('seznam stavů sedí s CHECKem v migraci 0038', () => {
    const sql = readFileSync('supabase/migrations/0038_evidence.sql', 'utf8')
    const m = sql.match(/info_state IN\s*\(([^)]*)\)/)
    expect(m).not.toBeNull()
    const inSql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    expect(inSql).toEqual([...INFORMATION_STATES].sort())
  })

  test('druhy zdroje sedí s CHECKem v migraci 0038', () => {
    const sql = readFileSync('supabase/migrations/0038_evidence.sql', 'utf8')
    const m = sql.match(/source_kind IN\s*\(([^)]*)\)/)
    expect(m).not.toBeNull()
    const inSql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    expect(inSql).toEqual([...EVIDENCE_KINDS].sort())
  })
})

describe('odkaz na zdroj (evidence)', () => {
  test('platný odkaz bez webLinku i s webLinkem', () => {
    expect(isValidEvidenceRef({ kind: 'email_message', sourceId: 'AAMkAD...' })).toBe(true)
    expect(
      isValidEvidenceRef({ kind: 'meeting', sourceId: '01ABC', webLink: 'https://app.fireflies.ai/view/x' }),
    ).toBe(true)
  })

  test('prázdné a příliš dlouhé sourceId se odmítne (ukazatel, ne obsah)', () => {
    expect(evidenceRefIssues({ kind: 'file', sourceId: '   ' })).toHaveLength(1)
    expect(evidenceRefIssues({ kind: 'file', sourceId: 'x'.repeat(513) })).toHaveLength(1)
    expect(isValidEvidenceRef({ kind: 'file', sourceId: 'x'.repeat(512) })).toBe(true)
  })

  test('webLink musí být https a omezené délky', () => {
    expect(isValidEvidenceRef({ kind: 'url', sourceId: 'u', webLink: 'http://example.com' })).toBe(false)
    expect(isValidEvidenceRef({ kind: 'url', sourceId: 'u', webLink: 'javascript:alert(1)' })).toBe(false)
    expect(isValidEvidenceRef({ kind: 'url', sourceId: 'u', webLink: 'https://a.cz/' + 'x'.repeat(2048) })).toBe(false)
    expect(isValidEvidenceRef({ kind: 'url', sourceId: 'u', webLink: null })).toBe(true)
  })

  test('neznámý druh zdroje se odmítne', () => {
    expect(isValidEvidenceRef({ kind: 'sms' as never, sourceId: 'x' })).toBe(false)
  })
})
