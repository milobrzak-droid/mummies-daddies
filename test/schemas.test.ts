import { expect, test } from 'vitest'
import {
  accountSchema, dealSchema, salesActivitySchema, teamRole,
  entityId, companyAliasSchema, companyRelationshipSchema,
} from '@/lib/validation/schemas'

test('accountSchema requires a name', () => {
  const r = accountSchema.safeParse({ name: '' })
  expect(r.success).toBe(false)
})
test('accountSchema coerces ms_licenses and defaults booleans', () => {
  const r = accountSchema.parse({ name: 'X', ms_licenses: '50' })
  expect(r.ms_licenses).toBe(50)
  expect(r.is_reference).toBe(false)
})
test('accountSchema treats empty optional strings as null', () => {
  const r = accountSchema.parse({ name: 'X', industry: '' })
  expect(r.industry).toBeNull()
})

test('sales role includes obchodnik', () => {
  expect(teamRole.parse('obchodnik')).toBe('obchodnik')
})

test('lost deal requires a reason', () => {
  const r = dealSchema.safeParse({
    account_id: 1,
    title: 'Lost',
    revenue_line: 'svatebni_hostina',
    stage: 'prohráno',
  })
  expect(r.success).toBe(false)
})

test('sales activity requires an account and subject', () => {
  const r = salesActivitySchema.safeParse({
    account_id: 1,
    kind: 'call',
    outcome: 'completed',
    subject: 'Discovery call',
    occurred_at: '2026-08-19T10:00',
  })
  expect(r.success).toBe(true)
})

// --- id, alias a vztahy firem ---

test('entityId accepts positive safe integers only', () => {
  expect(entityId.safeParse(1).success).toBe(true)
  expect(entityId.safeParse(42).success).toBe(true)
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', '1) or (id.gt.0', null, undefined, {}]) {
    expect(entityId.safeParse(bad).success).toBe(false)
  }
})

test('companyRelationshipSchema requires a positive integer other_account_id', () => {
  expect(companyRelationshipSchema.safeParse({ direction: 'parent_of', other_account_id: '7' }).success).toBe(true)
  for (const bad of ['', '0', '-3', '1.5', 'abc', '7,child_account_id.eq.1']) {
    expect(companyRelationshipSchema.safeParse({ direction: 'parent_of', other_account_id: bad }).success).toBe(false)
  }
  expect(companyRelationshipSchema.safeParse({ direction: 'sibling', other_account_id: '7' }).success).toBe(false)
})

test('companyAliasSchema trims and lowercases domain and name', () => {
  const r = companyAliasSchema.parse({ alias_domain: '  Firma.CZ ', alias_name: '  ACME s.r.o.  ' })
  expect(r).toEqual({ alias_domain: 'firma.cz', alias_name: 'acme s.r.o.' })
})

test('companyAliasSchema turns empty and whitespace-only values into null', () => {
  const r = companyAliasSchema.parse({ alias_domain: '   ', alias_name: 'Acme' })
  expect(r).toEqual({ alias_domain: null, alias_name: 'acme' })
})

test('companyAliasSchema needs at least one value', () => {
  expect(companyAliasSchema.safeParse({ alias_domain: '', alias_name: '   ' }).success).toBe(false)
  expect(companyAliasSchema.safeParse({}).success).toBe(false)
})

test('companyAliasSchema enforces length limits (domain 253, name 200)', () => {
  expect(companyAliasSchema.safeParse({ alias_domain: 'a'.repeat(253) }).success).toBe(true)
  expect(companyAliasSchema.safeParse({ alias_domain: 'a'.repeat(254) }).success).toBe(false)
  expect(companyAliasSchema.safeParse({ alias_name: 'a'.repeat(200) }).success).toBe(true)
  expect(companyAliasSchema.safeParse({ alias_name: 'a'.repeat(201) }).success).toBe(false)
})

test('companyAliasSchema limits apply after trimming', () => {
  expect(companyAliasSchema.safeParse({ alias_name: ` ${'a'.repeat(200)} ` }).success).toBe(true)
})
