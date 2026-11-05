// 0095, část D1 (identita a verze zdroje dokumentu jen pro server) v opravdovém
// Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez živé DB. Schéma jako
// v test/sp-documents-pglite.test.ts: pomocné schéma auditu + skutečné 0035/0064
// + funkce měkkého auditu 0082 + skutečná 0094, nad tím skutečná 0095 dvakrát.
// Požadavek PostgRESTu se simuluje transakcí se set_config('request.jwt.claims')
// a SET LOCAL ROLE. Část D3 (auto_intake_dismiss) hlídá
// test/intake-not-inquiry-0086-pglite.test.ts.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_PM } from './helpers/auditPgliteSchema'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

type Row = Record<string, unknown>
type Db = {
  exec: (sql: string, opts?: { onNotice?: (n: { severity: string; message: string }) => void }) => Promise<unknown>
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

const PGLITE_MODULE = '@electric-sql/pglite'
let PGliteCtor: (new () => Db) | null = null
try {
  const mod = (await import(/* @vite-ignore */ PGLITE_MODULE)) as { PGlite: new () => Db }
  PGliteCtor = mod.PGlite
} catch {
  PGliteCtor = null
}

const mig = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8')
const M0064 = mig('0064_audit_coverage.sql')
const M0082 = mig('0082_audit_gaps_partner_lockdown.sql')
const M0094 = mig('0094_sp_documents.sql')
// Jen část D1 (strážce dokumentů). Část D3 (auto_intake_dismiss) potřebuje
// schéma poptávek a běží v test/intake-not-inquiry-0086-pglite.test.ts, kde se
// aplikuje celá 0095 (včetně vstupních kontrol a zápisu do ledgeru).
const M0095_FULL = mig('0095_security_review_hardening.sql')
function documentGuardPart(): string {
  const start = M0095_FULL.indexOf('-- 1) engagement_document: identita a verze zdroje jen pro server')
  const end = M0095_FULL.indexOf('-- 2) auto_intake_dismiss')
  if (start < 0 || end < 0 || end < start) throw new Error('0095: struktura se změnila, uprav vytažení části D1 v testu')
  return M0095_FULL.slice(start, end)
}
const M0095 = documentGuardPart()
const M0035 = mig('0035_deal_audit_hardening.sql')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')

function softAuditFunctions(): string {
  const start = M0082.indexOf('CREATE OR REPLACE FUNCTION audit_row_record(')
  const end = M0082.indexOf('-- 3) Napojení tabulek')
  if (start < 0 || end < 0) throw new Error('0082: struktura se změnila, uprav vytažení měkkého auditu v testu')
  return M0082.slice(start, end)
}

// Stuby závislostí 0094/0095 a práva jako v Supabase (nové tabulky dostávají plná práva).
const EXTRA = `
ALTER ROLE service_role BYPASSRLS;
ALTER TABLE audit_event ADD COLUMN entity_ref text;
ALTER TABLE audit_event ALTER COLUMN entity_id DROP NOT NULL;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER TABLE engagement_document ENABLE ROW LEVEL SECURITY;
CREATE POLICY biz_all ON engagement_document FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
CREATE POLICY require_aal2 ON engagement_document AS RESTRICTIVE FOR ALL
  USING ((SELECT auth.jwt() ->> 'aal') = 'aal2') WITH CHECK ((SELECT auth.jwt() ->> 'aal') = 'aal2');
ALTER TABLE engagement_milestone ENABLE ROW LEVEL SECURITY;
CREATE POLICY biz_all ON engagement_milestone FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE task ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_all ON task FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
`

const DRIVE = 'b!drive-1'
const ITEM = '01ABCDEF'
const OTHER_ITEM = '01ZZZZZZ'

// Každý sloupec, který od 0095 smí měnit jen server, s hodnotou jiné než výchozí.
const PROTECTED: [string, string][] = [
  ['drive_id', `'b!jina-knihovna'`],
  ['item_id', `'${OTHER_ITEM}'`],
  ['e_tag', `'"e-podvrzeny"'`],
  ['c_tag', `'"c-podvrzeny"'`],
  ['version_label', `'9.9'`],
  ['last_modified_at', `'2020-01-01T00:00:00Z'`],
  ['last_modified_by', `'Někdo jiný'`],
  ['source_state', `'missing'`],
  ['source_checked_at', `'2020-01-01T00:00:00Z'`],
]

describe.skipIf(!PGliteCtor)('0095 (identita a verze dokumentu) v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

  async function as(who: { role: 'authenticated' | 'service_role'; sub?: string; aal?: string }, sql: string) {
    const claims = JSON.stringify({ role: who.role, aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
    try {
      await run(`BEGIN;\nSELECT set_config('request.jwt.claims', '${claims}', true);\nSET LOCAL ROLE ${who.role};\n${sql}\nCOMMIT;`)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const member = (sql: string) => as({ role: 'authenticated', sub: U_PM }, sql)
  const svc = (sql: string) => as({ role: 'service_role' }, sql)
  const one = async <T = Row>(sql: string): Promise<T> => (await db.query<T>(sql)).rows[0]

  let engagementId = 0
  let docId = 0
  let version = 0

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(M0035)
    await run(M0064)
    await run(softAuditFunctions())
    await run(EXTRA)
    await run(`INSERT INTO account (name) VALUES ('Klient');
      INSERT INTO engagement (account_id, kind) VALUES (1, 'ai_workshop');
      INSERT INTO engagement_document (engagement_id, title, url, kind)
        VALUES (1, 'Starý odkaz', 'https://mummiesdaddies.sharepoint.com/a', 'podklad');`)
    await run(M0094)
    await run(M0095)
    await run(M0095) // idempotence
    engagementId = (await one<{ id: number }>('select id from engagement limit 1')).id
    docId = (await one<{ id: number }>('select id from engagement_document limit 1')).id
    // Server (denní kontrola / akce po ověření člena) doplní identitu a verzi.
    await svc(`UPDATE engagement_document SET drive_id = '${DRIVE}', item_id = '${ITEM}', e_tag = '"e1"', c_tag = '"c1"',
      version_label = '1.0', last_modified_at = '2026-09-27T12:00:00Z', last_modified_by = 'Jana', source_state = 'ok',
      source_checked_at = now() WHERE id = ${docId};
      INSERT INTO engagement_document_version (document_id, e_tag, c_tag, version_label, observed_by, reason)
        VALUES (${docId}, '"e1"', '"c1"', '1.0', 'system:test', 'linked');`)
    version = (await one<{ id: number }>('select id from engagement_document_version limit 1')).id
  })

  test('funkce zůstala INVOKER a bez práv pro klienty, trigger je jediný, migrace nehlásí varování', async () => {
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
    const fn = await one<{ secdef: boolean; acl: string | null }>(`select prosecdef as secdef, proacl::text as acl from pg_proc where proname = 'engagement_document_workflow_guard'`)
    expect(fn.secdef).toBe(false)
    for (const role of ['anon', 'authenticated']) {
      expect((await one<{ ok: boolean }>(`select has_function_privilege('${role}', 'engagement_document_workflow_guard()', 'EXECUTE') as ok`)).ok, role).toBe(false)
    }
    const triggers = await db.query<{ tgname: string }>(`select tgname from pg_trigger where tgrelid = 'engagement_document'::regclass and tgname = 'engagement_document_workflow_guard'`)
    expect(triggers.rows).toHaveLength(1)
  })

  describe('UPDATE: člen týmu identitu ani verzi zdroje nepřepíše', () => {
    for (const [col, value] of PROTECTED) {
      test(col, async () => {
        // Identita je celá, nebo žádná: dvojice drive/item se mění společně, ať CHECK nepřebije naši hlášku.
        const set = col === 'drive_id' ? `drive_id = 'b!jina-knihovna', item_id = item_id` : `${col} = ${value}`
        await expect(member(`UPDATE engagement_document SET ${set} WHERE id = ${docId};`)).rejects.toThrow(/mění jen Cockpit ze SharePointu/)
        const d = await one<Row>(`select drive_id, item_id, e_tag, c_tag, version_label, source_state from engagement_document where id = ${docId}`)
        expect(d).toEqual({ drive_id: DRIVE, item_id: ITEM, e_tag: '"e1"', c_tag: '"c1"', version_label: '1.0', source_state: 'ok' })
      })
    }

    test('vynulování (NULL) je také změna', async () => {
      await expect(member(`UPDATE engagement_document SET e_tag = NULL, c_tag = NULL, version_label = NULL WHERE id = ${docId};`)).rejects.toThrow(/mění jen Cockpit/)
      await expect(member(`UPDATE engagement_document SET drive_id = NULL, item_id = NULL WHERE id = ${docId};`)).rejects.toThrow(/mění jen Cockpit/)
    })

    test('úplná změna najednou (přesměrování na jinou položku i s dopsanou verzí) neprojde', async () => {
      await expect(member(`UPDATE engagement_document SET item_id = '${OTHER_ITEM}', c_tag = '"c1"', e_tag = '"e1"' WHERE id = ${docId};`)).rejects.toThrow(/mění jen Cockpit/)
    })
  })

  test('člen smí dál to, co má: typ, název, odkaz, stav a připíchnutou verzi; beze změny zdroje (i „SET x = x") projde', async () => {
    await member(`UPDATE engagement_document SET doc_type = 'nabidka', title = 'Nabídka', drive_id = drive_id, e_tag = e_tag WHERE id = ${docId};`)
    await member(`UPDATE engagement_document SET status = 'approved', approved_version_id = ${version} WHERE id = ${docId};`)
    const d = await one<Row>(`select doc_type, title, status, approved_by, approved_version_id from engagement_document where id = ${docId}`)
    expect(d).toEqual({ doc_type: 'nabidka', title: 'Nabídka', status: 'approved', approved_by: U_PM, approved_version_id: version })
    await member(`UPDATE engagement_document SET status = 'draft' WHERE id = ${docId};`)
    expect((await one<Row>(`select status, approved_version_id from engagement_document where id = ${docId}`))).toEqual({ status: 'draft', approved_version_id: null })
  })

  test('INSERT od člena: identita a verze zdroje musí být prázdné, prostý dokument projde', async () => {
    const insert = (cols: string, vals: string) =>
      member(`INSERT INTO engagement_document (engagement_id, title, url, kind, ${cols}) VALUES (${engagementId}, 'Nový', 'https://mummiesdaddies.sharepoint.com/${Math.random().toString(36).slice(2)}', 'jine', ${vals});`)
    await expect(insert('drive_id, item_id', `'${DRIVE}', '${OTHER_ITEM}'`)).rejects.toThrow(/doplňuje jen Cockpit ze SharePointu/)
    await expect(insert('e_tag', `'"e"'`)).rejects.toThrow(/doplňuje jen Cockpit/)
    await expect(insert('c_tag', `'"c"'`)).rejects.toThrow(/doplňuje jen Cockpit/)
    await expect(insert('version_label', `'2.0'`)).rejects.toThrow(/doplňuje jen Cockpit/)
    await expect(insert('source_state', `'ok'`)).rejects.toThrow(/doplňuje jen Cockpit/)
    await expect(insert('last_modified_by', `'Jana'`)).rejects.toThrow(/doplňuje jen Cockpit/)
    await expect(insert('source_checked_at', `now()`)).rejects.toThrow(/doplňuje jen Cockpit/)
    await member(`INSERT INTO engagement_document (engagement_id, title, url, kind, doc_type) VALUES (${engagementId}, 'Prostý', 'https://mummiesdaddies.sharepoint.com/prosty', 'jine', 'zapis');`)
    expect((await one<{ n: number }>(`select count(*)::int as n from engagement_document where title = 'Prostý'`)).n).toBe(1)
  })

  test('servisní klíč (denní kontrola, akce po ověření člena) identitu i verzi zapisuje dál', async () => {
    await svc(`UPDATE engagement_document SET e_tag = '"e2"', c_tag = '"c2"', version_label = '2.0', last_modified_by = 'Petr', source_state = 'ok', source_checked_at = now() WHERE id = ${docId};`)
    await svc(`INSERT INTO engagement_document (engagement_id, title, url, kind, drive_id, item_id, e_tag, source_state)
      VALUES (${engagementId}, 'Ze serveru', 'https://mummiesdaddies.sharepoint.com/server', 'jine', '${DRIVE}', '${OTHER_ITEM}', '"e9"', 'ok');`)
    expect(await one<Row>(`select e_tag, version_label from engagement_document where id = ${docId}`)).toEqual({ e_tag: '"e2"', version_label: '2.0' })
    // i vrácení zpět po „missing" (soubor se objevil)
    await svc(`UPDATE engagement_document SET source_state = 'missing' WHERE id = ${docId};`)
    await svc(`UPDATE engagement_document SET source_state = 'ok' WHERE id = ${docId};`)
  })

  test('anon a člen bez AAL2 se k dokumentu nedostanou vůbec (RLS beze změny)', async () => {
    await expect(as({ role: 'authenticated', sub: U_PM, aal: 'aal1' }, `UPDATE engagement_document SET title = 'x' WHERE id = ${docId};`)).resolves.toBeUndefined()
    expect((await one<{ title: string }>(`select title from engagement_document where id = ${docId}`)).title).not.toBe('x')
  })

  test('pravidla 0094 platí dál: přechody stavu, přijetí jen s dokladem, verze jen tomuto dokumentu', async () => {
    await expect(member(`UPDATE engagement_document SET status = 'sent' WHERE id = ${docId};`)).rejects.toThrow(/není povolený/)
    await expect(member(`UPDATE engagement_document SET status = 'approved', approved_version_id = 999 WHERE id = ${docId};`)).rejects.toThrow(/nepatří k dokumentu/)
    await member(`UPDATE engagement_document SET status = 'approved', approved_version_id = ${version} WHERE id = ${docId};`)
    await member(`UPDATE engagement_document SET status = 'sent' WHERE id = ${docId};`)
    await expect(member(`UPDATE engagement_document SET status = 'accepted' WHERE id = ${docId};`)).rejects.toThrow(/dokladem akceptace/)
    // status_changed_by z klienta se přepíše auth.uid()
    const d = await one<Row>(`select status_changed_by from engagement_document where id = ${docId}`)
    expect(d).toEqual({ status_changed_by: U_PM })
  })
})
