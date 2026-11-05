import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CHANGES_VISIT_GAP_MINUTES } from '@/domain/crm/changes'

// 0075_changes_view.sql: statické kontroly bez databáze. Pravidlo návštěvy
// a oprávnění drží SQL a TS ručně synchronně, tenhle test je porovnává.

const raw = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0075_changes_view.sql'), 'utf8')
const flat = raw.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ')

describe('0075 changes_view', () => {
  test('hlavička je česky a vysvětluje, proč tabulka a ne sloupec v team_member', () => {
    expect(raw.split('\n')[0]).toMatch(/^-- 0075 — /)
    expect(raw).toMatch(/team_member/)
  })

  test('mezera návštěvy v SQL je stejná jako v TS', () => {
    expect(flat).toContain(`interval '${CHANGES_VISIT_GAP_MINUTES} minutes'`)
  })

  test('jeden řádek na člena týmu; odchod člena řádek smaže; baseline nikdy po last_open', () => {
    expect(flat).toContain('member_id uuid PRIMARY KEY REFERENCES team_member(id) ON DELETE CASCADE')
    expect(flat).toContain('CHECK (baseline_at IS NULL OR baseline_at <= last_open_at)')
  })

  test('RLS: čtení jen vlastního řádku, žádná politika pro zápis, RESTRICTIVE AAL2, anon nic', () => {
    expect(flat).toContain('ALTER TABLE changes_view ENABLE ROW LEVEL SECURITY')
    expect(flat).toMatch(/CREATE POLICY changes_view_own_select ON changes_view FOR SELECT USING \(member_id = \(SELECT auth\.uid\(\)\) AND \(SELECT is_team_member\(\)\)\)/)
    const policies = flat.match(/CREATE POLICY \w+ ON changes_view [^;]*;/g) ?? []
    expect(policies).toHaveLength(2)
    expect(policies.filter((p) => !/AS RESTRICTIVE/.test(p))).toHaveLength(1)
    expect(policies.filter((p) => /FOR (INSERT|UPDATE|DELETE|ALL)/.test(p) && !/AS RESTRICTIVE/.test(p))).toEqual([])
    expect(flat).toMatch(/CREATE POLICY require_aal2 ON changes_view AS RESTRICTIVE FOR ALL USING \(\(SELECT auth\.jwt\(\) ->> 'aal'\) = 'aal2'\)/)
    expect(flat).toContain('REVOKE ALL ON changes_view FROM anon')
    expect(flat).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON changes_view FROM authenticated')
    expect(flat).toContain('GRANT SELECT ON changes_view TO authenticated')
  })

  test('každá CREATE POLICY má předem DROP POLICY IF EXISTS (idempotence)', () => {
    for (const m of flat.matchAll(/CREATE POLICY (\w+) ON (\w+)/g)) {
      const at = flat.search(new RegExp(`DROP POLICY IF EXISTS ${m[1]} ON ${m[2]};`))
      expect(at, m[1]).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThan(m.index!)
    }
  })

  test('touch_changes_view: SECURITY DEFINER s pevným search_path, aktér z auth.uid(), AAL2 a člen týmu, jen authenticated', () => {
    expect(flat).toMatch(/FUNCTION touch_changes_view\(\) RETURNS TABLE \([^)]*\) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp/)
    expect(flat).toContain('v_uid uuid := auth.uid()')
    expect(flat).toContain("coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'")
    expect(flat).toContain('SELECT 1 FROM team_member tm WHERE tm.id = v_uid')
    expect(flat).toContain('REVOKE ALL ON FUNCTION touch_changes_view() FROM PUBLIC, anon')
    expect(flat).toContain('GRANT EXECUTE ON FUNCTION touch_changes_view() TO authenticated')
    // Funkce nemá parametr: nikdo jí nemůže podstrčit cizí uživatele ani vlastní mezeru návštěvy.
    expect(flat).toMatch(/FUNCTION touch_changes_view\(\)/)
  })

  test('zápis se týká jen řádku volajícího: baseline dostane PŘEDCHOZÍ otevření', () => {
    expect(flat).toContain('VALUES (v_uid, NULL, now())')
    expect(flat).toMatch(/ON CONFLICT \(member_id\) DO UPDATE SET baseline_at = CASE WHEN now\(\) - cv\.last_open_at > interval '240 minutes' THEN cv\.last_open_at ELSE cv\.baseline_at END, last_open_at = now\(\)/)
    expect(flat).not.toMatch(/UPDATE changes_view/)
  })

  test('guard na prerekvizity a ledger s verzí 0075', () => {
    expect(flat).toContain("to_regclass('public.team_member')")
    expect(flat).toContain("to_regprocedure('public.is_team_member()')")
    expect(flat).toContain("to_regclass('public.schema_migration')")
    expect(flat).toMatch(/INSERT INTO schema_migration \(version, note\) VALUES \('0075',[^;]*ON CONFLICT \(version\) DO NOTHING;/)
  })

  test('číslo 0075 nikdo jiný nepoužívá a navazuje na 0074', () => {
    const files = readdirSync(join(__dirname, '..', 'supabase', 'migrations')).filter((f: string) => f.startsWith('007'))
    expect(files.filter((f: string) => f.startsWith('0075'))).toEqual(['0075_changes_view.sql'])
    expect(files.some((f: string) => f.startsWith('0074'))).toBe(true)
  })
})
