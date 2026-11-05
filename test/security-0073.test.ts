// Statická kontrola 0073_team_member_guard_allowlist.sql (bez DB): pojistka
// z 0069 na team_member pouští mimo vyjmuté role nejvýš změnu full_name
// (výčet povolených, ne zakázaných sloupců), klientským rolím nezůstane žádný
// zápis a migrace ověří, že UPDATE po REVOKE opravdu zmizel.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const sql = strip(readFileSync('supabase/migrations/0073_team_member_guard_allowlist.sql', 'utf8'))
const sql0069 = strip(readFileSync('supabase/migrations/0069_security_fixes.sql', 'utf8'))

/** Tělo funkce mezi `AS $$` a `$$;`. */
function fnBody(name: string, source = sql): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`).exec(source)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return m[2]
}

/** Hlavička funkce (parametry + atributy) až po `AS $$`. */
function fnHeader(name: string, source = sql): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(([\\s\\S]*?)AS \\$\\$`).exec(source)
  if (!m) throw new Error(`funkce ${name} nenalezena`)
  return m[1]
}

describe('0073 — prerekvizity', () => {
  test('guard je první příkaz a jmenuje 0002, 0069 a 0026', () => {
    expect(sql.trim().startsWith('DO $$')).toBe(true)
    expect(sql).toMatch(/to_regclass\('public\.team_member'\) IS NULL/)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0002_auth_and_team\.sql'/)
    expect(sql).toMatch(/to_regprocedure\('public\.team_member_guard_privileged\(\)'\) IS NULL/)
    expect(sql).toMatch(/column_name = 'deactivated_at'/)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0069_security_fixes\.sql'/)
    expect(sql).toMatch(/RAISE EXCEPTION '[^']*0026_migration_ledger\.sql'/)
  })

  test('odkazované migrace existují', () => {
    const files = readdirSync('supabase/migrations')
    for (const f of ['0002_auth_and_team.sql', '0026_migration_ledger.sql', '0069_security_fixes.sql']) {
      expect(files).toContain(f)
    }
  })

  test('schema_migration nese 0073, idempotentně', () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0073'[^;]*ON CONFLICT \(version\) DO NOTHING;/)
  })
})

