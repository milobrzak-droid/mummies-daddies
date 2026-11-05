// Statická kontrola 0064_audit_coverage.sql (bez DB) a jejího napojení na
// kód: konfigurace triggerů == core/auditCoverage.ts, aktér jen z
// auth.uid() nebo hlaviček pod service_role, nikdy dvojí audit (deal proti
// 0034/0035, appková volání proti triggeru) a historie obchodů jen pro
// obchodní role.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  AUDIT_SOFT_TRIGGER_EXTRA_MIGRATIONS,
  AUDIT_SOFT_TRIGGER_MIGRATION,
  AUDIT_SOFT_TRIGGER_MIGRATION_FILE,
  AUDIT_SOFT_TRIGGER_REDEFINITIONS,
  AUDIT_TRIGGER_EXTRA_MIGRATIONS,
  AUDIT_TRIGGER_REDEFINITIONS,
  NEVER_SAFE_COLUMNS,
  SALES_ONLY_AUDIT_ENTITIES_0082,
  SALES_ONLY_AUDIT_ENTITIES_0092,
  AUDIT_ACTOR_HEADER,
  AUDIT_ACTOR_RE,
  AUDIT_EVIDENCE_HEADER,
  AUDIT_INFO_STATE_HEADER,
  AUDIT_TRIGGER_MIGRATION,
  DB_AUDITED_TABLES,
  DEAL_AUDIT_0035_COLUMNS,
  SALES_ONLY_AUDIT_ENTITIES,
  SEMANTIC_AUDIT_ACTIONS,
  isDbAuditedTable,
} from '@/core/auditCoverage'
import { INFORMATION_STATES } from '@/core/informationState'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const raw = readFileSync('supabase/migrations/0064_audit_coverage.sql', 'utf8')
const sql = strip(raw)
const sql0035 = strip(readFileSync('supabase/migrations/0035_deal_audit_hardening.sql', 'utf8'))

