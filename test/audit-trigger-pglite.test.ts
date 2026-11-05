// 0064 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB. PGlite je v devDependencies, v bráně (build:release) i v CI běží;
// kdyby chyběl, červeně selže test/pglite-dependency.test.ts.
// Statické kontroly téže migrace běží také
// (test/audit-coverage-0064.test.ts).
//
// Schéma (test/helpers/auditPgliteSchema.ts) je zjednodušená kopie krytých
// tabulek (sloupce podle migrací 0001–0059), stuby auth.uid()/auth.jwt()
// jako v Supabase a role authenticated/service_role. Požadavek PostgRESTu se simuluje transakcí se
// set_config('request.jwt.claims' | 'request.headers') a SET LOCAL ROLE.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_API, U_PM, U_SALES } from './helpers/auditPgliteSchema'

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

const MIG = readFileSync('supabase/migrations/0064_audit_coverage.sql', 'utf8')
// 0035 bez části pro calendar_token (0031) a bez ledgeru — jen triggery obchodu.
const M0035 = readFileSync('supabase/migrations/0035_deal_audit_hardening.sql', 'utf8')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')

type Audit = {
  id: number
  actor_type: string
  actor_id: string | null
  action: string
  entity_table: string
  entity_id: number
  before: Row | null
  after: Row | null
  evidence_id: number | null
  info_state: string | null
}

