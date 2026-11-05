// 0087 (nesouhlas s oslovením na kontaktu) v opravdovém Postgresu (PGlite =
// PostgreSQL ve WASM), bez sítě a bez živé DB. PGlite NENÍ závislost projektu:
// bez `npm i --no-save @electric-sql/pglite` se soubor přeskočí. Statické
// kontroly téže migrace běží vždy (test/migrations-lint.test.ts,
// test/audit-coverage-0064.test.ts).
//
// Hlídá se: guard, idempotence, čas a autor nesouhlasu z databáze (klient je
// nepodvrhne), zrušení nesouhlasu vše vymaže, CHECK konzistence a délky,
// audit s hodnotou příznaku/času/autora a důvod jen názvem, RLS + AAL2.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_PM, U_SALES } from './helpers/auditPgliteSchema'

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

const M0064 = readFileSync('supabase/migrations/0064_audit_coverage.sql', 'utf8')
const M0087 = readFileSync('supabase/migrations/0087_contact_opt_out.sql', 'utf8')

// RLS na contact jako v produkci (0058 + 0007): tým čte/zakládá/upravuje, AAL2 povinné.
const RLS = `
ALTER ROLE service_role BYPASSRLS;
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_select ON contact FOR SELECT USING ((SELECT is_team_member()));
CREATE POLICY contact_insert ON contact FOR INSERT WITH CHECK ((SELECT is_team_member()));
CREATE POLICY contact_update ON contact FOR UPDATE USING ((SELECT is_team_member())) WITH CHECK ((SELECT is_team_member()));
CREATE POLICY require_aal2 ON contact AS RESTRICTIVE FOR ALL
  USING ((select auth.jwt()->>'aal') = 'aal2') WITH CHECK ((select auth.jwt()->>'aal') = 'aal2');
`

type Contact = {
  id: number
  do_not_contact: boolean
  do_not_contact_at: string | null
  do_not_contact_reason: string | null
  do_not_contact_by: string | null
}
type Audit = { action: string; actor_id: string | null; entity_id: number; before: Row | null; after: Row | null }

