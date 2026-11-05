import { expect, test } from 'vitest'
import { isStale, type ConnectorState } from '@/core/connectorState'

function stateAt(hoursAgo: number, overrides: Partial<ConnectorState> = {}): ConnectorState {
  const lastSuccessAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString()
  return {
    connector: 'graph_calendar',
    cursor: null,
    last_success_at: lastSuccessAt,
    last_error: null,
    last_error_at: null,
    consecutive_errors: 0,
    updated_at: lastSuccessAt,
    ...overrides,
  }
}

test('a connector that has never run (null state) is stale', () => {
  expect(isStale(null, 24)).toBe(true)
})

test('a fresh success well inside the window is not stale', () => {
  expect(isStale(stateAt(1), 24)).toBe(false)
})

test('a success older than maxAgeHours is stale', () => {
  expect(isStale(stateAt(25), 24)).toBe(true)
})

test('3 consecutive errors are stale even with a recent last_success_at', () => {
  // Tři chyby v řadě znamenají rozbitý konektor, i kdyby mezitím jednou
  // náhodou uspěl před chvílí — consecutive_errors má vyhrát nad čerstvostí.
  const state = stateAt(0.1, { consecutive_errors: 3 })
  expect(isStale(state, 24)).toBe(true)
})

test('more than 3 consecutive errors are also stale', () => {
  const state = stateAt(0.1, { consecutive_errors: 5 })
  expect(isStale(state, 24)).toBe(true)
})

test('2 consecutive errors with a recent success are not stale', () => {
  // Pod prahem 3 chyby čerstvost nepřebíjejí.
  const state = stateAt(0.1, { consecutive_errors: 2 })
  expect(isStale(state, 24)).toBe(false)
})

test('čas lze předat: zastaralost nezávisí na skutečných hodinách', () => {
  const s = stateAt(0, { last_success_at: '2026-09-29T05:00:00.000Z' })
  expect(isStale(s, 24, Date.parse('2026-09-29T08:00:00.000Z'))).toBe(false)
  expect(isStale(s, 24, Date.parse('2026-09-30T08:00:00.000Z'))).toBe(true)
})
