// Pravidlo „obchodní role“ (kdo vidí obchody a částky) je zapsané na čtyřech
// místech: v SQL funkci can_see_sales() (0020, naposledy přepsaná v 0069) a ve
// třech kopiích v TypeScriptu — sees_byznys v TEAM_ROLES (lib/domain.ts: menu
// a stránky), SALES_ROLES (lib/apiKeyAuth.ts: API a MCP přes admin klienta,
// kde RLS neplatí) a DIGEST_ALLOWED_ROLES (domain/crm/digestDelivery.ts:
// příjemci přehledu). Kopie v TS jsou nutné, protože admin klient RLS obchází;
// tenhle test hlídá, že se od SQL nerozejdou. Vzor: test/hardening-0082.test.ts
// (INTERNAL_ROLES vs. is_team_member()).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { INTERNAL_ROLES, TEAM_ROLES, seesByznys } from '@/lib/domain'
import { SALES_ROLES, isSalesRole } from '@/lib/apiKeyAuth'
import { DIGEST_ALLOWED_ROLES } from '@/domain/crm/digestDelivery'

const DIR = 'supabase/migrations'
const strip = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

// Platná definice = poslední CREATE [OR REPLACE] FUNCTION can_see_sales() v pořadí
// migrací (jako by je běhač aplikoval od 0001).
function latestCanSeeSales(): { file: string; body: string } {
  let found: { file: string; body: string } | null = null
  for (const file of readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    const sql = strip(readFileSync(join(DIR, file), 'utf8'))
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?can_see_sales\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/gi)) {
      found = { file, body: m[1] }
    }
  }
  if (!found) throw new Error('can_see_sales() v migracích nenalezena')
  return found
}

const sorted = (xs: Iterable<string>) => [...xs].sort()

describe('obchodní role: SQL can_see_sales() == kopie v TypeScriptu', () => {
  const { file, body } = latestCanSeeSales()
  const lists = [...body.matchAll(/role::text\s+IN\s*\(([^)]*)\)/gi)].map((m) => m[1].match(/'(\w+)'/g)!.map((x) => x.slice(1, -1)))
  const sqlRoles = lists[0] ?? []

  test('poslední definice má jeden allowlist rolí a ignoruje deaktivované', () => {
    expect(lists, file).toHaveLength(1)
    expect(sqlRoles.length, file).toBeGreaterThan(0)
    expect(body, file).toMatch(/id\s*=\s*auth\.uid\(\)/)
    expect(body, file).toMatch(/deactivated_at\s+IS\s+NULL/i)
  })

  test('TEAM_ROLES.sees_byznys (menu a stránky) == can_see_sales()', () => {
    expect(sorted(TEAM_ROLES.filter((r) => r.sees_byznys).map((r) => r.key))).toEqual(sorted(sqlRoles))
    for (const r of TEAM_ROLES) expect(seesByznys(r.key), r.key).toBe(sqlRoles.includes(r.key))
  })

  test('SALES_ROLES (API, MCP) == can_see_sales()', () => {
    expect(sorted(SALES_ROLES)).toEqual(sorted(sqlRoles))
    for (const r of TEAM_ROLES) expect(isSalesRole(r.key), r.key).toBe(sqlRoles.includes(r.key))
  })

  test('DIGEST_ALLOWED_ROLES (příjemci přehledu) == can_see_sales()', () => {
    expect(sorted(DIGEST_ALLOWED_ROLES)).toEqual(sorted(sqlRoles))
  })

  test('obchodní role jsou podmnožinou interních (Partner nikdy); neznámá role nic', () => {
    for (const r of sqlRoles) expect(INTERNAL_ROLES, r).toContain(r)
    expect(sqlRoles).not.toContain('partner')
    for (const bad of ['partner', 'nova_role', '', null, undefined]) {
      expect(seesByznys(bad as string | null | undefined)).toBe(false)
      expect(isSalesRole(bad)).toBe(false)
    }
  })
})
