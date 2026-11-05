// 0094 (dokumenty dodávek v SharePointu) v opravdovém Postgresu (PGlite =
// PostgreSQL ve WASM), bez sítě a bez živé DB. PGlite je v devDependencies;
// kdyby chyběl, červeně selže test/pglite-dependency.test.ts. Statické
// kontroly téže migrace: test/sp-documents-0094.test.ts.
//
// Schéma = test/helpers/auditPgliteSchema.ts + skutečné 0035/0064 (obecný audit)
// + měkký audit z 0082 (funkce) + skutečná 0094 dvakrát (idempotence).
// Požadavek PostgRESTu se simuluje transakcí se set_config('request.jwt.claims')
// a SET LOCAL ROLE.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_API, U_PM, U_SALES } from './helpers/auditPgliteSchema'

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
const M0035 = mig('0035_deal_audit_hardening.sql')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')

// Měkký audit z 0082: jen funkce (tabulky 0082 tu nejsou).
function softAuditFunctions(): string {
  const start = M0082.indexOf('CREATE OR REPLACE FUNCTION audit_row_record(')
  const end = M0082.indexOf('-- 3) Napojení tabulek')
  if (start < 0 || end < 0) throw new Error('0082: struktura se změnila, uprav vytažení měkkého auditu v testu')
  return M0082.slice(start, end)
}

