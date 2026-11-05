// Statická kontrola migrace 0058 (obchody a částky jen pro obchodní role,
// rozhodnutí majitele 2026-09-28) a serverového skrývání v UI. Bez DB —
// RLS se tu neověřuje za běhu, jen že SQL říká přesně to, co má.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = join(__dirname, '..')
const raw = readFileSync(join(ROOT, 'supabase', 'migrations', '0058_sales_visibility.sql'), 'utf8')
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

function policies(table: string): { name: string; body: string }[] {
  const re = new RegExp(`CREATE POLICY\\s+(\\w+)\\s+ON\\s+(?:public\\.)?${table}\\b([^;]*);`, 'gi')
  return [...sql.matchAll(re)].map((m) => ({ name: m[1], body: m[2] }))
}

function functionBody(name: string): { header: string; body: string } {
  const m = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${name}\\s*\\(([\\s\\S]*?)AS\\s+\\$\\$([\\s\\S]*?)\\$\\$`, 'i').exec(sql)
  if (!m) throw new Error(`funkce ${name} v 0058 chybí`)
  return { header: m[1], body: m[2] }
}

describe('0058 — deal, deal_partner a subscription jen pro can_see_sales()', () => {
  test.each(['deal', 'deal_partner', 'subscription'])('%s má RESTRICTIVE FOR ALL politiku s can_see_sales() v USING i WITH CHECK', (table) => {
    const p = policies(table)
    expect(p).toHaveLength(1)
    const body = p[0].body.replace(/\s+/g, ' ')
    expect(body).toMatch(/AS RESTRICTIVE FOR ALL/i)
    // (SELECT …) → vyhodnotí se jednou za dotaz (initPlan), ne pro každý řádek
    expect(body).toMatch(/USING \(\(SELECT can_see_sales\(\)\)\)/i)
    expect(body).toMatch(/WITH CHECK \(\(SELECT can_see_sales\(\)\)\)/i)
  })

  test('guard vyžaduje i tabulku subscription', () => {
    expect(sql).toMatch(/to_regclass\('public\.subscription'\)/)
  })

  test('samostatná tabulka nabídek neexistuje — nabídka je řádek deal (pokrytý sales_only)', () => {
    const dir = join(ROOT, 'supabase', 'migrations')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/CREATE TABLE\s+(IF NOT EXISTS\s+)?(public\.)?offers?\b/i)
    }
  })

  test('stávající politiky (biz_all, require_aal2) na deal/deal_partner se nemažou', () => {
    expect(sql).not.toMatch(/DROP POLICY[^;]*\b(biz_all|require_aal2)\b[^;]*ON\s+deal/i)
    expect(sql).not.toMatch(/DROP POLICY[^;]*require_aal2/i)
  })
})

describe('0058 — deal_public: jen id, název a „vyhráno"', () => {
  const fn = functionBody('deal_public')

  test('SECURITY DEFINER s pevným search_path', () => {
    expect(fn.header).toMatch(/SECURITY DEFINER/i)
    expect(fn.header).toMatch(/SET\s+search_path\s*=\s*public,\s*pg_temp/i)
  })

  test('vrací přesně id, account_id, title, is_won', () => {
    const m = /RETURNS TABLE\s*\(([^)]*)\)/i.exec(fn.header)
    expect(m).not.toBeNull()
    const cols = m![1].split(',').map((c) => c.trim().split(/\s+/)[0])
    expect(cols).toEqual(['id', 'account_id', 'title', 'is_won'])
  })

  test('brána: přihlášený + AAL2 + člen týmu, jinak 42501', () => {
    expect(fn.body).toMatch(/auth\.uid\(\)\s+IS NULL/i)
    expect(fn.body).toMatch(/auth\.jwt\(\)\s*->>\s*'aal'/i)
    expect(fn.body).toMatch(/'aal2'/)
    expect(fn.body).toMatch(/NOT\s+is_team_member\(\)/i)
    expect((fn.body.match(/ERRCODE\s*=\s*'42501'/g) ?? []).length).toBe(3)
    // brána předchází dotazu
    expect(fn.body.indexOf('is_team_member')).toBeLessThan(fn.body.indexOf('RETURN QUERY'))
  })

  test('nesahá na částky, pravděpodobnost, další kroky ani vlastníka', () => {
    for (const col of ['amount', 'probability', 'next_step', 'cogs', 'client_paid', 'owner_id', 'forecast', 'margin']) {
      expect(fn.body.toLowerCase()).not.toContain(col)
    }
  })

  test('volat smí jen authenticated (ne PUBLIC, ne anon)', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION deal_public\(bigint\) FROM PUBLIC/i)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION deal_public\(bigint\) FROM anon/i)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION deal_public\(bigint\) TO authenticated/i)
  })
})

describe('0058 — pohledy nad deal znovu security_invoker', () => {
  test.each([
    'v_account_rollup', 'v_pipeline_by_line', 'v_partner_attribution', 'v_contracted_over_time',
  ])('%s je v seznamu pro ALTER VIEW … SET (security_invoker = on)', (view) => {
    expect(sql).toContain(`'${view}'`)
    expect(sql).toMatch(/ALTER VIEW public\.%I SET \(security_invoker = on\)/)
  })

  test('0025 a 0027 opravdu přepsaly v_account_rollup bez WITH (security_invoker) — proto oprava', () => {
    for (const f of ['0025_fix_account_rollup.sql', '0027_subscription_lifecycle.sql']) {
      const src = readFileSync(join(ROOT, 'supabase', 'migrations', f), 'utf8')
      expect(src).toMatch(/CREATE OR REPLACE VIEW v_account_rollup AS/)
      expect(src).not.toMatch(/security_invoker/)
    }
  })
})

describe('0058 — contact: DELETE jen admin', () => {
  const p = policies('contact')
  const byName = new Map(p.map((x) => [x.name, x.body.replace(/\s+/g, ' ')]))

  test('biz_all FOR ALL se ruší a nahrazuje SELECT/INSERT/UPDATE/DELETE', () => {
    expect(sql).toMatch(/DROP POLICY IF EXISTS biz_all ON contact;/i)
    expect([...byName.keys()].sort()).toEqual(['contact_delete_admin', 'contact_insert', 'contact_select', 'contact_update'])
    expect(p.every((x) => !/FOR ALL/i.test(x.body))).toBe(true)
  })

  test('SELECT/INSERT/UPDATE pro tým, DELETE jen admin', () => {
    expect(byName.get('contact_select')).toMatch(/FOR SELECT USING \(\(SELECT is_team_member\(\)\)\)/i)
    expect(byName.get('contact_insert')).toMatch(/FOR INSERT WITH CHECK \(\(SELECT is_team_member\(\)\)\)/i)
    expect(byName.get('contact_update')).toMatch(/FOR UPDATE USING \(\(SELECT is_team_member\(\)\)\) WITH CHECK \(\(SELECT is_team_member\(\)\)\)/i)
    expect(byName.get('contact_delete_admin')).toMatch(/FOR DELETE USING \(\(SELECT is_team_member\(\)\) AND \(SELECT is_admin\(\)\)\)/i)
    expect(byName.get('contact_delete_admin')).not.toMatch(/is_team_member\(\)\)?\s+OR/i)
  })

  test('contact nemá ALTER/DROP require_aal2 — AAL2 z 0007 zůstává', () => {
    expect(sql).not.toMatch(/require_aal2\s+ON\s+contact/i)
  })
})

describe('0058 — politiky volají funkce přes (SELECT …)', () => {
  test('žádné holé volání can_see_sales/is_team_member/is_admin v USING/WITH CHECK', () => {
    for (const m of sql.matchAll(/CREATE POLICY[^;]*;/gi)) {
      const bare = m[0].replace(/\(SELECT\s+\w+\(\)\)/gi, '')
      expect(bare, m[0]).not.toMatch(/\b(can_see_sales|is_team_member|is_admin)\(\)/i)
    }
  })
})

describe('0058 — idempotence a ledger', () => {
  test('každá CREATE POLICY má předem DROP POLICY IF EXISTS na stejném jménu a tabulce', () => {
    for (const m of sql.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+(\w+)/gi)) {
      const drop = new RegExp(`DROP POLICY IF EXISTS\\s+${m[1]}\\s+ON\\s+${m[2]}\\s*;`, 'i')
      const dropIdx = sql.search(drop)
      expect(dropIdx, `${m[1]} ON ${m[2]}`).toBeGreaterThanOrEqual(0)
      expect(dropIdx).toBeLessThan(m.index!)
    }
  })

  test('guard na prerekvizity (deal, is_admin, can_see_sales)', () => {
    expect(sql).toMatch(/to_regprocedure\('public\.can_see_sales\(\)'\)/)
    expect(sql).toMatch(/to_regprocedure\('public\.is_admin\(\)'\)/)
    expect(sql).toMatch(/to_regclass\('public\.deal'\)/)
  })

  test("zapisuje '0058' do schema_migration s ON CONFLICT DO NOTHING", () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s*VALUES \('0058',[^;]*ON CONFLICT \(version\) DO NOTHING;/)
  })

  test('hlavička je česky a odkazuje na rozhodnutí majitele', () => {
    expect(raw.split('\n')[0]).toMatch(/^-- 0058 — /)
    expect(raw).toContain('2026-09-28')
  })
})

describe('UI: stránky s obchody je skrývají serverově podle canCurrentUserSeeSales', () => {
  test.each([
    'app/cockpit/clients/page.tsx',
    'app/cockpit/clients/[id]/page.tsx',
    'app/cockpit/tasks/page.tsx',
    'app/cockpit/hledat/page.tsx',
  ])('%s volá canCurrentUserSeeSales a deal načítá jen pro obchodní role', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8')
    expect(src).toContain("import { canCurrentUserSeeSales } from '@/lib/queries/access'")
    expect(src).toMatch(/canCurrentUserSeeSales\(\)/)
    // žádné bezpodmínečné načtení obchodů
    expect(src).not.toMatch(/Promise\.all\(\[\s*(listAccounts\(\), )?getSalesDeals\(\)/)
    expect(src).not.toMatch(/\[\s*getDealsForAccount\(accountId\),/)
  })

  test.each([
    'app/cockpit/clients/[id]/predplatne/[subId]/edit/page.tsx',
    'app/cockpit/nabidka/import/page.tsx',
    'app/cockpit/import/zakazky/page.tsx',
  ])('%s přesměruje role bez obchodu (předplatné / import nabídky)', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8')
    expect(src).toMatch(/if \(!await canCurrentUserSeeSales\(\)\) redirect\(/)
  })

  test('/hledat předává includeDeals podle role a skupinu Obchody vykreslí jen obchodním rolím', () => {
    const src = readFileSync(join(ROOT, 'app/cockpit/hledat/page.tsx'), 'utf8')
    expect(src).toMatch(/search\(query, \{ includeDeals: canSeeSales \}\)/)
    expect(src).toMatch(/\{canSeeSales && <ResultGroup title=\{GROUP_LABELS\.deals\}/)
  })
})
