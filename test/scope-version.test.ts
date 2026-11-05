import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, test } from 'vitest'
import {
  SCOPE_VERSION_DB_CODES,
  SCOPE_VERSION_STATUSES,
  SCOPE_VERSION_TRANSITIONS,
  canTransitionScopeVersion,
  draftDefaults,
  isScopeVersionMissing,
  latestVersion,
  nextVersionNumber,
  scopeVersionActions,
  scopeVersionDbMessage,
  scopeVersionSchema,
  versionFromOffer,
} from '@/domain/crm/scopeVersion'

// domain/crm/scopeVersion.ts — čistá logika verzí nabídky (0072).

const SQL = readFileSync(join(__dirname, '..', 'supabase/migrations/0072_deal_scope_version.sql'), 'utf8')

describe('přechody verzí', () => {
  test('tabulka přechodů je shodná s deal_scope_version_transition_ok v 0072', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION deal_scope_version_transition_ok'))
    const body = fn.slice(0, fn.indexOf('$$', fn.indexOf('$$') + 2))
    const sqlPairs = [...body.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort()
    const tsPairs = SCOPE_VERSION_STATUSES.flatMap((f) => SCOPE_VERSION_TRANSITIONS[f].map((t) => `${f}>${t}`)).sort()
    expect(sqlPairs).toEqual(tsPairs)
  })

  test('status CHECK v 0072 zná přesně stavy z TS', () => {
    const m = SQL.match(/status IN \(([^)]*)\)\)/)
    const sqlStatuses = [...(m?.[1] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1])
    expect(sqlStatuses).toEqual([...SCOPE_VERSION_STATUSES])
  })

  test('koncové stavy nikam nevedou, přijetí jen z odeslané', () => {
    expect(canTransitionScopeVersion('sent', 'accepted')).toBe(true)
    expect(canTransitionScopeVersion('draft', 'accepted')).toBe(false)
    expect(canTransitionScopeVersion('rejected', 'sent')).toBe(false)
    expect(canTransitionScopeVersion('superseded', 'accepted')).toBe(false)
  })

  test('akce v UI', () => {
    expect(scopeVersionActions('draft')).toEqual(['send'])
    expect(scopeVersionActions('sent')).toEqual(['accept', 'reject'])
    expect(scopeVersionActions('accepted')).toEqual([])
    expect(scopeVersionActions('superseded')).toEqual([])
  })

  test('každý SQLSTATE strážce z 0072 má českou větu', () => {
    const codes = [...new Set([...SQL.matchAll(/ERRCODE = '(SV\d{3})'/g)].map((m) => m[1]))].sort()
    expect(codes.every((c) => c in SCOPE_VERSION_DB_CODES)).toBe(true)
    expect(scopeVersionDbMessage({ code: 'SV002' })).toMatch(/novou verzi/)
    expect(scopeVersionDbMessage({ code: '23505' })).toBeNull()
    expect(scopeVersionDbMessage(null)).toBeNull()
  })
})

describe('číslování a návrh nové verze', () => {
  test('další číslo = max + 1, prázdno = 1', () => {
    expect(nextVersionNumber([])).toBe(1)
    expect(nextVersionNumber([{ version: 2 }, { version: 5 }, { version: 3 }])).toBe(6)
    expect(latestVersion([{ version: 2 }, { version: 5 }])?.version).toBe(5)
    expect(latestVersion([])).toBeNull()
  })

  const deal = { currency: 'CZK', amount_one_time: '120000', amount_one_time_original: null, expected_mrr: '5000', fx_rate: null }

  test('kopie z poslední verze', () => {
    expect(draftDefaults({ scope: 'Workshop', amount_one_time: '90000.00', expected_mrr: '0', currency: 'EUR' }, deal))
      .toEqual({ scope: 'Workshop', amount_one_time: 90000, expected_mrr: 0, currency: 'EUR' })
  })

  test('bez verze z částek obchodu (CZK i EUR v původní měně)', () => {
    expect(draftDefaults(null, deal)).toEqual({ scope: '', amount_one_time: 120000, expected_mrr: 5000, currency: 'CZK' })
    expect(draftDefaults(null, { currency: 'EUR', amount_one_time: 250000, amount_one_time_original: 10000, expected_mrr: 2500, fx_rate: 25 }))
      .toEqual({ scope: '', amount_one_time: 10000, expected_mrr: 100, currency: 'EUR' })
  })

  test('verze 1 z importu PDF je odeslaná, v měně nabídky', () => {
    expect(versionFromOffer({ title: 'AI audit', amount_one_time: 70000, currency: 'EUR' }))
      .toEqual({ version: 1, status: 'sent', scope: 'AI audit', amount_one_time: 70000, expected_mrr: 0, currency: 'EUR' })
    expect(versionFromOffer({ title: 'X', amount_one_time: null, currency: 'CZK' }).amount_one_time).toBe(0)
  })
})