describe.skipIf(!PGliteCtor)('0064 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

  // Jeden požadavek jako z PostgRESTu: JWT claims, hlavičky, SET LOCAL ROLE.
  async function as(
    who: { role: 'authenticated' | 'service_role' | 'postgres'; sub?: string; headers?: Record<string, string> },
    sql: string,
  ) {
    const claims = who.role === 'postgres' ? null : JSON.stringify({ role: who.role, aal: 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
    const prefix = [
      'BEGIN;',
      claims ? `SELECT set_config('request.jwt.claims', '${claims}', true);` : '',
      who.headers ? `SELECT set_config('request.headers', '${JSON.stringify(who.headers)}', true);` : '',
      who.role === 'postgres' ? '' : `SET LOCAL ROLE ${who.role};`,
    ].join('\n')
    try {
      await run(`${prefix}\n${sql}\nCOMMIT;`)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const last = async (table: string) =>
    (await db.query<Audit>('select * from audit_event where entity_table = $1 order by id desc limit 1', [table])).rows[0]
  const count = async (where = 'true') =>
    (await db.query<{ n: number }>(`select count(*)::int as n from audit_event where ${where}`)).rows[0].n

  let accountId = 0

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(M0035)
    await run(MIG)
    await run(MIG) // idempotence
  }, 60_000)

  test('21 triggerů, ledger 0064, žádné varování o chybějícím sloupci', async () => {
    expect((await db.query<{ n: number }>(`select count(*)::int as n from pg_trigger where tgname = 'audit_row_change'`)).rows[0].n).toBe(21)
    expect((await db.query<{ n: number }>(`select count(*)::int as n from schema_migration where version = '0064'`)).rows[0].n).toBe(1)
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
  })

  test('přihlášený člověk: aktér user, human_confirmed, jméno/IČO/poznámka jen názvem', async () => {
    await as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO account (name, ico, notes, owner_id, industry) VALUES ('Jan Novák OSVČ', '12345678', 'volá mu Petr', '${U_SALES}', 'Výroba');`)
    const a = await last('account')
    accountId = a.entity_id
    expect(a).toMatchObject({ action: 'account.created', actor_type: 'user', actor_id: U_SALES, info_state: 'human_confirmed', before: null })
    expect(a.after).toEqual({ owner_id: U_SALES, industry: 'Výroba', is_reference: false, _columns: ['ico', 'industry', 'is_reference', 'name', 'notes', 'owner_id'] })
    expect(JSON.stringify(a)).not.toMatch(/Novák|12345678|Petr/)
  })

  test('update jen ignorovaných sloupců nic nezaloží; jinak jen změněné sloupce', async () => {
    const before = await count()
    await as({ role: 'service_role' }, `UPDATE account SET last_inbound_at = now(), updated_at = now() WHERE id = ${accountId};`)
    expect(await count()).toBe(before)
    await as({ role: 'authenticated', sub: U_SALES }, `UPDATE account SET notes = 'o panu X', owner_id = '${U_PM}' WHERE id = ${accountId};`)
    const a = await last('account')
    expect(a.before).toEqual({ owner_id: U_SALES })
    expect(a.after).toEqual({ owner_id: U_PM, _columns: ['notes', 'owner_id'] })
  })

  test('servisní klíč: aktér jen z hlavičky, jinak db-trigger:<role>; přihlášený hlavičkou nic nepřepíše', async () => {
    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `api_key:${U_API}` } },
      `INSERT INTO task (title, account_id) VALUES ('Zavolat panu Novákovi', ${accountId});`)
    expect(await last('task')).toMatchObject({ actor_type: 'api_key', actor_id: U_API, info_state: null })

    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `user:${U_SALES}` } },
      `INSERT INTO task (title) VALUES ('za člověka');`)
    expect(await last('task')).toMatchObject({ actor_type: 'user', actor_id: U_SALES, info_state: 'human_confirmed' })

    await as({ role: 'service_role' }, `INSERT INTO task (title) VALUES ('bez hlavičky');`)
    expect(await last('task')).toMatchObject({ actor_type: 'system', actor_id: 'db-trigger:service_role' })

    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': 'admin:root' } }, `INSERT INTO task (title) VALUES ('špatná');`)
    expect(await last('task')).toMatchObject({ actor_type: 'system', actor_id: 'db-trigger:service_role' })

    await as({ role: 'postgres' }, `INSERT INTO task (title) VALUES ('sql');`)
    expect(await last('task')).toMatchObject({ actor_type: 'system', actor_id: 'db-trigger:postgres' })

    await as({ role: 'authenticated', sub: U_PM, headers: { 'x-cockpit-audit-actor': `user:${U_SALES}` } },
      `INSERT INTO task (title) VALUES ('podvrh');`)
    expect(await last('task')).toMatchObject({ actor_type: 'user', actor_id: U_PM })
  })

  test('evidence z hlavičky jen existující; stav údaje jen jeden ze čtyř; redakce textu aktivity bez triggeru', async () => {
    await run(`INSERT INTO evidence (source_kind, source_id) VALUES ('meeting', 'wispr-1')`)
    const evId = (await db.query<{ id: number }>(`select id from evidence where source_id = 'wispr-1'`)).rows[0].id
    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `api_key:${U_API}`, 'x-cockpit-audit-evidence': String(evId), 'x-cockpit-audit-info-state': 'human_confirmed' } },
      `INSERT INTO sales_activity (account_id, kind, subject, body, source) VALUES (${accountId}, 'meeting', 'Schůzka s panem Svobodou', 'tajné', 'api');`)
    const a = await last('sales_activity')
    expect([Number(a.evidence_id), a.info_state]).toEqual([Number(evId), 'human_confirmed'])
    expect(JSON.stringify(a.after)).not.toMatch(/Svobod|tajné/)

    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': 'system:x', 'x-cockpit-audit-evidence': '999999', 'x-cockpit-audit-info-state': 'nonsense' } },
      `INSERT INTO task (title) VALUES ('x');`)
    expect(await last('task')).toMatchObject({ evidence_id: null, info_state: null })

    const before = await count()
    await as({ role: 'authenticated', sub: U_SALES }, `UPDATE sales_activity SET subject = '[odstraněno]', body = '[odstraněno]' WHERE id = ${a.entity_id};`)
    expect(await count()).toBe(before)
  })

  test('obchod: cena/fáze jen 0034/0035, další krok z API jako deal.updated, markery ignorované', async () => {
    await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO deal (account_id, title, amount_one_time) VALUES (${accountId}, 'Workshop pro pana Nováka', 100000);`)
    const dealId = (await last('deal')).entity_id
    await as({ role: 'authenticated', sub: U_SALES }, `UPDATE deal SET amount_one_time = 200000, stage = 'diagnostika' WHERE id = ${dealId};`)
    expect(await count(`action = 'deal.updated'`)).toBe(0)
    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `api_key:${U_API}` } },
      `UPDATE deal SET next_step = 'zavolat panu Novákovi', next_step_due = '2026-10-01', last_activity_at = now(), follow_up_nudged_on = '2026-10-02' WHERE id = ${dealId};`)
    const d = await last('deal')
    expect(d).toMatchObject({ action: 'deal.updated', actor_type: 'api_key', actor_id: U_API, before: { next_step_due: null } })
    expect(d.after).toEqual({ next_step_due: '2026-10-01', _columns: ['next_step', 'next_step_due'] })
  })

  test('akceptace milníku nese evidenci ze sloupce; kaskáda ze smazání firmy zanechá stopu', async () => {
    await as({ role: 'authenticated', sub: U_PM }, `INSERT INTO engagement (account_id, kind, roi_czk_year) VALUES (${accountId}, 'edu', 500000);`)
    const eng = await last('engagement')
    expect(eng.after).not.toHaveProperty('roi_czk_year')
    await as({ role: 'authenticated', sub: U_PM }, `INSERT INTO engagement_milestone (engagement_id, title, status) VALUES (${eng.entity_id}, 'Mapa pro paní Dvořákovou', 'ceka_na_schvaleni');`)
    const msId = (await last('engagement_milestone')).entity_id
    await run(`INSERT INTO evidence (source_kind, source_id) VALUES ('file', 'engagement_document:1')`)
    const ev = (await db.query<{ id: number }>(`select id from evidence where source_id = 'engagement_document:1'`)).rows[0].id
    await as({ role: 'authenticated', sub: U_PM }, `UPDATE engagement_milestone SET status = 'prijato', accepted_at = now(), acceptance_evidence_id = ${ev} WHERE id = ${msId};`)
    expect(await last('engagement_milestone')).toMatchObject({ evidence_id: ev, info_state: 'human_confirmed' })

    await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO account (name) VALUES ('Dcera');
      INSERT INTO relationship (parent_account_id, child_account_id) SELECT ${accountId}, max(id) FROM account;`)
    const before = await count(`action IN ('relationship.deleted', 'account.deleted')`)
    await as({ role: 'postgres' }, `DELETE FROM account WHERE name = 'Dcera';`)
    expect(await count(`action IN ('relationship.deleted', 'account.deleted')`)).toBe(before + 2)
  })

  test('historie obchodů a předplatného jen pro obchodní role (audit_event_sales_only)', async () => {
    await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO subscription (account_id, product, mrr) VALUES (${accountId}, 'Platforma', 9900);`)
    const seen = async (sub: string, where: string) => {
      await run(`BEGIN; SELECT set_config('request.jwt.claims', '{"role":"authenticated","sub":"${sub}","aal":"aal2"}', true);
        SET LOCAL ROLE authenticated; SELECT set_config('x.seen', (SELECT count(*)::text FROM audit_event WHERE ${where}), false); COMMIT;`)
      return Number((await db.query<{ s: string }>(`select current_setting('x.seen') as s`)).rows[0].s)
    }
    expect(await seen(U_SALES, `entity_table IN ('deal', 'subscription')`)).toBeGreaterThan(0)
    expect(await seen(U_PM, `entity_table IN ('deal', 'subscription')`)).toBe(0)
    expect(await seen(U_PM, `entity_table = 'task'`)).toBe(await seen(U_SALES, `entity_table = 'task'`))
  })

  test('klient nesmí volat pomocné funkce; guard bez prerekvizit hlásí migraci', async () => {
    await expect(as({ role: 'authenticated', sub: U_SALES }, 'SELECT * FROM audit_request_context();')).rejects.toThrow(/permission denied/)
    const empty = new PGliteCtor!()
    await expect(empty.exec(MIG)).rejects.toThrow(/nejdřív aplikujte 0028_audit_event\.sql/)
  }, 60_000)
})
