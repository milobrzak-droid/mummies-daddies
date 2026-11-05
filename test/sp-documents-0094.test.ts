// Statická kontrola migrace 0094 (dokumenty dodávek v SharePointu) — bez databáze.
// Obecné konvence (číslování, ledger, RLS + AAL2, search_path) hlídá
// test/migrations-lint.test.ts, audit test/audit-coverage-0064.test.ts, chování
// v Postgresu test/sp-documents-pglite.test.ts; tady jde o to, co 0094 slibuje
// v hlavičce a že TypeScript drží stejné číselníky a přechody jako DB.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { GRAPH_ID_RE } from '@/connectors/graph'
import {
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  canTransitionDocument,
  nextDocumentStatuses,
  type DocumentStatus,
} from '@/domain/delivery/documents'

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const raw = readFileSync('supabase/migrations/0094_sp_documents.sql', 'utf8')
const sql = strip(raw)
const list = (m: RegExpExecArray | null) => (m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [])

describe('0094 — prerekvizity, ledger, idempotence', () => {
  test('guard je první příkaz a jmenuje migrace, na kterých stojí', () => {
    expect(sql.trim().startsWith('DO $$')).toBe(true)
    for (const dep of ['0051_engagement_document.sql', '0042_engagement_milestone.sql', '0006_tasks_and_calendar.sql',
      '0064_audit_coverage.sql', '0082_audit_gaps_partner_lockdown.sql', '0026_migration_ledger.sql', '0002_auth_and_team.sql']) {
      expect(sql).toContain(dep)
    }
  })

  test('stávající data se nepřepisují a nic se nemaže', () => {
    expect(sql).not.toMatch(/\bUPDATE\s+engagement_document\b/i)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i)
  })

  test('sloupce, tabulky a indexy jsou idempotentní', () => {
    expect(sql).toMatch(/ALTER TABLE engagement_document\s+ADD COLUMN IF NOT EXISTS drive_id text/)
    expect(sql).toMatch(/ALTER TABLE engagement_milestone\s+ADD COLUMN IF NOT EXISTS acceptance_document_version_id bigint/)
    for (const m of sql.matchAll(/CREATE TABLE\s+(IF NOT EXISTS\s+)?(\w+)/g)) expect(m[1], m[2]).toBeTruthy()
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX\s+(IF NOT EXISTS\s+)?(\w+)/g)) expect(m[1], m[2]).toBeTruthy()
    // Každé ADD CONSTRAINT je pod kontrolou pg_constraint.
    const adds = [...sql.matchAll(/ADD CONSTRAINT\s+(\w+)/g)].map((m) => m[1])
    expect(adds.length).toBeGreaterThan(5)
    for (const c of adds) expect(sql, c).toMatch(new RegExp(`conname = '${c}'`))
  })

  test('ledger nese 0094 a opakovaný běh nic nezdvojí', () => {
    expect(sql).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0094'/)
    expect(sql).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
  })
})

describe('0094 — číselníky a pravidla sedí s TypeScriptem', () => {
  test('typ dokumentu a stav', () => {
    expect(list(/doc_type IN \(([^)]*)\)/.exec(sql))).toEqual([...DOCUMENT_TYPES])
    const status = /engagement_document_status_check[\s\S]*?CHECK \(status IN \(([^)]*)\)\)/.exec(sql)
    expect(list(status)).toEqual([...DOCUMENT_STATUSES])
  })

  test('regulární výraz Graph id je v DB a v TS stejný', () => {
    const db = /drive_id ~ '(\^[^']*\$)'/.exec(sql)![1]
    expect(db).toBe(GRAPH_ID_RE.source.replace(/\\/g, ''))
    expect(sql).toContain(`item_id ~ '${db}'`)
  })

  test('přechody stavů strážce == canTransitionDocument', () => {
    const guard = /CREATE OR REPLACE FUNCTION engagement_document_workflow_guard\(\)([\s\S]*?)AS \$\$([\s\S]*?)\$\$;/.exec(sql)!
    expect(guard[1]).toMatch(/SET search_path = public, pg_temp/)
    expect(guard[1]).not.toMatch(/SECURITY DEFINER/)
    const allowed = new Set<string>()
    const body = guard[2]
    for (const m of body.matchAll(/OLD\.status = '(\w+)' AND NEW\.status (?:IN \(([^)]*)\)|= '(\w+)')/g)) {
      const targets = m[2] ? [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]) : [m[3]]
      for (const t of targets) allowed.add(`${m[1]}>${t}`)
    }
    const fromTs = new Set<string>()
    for (const from of DOCUMENT_STATUSES) {
      for (const to of DOCUMENT_STATUSES) if (canTransitionDocument(from, to)) fromTs.add(`${from}>${to}`)
    }
    expect([...allowed].sort()).toEqual([...fromTs].sort())
  })

  test('ručně jde přepnout všude, jen ne na přijato (to dělá akceptace milníku)', () => {
    const manual = (from: DocumentStatus) => nextDocumentStatuses(from)
    expect(manual('draft')).toEqual(['approved'])
    expect(manual('approved')).toEqual(['draft', 'sent'])
    expect(manual('sent')).toEqual(['draft'])
    expect(manual('accepted')).toEqual([])
  })
})

describe('0094 — práva a bezpečnost', () => {
  test('verze: append-only, klient jen čte; nález: klient smí jen uzavřít', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON engagement_document_version FROM authenticated;/)
    expect(sql).toMatch(/GRANT SELECT ON engagement_document_version TO authenticated;/)
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON engagement_document_finding FROM authenticated;/)
    expect(sql).toMatch(/GRANT UPDATE \(resolved_at, resolved_by, resolution\) ON engagement_document_finding TO authenticated;/)
    expect(sql).toMatch(/REVOKE ALL ON engagement_document_version FROM anon;/)
    expect(sql).toMatch(/REVOKE ALL ON engagement_document_finding FROM anon;/)
  })

  test('strážci nejsou SECURITY DEFINER a klientům jsou odebraní', () => {
    for (const fn of ['engagement_document_workflow_guard', 'engagement_document_finding_guard']) {
      const m = new RegExp(`CREATE OR REPLACE FUNCTION ${fn}\\(\\)([\\s\\S]*?)AS \\$\\$`).exec(sql)!
      expect(m[1], fn).toMatch(/SET search_path = public, pg_temp/)
      expect(m[1], fn).not.toMatch(/SECURITY DEFINER/)
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\(\\) FROM PUBLIC, anon, authenticated;`))
      expect(sql).toContain(`DROP TRIGGER IF EXISTS ${fn} ON`)
    }
  })

  test('žádný obsah souboru: v tabulkách není sloupec na text, náhled ani stažení', () => {
    const cols = /ALTER TABLE engagement_document\s+ADD COLUMN[\s\S]*?;/.exec(sql)![0]
    expect(cols).not.toMatch(/content|download|thumbnail|body|text_index|fulltext/i)
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS engagement_document_(?:version|finding) \(([\s\S]*?)\n\);/g)].map((m) => m[1]).join('\n')
    expect(tables).not.toMatch(/content|download|thumbnail|body|fulltext/i)
  })
})
