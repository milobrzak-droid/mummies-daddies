import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { INDUSTRY_SEPARATOR } from '@/domain/crm/accountList'

// Statická kontrola 0068 (bez databáze): idempotence, žádné CONCURRENTLY
// (migrace běží v transakci), pg_trgm jen s guardem, pohled se
// security_invoker, shoda oddělovače oboru s TS a ledger.

const raw = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0068_account_indexes.sql'), 'utf8')
const sql = raw.replace(/--[^\n]*/g, '')

describe('0068_account_indexes.sql', () => {
  test('hlavička česky, proč', () => {
    expect(raw.split('\n')[0]).toMatch(/^-- 0068 — /)
    expect(raw).toContain('PROČ')
  })

  test('guard na předpoklady (account, sloupce z 0011/0030, ledger)', () => {
    expect(sql).toMatch(/to_regclass\('public\.account'\) IS NULL/)
    expect(sql).toMatch(/to_regclass\('public\.schema_migration'\) IS NULL/)
    expect(sql).toContain("'last_inbound_at', 'last_outbound_at'")
    expect(sql).toMatch(/RAISE EXCEPTION '0068 vyžaduje/)
  })

  test('indexy idempotentně, bez CONCURRENTLY a bez vlastní transakce', () => {
    const creates = [...sql.matchAll(/CREATE\s+INDEX\b[^;]*/gi)].map((m) => m[0])
    expect(creates.length).toBeGreaterThanOrEqual(6)
    for (const c of creates) expect(c).toMatch(/IF NOT EXISTS/i)
    expect(sql).not.toMatch(/CONCURRENTLY/i)
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im)
    for (const name of [
      'account_name_id_idx', 'account_industry_pattern_idx', 'account_region_idx',
      'account_owner_id_idx', 'account_client_since_idx', 'account_last_contact_idx',
    ]) expect(sql).toContain(name)
  })

  test('pg_trgm: jen když je nainstalované, rozšíření sama nezapíná', () => {
    expect(sql).not.toMatch(/CREATE\s+EXTENSION/i)
    expect(sql).toMatch(/FROM pg_extension e[\s\S]*extname = 'pg_trgm'/)
    expect(sql).toMatch(/IF v_schema IS NULL THEN[\s\S]*RETURN;/)
    expect(sql).toMatch(/gin_trgm_ops/)
  })

  test('pohled faset: security_invoker, anon bez přístupu, stejný oddělovač oboru jako TS', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW v_account_list_facets\s+WITH \(security_invoker = on\)/)
    expect(sql).toMatch(/ALTER VIEW v_account_list_facets SET \(security_invoker = on\)/)
    expect(sql).toMatch(/REVOKE ALL ON v_account_list_facets FROM anon/)
    expect(sql).toContain(`split_part(a.industry, '${INDUSTRY_SEPARATOR}', 1)`)
    expect(sql).toContain("ico IS NULL OR ico = ''")
  })

  test('last_contact_at(account): SECURITY INVOKER, inlinovatelná, bez anon', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.last_contact_at\(a public\.account\)/)
    expect(sql).not.toMatch(/SECURITY DEFINER/i)
    expect(sql).toMatch(/GREATEST\(a\.last_inbound_at, a\.last_outbound_at\)/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.last_contact_at\(public\.account\) FROM anon/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.last_contact_at\(public\.account\) TO authenticated/)
  })

  test("zapisuje '0068' do schema_migration s ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s*VALUES \('0068',[^;]*ON CONFLICT \(version\) DO NOTHING;/)
  })
})
