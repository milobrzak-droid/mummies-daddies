// 0098_bulk_import.sql: statické kontroly (bez databáze) a vazby na kód.
// Chování ve skutečném Postgresu hlídá test/bulk-import-0098-pglite.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { SALES_ROLES } from '@/lib/apiKeyAuth'
import { CSV_COLUMNS, IMPORT_DB_MESSAGES, IMPORT_STAGE_DEAL, REVERT_REASON_LABEL, importStageProbability } from '@/domain/crm/bulkImport'
import { FINANCIAL_SOURCES } from '@/domain/finance/records'
import { DB_AUDITED_TABLES } from '@/core/auditCoverage'

const RAW = readFileSync('supabase/migrations/0098_bulk_import.sql', 'utf8')
const M0080 = readFileSync('supabase/migrations/0080_auto_delivery.sql', 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const SQL = strip(RAW)
const fnBody = (sql: string, name: string) => new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?\\n\\$\\$;|CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?END \\$\\$;`).exec(sql)![0]

describe('0098 — prerekvizity, ledger, idempotence', () => {
  test('guard je první příkaz a jmenuje migrace, na kterých stojí', () => {
    expect(SQL.trim().startsWith('DO $$')).toBe(true)
    for (const f of [
      '0001_base_schema.sql', '0002_auth_and_team.sql', '0063_financial_record.sql', '0072_deal_scope_version.sql',
      '0080_auto_delivery.sql', '0082_audit_gaps_partner_lockdown.sql', '0064_audit_coverage.sql', '0020_core_sales_crm.sql',
      '0026_migration_ledger.sql', '0028_audit_event.sql',
    ]) expect(SQL).toContain(f)
  })

  test('ledger nese 0098, bez vlastní transakce, opakovaný běh nic nezdvojí', () => {
    expect(SQL).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0098'/)
    expect(SQL).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
    expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im)
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS import_batch (')
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS import_batch_item (')
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS import_batch_id')
    expect(SQL).toContain('DROP TRIGGER IF EXISTS deal_import_guard ON deal;')
    expect(SQL).toContain('DROP TRIGGER IF EXISTS financial_record_import_guard ON financial_record;')
    expect(SQL).toContain('DROP TRIGGER IF EXISTS audit_row_change_soft ON import_batch;')
  })

  test('hlavička je česky a vysvětluje historické zakázky', () => {
    expect(RAW.split('\n')[0]).toMatch(/^-- 0098 — /)
    expect(RAW).toContain('HISTORICKÉ ZAKÁZKY')
    expect(RAW).toContain('Naplánovat realizaci')
  })
})

describe('0098 — oprávnění', () => {
  test.each([
    'import_open_batch(uuid, text, text)', 'import_apply_row(uuid, bigint, jsonb)', 'import_revert_batch(uuid, bigint)',
  ])('%s: jen service_role', (sig) => {
    expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`)
    expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`)
    expect(SQL).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${sig.replace(/[()]/g, '\\$&')} TO [^;]*authenticated`))
  })

  test('pomocné funkce a strážci nemají klientské EXECUTE', () => {
    for (const sig of ['import_actor_ok(uuid)', 'import_fk_refs(regclass, bigint, text[])', 'deal_import_guard()', 'financial_record_import_guard()']) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`)
    }
    expect(SQL).toContain('REVOKE ALL ON FUNCTION auto_delivery_create(bigint, date, text, text) FROM anon, authenticated;')
  })

  test('každá SECURITY DEFINER funkce má search_path', () => {
    for (const m of SQL.matchAll(/CREATE OR REPLACE FUNCTION (\w+)[\s\S]*?\$\$/g)) {
      if (/SECURITY DEFINER/.test(m[0])) expect(m[0], m[1]).toMatch(/SET search_path = public, pg_temp/)
    }
  })

  test('aktér musí být aktivní člen s obchodní rolí: seznam rolí == SALES_ROLES (can_see_sales)', () => {
    const actor = fnBody(SQL, 'import_actor_ok')
    const roles = [...actor.matchAll(/role::text IN \(([^)]*)\)/g)][0][1].match(/'(\w+)'/g)!.map((r) => r.slice(1, -1))
    expect([...roles].sort()).toEqual([...SALES_ROLES].sort())
    expect(actor).toContain('deactivated_at IS NULL')
    for (const name of ['import_open_batch', 'import_apply_row', 'import_revert_batch']) {
      expect(fnBody(SQL, name), name).toContain('NOT import_actor_ok(p_actor)')
    }
  })

  test('tabulky: RLS, RESTRICTIVE AAL2 a jen obchodní role, klient nezapisuje', () => {
    for (const t of ['import_batch', 'import_batch_item']) {
      expect(SQL).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`)
      expect(SQL).toMatch(new RegExp(`CREATE POLICY require_aal2 ON ${t}\\s+AS RESTRICTIVE FOR ALL`))
      expect(SQL).toMatch(new RegExp(`CREATE POLICY sales_only ON ${t}\\s+AS RESTRICTIVE FOR ALL\\s+USING \\(\\(SELECT can_see_sales\\(\\)\\)\\)`))
      expect(SQL).not.toMatch(new RegExp(`CREATE POLICY \\w+ ON ${t} FOR (INSERT|UPDATE|DELETE)`))
    }
    expect(SQL).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON import_batch, import_batch_item FROM authenticated;')
  })

  test('zápis původu a zdroje import chrání strážci s transakčním příznakem', () => {
    expect(fnBody(SQL, 'deal_import_guard')).toContain("current_setting('app.bulk_import', true)")
    expect(fnBody(SQL, 'financial_record_import_guard')).toContain("NEW.source = 'import'")
    expect(SQL).toMatch(/CREATE TRIGGER deal_import_guard\s+BEFORE INSERT OR UPDATE OF import_batch_id ON deal/)
    expect(SQL).toMatch(/CREATE TRIGGER financial_record_import_guard\s+BEFORE INSERT ON financial_record/)
  })
})

