// Statická kontrola 0084_approval_executor.sql (bez DB) a jejího napojení na
// kód: kopie konfigurace v SQL == config/mummiesDaddies.ts, druhy akcí, přechody,
// stavy a kódy důvodů == core/approvalActions.ts, práva funkcí, idempotence.
// Chování ve skutečném Postgresu ověřuje test/approval-executor-pglite.test.ts.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import {
  APPROVAL_ACTIONS,
  APPROVAL_ACTION_MIGRATION,
  APPROVAL_ACTION_TYPES,
  EXECUTION_REASON_TEXT,
  EXECUTION_REQUEST_STATUSES,
  EXECUTION_STATUSES,
  MAX_EXECUTION_ATTEMPTS,
  approvalSettingsJson,
} from '@/core/approvalActions'
import { SCOPE_VERSION_DB_CODES } from '@/domain/crm/scopeVersion'
import { APPROVAL_EXPIRY_JOB } from '@/worker/approvalExpiry'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const RAW = readFileSync('supabase/migrations/0084_approval_executor.sql', 'utf8')
const SQL = strip(RAW)

function fn(name: string): { header: string; body: string } {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(SQL)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return { header: m[1], body: m[2] }
}
const quoted = (list: string) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1])

describe('0084 — prerekvizity, ledger, transakce', () => {
  test('guard je první příkaz a jmenuje migrace, na kterých stojí', () => {
    expect(SQL.trim().startsWith('DO $$')).toBe(true)
    for (const f of [
      '0039_loop_core.sql', '0053_security_hardening.sql', '0057_loop_core_hardening.sql', '0064_audit_coverage.sql',
      '0069_security_fixes.sql', '0072_deal_scope_version.sql', '0082_audit_gaps_partner_lockdown.sql',
      '0006_tasks_and_calendar.sql', '0020_core_sales_crm.sql', '0021_activity_partner.sql', '0026_migration_ledger.sql',
    ]) expect(SQL).toContain(f)
  })

  test('ledger nese 0084 a soubor nemá vlastní transakci', () => {
    expect(APPROVAL_ACTION_MIGRATION).toBe('0084')
    expect(SQL).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0084'/)
    expect(SQL).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
    expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im)
  })

  test('idempotence: sloupce IF NOT EXISTS, constrainty jen když chybí, triggery DROP + CREATE', () => {
    expect(SQL.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBe(10)
    for (const m of SQL.matchAll(/ADD COLUMN (?!IF NOT EXISTS)(\w+)/g)) throw new Error(`ADD COLUMN bez IF NOT EXISTS: ${m[0]}`)
    const constraints = [...SQL.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1])
    for (const c of constraints) expect(SQL, c).toContain(`conname = '${c}'`)
    for (const m of SQL.matchAll(/CREATE TRIGGER (\w+)\s+(?:AFTER|BEFORE)[\s\S]*?ON (\w+)/g)) {
      expect(SQL, m[0]).toContain(`DROP TRIGGER IF EXISTS ${m[1]} ON ${m[2]};`)
    }
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS approval_execution')
    expect(SQL).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM authority_policy ap WHERE ap\.action_kind = v\.kind AND ap\.active\)/)
  })
})

