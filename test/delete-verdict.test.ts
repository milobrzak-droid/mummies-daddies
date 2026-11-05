import { expect, test } from 'vitest'
import { judgeSingleRowDelete } from '@/domain/crm/deleteVerdict'

test('exactly one deleted row is a success', () => {
  expect(judgeSingleRowDelete(null, [{ id: 1 }])).toEqual({ ok: true })
})

test('a database error is a failure even if rows are present', () => {
  expect(judgeSingleRowDelete({ message: 'fk violation' }, [{ id: 1 }])).toEqual({ ok: false, reason: 'db_error' })
})

test('zero deleted rows (RLS / AAL1 silently blocks) is a failure', () => {
  expect(judgeSingleRowDelete(null, [])).toEqual({ ok: false, reason: 'not_deleted' })
})

test('null or undefined data without error is treated as nothing deleted', () => {
  expect(judgeSingleRowDelete(null, null)).toEqual({ ok: false, reason: 'not_deleted' })
  expect(judgeSingleRowDelete(null, undefined)).toEqual({ ok: false, reason: 'not_deleted' })
})

test('more than one deleted row is an unexpected count, not a success', () => {
  expect(judgeSingleRowDelete(null, [{ id: 1 }, { id: 2 }])).toEqual({ ok: false, reason: 'unexpected_count' })
})