describe.skipIf(!PGliteCtor)('0087 v Postgresu (PGlite)', () => {
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
  const contact = async (id: number) =>
    (await db.query<Contact>('select id, do_not_contact, do_not_contact_at, do_not_contact_reason, do_not_contact_by from contact where id = $1', [id])).rows[0]
  const lastAudit = async (id: number) =>
    (await db.query<Audit>(`select * from audit_event where entity_table = 'contact' and entity_id = $1 order by id desc limit 1`, [id])).rows[0]
  const newContactId = async () => (await db.query<{ id: number }>('select max(id)::int as id from contact')).rows[0].id

  let accountId = 0

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(M0064)
    await run(RLS)
    await run(M0087)
    notices.length = 0
    await run(M0087) // idempotence
    await run(`INSERT INTO account (name) VALUES ('Alfa')`)
    accountId = (await db.query<{ id: number }>('select id from account limit 1')).rows[0].id
  }, 90_000)

  test('guard: bez audit_row_change() (0064) migrace skončí srozumitelnou chybou', async () => {
    const fresh = new PGliteCtor!()
    await fresh.exec(SCHEMA)
    await expect(fresh.exec(M0087)).rejects.toThrow(/0064_audit_coverage/)
    const cols = await fresh.query(`select 1 from information_schema.columns where table_name = 'contact' and column_name = 'do_not_contact'`)
    expect(cols.rows).toEqual([])
  }, 60_000)

  test('idempotence: druhý běh nezdvojí triggery, constrainty ani ledger; bez varování', async () => {
    const n = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n
    expect(await n(`select count(*)::int as n from pg_trigger where tgrelid = 'contact'::regclass and tgname = 'contact_do_not_contact_stamp'`)).toBe(1)
    expect(await n(`select count(*)::int as n from pg_trigger where tgrelid = 'contact'::regclass and tgname = 'audit_row_change'`)).toBe(1)
    expect(await n(`select count(*)::int as n from pg_constraint where conrelid = 'contact'::regclass and contype = 'c' and conname in ('contact_do_not_contact_reason_len', 'contact_do_not_contact_consistent')`)).toBe(2)
    expect(await n(`select count(*)::int as n from pg_constraint where conrelid = 'contact'::regclass and contype = 'f' and conname like 'contact_do_not_contact_by%'`)).toBe(1)
    expect(await n(`select count(*)::int as n from schema_migration where version = '0087'`)).toBe(1)
    expect(await n(`select count(*)::int as n from information_schema.columns where table_name = 'contact' and column_name like 'do_not_contact%'`)).toBe(4)
    expect(notices.filter((x) => x.startsWith('WARNING') || x.includes('AAL2'))).toEqual([])
  })

  test('nový kontakt bez nesouhlasu: false a prázdné údaje', async () => {
    await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO contact (account_id, full_name) VALUES (${accountId}, 'Adam Malý');`)
    expect(await contact(await newContactId())).toMatchObject({ do_not_contact: false, do_not_contact_at: null, do_not_contact_reason: null, do_not_contact_by: null })
  })

  test('člen týmu zapíše nesouhlas: kdy a kdo z databáze, podvržené hodnoty se zahodí; audit bez důvodu', async () => {
    await as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO contact (account_id, full_name, do_not_contact, do_not_contact_at, do_not_contact_by, do_not_contact_reason)
       VALUES (${accountId}, 'Petra Nováková', true, '2001-01-01', '${U_PM}', '  Řekla na veletrhu, ať jí nevoláme.  ');`)
    const id = await newContactId()
    const c = await contact(id)
    expect(c.do_not_contact).toBe(true)
    expect(c.do_not_contact_by).toBe(U_SALES)
    expect(new Date(c.do_not_contact_at!).getFullYear()).toBeGreaterThan(2001)
    expect(c.do_not_contact_reason).toBe('Řekla na veletrhu, ať jí nevoláme.')

    const a = await lastAudit(id)
    expect(a).toMatchObject({ action: 'contact.created', actor_id: U_SALES })
    expect(a.after).toMatchObject({ account_id: accountId, do_not_contact: true, do_not_contact_by: U_SALES })
    expect(a.after!.do_not_contact_at).toBeTruthy()
    expect(a.after!._columns).toEqual(expect.arrayContaining(['do_not_contact_reason', 'full_name']))
    expect(JSON.stringify(a)).not.toMatch(/veletrhu|Nováková/)
  })

  test('trvající nesouhlas: kdy a kdo se nepřepíše, důvod ano', async () => {
    await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO contact (account_id, full_name, do_not_contact) VALUES (${accountId}, 'Eva Černá', true);`)
    const id = await newContactId()
    const first = await contact(id)
    await as({ role: 'authenticated', sub: U_PM },
      `UPDATE contact SET do_not_contact_reason = 'Odhlásila se e-mailem', do_not_contact_by = '${U_PM}', do_not_contact_at = '2001-01-01' WHERE id = ${id};`)
    const c = await contact(id)
    expect(c).toMatchObject({ do_not_contact: true, do_not_contact_by: U_SALES, do_not_contact_reason: 'Odhlásila se e-mailem' })
    expect(c.do_not_contact_at).toEqual(first.do_not_contact_at)
    const a = await lastAudit(id)
    expect(a.action).toBe('contact.updated')
    expect(a.after).toEqual({ _columns: ['do_not_contact_reason'] })
  })

  test('zrušení nesouhlasu vymaže kdy, důvod i autora; audit nese původní hodnoty příznaku', async () => {
    await as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO contact (account_id, full_name, do_not_contact, do_not_contact_reason) VALUES (${accountId}, 'Karel Dvořák', true, 'GDPR námitka');`)
    const id = await newContactId()
    await as({ role: 'authenticated', sub: U_PM }, `UPDATE contact SET do_not_contact = false WHERE id = ${id};`)
    expect(await contact(id)).toMatchObject({ do_not_contact: false, do_not_contact_at: null, do_not_contact_reason: null, do_not_contact_by: null })
    const a = await lastAudit(id)
    expect(a).toMatchObject({ action: 'contact.updated', actor_id: U_PM })
    expect(a.before).toMatchObject({ do_not_contact: true, do_not_contact_by: U_SALES })
    expect(a.after).toMatchObject({ do_not_contact: false, do_not_contact_at: null, do_not_contact_by: null })
    expect(JSON.stringify(a)).not.toContain('námitka')
  })

  test('servisní zápis (bez přihlášeného): vlastní čas a autor smí, čas ne v budoucnu', async () => {
    await as({ role: 'service_role' },
      `INSERT INTO contact (account_id, full_name, do_not_contact, do_not_contact_at, do_not_contact_by)
       VALUES (${accountId}, 'Import Jedna', true, '2026-01-15T10:00:00Z', '${U_PM}');`)
    const past = await contact(await newContactId())
    expect(past.do_not_contact_by).toBe(U_PM)
    expect(new Date(past.do_not_contact_at!).toISOString()).toBe('2026-01-15T10:00:00.000Z')

    await as({ role: 'service_role' },
      `INSERT INTO contact (account_id, full_name, do_not_contact, do_not_contact_at) VALUES (${accountId}, 'Import Dva', true, '2999-01-01');`)
    const future = await contact(await newContactId())
    expect(new Date(future.do_not_contact_at!).getTime()).toBeLessThanOrEqual(Date.now() + 60_000)
    expect(future.do_not_contact_by).toBeNull()
  })

  test('CHECK: důvod nejvýš 300 znaků; nekonzistentní řádek odmítne i bez triggeru', async () => {
    await expect(as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO contact (account_id, full_name, do_not_contact, do_not_contact_reason) VALUES (${accountId}, 'Dlouhý', true, '${'x'.repeat(301)}');`))
      .rejects.toThrow(/contact_do_not_contact_reason_len/)
    await run('ALTER TABLE contact DISABLE TRIGGER contact_do_not_contact_stamp')
    try {
      await expect(run(`INSERT INTO contact (account_id, full_name, do_not_contact) VALUES (${accountId}, 'Bez času', true)`))
        .rejects.toThrow(/contact_do_not_contact_consistent/)
      await expect(run(`INSERT INTO contact (account_id, full_name, do_not_contact_reason) VALUES (${accountId}, 'Důvod bez nesouhlasu', 'x')`))
        .rejects.toThrow(/contact_do_not_contact_consistent/)
    } finally {
      await run('ALTER TABLE contact ENABLE TRIGGER contact_do_not_contact_stamp')
    }
  })

  test('RLS + AAL2: relace aal1 nesouhlas nezapíše (0 řádků), člen týmu s aal2 ano', async () => {
    await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO contact (account_id, full_name) VALUES (${accountId}, 'Olga Veselá');`)
    const id = await newContactId()
    await as({ role: 'authenticated', sub: U_SALES, aal: 'aal1' }, `UPDATE contact SET do_not_contact = true WHERE id = ${id};`)
    expect((await contact(id)).do_not_contact).toBe(false)
    await as({ role: 'authenticated', sub: U_SALES }, `UPDATE contact SET do_not_contact = true WHERE id = ${id};`)
    expect((await contact(id)).do_not_contact).toBe(true)
  })

  test('funkce triggeru není volatelná klientům', async () => {
    const r = await db.query<{ ok: boolean }>(`select has_function_privilege('authenticated', 'contact_do_not_contact_stamp()', 'EXECUTE') as ok`)
    expect(r.rows[0].ok).toBe(false)
  })
})