describe('kopie konfigurace a číselníků == TypeScript', () => {
  test('approval_action_settings == COMPANY.approvalActions', () => {
    const literal = /SELECT '(\{[\s\S]*?\})'::jsonb/.exec(fn('approval_action_settings').body)![1]
    expect(JSON.parse(literal)).toEqual(approvalSettingsJson(COMPANY.approvalActions))
    expect(COMPANY.nodes).toContain(COMPANY.approvalActions.sendOffer.node)
  })

  test('druhy akcí: CHECK na žádosti, na výsledku i v RPC', () => {
    const typeCheck = /approval_request_action_type_check\s+CHECK \(action_type IS NULL OR action_type IN \(([^)]*)\)\)/.exec(SQL)!
    expect(quoted(typeCheck[1])).toEqual([...APPROVAL_ACTION_TYPES])
    const execCheck = /approval_execution_action_type_check CHECK \(action_type IN \(([^)]*)\)\)/.exec(SQL)!
    expect(quoted(execCheck[1])).toEqual([...APPROVAL_ACTION_TYPES])
    const rpc = /p_action_type NOT IN \(([^)]*)\)/.exec(fn('request_action_approval').body)!
    expect(quoted(rpc[1])).toEqual([...APPROVAL_ACTION_TYPES])
  })

  test('cíl a jediný povolený přechod podle druhu == APPROVAL_ACTIONS', () => {
    const check = /approval_request_action_target CHECK \(([\s\S]*?)\n    \);/.exec(SQL)![1]
    for (const t of APPROVAL_ACTION_TYPES) {
      const a = APPROVAL_ACTIONS[t]
      expect(check).toMatch(new RegExp(`action_type = '${t}' AND target_table = '${a.targetTable}'\\s+AND transition = '${a.transition}'`))
      expect(fn('request_action_approval').body).toContain(`v_transition := '${a.transition}'`)
      expect(fn('request_action_approval').body).toContain(`v_target_table := '${a.targetTable}'`)
    }
  })

  test('stavy výsledku a na co se reaguje == TS', () => {
    const st = /approval_execution_status_check CHECK \(status IN \(([^)]*)\)\)/.exec(SQL)!
    expect(quoted(st[1])).toEqual([...EXECUTION_STATUSES])
    const rs = /approval_execution_request_status_check CHECK \(request_status IN \(([^)]*)\)\)/.exec(SQL)!
    expect(quoted(rs[1])).toEqual([...EXECUTION_REQUEST_STATUSES])
  })

  test('každý kód důvodu, který SQL zapisuje, má českou větu', () => {
    const codes = new Set<string>()
    for (const m of SQL.matchAll(/v_reason := '(\w+)'/g)) codes.add(m[1])
    for (const m of SQL.matchAll(/'reason', '(\w+)'/g)) codes.add(m[1])
    expect(codes.size).toBeGreaterThan(8)
    for (const c of codes) expect(EXECUTION_REASON_TEXT, c).toHaveProperty(c)
  })

  test('nové kódy strážce nabídky (SV006–SV008) mají českou větu', () => {
    const codes = [...new Set([...SQL.matchAll(/ERRCODE = '(SV\d{3})'/g)].map((m) => m[1]))].sort()
    expect(codes).toEqual(['SV006', 'SV007', 'SV008'])
    for (const c of codes) expect(SCOPE_VERSION_DB_CODES, c).toHaveProperty(c)
  })

  test('počet pokusů a aktér denní úlohy sedí s TS', () => {
    expect(fn('expire_due_approvals').body).toContain(`e.attempts < ${MAX_EXECUTION_ATTEMPTS}`)
    expect(fn('expire_due_approvals').body).toContain(`'system:${APPROVAL_EXPIRY_JOB}'`)
  })
})

describe('práva a brány', () => {
  const INTERNAL = [
    'approval_add_working_days(date, integer)', 'approval_today()', 'approval_day_end(date)', 'approval_member_uuid(text)',
    'approval_params_hash(text, text, bigint, jsonb)', 'approval_offer_content(deal_scope_version)',
    'approval_first_active_member(uuid[])', 'approval_can_decide(uuid, approval_request)',
    'approval_human_task(text, text, uuid, bigint, bigint, text, date)', 'approval_exec_confirm_next_step(approval_request)',
    'approval_exec_send_offer(approval_request)', 'approval_exec_return_to_owner(approval_request)',
    'approval_execute(bigint, text)', 'deal_scope_version_send_guard()',
  ]
  test('vnitřní funkce executoru nemá žádná klientská role', () => {
    for (const f of INTERNAL) {
      expect(SQL, f).toContain(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon, authenticated;`)
      expect(SQL, f).not.toContain(`GRANT EXECUTE ON FUNCTION ${f}`)
    }
  })

  test('RPC jen pro authenticated, vypršení jen service_role', () => {
    for (const f of [
      'request_action_approval(text, bigint, jsonb, timestamptz)', 'decide_approval(bigint, boolean, text)',
      'snooze_approval(bigint, timestamptz)', 'retry_approval_execution(bigint)',
    ]) {
      expect(SQL, f).toContain(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC, anon;`)
      expect(SQL, f).toContain(`GRANT EXECUTE ON FUNCTION ${f} TO authenticated;`)
    }
    expect(SQL).toContain('REVOKE ALL ON FUNCTION expire_due_approvals(integer) FROM PUBLIC, anon, authenticated;')
    expect(SQL).toContain('GRANT EXECUTE ON FUNCTION expire_due_approvals(integer) TO service_role;')
    expect(fn('expire_due_approvals').body).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = '42501'/)
  })

  test('RPC razítkují aktéra z auth.uid() (loop_actor), SECURITY DEFINER s pevným search_path', () => {
    for (const name of ['request_action_approval', 'decide_approval', 'snooze_approval', 'retry_approval_execution']) {
      const { header, body } = fn(name)
      expect(header, name).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/)
      expect(body, name).toMatch(/v_actor\s+text := loop_actor\(\);/)
    }
  })

  test('decide_approval: kontroly z 0057 zůstaly, přibyla obchodní role u nabídky a executor', () => {
    const b = fn('decide_approval').body
    const order = [
      "v_req.status <> 'pending'",
      'v_req.expires_at <= now()',
      'v_req.requested_by = v_actor',
      'loop_approver_role_for_node(auth.uid(), v_req.node)',
      "v_req.action_type = 'send_offer' AND NOT can_see_sales()",
      'UPDATE approval_request',
      'PERFORM approval_execute(p_request_id, v_actor)',
    ].map((s) => b.indexOf(s))
    for (const i of order) expect(i).toBeGreaterThan(0)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    expect(b).toMatch(/FROM approval_request WHERE id = p_request_id FOR UPDATE/)
  })

  test('odložení smí jen schvalovatel; odeslání nabídky žádá jen obchodní role', () => {
    expect(fn('snooze_approval').body).toMatch(/IF NOT approval_can_decide\(auth\.uid\(\), v_req\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = '42501'/)
    expect(fn('request_action_approval').body).toMatch(/IF NOT can_see_sales\(\) THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = '42501'/)
    const can = fn('approval_can_decide').body
    expect(can).toContain("p_req.requested_by = 'user:' || p_member::text")
    expect(can).toContain("tm.role::text IN ('vedeni', 'obchodnik')")
  })

  test('tabulka výsledků: RLS čtení pro tým, RESTRICTIVE AAL2, žádný klientský zápis', () => {
    expect(SQL).toContain('ALTER TABLE approval_execution ENABLE ROW LEVEL SECURITY;')
    expect(SQL).toMatch(/CREATE POLICY approval_execution_read ON approval_execution\s+FOR SELECT USING \(\(SELECT is_team_member\(\)\)\);/)
    expect(SQL).toMatch(/CREATE POLICY require_aal2 ON approval_execution\s+AS RESTRICTIVE FOR ALL/)
    expect(SQL).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON approval_execution FROM PUBLIC, anon, authenticated;')
    expect(SQL).not.toMatch(/CREATE POLICY \w+ ON approval_execution\s+FOR (INSERT|UPDATE|DELETE|ALL)/)
  })
})