describe('0098 — vazby na kód', () => {
  test('zdroje finančních záznamů v CHECKu == FINANCIAL_SOURCES', () => {
    const m = /financial_record_source_check\s+CHECK \(source IN \(([^)]*)\)\)/.exec(SQL)!
    expect([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()).toEqual([...FINANCIAL_SOURCES].sort())
  })

  test('audit dávky: trigger == DB_AUDITED_TABLES.import_batch', () => {
    const m = /audit_row_change_soft\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/.exec(SQL.slice(SQL.indexOf('ON import_batch')))!
    expect(m[1].split(',').sort()).toEqual([...DB_AUDITED_TABLES.import_batch.safe].sort())
    expect(m[2]).toBe('')
    expect(DB_AUDITED_TABLES.import_batch.soft).toBe(true)
  })

  test('chybové kódy IM001–IM011 v SQL == překlady v kódu', () => {
    const inSql = [...new Set([...SQL.matchAll(/ERRCODE = '(IM\d{3})'/g)].map((m) => m[1]))].sort()
    expect(inSql).toEqual(Object.keys(IMPORT_DB_MESSAGES).sort())
  })

  test('důvody ponechání zakázky při vrácení v SQL == popisky v kódu', () => {
    const reasons = [...new Set([...fnBody(SQL, 'import_revert_batch').matchAll(/v_reason := '(\w+)'/g)].map((m) => m[1]))].sort()
    expect(reasons).toEqual(Object.keys(REVERT_REASON_LABEL).sort())
  })

  test('fáze a pravděpodobnost: import zapisuje fáze, které SQL zná, a vyhráno přes trigger', () => {
    expect(new Set(Object.values(IMPORT_STAGE_DEAL))).toEqual(new Set(['vyhráno', 'rozsah_nabidka', 'diagnostika']))
    const apply = fnBody(SQL, 'import_apply_row')
    expect(apply).toContain("v_stage NOT IN ('vyhráno', 'rozsah_nabidka', 'diagnostika')")
    // vyhráno se zapisuje přes UPDATE po přijaté verzi, ať dodávka dostane rozsah (0080)
    expect(apply).toMatch(/CASE WHEN v_stage = 'vyhráno' THEN 'rozsah_nabidka' ELSE v_stage END/)
    expect(apply).toMatch(/UPDATE deal\s+SET stage = 'vyhráno'/)
    expect(importStageProbability('won')).toBe(100)
    expect(apply).toContain('probability_pct = 100')
  })

  test('finance z importu: Nasmlouváno potvrzeno, Vyfakturováno a Přijato jen návrh, vždy zdroj import', () => {
    const apply = fnBody(SQL, 'import_apply_row')
    expect(apply).toMatch(/'contracted'[\s\S]*?'confirmed', 'import'/)
    expect(apply).toMatch(/'invoiced'[\s\S]*?'draft', 'import'/)
    expect(apply).toMatch(/'received'[\s\S]*?'draft', 'import'/)
    expect(apply).not.toMatch(/'(invoiced|received)'[\s\S]{0,300}'confirmed'/)
  })

  test('sloupce CSV jsou popsané v návodu', () => {
    const doc = readFileSync('docs/PROVOZ.md', 'utf8').replace(/\s+/g, ' ')
    for (const c of CSV_COLUMNS) expect(doc, c.header).toContain(c.header)
    for (const code of ['0098', 'Vrátit import', 'Naplánovat realizaci akce', 'ANTHROPIC_API_KEY']) expect(doc).toContain(code)
  })
})

describe('0098 — jádro dodávky nic z 0080 neubralo', () => {
  const core = (sql: string) => /CREATE OR REPLACE FUNCTION auto_delivery_create\([\s\S]*?\nEND \$\$;/.exec(sql)![0]
  const lines = (s: string) => strip(s).split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean)

  test('každý příkaz z 0080 je v nové verzi (jen přidané větve pro import)', () => {
    const now = new Set(lines(core(RAW)))
    const missing = lines(core(M0080)).filter((l) => !now.has(l))
    expect(missing).toEqual([])
  })

  test('historická zakázka: bez úkolu a aktivity, začátek z importu, jen když výhru zapisuje import', () => {
    const c = strip(core(RAW))
    expect(c).toContain("v_imported := v_deal.import_batch_id IS NOT NULL\n    AND coalesce(current_setting('app.bulk_import', true), '') = v_deal.import_batch_id::text;")
    expect(c).toContain('IF NOT v_imported THEN')
    expect(c).toMatch(/IF NOT v_imported THEN[\s\S]*INSERT INTO task[\s\S]*INSERT INTO sales_activity[\s\S]*END IF;/)
    expect(c).toContain("current_setting('app.bulk_import_started_on', true)")
    expect(c).toContain("'imported', v_imported")
  })
})
