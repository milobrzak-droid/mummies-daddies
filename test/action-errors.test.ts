import { afterEach, expect, test, vi } from 'vitest'
import {
  dbErrorMessage,
  DUPLICATE_ACTION_ERROR,
  GENERIC_ACTION_ERROR,
  REFERENCE_ACTION_ERROR,
} from '@/lib/actionResult'

afterEach(() => vi.restoreAllMocks())

function silence() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

test('generická chyba neprozradí detail z databáze, ale zaloguje ho', () => {
  const spy = silence()
  const msg = dbErrorMessage('action.contacts', {
    code: '42501',
    message: 'permission denied for table contact',
  })
  expect(msg).toBe(GENERIC_ACTION_ERROR)
  expect(msg).not.toMatch(/contact|permission/)
  expect(spy).toHaveBeenCalledOnce()
  expect(String(spy.mock.calls[0][0])).toContain('permission denied for table contact')
})

test('23505 → hláška o duplicitě bez názvu constraintu', () => {
  silence()
  const msg = dbErrorMessage('x', { code: '23505', message: 'duplicate key value violates unique constraint "contact_email_key"' })
  expect(msg).toBe(DUPLICATE_ACTION_ERROR)
  expect(msg).not.toContain('contact_email_key')
})

test('23503 → hláška o návaznosti', () => {
  silence()
  expect(dbErrorMessage('x', { code: '23503', message: 'violates foreign key constraint "task_account_id_fkey"' })).toBe(REFERENCE_ACTION_ERROR)
})

test('ne-objektové chyby spadnou na obecnou hlášku', () => {
  silence()
  expect(dbErrorMessage('x', null)).toBe(GENERIC_ACTION_ERROR)
  expect(dbErrorMessage('x', 'boom')).toBe(GENERIC_ACTION_ERROR)
})