function fn(name: string): { header: string; body: string } {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)AS \\$\\$([\\s\\S]*?)\\$\\$;`).exec(sql)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return { header: m[1], body: m[2] }
}

// Triggery: 0064 zakládá funkci a prvních 21 tabulek; pozdější migrace
// (AUDIT_TRIGGER_EXTRA_MIGRATIONS, dnes 0078 a 0081) napojují další tabulky
// a některé (AUDIT_TRIGGER_REDEFINITIONS, dnes 0084 a 0087) trigger kryté tabulky
// předefinují — v databázi platí poslední definice v pořadí migrací.
const byVersion = (files: string[]) => [...new Set(files)].sort()
const hardFiles = ['0064_audit_coverage.sql', ...byVersion([...Object.values(AUDIT_TRIGGER_EXTRA_MIGRATIONS), ...Object.values(AUDIT_TRIGGER_REDEFINITIONS)])]
const extraSql = hardFiles.slice(1)
  .map((f) => strip(readFileSync(join('supabase/migrations', f), 'utf8')))
  .join('\n')
const triggerSql = `${sql}\n${extraSql}`

// 0082 napojuje tabulky s `soft: true` funkcí audit_row_change_soft (čtyři argumenty,
// chyba auditu zápis neshodí) — parsují se zvlášť, ať se režimy nepomíchají.
// Pozdější migrace (AUDIT_SOFT_TRIGGER_EXTRA_MIGRATIONS / _REDEFINITIONS) ho
// napojují na nové tabulky nebo předefinují.
const raw0082 = readFileSync(join('supabase/migrations', AUDIT_SOFT_TRIGGER_MIGRATION_FILE), 'utf8')
const sql0082 = strip(raw0082)
const softFiles = [AUDIT_SOFT_TRIGGER_MIGRATION_FILE, ...byVersion([...Object.values(AUDIT_SOFT_TRIGGER_EXTRA_MIGRATIONS), ...Object.values(AUDIT_SOFT_TRIGGER_REDEFINITIONS)])]
const softSql = softFiles.map((f) => strip(readFileSync(join('supabase/migrations', f), 'utf8'))).join('\n')

type ParsedTrigger = { table: string; ops: string[]; safe: string[]; ignore: string[]; evidence: string; key?: string[] }
const SOFT_RE = /CREATE TRIGGER audit_row_change_soft\s+AFTER ([A-Z ]+?) ON (\w+)\s+FOR EACH ROW EXECUTE FUNCTION audit_row_change_soft\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/g
const HARD_RE = /CREATE TRIGGER audit_row_change\s+AFTER ([A-Z ]+?) ON (\w+)\s+FOR EACH ROW EXECUTE FUNCTION audit_row_change\(\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/g
const parseSoft = (text: string): ParsedTrigger[] => [...text.matchAll(SOFT_RE)].map((m) => ({
  table: m[2],
  ops: m[1].split(/\s+OR\s+/),
  safe: m[3] ? m[3].split(',') : [],
  ignore: m[4] ? m[4].split(',') : [],
  evidence: m[5],
  key: m[6] ? m[6].split(',') : [],
}))
const parseHard = (text: string): ParsedTrigger[] => [...text.matchAll(HARD_RE)].map((m) => ({
  table: m[2],
  ops: m[1].split(/\s+OR\s+/),
  safe: m[3] ? m[3].split(',') : [],
  ignore: m[4] ? m[4].split(',') : [],
  evidence: m[5],
}))
// Po souborech v pořadí migrací: v jednom souboru tabulka nejvýš jednou,
// pozdější definice přepíše dřívější (DROP TRIGGER IF EXISTS + CREATE).
function lastDefinitions(files: string[], parse: (text: string) => ParsedTrigger[]) {
  const perFile = files.map((f) => ({ file: f, list: parse(strip(readFileSync(join('supabase/migrations', f), 'utf8'))) }))
  const merged = new Map<string, ParsedTrigger>()
  for (const { list } of perFile) for (const t of list) merged.set(t.table, t)
  return { perFile, merged: [...merged.values()] }
}
const hardParsed = lastDefinitions(hardFiles, parseHard)
const softParsed = lastDefinitions(softFiles, parseSoft)
const softTriggers: ParsedTrigger[] = softParsed.merged
const triggers: ParsedTrigger[] = hardParsed.merged

describe('0064 — prerekvizity, ledger, idempotence', () => {
  test('guard je první příkaz a jmenuje migrace, na kterých stojí', () => {
    expect(sql.trim().startsWith('DO $$')).toBe(true)
    for (const f of ['0028_audit_event.sql', '0038_evidence.sql', '0020_core_sales_crm.sql', '0026_migration_ledger.sql', '0002_auth_and_team.sql']) {
      expect(sql).toContain(f)
    }
  })

  test('guard hlídá každou tabulku napojenou v 0064 (pozdější napojují své migrace)', () => {
    const guarded = [...sql.matchAll(/\['(\w+)', '(\d{4}_\w+\.sql)'\]/g)].map((m) => m[1]).sort()
    const later = Object.keys(AUDIT_TRIGGER_EXTRA_MIGRATIONS)
    const soft = Object.keys(DB_AUDITED_TABLES).filter((t) => DB_AUDITED_TABLES[t].soft)
    expect(guarded).toEqual(Object.keys(DB_AUDITED_TABLES).filter((t) => !later.includes(t) && !soft.includes(t)).sort())
  })

  test('schema_migration nese verzi, na kterou se ptá dbAuditActive', () => {
    expect(AUDIT_TRIGGER_MIGRATION).toBe('0064')
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0064'/)
    expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
  })

  test('každý CREATE TRIGGER má před sebou DROP TRIGGER IF EXISTS (opakovaný běh)', () => {
    for (const t of triggers) expect(triggerSql).toContain(`DROP TRIGGER IF EXISTS audit_row_change ON ${t.table};`)
  })

  test('v jednom souboru je trigger každé tabulky nejvýš jednou', () => {
    for (const { file, list } of [...hardParsed.perFile, ...softParsed.perFile]) {
      const tables = list.map((t) => t.table)
      expect(new Set(tables).size, file).toBe(tables.length)
    }
  })

  test('předefinice míří na tabulku krytou už dřív a nemění operace', () => {
    for (const [table, file] of Object.entries(AUDIT_TRIGGER_REDEFINITIONS)) {
      const first = parseHard(sql).find((t) => t.table === table)
      expect(first, `${table} musí být krytá v 0064`).toBeDefined()
      const again = hardParsed.perFile.find((p) => p.file === file)!.list.find((t) => t.table === table)!
      expect(again.ops).toEqual(first!.ops)
      for (const c of first!.safe) expect(again.safe, `${file}: ${table}.${c} z allow-listu nesmí zmizet`).toContain(c)
    }
    for (const [table, file] of Object.entries(AUDIT_SOFT_TRIGGER_REDEFINITIONS)) {
      const first = parseSoft(sql0082).find((t) => t.table === table)
      expect(first, `${table} musí být krytá v 0082`).toBeDefined()
      const again = softParsed.perFile.find((p) => p.file === file)!.list.find((t) => t.table === table)!
      expect(again.ops).toEqual(first!.ops)
      expect(again.key).toEqual(first!.key)
      for (const c of first!.safe) expect(again.safe, `${file}: ${table}.${c} z allow-listu nesmí zmizet`).toContain(c)
    }
  })

  test('contact (0087): nesouhlas s oslovením s hodnotou, důvod nikdy', () => {
    const contact = triggers.find((t) => t.table === 'contact')!
    expect(contact.safe).toEqual(expect.arrayContaining(['do_not_contact', 'do_not_contact_at', 'do_not_contact_by']))
    expect(contact.safe).not.toContain('do_not_contact_reason')
    expect(NEVER_SAFE_COLUMNS).toContain('do_not_contact_reason')
    for (const c of ['full_name', 'email', 'phone', 'role', 'notes']) expect(contact.safe).not.toContain(c)
    // Starší definice z 0064 zůstává v souboru, ale v DB ji 0087 přepíše.
    expect(hardParsed.perFile.flatMap((p) => p.list).filter((t) => t.table === 'contact')).toHaveLength(2)
  })

  test('engagement_document (0094): typ, stav a kdo/kdy s hodnotou; identita, tagy a odkaz jen názvem', () => {
    const doc = triggers.find((t) => t.table === 'engagement_document')!
    expect(doc.safe).toEqual(expect.arrayContaining(['doc_type', 'status', 'status_changed_by', 'approved_version_id', 'source_state']))
    for (const c of ['drive_id', 'item_id', 'e_tag', 'c_tag', 'last_modified_by', 'url', 'title']) expect(doc.safe, c).not.toContain(c)
    // Denní kontrola mění source_checked_at každý den — to není auditní událost.
    expect(doc.ignore).toEqual(['source_checked_at'])
    expect(hardParsed.perFile.flatMap((p) => p.list).filter((t) => t.table === 'engagement_document')).toHaveLength(2)
  })

  test('pozdější migrace napojují jen funkci z 0064 a zapisují svůj řádek do ledgeru', () => {
    for (const [table, file] of [...Object.entries(AUDIT_TRIGGER_EXTRA_MIGRATIONS), ...Object.entries(AUDIT_TRIGGER_REDEFINITIONS)]) {
      const text = strip(readFileSync(join('supabase/migrations', file), 'utf8'))
      expect(text, file).toContain("to_regprocedure('public.audit_row_change()')")
      expect(text, file).not.toMatch(/CREATE OR REPLACE FUNCTION audit_row_change/)
      expect(text, file).toContain(`ON ${table}`)
      expect(text, file).toMatch(/INSERT INTO schema_migration/)
    }
  })
})

describe('0082 — měkký audit (chyba auditu nezablokuje zápis)', () => {
  test('ledger verze a soubor sedí s TS, guard je první příkaz', () => {
    expect(AUDIT_SOFT_TRIGGER_MIGRATION).toBe('0082')
    expect(sql0082.trim().startsWith('DO $$')).toBe(true)
    expect(sql0082).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0082'/)
    expect(sql0082).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
    expect(sql0082).toContain("to_regprocedure('public.audit_row_change()')")
  })

  test('každý měkký CREATE TRIGGER má DROP TRIGGER IF EXISTS (opakovaný běh)', () => {
    for (const t of softTriggers) expect(softSql).toContain(`DROP TRIGGER IF EXISTS audit_row_change_soft ON ${t.table};`)
  })

  test('pozdější měkké triggery používají funkci z 0082 a nepřepisují ji', () => {
    for (const [table, file] of [...Object.entries(AUDIT_SOFT_TRIGGER_EXTRA_MIGRATIONS), ...Object.entries(AUDIT_SOFT_TRIGGER_REDEFINITIONS)]) {
      const text = strip(readFileSync(join('supabase/migrations', file), 'utf8'))
      expect(text, file).toContain("to_regprocedure('public.audit_row_change_soft()')")
      expect(text, file).not.toMatch(/CREATE OR REPLACE FUNCTION audit_row_(change_soft|record)/)
      expect(text, file).toContain(`ON ${table}`)
      expect(text, file).toMatch(/INSERT INTO schema_migration/)
    }
  })

  test('audit_row_change_soft chytá výjimky a varování nenese data řádku', () => {
    const m = /CREATE OR REPLACE FUNCTION audit_row_change_soft\(\)([\s\S]*?)AS \$\$([\s\S]*?)\$\$;/.exec(sql0082)!
    expect(m[1]).toMatch(/SECURITY DEFINER SET search_path = public, pg_temp/)
    expect(m[2]).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/)
    expect(m[2]).toMatch(/SQLSTATE/)
    expect(m[2]).not.toMatch(/SQLERRM/)
    expect(m[2]).toMatch(/RETURN NULL;/)
    expect(sql0082).toMatch(/REVOKE ALL ON FUNCTION audit_row_change_soft\(\) FROM anon, authenticated;/)
    expect(sql0082).toMatch(/REVOKE ALL ON FUNCTION audit_row_record\(text, text, jsonb, jsonb, text\[\], text\[\], text, text\[\]\) FROM anon, authenticated;/)
  })

  test('citlivé sloupce nikdy nejsou v allow-listech měkkých triggerů', () => {
    for (const t of softTriggers) {
      for (const c of t.safe) {
        const exception = t.table === 'team_member' && c === 'role'
        if (!exception) expect(['name', 'full_name', 'email', 'phone', 'notes', 'note', 'external_ref', 'source_key', 'metric', 'unit', 'steps', 'scope', 'params', 'result'], `${t.table}.${c}`).not.toContain(c)
      }
    }
  })
})

describe('funkce', () => {
  test('audit_row_change: SECURITY DEFINER, search_path s pg_temp, klientům odebraná', () => {
    const { header, body } = fn('audit_row_change')
    expect(header).toMatch(/SECURITY DEFINER SET search_path = public, pg_temp/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION audit_row_change\(\) FROM anon, authenticated;/)
    // Změna a její audit jsou jedna transakce — žádné tiché polykání chyb.
    expect(body).not.toMatch(/EXCEPTION/)
    expect(body).toMatch(/INSERT INTO audit_event \(actor_type, actor_id, action, entity_table, entity_id, before, after, evidence_id, info_state\)/)
    expect(body).toMatch(/v_ignore\s+text\[\] := ARRAY\['updated_at'\]/)
    expect(body).toMatch(/IF cardinality\(v_cols\) = 0 THEN\s+RETURN NULL;/)
  })

  test('audit_request_context: přihlášený uživatel má přednost, hlavičky jen pod service_role', () => {
    const { header, body } = fn('audit_request_context')
    expect(header).toMatch(/SET search_path = public, pg_temp/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION audit_request_context\(\) FROM anon, authenticated;/)
    const userBranch = body.indexOf('IF v_uid IS NOT NULL THEN')
    const serviceBranch = body.indexOf("IF v_role = 'service_role' THEN")
    const firstHeader = body.indexOf('request.headers')
    expect(userBranch).toBeGreaterThan(0)
    expect(body.slice(userBranch, serviceBranch)).toMatch(/info_state := 'human_confirmed';\s+RETURN;/)
    expect(serviceBranch).toBeGreaterThan(userBranch)
    expect(firstHeader).toBeGreaterThan(serviceBranch)
    // current_user je v SECURITY DEFINER vlastník funkce — nesmí určovat aktéra.
    expect(body).not.toMatch(/current_user/)
    expect(body).toMatch(/'db-trigger:' \|\| v_role/)
  })

  test('hlavičky, regex aktéra a čtyři stavy údaje sedí s TS', () => {
    const { body } = fn('audit_request_context')
    for (const h of [AUDIT_ACTOR_HEADER, AUDIT_EVIDENCE_HEADER, AUDIT_INFO_STATE_HEADER]) expect(body).toContain(`'${h}'`)
    expect(body).toContain(`'${AUDIT_ACTOR_RE.source}'`)
    const states = /v_state IN \(([^)]*)\)/.exec(body)![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1))
    expect(states).toEqual([...INFORMATION_STATES])
    // Odkaz na evidenci jen na existující řádek (jinak by FK shodil zápis).
    expect(body).toMatch(/EXISTS \(SELECT 1 FROM evidence e WHERE e\.id = v_ev::bigint\)/)
  })
})

describe('napojené tabulky == DB_AUDITED_TABLES', () => {
  test('stejná množina tabulek, každá jednou (tvrdý režim 0064/0078, měkký 0082)', () => {
    const softTables = Object.keys(DB_AUDITED_TABLES).filter((t) => DB_AUDITED_TABLES[t].soft).sort()
    const hardTables = Object.keys(DB_AUDITED_TABLES).filter((t) => !DB_AUDITED_TABLES[t].soft).sort()
    expect(triggers.map((t) => t.table).sort()).toEqual(hardTables)
    expect(softTriggers.map((t) => t.table).sort()).toEqual(softTables)
    // authority_policy už kryje 0064 (tvrdý režim), 0082 ji nepřepisuje.
    expect(hardTables).toContain('authority_policy')
    expect(softTables).toEqual(['allocation', 'approval_execution', 'case_proposal', 'deal_partner', 'deal_scope_version',
      'engagement_document_finding', 'financial_record', 'follow_up_attempt', 'idoklad_discrepancy', 'import_batch', 'loop_node', 'mail_content_intake', 'metric_observation',
      'outbound_outreach', 'outbound_signal', 'outreach_consent', 'outreach_suppression', 'shop_order', 'team_member',
      'web_inquiry'])
  })

  test.each(Object.entries(DB_AUDITED_TABLES))('%s: operace, allow-list, ignorované a evidence', (table, cfg) => {
    const t = (cfg.soft ? softTriggers : triggers).find((x) => x.table === table)!
    expect(t.ops).toEqual([...cfg.ops])
    expect(t.safe).toEqual([...cfg.safe])
    expect(t.ignore).toEqual([...cfg.ignore])
    expect(t.evidence).toBe(cfg.evidenceColumn ?? '')
    // Klíč entity bez bigint id (0082): jen u měkkých tabulek, entity_id je pak NULL.
    if (cfg.soft) expect(t.key).toEqual([...(cfg.key ?? [])])
  })

  test('obchod: ignorované ⊇ každý sloupec, na který reaguje 0034/0035 (nikdy obojí)', () => {
    const when = /CREATE TRIGGER deal_audit_price_stage_trigger[\s\S]*?WHEN \(([\s\S]*?)\)\s+EXECUTE FUNCTION/.exec(sql0035)![1]
    const watched = [...when.matchAll(/OLD\.(\w+)\s+IS DISTINCT FROM/g)].map((m) => m[1]).sort()
    expect(watched).toEqual([...DEAL_AUDIT_0035_COLUMNS].sort())
    const deal = triggers.find((t) => t.table === 'deal')!
    for (const c of watched) expect(deal.ignore).toContain(c)
    // Vznik a smazání obchodu zapisuje jen 0035.
    expect(deal.ops).toEqual(['UPDATE'])
    expect(sql0035).toMatch(/AFTER INSERT OR DELETE ON deal/)
  })

  test('funkce 0034/0035 se v 0064 nepřepisují (běží na nich souběžné větve)', () => {
    expect(sql).not.toMatch(/FUNCTION deal_audit_price_stage|FUNCTION deal_audit_insert_delete/)
  })
})

describe('viditelnost: historie obchodů a předplatného jen pro obchodní role', () => {
  test('RESTRICTIVE SELECT politika s (SELECT can_see_sales())', () => {
    const m = /CREATE POLICY audit_event_sales_only ON audit_event\s+AS RESTRICTIVE FOR SELECT\s+USING \(entity_table NOT IN \(([^)]*)\) OR \(SELECT can_see_sales\(\)\)\);/.exec(sql)
    expect(m).not.toBeNull()
    expect(m![1].match(/'(\w+)'/g)!.map((s) => s.slice(1, -1))).toEqual([...SALES_ONLY_AUDIT_ENTITIES])
    expect(sql).toContain('DROP POLICY IF EXISTS audit_event_sales_only ON audit_event;')
  })

  test('0082: částky a rozsah nabídky (financial_record, deal_scope_version) také jen pro obchodní role', () => {
    const m = /CREATE POLICY audit_event_sales_only_fin ON audit_event\s+AS RESTRICTIVE FOR SELECT\s+USING \(entity_table NOT IN \(([^)]*)\) OR \(SELECT can_see_sales\(\)\)\);/.exec(sql0082)
    expect(m).not.toBeNull()
    expect(m![1].match(/'(\w+)'/g)!.map((x) => x.slice(1, -1)).sort()).toEqual([...SALES_ONLY_AUDIT_ENTITIES_0082].sort())
    expect(sql0082).toContain('DROP POLICY IF EXISTS audit_event_sales_only_fin ON audit_event;')
    for (const t of SALES_ONLY_AUDIT_ENTITIES_0082) expect(isDbAuditedTable(t)).toBe(true)
  })

  test('0092: fronta rozdílů z iDokladu jen pro obchodní role (vlastní RESTRICTIVE politika)', () => {
    const sql0092 = strip(readFileSync('supabase/migrations/0092_idoklad_sync.sql', 'utf8'))
    const m = /CREATE POLICY audit_event_sales_only_idoklad ON audit_event\s+AS RESTRICTIVE FOR SELECT\s+USING \(entity_table <> '(\w+)' OR \(SELECT can_see_sales\(\)\)\);/.exec(sql0092)
    expect(m).not.toBeNull()
    expect([m![1]]).toEqual([...SALES_ONLY_AUDIT_ENTITIES_0092])
    expect(sql0092).toContain('DROP POLICY IF EXISTS audit_event_sales_only_idoklad ON audit_event;')
    for (const t of SALES_ONLY_AUDIT_ENTITIES_0092) expect(isDbAuditedTable(t)).toBe(true)
  })

  test('obchodní entity s DB auditem jsou v seznamu skrytých', () => {
    for (const t of ['deal', 'subscription']) {
      expect(isDbAuditedTable(t)).toBe(true)
      expect(SALES_ONLY_AUDIT_ENTITIES).toContain(t)
    }
  })
})

// ---------------------------------------------------------------------------
// Nikdy obojí: appkové volání recordAudit nad krytou tabulkou smí být jen
// záloha za trigger (gated dbAuditActive) nebo významová událost.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return []
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

const SOURCE_DIRS = ['app', 'components', 'domain', 'lib', 'worker', 'connectors']
const sources = SOURCE_DIRS.flatMap((d) => walk(d))

type AuditCall = { file: string; line: number; table: string | null; action: string | null; gated: boolean }
function auditCalls(): AuditCall[] {
  const out: AuditCall[] = []
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (const m of text.matchAll(/\brecordAudit(?:WithEvidence)?\(/g)) {
      const idx = m.index!
      const line = text.slice(0, idx).split('\n').length
      const args = text.slice(idx, idx + 600)
      const lit = /^recordAudit\(\s*'(\w+)'\s*,\s*[^,]+,\s*'([\w.]+)'/.exec(args)
      const withEvidence = /entityTable:\s*'(\w+)'[\s\S]*?action:\s*'([\w.]+)'/.exec(args)
      const table = lit?.[1] ?? withEvidence?.[1] ?? null
      const action = lit?.[2] ?? withEvidence?.[2] ?? null
      const window = lines.slice(Math.max(0, line - 13), line).join('\n')
      out.push({ file, line, table, action, gated: /db(?:Soft)?AuditActive\(/.test(window) })
    }
  }
  return out
}

describe('appková volání recordAudit vs. DB trigger', () => {
  const calls = auditCalls()

  test('scan něco našel (sanity)', () => {
    expect(calls.length).toBeGreaterThan(5)
  })

  test('nad krytou tabulkou jen záloha za trigger nebo významová událost', () => {
    const offenders = calls
      .filter((c) => c.table === null || isDbAuditedTable(c.table))
      .filter((c) => !(c.action && SEMANTIC_AUDIT_ACTIONS.includes(c.action)))
      .filter((c) => !c.gated)
      .map((c) => `${c.file}:${c.line} ${c.table ?? '?'} ${c.action ?? '?'}`)
    expect(offenders).toEqual([])
  })

  test('významové události opravdu existují a trigger je nezapisuje', () => {
    for (const a of SEMANTIC_AUDIT_ACTIONS) expect(calls.some((c) => c.action === a), a).toBe(true)
    expect(DB_AUDITED_TABLES.sales_activity.ignore).toEqual(['body', 'subject'])
  })
})
