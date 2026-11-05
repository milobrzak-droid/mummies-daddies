import { expect, test } from 'vitest'
import {
  contactDeletedAuditBefore,
  salesActivityRedactedAudit,
  taskDeletedAuditBefore,
} from '@/domain/crm/auditPayload'

test('contact.deleted keeps only account_id, had_email and the scrub flag', () => {
  const out = contactDeletedAuditBefore({ email: 'jan.novak@firma.cz', account_id: 7 })
  expect(out).toEqual({ account_id: 7, had_email: true, pii_scrubbed: true })
})

test('contact.deleted never leaks name, email or role', () => {
  const out = contactDeletedAuditBefore({
    email: 'jan.novak@firma.cz',
    account_id: 7,
    // @ts-expect-error extra osobní pole se nesmí propsat
    full_name: 'Jan Novák',
    role: 'paní Dvořáková',
  })
  const json = JSON.stringify(out)
  expect(json).not.toContain('Novák')
  expect(json).not.toContain('jan.novak')
  expect(json).not.toContain('Dvořákov')
})

test('partner contact (no account_id) and blank e-mail match the 0037 shape', () => {
  expect(contactDeletedAuditBefore({ email: '   ' })).toEqual({ account_id: null, had_email: false, pii_scrubbed: true })
  expect(contactDeletedAuditBefore({ email: null, account_id: null })).toEqual({ account_id: null, had_email: false, pii_scrubbed: true })
})

test('sales_activity.redacted stores only presence flags and lengths', () => {
  const out = salesActivityRedactedAudit({ subject: 'Hovor s Janem', body: 'Jan Novák volal' })
  expect(out).toEqual({ had_subject: true, had_body: true, subject_length: 13, body_length: 15, pii_scrubbed: true })
  expect(JSON.stringify(out)).not.toContain('Jan')
})

test('null texts give false flags and zero lengths', () => {
  expect(salesActivityRedactedAudit({ subject: null, body: null })).toEqual({
    had_subject: false, had_body: false, subject_length: 0, body_length: 0, pii_scrubbed: true,
  })
})

test('length counts code points like Postgres char_length', () => {
  expect(salesActivityRedactedAudit({ subject: '😀😀', body: 'ěšč' }).subject_length).toBe(2)
  expect(salesActivityRedactedAudit({ subject: '😀😀', body: 'ěšč' }).body_length).toBe(3)
})

test('task.deleted drops the free-text title', () => {
  const out = taskDeletedAuditBefore({ status: 'open', assignee_id: 'u-1' })
  expect(out).toEqual({ status: 'open', assignee_id: 'u-1', pii_scrubbed: true })
})
