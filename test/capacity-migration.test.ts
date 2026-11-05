import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DEFAULT_WEEKLY_CAPACITY, MAX_WEEKLY_HOURS, NOTE_MAX, canSetCapacity } from '@/domain/delivery/capacity'

// 0062_capacity.sql a domain/delivery/capacity.ts drží stejná čísla a stejné
// pravidlo „kdo smí měnit kapacitu". Bez databáze: čteme text migrace
// (bez komentářů) a porovnáváme s TS konstantami.

const SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0062_capacity.sql'), 'utf8')
  .replace(/--[^\n]*/g, '')
const flat = SQL.replace(/\s+/g, ' ')

describe('0062_capacity.sql ↔ domain/delivery/capacity.ts', () => {
  test('výchozí a maximální kapacita', () => {
    expect(flat).toContain(`weekly_capacity_hours numeric(4,1) NOT NULL DEFAULT ${DEFAULT_WEEKLY_CAPACITY}`)
    expect(flat).toContain(`CHECK (weekly_capacity_hours >= 0 AND weekly_capacity_hours <= ${MAX_WEEKLY_HOURS})`)
    expect(flat).toContain(`IF v_hours < 0 OR v_hours > ${MAX_WEEKLY_HOURS} THEN`)
  })

  test('alokace: hodiny, období, jeden cíl, zástup ≠ člověk, poznámka', () => {
    expect(flat).toContain(`CHECK (hours_per_week > 0 AND hours_per_week <= ${MAX_WEEKLY_HOURS})`)
    expect(flat).toContain('CHECK (ends_on IS NULL OR ends_on >= starts_on)')
    expect(flat).toContain('CHECK (num_nonnulls(engagement_id, work_case_id) = 1)')
    expect(flat).toContain('CHECK (substitute_id IS NULL OR substitute_id <> member_id)')
    expect(flat).toContain(`CHECK (note IS NULL OR char_length(note) <= ${NOTE_MAX})`)
  })

  test('kaskády: člověk/dodávka/případ mažou alokaci, odchod zástupce jen vynuluje', () => {
    expect(flat).toContain('member_id uuid NOT NULL REFERENCES team_member(id) ON DELETE CASCADE')
    expect(flat).toContain('engagement_id bigint REFERENCES engagement(id) ON DELETE CASCADE')
    expect(flat).toContain('work_case_id bigint REFERENCES work_case(id) ON DELETE CASCADE')
    expect(flat).toContain('substitute_id uuid REFERENCES team_member(id) ON DELETE SET NULL')
  })

  test('autor z auth.uid(), RLS pro tým + RESTRICTIVE AAL2, anon bez přístupu', () => {
    expect(flat).toContain('created_by uuid DEFAULT auth.uid()')
    expect(flat).toContain('ALTER TABLE allocation ENABLE ROW LEVEL SECURITY')
    expect(flat).toMatch(/CREATE POLICY team_all ON allocation FOR ALL USING \(\(SELECT is_team_member\(\)\)\) WITH CHECK \(\(SELECT is_team_member\(\)\)\)/)
    expect(flat).toMatch(/CREATE POLICY require_aal2 ON allocation AS RESTRICTIVE FOR ALL/)
    expect(flat).toContain('REVOKE ALL ON allocation FROM anon')
  })

  test('set_weekly_capacity: SECURITY DEFINER s pevným search_path, brána AAL2, jen authenticated', () => {
    expect(flat).toMatch(/FUNCTION set_weekly_capacity\(p_member_id uuid, p_hours numeric\) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp/)
    expect(flat).toContain("coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'")
    expect(flat).toContain('REVOKE ALL ON FUNCTION set_weekly_capacity(uuid, numeric) FROM PUBLIC, anon')
    expect(flat).toContain('GRANT EXECUTE ON FUNCTION set_weekly_capacity(uuid, numeric) TO authenticated')
    // Mění jen kapacitu, nic dalšího z řádku.
    expect(flat).toContain('UPDATE team_member SET weekly_capacity_hours = v_hours WHERE id = p_member_id')
  })

  test('pravidlo „kdo smí" je stejné jako canSetCapacity: sobě, admin, vedeni', () => {
    expect(flat).toContain("IF p_member_id <> v_uid AND NOT is_admin() AND NOT EXISTS (SELECT 1 FROM team_member tm WHERE tm.id = v_uid AND tm.role::text = 'vedeni') THEN")
    const other = '00000000-0000-4000-8000-0000000000bb'
    expect(canSetCapacity({ id: 'x', teamRole: 'vedeni', isAdmin: false }, other)).toBe(true)
    expect(canSetCapacity({ id: 'x', teamRole: 'lektor', isAdmin: true }, other)).toBe(true)
    expect(canSetCapacity({ id: other, teamRole: 'lektor', isAdmin: false }, other)).toBe(true)
    expect(canSetCapacity({ id: 'x', teamRole: 'lektor', isAdmin: false }, other)).toBe(false)
  })

  test('ledger nese verzi 0062', () => {
    expect(flat).toMatch(/INSERT INTO schema_migration \(version, note\) VALUES \('0062',/)
  })

  test('team_member: authenticated nemá UPDATE (politika ani grant) — role/is_admin nejdou přepsat', () => {
    expect(flat).toContain('DROP POLICY IF EXISTS team_self ON team_member')
    expect(flat).toContain('REVOKE UPDATE ON team_member FROM authenticated, anon')
    // Napříč všemi migracemi: po 0062 už nesmí vzniknout UPDATE politika
    // (kromě RESTRICTIVE) ani UPDATE grant pro authenticated na team_member.
    const dir = join(__dirname, '..', 'supabase', 'migrations')
    const later = readdirSync(dir).filter((f) => f.endsWith('.sql') && f >= '0062').sort()
    for (const f of later) {
      const sql = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' ')
      const policies = sql.match(/CREATE POLICY \w+ ON (public\.)?team_member[^;]*;/gi) ?? []
      for (const pol of policies) {
        if (/AS RESTRICTIVE/i.test(pol)) continue
        expect(pol, f).not.toMatch(/FOR (UPDATE|ALL)/i)
      }
      expect(sql, f).not.toMatch(/GRANT [^;]*UPDATE[^;]* ON (TABLE )?(public\.)?team_member [^;]*TO [^;]*authenticated/i)
    }
  })
})
