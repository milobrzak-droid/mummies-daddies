// Statická kontrola migrací 0078 (meeting_note_intake) a 0079 (api_key.scope
// 'intake') a jejich shody s kódem — bez databáze. Obecné konvence
// (číslování, RLS + AAL2, search_path, ledger) hlídá test/migrations-lint.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { DB_AUDITED_TABLES, NEVER_SAFE_COLUMNS } from '@/core/auditCoverage'
import { normalizeScope } from '@/lib/apiKeyAuth'
import {
  MEETING_NOTE_ACTIONS_MAX,
  MEETING_NOTE_BODY_MAX,
  MEETING_NOTE_HINT_MAX,
  MEETING_NOTE_SOURCE,
  MEETING_NOTE_TITLE_MAX,
  NOTE_MATCH_METHODS,
} from '@/domain/crm/meetingIntake'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const sql78 = strip(readFileSync('supabase/migrations/0078_meeting_note_intake.sql', 'utf8'))
const sql79 = strip(readFileSync('supabase/migrations/0079_api_key_scope_intake.sql', 'utf8'))

describe('0078 — meeting_note_intake', () => {
  test('guard je první příkaz a jmenuje závislosti', () => {
    expect(sql78.trim().startsWith('DO $$')).toBe(true)
    for (const dep of ['0067_case_proposal.sql', '0064_audit_coverage.sql', '0020_core_sales_crm.sql', '0026_migration_ledger.sql']) {
      expect(sql78).toContain(dep)
    }
  })

  test('idempotentní: tabulka, indexy, politiky i trigger se dají pustit znovu', () => {
    expect(sql78).toMatch(/CREATE TABLE IF NOT EXISTS meeting_note_intake/)
    const indexes = [...sql78.matchAll(/CREATE (?:UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?(\w+)/g)]
    expect(indexes.length).toBeGreaterThan(0)
    for (const idx of indexes) expect(idx[1], idx[2]).toBeTruthy()
    for (const p of ['meeting_note_intake_read', 'sales_only', 'require_aal2']) {
      expect(sql78).toContain(`DROP POLICY IF EXISTS ${p} ON meeting_note_intake;`)
    }
    expect(sql78).toContain('DROP TRIGGER IF EXISTS audit_row_change ON meeting_note_intake;')
    expect(sql78).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
    expect(sql78).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0078'/)
  })

  test('RLS: čtení jen tým, RESTRICTIVE sales_only = can_see_sales a AAL2, klient nezapíše nic', () => {
    expect(sql78).toMatch(/ALTER TABLE meeting_note_intake ENABLE ROW LEVEL SECURITY/)
    expect(sql78).toMatch(/CREATE POLICY meeting_note_intake_read ON meeting_note_intake\s+FOR SELECT USING \(\(SELECT is_team_member\(\)\)\)/)
    expect(sql78).toMatch(
      /CREATE POLICY sales_only ON meeting_note_intake\s+AS RESTRICTIVE FOR ALL\s+USING \(\(SELECT can_see_sales\(\)\)\)\s+WITH CHECK \(\(SELECT can_see_sales\(\)\)\)/,
    )
    expect(sql78).toMatch(/CREATE POLICY require_aal2 ON meeting_note_intake\s+AS RESTRICTIVE FOR ALL[\s\S]*?aal2/)
    // žádná permisivní politika pro zápis
    expect(sql78).not.toMatch(/CREATE POLICY \w+ ON meeting_note_intake\s+FOR (INSERT|UPDATE|DELETE|ALL)/)
    expect(sql78).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON meeting_note_intake FROM authenticated/)
    expect(sql78).toMatch(/GRANT SELECT ON meeting_note_intake TO authenticated/)
    expect(sql78).toMatch(/REVOKE ALL ON meeting_note_intake FROM PUBLIC, anon/)
    expect(sql78).toMatch(/GRANT USAGE ON SEQUENCE meeting_note_intake_id_seq TO service_role/)
  })

  test('meze sloupců a hodnoty sedí s TypeScriptem', () => {
    expect(sql78).toContain(`char_length(body) BETWEEN 1 AND ${MEETING_NOTE_BODY_MAX}`)
    expect(sql78).toContain(`char_length(title) BETWEEN 1 AND ${MEETING_NOTE_TITLE_MAX}`)
    expect(sql78).toContain(`char_length(client_hint) BETWEEN 1 AND ${MEETING_NOTE_HINT_MAX}`)
    expect(sql78).toContain(`jsonb_array_length(actions) <= ${MEETING_NOTE_ACTIONS_MAX}`)
    expect(sql78).toMatch(new RegExp(`source\\s+text NOT NULL DEFAULT '${MEETING_NOTE_SOURCE}'`))
    const methods = /match_method IN \(([^)]*)\)/.exec(sql78)![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1))
    expect(methods).toEqual([...NOTE_MATCH_METHODS, 'manual'])
    const statuses = /status IN \(([^)]*)\)/.exec(sql78)![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1))
    expect(statuses).toEqual(['unmatched', 'assigned', 'discarded'])
  })

  test('text drží jen čekající řádek: přiřazený i zahozený je bez textu (CHECK v DB)', () => {
    const check = /CONSTRAINT meeting_note_intake_state_consistent CHECK \(([\s\S]*?)\n  \),/.exec(sql78)![1]
    const branches = check.split(/\n\s*OR \(/)
    expect(branches).toHaveLength(3)
    const [unmatched, assigned, discarded] = branches
    expect(unmatched).toMatch(/status = 'unmatched'[\s\S]*body IS NOT NULL[\s\S]*account_id IS NULL/)
    for (const b of [assigned, discarded]) {
      expect(b).toMatch(/body IS NULL AND title IS NULL AND client_hint IS NULL AND actions = '\[\]'::jsonb/)
      expect(b).toMatch(/decided_at IS NOT NULL AND decided_by IS NOT NULL/)
    }
    expect(assigned).toMatch(/account_id IS NOT NULL AND match_method IS NOT NULL/)
    expect(discarded).toMatch(/account_id IS NULL/)
  })

  test('idempotence příjmu: unikátní klíč, vazby na aktivitu a návrh nesmažou zápis', () => {
    expect(sql78).toMatch(/CONSTRAINT meeting_note_intake_dedupe_unique UNIQUE \(dedupe_key\)/)
    expect(sql78).toMatch(/activity_id\s+bigint REFERENCES sales_activity\(id\) ON DELETE SET NULL/)
    expect(sql78).toMatch(/proposal_id\s+bigint REFERENCES case_proposal\(id\) ON DELETE SET NULL/)
    expect(sql78).toMatch(/account_id\s+bigint REFERENCES account\(id\) ON DELETE CASCADE/)
  })

  test('audit trigger sedí s DB_AUDITED_TABLES a do auditu nejde text ani nápověda', () => {
    const m = /CREATE TRIGGER audit_row_change\s+AFTER INSERT OR UPDATE OR DELETE ON meeting_note_intake\s+FOR EACH ROW EXECUTE FUNCTION audit_row_change\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/.exec(sql78)
    expect(m).not.toBeNull()
    const cfg = DB_AUDITED_TABLES.meeting_note_intake
    expect(m![1].split(',')).toEqual([...cfg.safe])
    expect(m![2]).toBe('')
    expect(m![3]).toBe('')
    for (const c of ['title', 'body', 'client_hint', 'actions', 'dedupe_key']) expect(cfg.safe).not.toContain(c)
    for (const c of cfg.safe) expect(NEVER_SAFE_COLUMNS, c).not.toContain(c)
  })
})

describe('0079 — api_key.scope intake', () => {
  test('CHECK povoluje přesně to, co kód zná', () => {
    const values = /CHECK \(scope IN \(([^)]*)\)\)/.exec(sql79)![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1))
    expect(values).toEqual(['read', 'full', 'intake'])
    for (const v of values) expect(normalizeScope(v)).toBe(v)
  })

  test('guard, idempotence a ledger', () => {
    expect(sql79.trim().startsWith('DO $$')).toBe(true)
    expect(sql79).toContain('0043_api_key_scope.sql')
    // přepisuje jen constraint, který ještě 'intake' nezná
    expect(sql79).toContain("v_def NOT LIKE '%intake%'")
    expect(sql79).toMatch(/DROP CONSTRAINT IF EXISTS api_key_scope_check/)
    expect(sql79).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0079'[\s\S]*ON CONFLICT \(version\) DO NOTHING;\s*$/)
  })

  test('nemění výchozí hodnotu ani data stávajících klíčů', () => {
    expect(sql79).not.toMatch(/UPDATE api_key/i)
    expect(sql79).not.toMatch(/SET DEFAULT/i)
    expect(sql79).not.toMatch(/DROP COLUMN|DELETE FROM/i)
  })
})
