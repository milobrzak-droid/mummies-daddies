// Statická kontrola 0057_loop_core_hardening.sql (bez DB): triggery
// vlastnictví a přechodů stavů, snímek uzlu na approval_request, auditní FK
// RESTRICT, DELETE jen pro vedení a zachování sémantiky request_approval /
// decide_approval z 0053. Tabulky přechodů v SQL musí sedět s core/workCase.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { nodeRoleFor } from '@/core/authority'
import { CASE_STATUSES, STEP_STATUSES, canTransitionCase, canTransitionStep } from '@/core/workCase'
import { LOOP_GUARD_MESSAGES } from '@/core/loopQueries'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const sql = strip(readFileSync('supabase/migrations/0057_loop_core_hardening.sql', 'utf8'))
const sql0053 = strip(readFileSync('supabase/migrations/0053_security_hardening.sql', 'utf8'))
const sql0039 = strip(readFileSync('supabase/migrations/0039_loop_core.sql', 'utf8'))

function fnBody(name: string, source = sql): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(source)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return m[2]
}
function fnHeader(name: string, source = sql): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)AS \\$\\$`).exec(source)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return m[1]
}
function fnParams(name: string, source: string): string {
  const header = fnHeader(name, source)
  return header.slice(0, header.indexOf('\n)')).replace(/\s+/g, ' ').trim()
}
const pairs = (body: string) =>
  [...body.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort()

describe('0057 — prerekvizity a ledger', () => {
  test('guard je první příkaz a jmenuje 0039 i 0053', () => {
    expect(sql.trim().startsWith('DO $$')).toBe(true)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0039_loop_core\.sql'/)
    expect(sql).toMatch(/to_regprocedure\('public\.loop_level_rank\(text\)'\) IS NULL/)
    expect(sql).toMatch(/to_regprocedure\('public\.loop_can_resolve_case\(uuid, bigint\)'\) IS NULL/)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0053_security_hardening\.sql'/)
  })
  test('schema_migration nese 0057', () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0057'/)
  })
})

describe('M7 — tabulky přechodů SQL == core/workCase.ts', () => {
  test('případ', () => {
    const ts = CASE_STATUSES.flatMap((f) => CASE_STATUSES.filter((t) => canTransitionCase(f, t)).map((t) => `${f}>${t}`)).sort()
    expect(pairs(fnBody('loop_case_transition_ok'))).toEqual(ts)
  })
  test('krok', () => {
    const ts = STEP_STATUSES.flatMap((f) => STEP_STATUSES.filter((t) => canTransitionStep(f, t)).map((t) => `${f}>${t}`)).sort()
    expect(pairs(fnBody('loop_step_transition_ok'))).toEqual(ts)
  })
  test('uzavření případu jako caseCloseIssues: kroky done/skipped a (má-li kroky) aspoň jeden done', () => {
    const b = fnBody('work_case_guard')
    expect(b).toMatch(/IF NOT loop_case_transition_ok\(OLD\.status, NEW\.status\) THEN\s+RAISE EXCEPTION '[^']+'[^;]*ERRCODE = 'LP001'/)
    expect(b).toMatch(/cs\.status NOT IN \('done', 'skipped'\)\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = 'LP003'/)
    expect(b).toMatch(/IF EXISTS \(SELECT 1 FROM case_step cs WHERE cs\.case_id = NEW\.id\)\s+AND NOT EXISTS \(SELECT 1 FROM case_step cs WHERE cs\.case_id = NEW\.id AND cs\.status = 'done'\)/)
  })
  test('kroky: přechod, uzavřený případ (FOR SHARE), přesun mezi případy, nový jen todo', () => {
    const b = fnBody('case_step_guard')
    expect(b).toMatch(/NOT loop_step_transition_ok\(OLD\.status, NEW\.status\) THEN\s+RAISE EXCEPTION '[^']+'[^;]*ERRCODE = 'LP002'/)
    expect(b).toMatch(/FROM work_case wc WHERE wc\.id = v_case_id FOR SHARE/)
    expect(b).toMatch(/v_case_status IN \('done', 'cancelled'\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = 'LP004'/)
    expect(b).toMatch(/NEW\.case_id IS DISTINCT FROM OLD\.case_id THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = 'LP007'/)
    expect(b).toMatch(/NEW\.status <> 'todo'/)
    expect(sql).toMatch(/CREATE TRIGGER case_step_guard\s+BEFORE INSERT OR UPDATE OR DELETE ON case_step/)
  })
})

describe('H1 — vlastník, zástupce a uzel případu', () => {
  const b = fnBody('work_case_guard')
  test('trigger BEFORE INSERT OR UPDATE, SECURITY DEFINER se search_path', () => {
    expect(sql).toMatch(/CREATE TRIGGER work_case_guard\s+BEFORE INSERT OR UPDATE ON work_case/)
    expect(fnHeader('work_case_guard')).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/)
  })
  test('hlídá lead_owner_id, deputy_id i node', () => {
    expect(b).toMatch(/NEW\.lead_owner_id IS DISTINCT FROM OLD\.lead_owner_id\s+OR NEW\.deputy_id IS DISTINCT FROM OLD\.deputy_id\s+OR NEW\.node IS DISTINCT FROM OLD\.node/)
  })
  test('smí jen vedení, současný vlastník případu nebo vlastník (starého) uzlu; jinak LP005', () => {
    expect(b).toMatch(
      /AND NOT loop_is_vedeni\(v_uid\)\s+AND OLD\.lead_owner_id IS DISTINCT FROM v_uid\s+AND NOT EXISTS \(SELECT 1 FROM loop_node ln WHERE ln\.node = OLD\.node AND ln\.owner_id = v_uid\) THEN\s+RAISE EXCEPTION '[^']+'\s+USING ERRCODE = 'LP005'/,
    )
    expect(b).toMatch(/v_uid\s+uuid := auth\.uid\(\)/)
    expect(fnBody('loop_is_vedeni')).toMatch(/tm\.role::text = 'vedeni'/)
  })
  test('service_role (bez auth.uid()) je vyjmutá až po kontrole přechodů', () => {
    const exempt = b.indexOf('IF v_uid IS NULL THEN')
    expect(exempt).toBeGreaterThan(b.indexOf('loop_case_transition_ok'))
    expect(exempt).toBeLessThan(b.indexOf("ERRCODE = 'LP005'"))
  })
  test('vynulování odešlého člena (ON DELETE SET NULL) projde', () => {
    expect(b).toMatch(/NEW\.lead_owner_id IS NULL\s+AND NOT EXISTS \(SELECT 1 FROM team_member tm WHERE tm\.id = OLD\.lead_owner_id\)/)
    expect(b).toMatch(/NEW\.deputy_id IS NULL\s+AND NOT EXISTS \(SELECT 1 FROM team_member tm WHERE tm\.id = OLD\.deputy_id\)/)
  })
})

describe('L9 — created_by z auth.uid()', () => {
  test('DEFAULT loop_actor() a vynucení při INSERT, zákaz změny při UPDATE', () => {
    expect(sql).toContain('ALTER TABLE work_case ALTER COLUMN created_by SET DEFAULT loop_actor();')
    const b = fnBody('work_case_guard')
    expect(b).toMatch(/v_uid IS NOT NULL AND NEW\.created_by IS DISTINCT FROM \('user:' \|\| v_uid::text\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = 'LP006'/)
    expect(b).toMatch(/NEW\.created_by IS DISTINCT FROM OLD\.created_by THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = 'LP006'/)
  })
})

describe('M3 — audit FK RESTRICT, DELETE jen vedení', () => {
  test('approval_request i decision → ON DELETE RESTRICT', () => {
    expect(sql).toMatch(/FOREACH t IN ARRAY ARRAY\['approval_request', 'decision'\]/)
    expect(sql).toMatch(/FOREIGN KEY \(case_id\) REFERENCES work_case\(id\) ON DELETE RESTRICT/)
    expect(sql).toMatch(/c\.confdeltype <> 'r'/)
    expect(sql).not.toMatch(/ON DELETE CASCADE/)
  })
  test('FOR ALL politika nahrazena SELECT/INSERT/UPDATE + DELETE pro vedení; AAL2 zůstává', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS work_case_all ON work_case;')
    expect(sql).toMatch(/CREATE POLICY work_case_select ON work_case\s+FOR SELECT USING \(is_team_member\(\)\)/)
    expect(sql).toMatch(/CREATE POLICY work_case_insert ON work_case\s+FOR INSERT WITH CHECK \(is_team_member\(\)\)/)
    expect(sql).toMatch(/CREATE POLICY work_case_update ON work_case\s+FOR UPDATE USING \(is_team_member\(\)\) WITH CHECK \(is_team_member\(\)\)/)
    expect(sql).toMatch(/CREATE POLICY work_case_delete ON work_case\s+FOR DELETE USING \(is_team_member\(\) AND loop_is_vedeni\(auth\.uid\(\)\)\)/)
    expect(sql).toMatch(/CREATE POLICY require_aal2 ON work_case\s+AS RESTRICTIVE FOR ALL/)
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON work_case\s+FOR ALL/)
  })
})

describe('H2 — snímek uzlu na approval_request', () => {
  test('sloupec, backfill z případu a CHECKy', () => {
    expect(sql).toContain('ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS node text;')
    expect(sql).toMatch(/UPDATE approval_request ar\s+SET node = wc\.node\s+FROM work_case wc\s+WHERE ar\.case_id = wc\.id\s+AND ar\.node IS NULL/)
    expect(sql).toMatch(/CHECK \(case_id IS NULL OR node IS NOT NULL\)/)
  })
  test('request_approval zmrazí uzel z případu a odmítne neexistující / uzavřený případ (L8)', () => {
    const b = fnBody('request_approval')
    expect(b).toMatch(/SELECT wc\.status, wc\.node INTO v_case_status, v_node\s+FROM work_case wc WHERE wc\.id = p_case_id FOR SHARE/)
    expect(b).toMatch(/IF NOT FOUND THEN\s+RAISE EXCEPTION '[^']+', p_case_id USING ERRCODE = 'P0002'/)
    expect(b).toMatch(/v_case_status IN \('done', 'cancelled'\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = 'LP004'/)
    expect(b).toMatch(/VALUES \(p_case_id, v_node, p_action_kind, v_level, 'pending', v_actor, p_expires_at\)/)
    expect(b.indexOf('FOR SHARE')).toBeLessThan(b.indexOf('INSERT INTO approval_request'))
  })
  test('request_approval drží sémantiku 0053: podlaha z politiky, výchozí L2, nikdy nesnižuje', () => {
    const b = fnBody('request_approval')
    const b53 = fnBody('request_approval', sql0053)
    for (const re of [
      /v_actor\s+text := loop_actor\(\)/,
      /FROM authority_policy ap\s+WHERE ap\.action_kind = p_action_kind AND ap\.active/,
      /ORDER BY loop_level_rank\(ap\.level\) ASC/,
      /v_policy := coalesce\(v_policy, 'L2'\)/,
      /loop_level_rank\(p_requested_level\) >= loop_level_rank\(v_policy\) THEN p_requested_level\s+ELSE v_policy/,
      /p_expires_at <= now\(\)/,
    ]) {
      expect(b).toMatch(re)
      expect(b53).toMatch(re)
    }
  })
  test('decide_approval: role ze snímku uzlu po FOR UPDATE, před UPDATE; aktuální uzel případu nečte', () => {
    const b = fnBody('decide_approval')
    const lock = b.indexOf('FOR UPDATE')
    const role = b.indexOf('loop_approver_role_for_node(auth.uid(), v_req.node)')
    expect(lock).toBeGreaterThan(-1)
    expect(role).toBeGreaterThan(lock)
    expect(b.indexOf('UPDATE approval_request')).toBeGreaterThan(role)
    expect(b).not.toMatch(/work_case/)
    expect(b).not.toMatch(/v_req\.case_id/)
    expect(b).toMatch(/v_req\.requested_by = v_actor/)
    expect(b).toMatch(/loop_level_rank\(v_req\.requested_level\) > loop_level_rank\(v_max\) THEN\s+RAISE EXCEPTION 'Nemáš oprávnění schválit tuto úroveň' USING ERRCODE = '42501'/)
  })
  test('loop_approver_role_for_node: pořadí jako nodeRoleFor, bez uzlu jen vedeni; stará varianta zrušena', () => {
    const b = fnBody('loop_approver_role_for_node')
    expect([...b.matchAll(/RETURN '(\w+)'/g)].map((m) => m[1])).toEqual(['node_owner', 'node_deputy', 'vedeni', 'member'])
    expect(b).toMatch(/IF p_node IS NULL THEN\s+RETURN CASE WHEN v_team_role = 'vedeni' THEN 'vedeni' END;/)
    expect(b).not.toMatch(/work_case/)
    expect(sql).toContain('DROP FUNCTION IF EXISTS loop_approver_role(uuid, bigint);')
    expect(sql).toContain('REVOKE ALL ON FUNCTION loop_approver_role_for_node(uuid, text) FROM PUBLIC, anon, authenticated;')
    const rows = [{ node: 'obchod', owner_id: 'o', deputy_id: 'd' }]
    expect(nodeRoleFor({ id: 'd', teamRole: 'vedeni' }, 'obchod', rows)).toBe('node_deputy')
  })
  test.each([
    ['request_approval', 'text, text, bigint, timestamptz'],
    ['decide_approval', 'bigint, boolean, text'],
  ])('%s: signatura z 0039, SECURITY DEFINER, search_path, granty', (name, types) => {
    expect(fnParams(name, sql)).toBe(fnParams(name, sql0039))
    expect(fnHeader(name)).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/)
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${name}(${types}) FROM PUBLIC, anon;`)
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${name}(${types}) TO authenticated;`)
  })
})

describe('SQLSTATE LP00x ↔ TS hlášky', () => {
  test('každý kód z migrace má hlášku a naopak', () => {
    const codes = [...new Set([...sql.matchAll(/ERRCODE = '(LP\d{3})'/g)].map((m) => m[1]))].sort()
    expect(codes).toEqual(Object.keys(LOOP_GUARD_MESSAGES).sort())
  })
})