describe('executor', () => {
  test('jeden výsledek na žádost: zámek, návrat bez provedení, podtransakce, upsert jen po selhání', () => {
    const b = fn('approval_execute').body
    expect(b).toMatch(/FROM approval_request WHERE id = p_request_id FOR UPDATE/)
    expect(b).toMatch(/IF FOUND AND v_prev\.status <> 'failed' THEN\s+RETURN v_prev\.status;/)
    expect(b).toMatch(/EXCEPTION WHEN OTHERS THEN\s+[\s\S]*?v_status := 'failed';/)
    expect(b).not.toMatch(/SQLERRM/)
    expect(b).toMatch(/ON CONFLICT \(request_id\) DO UPDATE[\s\S]*?WHERE e\.status = 'failed'/)
    expect(SQL).toContain('CONSTRAINT approval_execution_request_key UNIQUE (request_id)')
  })

  test('nabídku executor NEODESÍLÁ: nemění stav verze, jen značku schválení; aktivita má unikátní klíč', () => {
    const b = fn('approval_exec_send_offer').body
    expect(b).not.toMatch(/status\s*=\s*'sent'/)
    expect(b).toMatch(/SET send_approved_at = now\(\), send_approval_request_id = p_req\.id/)
    expect(b).toMatch(/set_config\('app\.approval_exec', p_req\.id::text, true\)/)
    expect(b).toContain("'approval', 'approval:' || p_req.id")
    expect(b).toContain('ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING')
    // Žádné síťové ani poštovní rozšíření.
    expect(SQL).not.toMatch(/\b(http_post|http_get|net\.http|pg_net|send_mail|graph)\b/i)
  })

  test('otisk: SHA-256 nad kanonickým jsonb; u nabídky kryje obsah verze', () => {
    expect(fn('approval_params_hash').body).toMatch(/encode\(sha256\(convert_to\(jsonb_build_object\(/)
    const content = fn('approval_offer_content').body
    for (const c of ['scope', 'amount_one_time', 'expected_mrr', 'currency', 'version', 'deal_id']) expect(content).toContain(`p_version.${c}`)
    // Žádost nese jen id a číslo verze (částky čte celý tým), otisk celý obsah.
    expect(fn('request_action_approval').body).toContain(
      "v_params := jsonb_build_object('deal_id', v_ver.deal_id, 'version_id', v_ver.id, 'version', v_ver.version);",
    )
  })

  test('strážce verze nabídky: SV006 bez schválení, SV007 jen executor, SV008 schválená verze se nemění', () => {
    const g = fn('deal_scope_version_send_guard')
    expect(g.header).not.toMatch(/SECURITY DEFINER/)
    expect(g.body).toMatch(/OLD\.status = 'draft' AND NEW\.status = 'sent' AND OLD\.send_approved_at IS NULL\s+AND approval_offer_requires_approval\(/)
    expect(g.body).toMatch(/current_setting\('app\.approval_exec', true\)/)
    expect(SQL).toMatch(/CREATE TRIGGER deal_scope_version_send_guard\s+BEFORE INSERT OR UPDATE ON deal_scope_version/)
  })

  test('vypršení: SKIP LOCKED, stav expired s časem, další stav přes executor', () => {
    const b = fn('expire_due_approvals').body
    expect(b).toContain('FOR UPDATE SKIP LOCKED')
    expect(b).toMatch(/SET status = 'expired', decided_at = now\(\)/)
    expect(b).toContain('v_status := approval_execute(r.id, v_actor);')
  })
})