describe('formulář verze', () => {
  test('platný vstup, prázdná částka = 0, čárka jako desetinná tečka', () => {
    const r = scopeVersionSchema.safeParse({ scope: '  Rozsah  ', amount_one_time: '1 500,5', expected_mrr: '', currency: 'CZK' })
    expect(r.success && r.data).toEqual({ scope: 'Rozsah', amount_one_time: 1500.5, expected_mrr: 0, currency: 'CZK' })
  })

  test('chyby', () => {
    expect(scopeVersionSchema.safeParse({ scope: '', amount_one_time: '1', expected_mrr: '0', currency: 'CZK' }).success).toBe(false)
    expect(scopeVersionSchema.safeParse({ scope: 'a', amount_one_time: '-1', expected_mrr: '0', currency: 'CZK' }).success).toBe(false)
    expect(scopeVersionSchema.safeParse({ scope: 'a', amount_one_time: 'abc', expected_mrr: '0', currency: 'CZK' }).success).toBe(false)
    expect(scopeVersionSchema.safeParse({ scope: 'a', amount_one_time: '1', expected_mrr: '0', currency: 'USD' }).success).toBe(false)
  })
})

test('chybějící tabulka / RPC = čeká na migraci', () => {
  expect(isScopeVersionMissing({ code: '42P01' })).toBe(true)
  expect(isScopeVersionMissing({ code: 'PGRST205' })).toBe(true)
  expect(isScopeVersionMissing({ code: 'PGRST202' })).toBe(true)
  expect(isScopeVersionMissing({ code: '23505' })).toBe(false)
  expect(isScopeVersionMissing(null)).toBe(false)
})

describe('migrace 0072', () => {
  test('RLS: RESTRICTIVE AAL2 i sales_only s (SELECT can_see_sales())', () => {
    expect(SQL).toMatch(/ENABLE ROW LEVEL SECURITY/)
    expect(SQL).toMatch(/CREATE POLICY sales_only ON deal_scope_version\s+AS RESTRICTIVE FOR ALL\s+USING \(\(SELECT can_see_sales\(\)\)\)/)
    expect(SQL).toMatch(/CREATE POLICY require_aal2 ON deal_scope_version\s+AS RESTRICTIVE/)
  })

  test('nejvýš jedna přijatá verze na obchod', () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON deal_scope_version \(deal_id\) WHERE status = 'accepted'/)
  })

  test('přijetí mění obchod běžným UPDATE (audit trigger 0034/0035), ne SECURITY DEFINER', () => {
    const fn = SQL.slice(SQL.indexOf('FUNCTION accept_deal_scope_version'))
    expect(fn).toMatch(/SECURITY INVOKER/)
    expect(fn).toMatch(/UPDATE deal\s+SET currency/)
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION accept_deal_scope_version\(bigint, bigint, numeric\) FROM PUBLIC, anon/)
  })
})

describe('0072: přijetí jen přes RPC', () => {
  it('strážce vyžaduje příznak, který nastavuje jen accept_deal_scope_version', () => {
    const guard = SQL.slice(SQL.indexOf('FUNCTION deal_scope_version_guard()'), SQL.indexOf('CREATE TRIGGER deal_scope_version_guard'))
    expect(guard).toMatch(/current_setting\('app\.scope_version_accept', true\)/)
    expect(guard).toMatch(/NEW\.status = 'accepted' OR OLD\.status = 'accepted'/)
    const rpc = SQL.slice(SQL.indexOf('FUNCTION accept_deal_scope_version('))
    const setIdx = rpc.indexOf("set_config('app.scope_version_accept', v_ver.deal_id::text, true)")
    expect(setIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeLessThan(rpc.indexOf("SET status = 'accepted'"))
  })
})