describe('0073 — trigger team_member_guard_privileged', () => {
  const header = fnHeader('team_member_guard_privileged')
  const body = fnBody('team_member_guard_privileged')

  test('SECURITY INVOKER (jinak by current_user byl vlastník a pojistka nic nechytila), pevný search_path', () => {
    expect(header).not.toMatch(/SECURITY DEFINER/i)
    expect(header).toMatch(/SET search_path = public, pg_temp/)
    expect(header).toMatch(/RETURNS trigger/)
  })

  test('vyjmuté role jsou přesně ty z 0069 a výjimka je před kontrolou řádku', () => {
    const exempt = (b: string) => /current_user IN \(([^)]*)\)/.exec(b)?.[1]
    expect(exempt(body)).toBe("'postgres', 'supabase_admin', 'service_role'")
    expect(exempt(body)).toBe(exempt(fnBody('team_member_guard_privileged', sql0069)))
    expect(body).toMatch(/IF current_user IN \([^)]*\) THEN\s+RETURN NEW;/)
    expect(body.indexOf('current_user IN')).toBeLessThan(body.indexOf('to_jsonb'))
  })

  test('ostatní smí změnit nejvýš full_name (celý řádek jako jsonb), jinak 42501', () => {
    expect(body).toMatch(/\(to_jsonb\(NEW\) - 'full_name'\) IS DISTINCT FROM \(to_jsonb\(OLD\) - 'full_name'\)/)
    expect(body).toMatch(/RAISE EXCEPTION '[^']+' USING ERRCODE = '42501'/)
    // žádný pevný výčet sloupců — nový sloupec je chráněný automaticky
    expect(body).not.toMatch(/NEW\.\w+/)
  })

  test('BEFORE UPDATE FOR EACH ROW, idempotentně; funkce není pro klienty', () => {
    expect(sql).toContain('DROP TRIGGER IF EXISTS team_member_guard_privileged ON team_member;')
    expect(sql).toMatch(
      /CREATE TRIGGER team_member_guard_privileged\s+BEFORE UPDATE ON team_member\s+FOR EACH ROW EXECUTE FUNCTION team_member_guard_privileged\(\);/,
    )
    expect(sql).toContain('REVOKE ALL ON FUNCTION team_member_guard_privileged() FROM PUBLIC, anon, authenticated;')
  })

  // Tatáž logika v JS nad SQL literálem: všechno, co 0069 hlídá, se odmítá
  // dál, navíc weekly_capacity_hours (0062) a libovolný budoucí sloupec;
  // samotné full_name projde.
  test('simulace: co nevyjmutá role smí a nesmí', () => {
    const allowed = /to_jsonb\(NEW\) - '(\w+)'/.exec(body)![1]
    expect(allowed).toBe('full_name')
    const row = {
      id: 'u1', full_name: 'A', email: 'a@x.cz', role: 'lektor', is_admin: false,
      manager_id: null, deactivated_at: null, weekly_capacity_hours: 40, created_at: 't',
    }
    const norm = (r: Record<string, unknown>) => JSON.stringify({ ...r, [allowed]: undefined })
    const blocks = (next: Record<string, unknown>) => norm(next) !== norm(row)
    expect(blocks({ ...row, full_name: 'B' })).toBe(false)
    const guarded0069 = [...fnBody('team_member_guard_privileged', sql0069).matchAll(/NEW\.(\w+) IS DISTINCT FROM/g)].map((m) => m[1])
    expect(guarded0069).toEqual(['id', 'email', 'role', 'is_admin', 'manager_id', 'deactivated_at'])
    for (const col of guarded0069) expect(blocks({ ...row, [col]: 'changed' }), col).toBe(true)
    expect(blocks({ ...row, weekly_capacity_hours: 80 })).toBe(true)
    expect(blocks({ ...row, future_column: 1 })).toBe(true)
  })
})

describe('0073 — práva', () => {
  test('REVOKE zápisu i z PUBLIC, včetně REFERENCES a TRIGGER', () => {
    expect(sql).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON team_member FROM PUBLIC, anon, authenticated;',
    )
  })

  test('žádná politika ani zápisový grant na team_member; SELECT se neodebírá', () => {
    expect(sql).not.toMatch(/CREATE POLICY\s+\w+\s+ON\s+(public\.)?team_member/i)
    expect(sql).not.toMatch(/GRANT\s+[^;]*\b(UPDATE|INSERT|DELETE)\b[^;]*ON\s+(TABLE\s+)?(public\.)?team_member\b/i)
    expect(sql).not.toMatch(/REVOKE\s+(ALL|SELECT)[^;]*ON\s+(TABLE\s+)?(public\.)?team_member\b/i)
  })

  test('kontrola na konci: anon/authenticated nesmí mít UPDATE tabulkově ani na sloupec', () => {
    expect(sql).toMatch(/ARRAY\['anon', 'authenticated'\]/)
    expect(sql).toMatch(/has_table_privilege\(r, 'public\.team_member', 'UPDATE'\)/)
    expect(sql).toMatch(/has_any_column_privilege\(r, 'public\.team_member', 'UPDATE'\)/)
    expect(sql).toMatch(/RAISE EXCEPTION '0073: role % má po REVOKE pořád UPDATE/)
    expect(sql.indexOf('has_table_privilege')).toBeGreaterThan(sql.indexOf('REVOKE INSERT, UPDATE'))
  })
})

describe('0073 — aplikace nezávisí na zápisu do team_member s uživatelskou session', () => {
  test('zápisy do team_member v kódu jdou jen přes admin klienta', () => {
    const sources = ['app', 'components', 'core', 'domain', 'lib'].flatMap((dir) =>
      (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => `${dir}/${f}`),
    )
    const writes = sources.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/(\w+)\s*\.from\('team_member'\)\s*\.(update|insert|upsert|delete)\(/g)].map(
        (m) => ({ file, client: m[1] }),
      ),
    )
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w.client, w.file).toBe('admin')
  })
})