// Doplněk schématu: RLS jako v 0051 a práva jako v Supabase (nové tabulky dostávají plná práva,
// migrace je musí omezit sama), stuby závislostí 0094.
const EXTRA = `
ALTER ROLE service_role BYPASSRLS;
-- Sloupec z 0082, který používá měkký audit (klíč entity bez bigint id).
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

describe.skipIf(!PGliteCtor)('0094 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

  async function as(who: { role: 'authenticated' | 'service_role' | 'postgres'; sub?: string; aal?: string }, sql: string) {
    const claims = who.role === 'postgres' ? null : JSON.stringify({ role: who.role, aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
    const prefix = [
      'BEGIN;',
      claims ? `SELECT set_config('request.jwt.claims', '${claims}', true);` : '',
      who.role === 'postgres' ? '' : `SET LOCAL ROLE ${who.role};`,
    ].join('\n')
    try {
      await run(`${prefix}\n${sql}\nCOMMIT;`)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const pm = (sql: string) => as({ role: 'authenticated', sub: U_PM }, sql)
  const svc = (sql: string) => as({ role: 'service_role' }, sql)
  const one = async <T = Row>(sql: string): Promise<T> => (await db.query<T>(sql)).rows[0]
  const lastAudit = (table: string) =>
    one<{ action: string; actor_type: string; actor_id: string | null; before: Row | null; after: Row | null }>(
      `select action, actor_type, actor_id, before, after from audit_event where entity_table = '${table}' order by id desc limit 1`)
  const auditCount = async (where = 'true') => (await one<{ n: number }>(`select count(*)::int as n from audit_event where ${where}`)).n

  let engagementId = 0
  let docId = 0
  let v1 = 0
  let v2 = 0

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(M0035)
    await run(M0064)
    await run(softAuditFunctions())
    await run(EXTRA)
    // Dokument z doby před 0094 — musí přežít migraci beze změny.
    await run(`INSERT INTO account (name) VALUES ('Klient');
      INSERT INTO engagement (account_id, kind) VALUES (1, 'ai_workshop');
      INSERT INTO engagement_document (engagement_id, title, url, kind)
        VALUES (1, 'Starý odkaz', 'https://mummiesdaddies.sharepoint.com/a', 'podklad');`)
    await run(M0094)
    await run(M0094) // idempotence
    engagementId = (await one<{ id: number }>('select id from engagement limit 1')).id
    docId = (await one<{ id: number }>('select id from engagement_document limit 1')).id
  })

  test('ledger 0094, žádné varování a starý dokument dostal výchozí typ a stav', async () => {
    expect((await one<{ n: number }>(`select count(*)::int as n from schema_migration where version = '0094'`)).n).toBe(1)
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
    const d = await one<Row>('select doc_type, status, drive_id, item_id, approved_at, source_state from engagement_document where id = ' + docId)
    expect(d).toEqual({ doc_type: 'jine', status: 'draft', drive_id: null, item_id: null, approved_at: null, source_state: null })
  })

  test('identita je celá, nebo žádná; jen bezpečné znaky; soubor jen jednou v dodávce', async () => {
    await expect(pm(`UPDATE engagement_document SET drive_id = '${DRIVE}' WHERE id = ${docId};`)).rejects.toThrow(/identity_check/)
    await expect(pm(`UPDATE engagement_document SET drive_id = 'b!x/../me', item_id = '${ITEM}' WHERE id = ${docId};`)).rejects.toThrow(/identity_check/)
    await pm(`UPDATE engagement_document SET drive_id = '${DRIVE}', item_id = '${ITEM}', doc_type = 'nabidka',
      e_tag = '"e1"', c_tag = '"c1"', version_label = '1.0', last_modified_at = now(), last_modified_by = 'Jana', source_state = 'ok' WHERE id = ${docId};`)
    await expect(pm(`INSERT INTO engagement_document (engagement_id, title, url, kind, drive_id, item_id)
      VALUES (${engagementId}, 'Duplicita', 'https://mummiesdaddies.sharepoint.com/b', 'jine', '${DRIVE}', '${ITEM}');`)).rejects.toThrow(/item_uidx|duplicate/)
  })

  test('doc_type a status mají číselník; nový dokument od člověka začíná jako koncept', async () => {
    await expect(pm(`UPDATE engagement_document SET doc_type = 'faktura' WHERE id = ${docId};`)).rejects.toThrow(/doc_type_check/)
    await expect(svc(`UPDATE engagement_document SET status = 'hotovo' WHERE id = ${docId};`)).rejects.toThrow(/status_check/)
    await expect(pm(`INSERT INTO engagement_document (engagement_id, title, url, kind, status, approved_at, status_changed_at)
      VALUES (${engagementId}, 'X', 'https://mummiesdaddies.sharepoint.com/x', 'jine', 'approved', now(), now());`)).rejects.toThrow(/začíná jako koncept/)
  })

  test('verze píše jen server; klient je jen čte', async () => {
    await expect(pm(`INSERT INTO engagement_document_version (document_id, c_tag, observed_by, reason)
      VALUES (${docId}, 'c-fake', 'user:${U_PM}', 'linked');`)).rejects.toThrow(/permission denied/)
    await svc(`INSERT INTO engagement_document_version (document_id, e_tag, c_tag, version_label, observed_by, reason)
      VALUES (${docId}, '"e1"', '"c1"', '1.0', 'user:${U_PM}', 'linked'),
             (${docId}, '"e2"', '"c2"', '2.0', 'system:sharepoint-doc-sync', 'sync');`)
    ;[v1, v2] = (await db.query<{ id: number }>(`select id from engagement_document_version where document_id = ${docId} order by id`)).rows.map((r) => r.id)
    // Řádek bez jakékoli verze a s cizím pozorovatelem se nezapíše.
    await expect(svc(`INSERT INTO engagement_document_version (document_id, observed_by, reason) VALUES (${docId}, 'system:x', 'sync');`)).rejects.toThrow(/known_check/)
    await expect(svc(`INSERT INTO engagement_document_version (document_id, c_tag, observed_by, reason) VALUES (${docId}, 'c', 'kdokoli', 'sync');`)).rejects.toThrow(/observed_by_check/)
    await expect(pm(`UPDATE engagement_document_version SET version_label = '9.9' WHERE id = ${v1};`)).rejects.toThrow(/permission denied/)
    await expect(pm(`DELETE FROM engagement_document_version WHERE id = ${v1};`)).rejects.toThrow(/permission denied/)
    // Člen týmu (AAL2) je čte.
    await pm(`SELECT 1 FROM engagement_document_version;`)
  })

  test('schválení: kdo a kdy z auth.uid(), připíchnutá verze, audit s hodnotami a bez identity souboru', async () => {
    await pm(`UPDATE engagement_document SET status = 'approved', approved_version_id = ${v1}, status_changed_by = '${U_API}' WHERE id = ${docId};`)
    const d = await one<Row>(`select status, status_changed_by, approved_by, approved_version_id, approved_at is not null as has_at, status_changed_at is not null as has_changed from engagement_document where id = ${docId}`)
    // Podvržený status_changed_by se přepíše přihlášeným členem.
    expect(d).toEqual({ status: 'approved', status_changed_by: U_PM, approved_by: U_PM, approved_version_id: v1, has_at: true, has_changed: true })
    const a = await lastAudit('engagement_document')
    expect(a).toMatchObject({ action: 'engagement_document.updated', actor_type: 'user', actor_id: U_PM })
    expect(a.after).toMatchObject({ status: 'approved', status_changed_by: U_PM, approved_by: U_PM, approved_version_id: v1 })
    const text = JSON.stringify(a)
    expect(text).not.toContain(DRIVE)
    expect(text).not.toContain(ITEM)
    expect(text).not.toContain('"e1"')
  })

  test('připíchnutá verze musí patřit tomu samému dokumentu', async () => {
    await run(`INSERT INTO engagement_document (engagement_id, title, url, kind) VALUES (${engagementId}, 'Druhý', 'https://mummiesdaddies.sharepoint.com/druhy', 'jine');`)
    const other = (await one<{ id: number }>(`select id from engagement_document where title = 'Druhý'`)).id
    await expect(pm(`UPDATE engagement_document SET status = 'approved', approved_version_id = ${v1} WHERE id = ${other};`)).rejects.toThrow(/nepatří k dokumentu/)
  })

  test('koncept nemá schválení; schválený musí mít čas schválení', async () => {
    await expect(svc(`UPDATE engagement_document SET approved_at = NULL WHERE id = ${docId};`)).rejects.toThrow(/approval_check/)
  })

  test('přechody: schváleno → přijato ani koncept → odesláno lidem neprojdou', async () => {
    await expect(pm(`UPDATE engagement_document SET status = 'accepted' WHERE id = ${docId};`)).rejects.toThrow(/není povolený/)
    await run(`INSERT INTO engagement_document (engagement_id, title, url, kind) VALUES (${engagementId}, 'Koncept', 'https://mummiesdaddies.sharepoint.com/koncept', 'jine');`)
    const draft = (await one<{ id: number }>(`select id from engagement_document where title = 'Koncept'`)).id
    await expect(pm(`UPDATE engagement_document SET status = 'sent' WHERE id = ${draft};`)).rejects.toThrow(/není povolený/)
  })

  test('nové schválení aktuální verze posune základ kontroly (approved_at/by)', async () => {
    await run(`UPDATE engagement_document SET approved_at = now() - interval '5 days' WHERE id = ${docId};`)
    await pm(`UPDATE engagement_document SET approved_version_id = ${v2} WHERE id = ${docId};`)
    const d = await one<{ approved_version_id: number; fresh: boolean; approved_by: string }>(
      `select approved_version_id, approved_at > now() - interval '1 minute' as fresh, approved_by from engagement_document where id = ${docId}`)
    expect(d).toEqual({ approved_version_id: v2, fresh: true, approved_by: U_PM })
  })

  test('odesláno; přijato jen s milníkem, který nese doklad akceptace („Odesláno ≠ přijato")', async () => {
    await pm(`UPDATE engagement_document SET status = 'sent' WHERE id = ${docId};`)
    // Bez milníku ne.
    await expect(pm(`UPDATE engagement_document SET status = 'accepted' WHERE id = ${docId};`)).rejects.toThrow(/dokladem akceptace/)
    // Milník čekající na schválení klientem ne.
    await run(`INSERT INTO engagement_milestone (engagement_id, title, status) VALUES (${engagementId}, 'Nabídka klientovi', 'ceka_na_schvaleni');
      UPDATE engagement_document SET milestone_id = (SELECT id FROM engagement_milestone LIMIT 1) WHERE id = ${docId};`)
    await expect(pm(`UPDATE engagement_document SET status = 'accepted' WHERE id = ${docId};`)).rejects.toThrow(/dokladem akceptace/)
    // Přijatý milník s dokladem ano; milník ukáže na přijatou verzi.
    await run(`INSERT INTO evidence (source_kind, source_id) VALUES ('file', 'engagement_document:${docId}@v${v2}');
      UPDATE engagement_milestone SET status = 'prijato', accepted_at = now(),
        acceptance_evidence_id = (SELECT max(id) FROM evidence), acceptance_document_version_id = ${v2};`)
    await pm(`UPDATE engagement_document SET status = 'accepted' WHERE id = ${docId};`)
    const d = await one<Row>(`select status, status_changed_by from engagement_document where id = ${docId}`)
    expect(d).toEqual({ status: 'accepted', status_changed_by: U_PM })
    const m = await one<Row>('select acceptance_document_version_id from engagement_milestone limit 1')
    expect(m).toEqual({ acceptance_document_version_id: v2 })
    // Přijato je konec.
    await expect(pm(`UPDATE engagement_document SET status = 'draft' WHERE id = ${docId};`)).rejects.toThrow(/není povolený/)
  })

  test('zpět do konceptu zruší schválení i připíchnutou verzi', async () => {
    await run(`UPDATE engagement_document SET status = 'draft' WHERE id = ${docId};
      UPDATE engagement_document SET status = 'approved', approved_version_id = ${v1}, approved_at = now(), status_changed_at = now() WHERE id = ${docId};`)
    await pm(`UPDATE engagement_document SET status = 'draft' WHERE id = ${docId};`)
    const d = await one<Row>(`select status, approved_at, approved_by, approved_version_id from engagement_document where id = ${docId}`)
    expect(d).toEqual({ status: 'draft', approved_at: null, approved_by: null, approved_version_id: null })
  })

  test('denní kontrola (servisní klíč): source_checked_at není auditní událost, změna verze ano — jen názvem sloupce', async () => {
    const before = await auditCount(`entity_table = 'engagement_document'`)
    await svc(`UPDATE engagement_document SET source_checked_at = now() WHERE id = ${docId};`)
    expect(await auditCount(`entity_table = 'engagement_document'`)).toBe(before)
    await svc(`UPDATE engagement_document SET e_tag = '"e3"', c_tag = '"c3"', version_label = '3.0', last_modified_by = 'Petr' WHERE id = ${docId};`)
    const a = await lastAudit('engagement_document')
    expect(a.action).toBe('engagement_document.updated')
    expect(a.after).toMatchObject({ version_label: '3.0' })
    expect((a.after as { _columns: string[] })._columns).toEqual(['c_tag', 'e_tag', 'last_modified_by', 'version_label'])
    expect(JSON.stringify(a)).not.toMatch(/"c3"|Petr/)
  })

  test('nález: založí server, člen ho smí jen uzavřít; jeden otevřený nález na dokument a druh', async () => {
    await expect(pm(`INSERT INTO engagement_document_finding (document_id, kind) VALUES (${docId}, 'changed');`)).rejects.toThrow(/permission denied/)
    await svc(`INSERT INTO engagement_document_finding (document_id, kind, version_id) VALUES (${docId}, 'changed', ${v2});`)
    await expect(svc(`INSERT INTO engagement_document_finding (document_id, kind) VALUES (${docId}, 'changed');`)).rejects.toThrow(/open_uidx|duplicate/)
    await svc(`INSERT INTO engagement_document_finding (document_id, kind) VALUES (${docId}, 'missing');`)
    const f = await lastAudit('engagement_document_finding')
    expect(f).toMatchObject({ action: 'engagement_document_finding.created' })

    const id = (await one<{ id: number }>(`select id from engagement_document_finding where kind = 'changed'`)).id
    // Nic jiného než uzavření změnit nejde.
    await expect(pm(`UPDATE engagement_document_finding SET kind = 'missing' WHERE id = ${id};`)).rejects.toThrow(/permission denied/)
    await expect(pm(`UPDATE engagement_document_finding SET task_id = 1 WHERE id = ${id};`)).rejects.toThrow(/permission denied/)
    // Uzavření: kdo uzavřel z auth.uid(), i kdyby klient poslal jiného.
    await pm(`UPDATE engagement_document_finding SET resolved_at = now(), resolution = 'reapproved', resolved_by = '${U_API}' WHERE id = ${id};`)
    const r = await one<Row>(`select resolution, resolved_by from engagement_document_finding where id = ${id}`)
    expect(r).toEqual({ resolution: 'reapproved', resolved_by: U_PM })
    // Uzavřený se znovu neotevře; nesmyslné uzavření neprojde.
    await expect(pm(`UPDATE engagement_document_finding SET resolved_at = NULL, resolution = NULL WHERE id = ${id};`)).rejects.toThrow(/nejde změnit/)
    const m = (await one<{ id: number }>(`select id from engagement_document_finding where kind = 'missing'`)).id
    await expect(pm(`UPDATE engagement_document_finding SET resolved_at = now(), resolution = 'nic' WHERE id = ${m};`)).rejects.toThrow(/resolution_check/)
    // Po uzavření smí server otevřít nový nález téhož druhu.
    await svc(`INSERT INTO engagement_document_finding (document_id, kind) VALUES (${docId}, 'changed');`)
    // Automatické uzavření servisním klíčem (kontrola).
    await svc(`UPDATE engagement_document_finding SET resolved_at = now(), resolution = 'auto' WHERE document_id = ${docId} AND kind = 'missing';`)
  })

  test('nález a verze zmizí s dokumentem; vazba milníku na verzi se vynuluje', async () => {
    await run(`DELETE FROM engagement_document WHERE id = ${docId};`)
    expect((await one<{ n: number }>('select count(*)::int as n from engagement_document_version')).n).toBe(0)
    expect((await one<{ n: number }>('select count(*)::int as n from engagement_document_finding')).n).toBe(0)
    expect(await one('select acceptance_document_version_id from engagement_milestone limit 1')).toEqual({ acceptance_document_version_id: null })
  })

  test('bez AAL2 a jako anon se k nové tabulce nikdo nedostane', async () => {
    await expect(as({ role: 'authenticated', sub: U_PM, aal: 'aal1' }, `SELECT count(*) FROM engagement_document_version;`)).resolves.toBeUndefined()
    // aal1: RESTRICTIVE politika řádky skryje.
    await svc(`INSERT INTO engagement_document (engagement_id, title, url, kind) VALUES (${engagementId}, 'Nový', 'https://mummiesdaddies.sharepoint.com/novy', 'jine');`)
    const nid = (await one<{ id: number }>(`select id from engagement_document where title = 'Nový'`)).id
    await svc(`INSERT INTO engagement_document_version (document_id, c_tag, observed_by, reason) VALUES (${nid}, 'c', 'system:x', 'sync');`)
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub: U_SALES, aal: 'aal1' })])
      await db.query('SET LOCAL ROLE authenticated')
      expect((await db.query('SELECT 1 FROM engagement_document_version')).rows).toHaveLength(0)
    } finally {
      await db.query('ROLLBACK')
    }
    await db.query('BEGIN')
    try {
      await db.query('SET LOCAL ROLE anon')
      await expect(db.query('SELECT 1 FROM engagement_document_version')).rejects.toThrow(/permission denied/)
    } finally {
      await db.query('ROLLBACK')
    }
  })
})
