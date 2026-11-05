// 0092 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez živé
// DB: odkaz na doklad iDokladu u finančních záznamů (idempotence, CHECKy,
// strážce), fronta rozdílů (RLS jen obchodní role, AAL2, strážce rozhodnutí,
// dedupe_key) a audit bez citlivých hodnot. PGlite je v devDependencies; kdyby
// chyběl, červeně selže test/pglite-dependency.test.ts.
//
// Schéma = test/helpers/auditPgliteSchema.ts + skutečné migrace 0035 (bez
// kontrol), 0063, 0064 a část 0082 (audit_row_change_soft).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { dedupeKey } from '@/domain/finance/idoklad'
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

const M0035 = readFileSync('supabase/migrations/0035_deal_audit_hardening.sql', 'utf8')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')
const M0064 = readFileSync('supabase/migrations/0064_audit_coverage.sql', 'utf8')
const M0082_full = readFileSync('supabase/migrations/0082_audit_gaps_partner_lockdown.sql', 'utf8')
// Jen funkce měkkého auditu (sekce 1 a 2 z 0082) — zbytek 0082 by chtěl další tabulky.
const M0082_AUDIT = M0082_full.slice(
  M0082_full.indexOf('ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS entity_ref'),
  M0082_full.indexOf('-- 3) Napojení tabulek'),
)
const M0063 = readFileSync('supabase/migrations/0063_financial_record.sql', 'utf8')
// Měkký audit financial_record přesně jako v 0082 (trigger si test vytáhne z migrace).
const FIN_AUDIT_TRIGGER = /DROP TRIGGER IF EXISTS audit_row_change_soft ON financial_record;\s*CREATE TRIGGER audit_row_change_soft[\s\S]*?\);/.exec(M0082_full)![0]
const M0092 = readFileSync('supabase/migrations/0092_idoklad_sync.sql', 'utf8')

const EXTRA = `
ALTER ROLE service_role BYPASSRLS;
ALTER TABLE team_member ADD COLUMN email text, ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
CREATE TYPE deal_currency AS ENUM ('CZK', 'EUR');
-- Jako v Supabase: nové tabulky dostávají práva automaticky (REVOKE v migraci je pak zužuje).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role, anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role, anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role, anon;
`
// Jako v produkci (0003): tým čte a zapisuje účty; audit_event čte tým.
const RLS = `
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_all ON account FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE deal ENABLE ROW LEVEL SECURITY;
CREATE POLICY deal_all ON deal FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE engagement ENABLE ROW LEVEL SECURITY;
CREATE POLICY engagement_all ON engagement FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE engagement_milestone ENABLE ROW LEVEL SECURITY;
CREATE POLICY engagement_milestone_all ON engagement_milestone FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
`

describe.skipIf(!PGliteCtor)('0092 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

  async function as(
    who: { role: 'authenticated' | 'service_role' | 'postgres'; sub?: string; aal?: string; headers?: Record<string, string> },
    sql: string,
  ) {
    const claims = who.role === 'postgres' ? null : JSON.stringify({ role: who.role, aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
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
  const sales = (sql: string) => as({ role: 'authenticated', sub: U_SALES }, sql)
  const service = (sql: string, actor = 'system:job:idoklad-sync') =>
    as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': actor, 'x-cockpit-audit-info-state': 'source_fact' } }, sql)

  async function countAs(sub: string, table: string, where = 'true', aal = 'aal2'): Promise<number> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub, aal })])
      await db.query('SET LOCAL ROLE authenticated')
      return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n
    } finally {
      await db.query('ROLLBACK')
    }
  }
  const one = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  const lastAudit = (table: string) => one<{ action: string; actor_type: string; actor_id: string | null; info_state: string | null; entity_id: number | null; before: Row | null; after: Row | null }>(
    'select * from audit_event where entity_table = $1 order by id desc limit 1', [table])
  const auditCount = async (where = 'true') => (await one<{ n: number }>(`select count(*)::int as n from audit_event where ${where}`)).n

  let acc = 0

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(EXTRA)
    await run(M0035)
    await run(M0064)
    await run(M0082_AUDIT)
    await run(RLS)
    await run(M0063)
    await run(FIN_AUDIT_TRIGGER)
    await run(M0092)
    notices.length = 0
    await run(M0092) // idempotence
    await run(`INSERT INTO account (name, ico) VALUES ('Alfa s.r.o.', '12345678')`)
    acc = (await one<{ id: number }>('select id from account limit 1')).id
  }, 120_000)

  test('idempotence: druhý běh nezdvojí triggery, ledger ani politiky; žádné varování', async () => {
    expect((await one<{ n: number }>(`select count(*)::int as n from schema_migration where version = '0092'`)).n).toBe(1)
    expect((await one<{ n: number }>(`select count(*)::int as n from pg_trigger where tgrelid = 'idoklad_discrepancy'::regclass and not tgisinternal`)).n).toBe(3)
    expect((await one<{ n: number }>(`select count(*)::int as n from pg_policies where tablename = 'audit_event' and policyname = 'audit_event_sales_only_idoklad'`)).n).toBe(1)
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
  })

  describe('financial_record: odkaz na doklad', () => {
    const ins = (extra: string, vals: string) =>
      `INSERT INTO financial_record (account_id, kind, amount, period_month, status, source, external_ref ${extra}) VALUES (${acc}, ${vals});`

    test('úloha zapíše fakturu ze zdroje idoklad; audit nese aktéra úlohy a source_fact, číslo dokladu jen názvem', async () => {
      await service(ins(', idoklad_kind, idoklad_id, idoklad_due_on', `'invoiced', 10000, '2026-09-01', 'confirmed', 'idoklad', 'FV-2026-0001', 'invoice', 1, '2026-09-30'`))
      const a = await lastAudit('financial_record')
      expect(a).toMatchObject({ action: 'financial_record.created', actor_type: 'system', actor_id: 'job:idoklad-sync', info_state: 'source_fact' })
      expect(a.after).toMatchObject({ source: 'idoklad', kind: 'invoiced', amount: 10000, status: 'confirmed' })
      expect(JSON.stringify(a)).not.toMatch(/FV-2026-0001/)
      expect(a.after!._columns).toEqual(expect.arrayContaining(['external_ref', 'idoklad_id', 'idoklad_kind', 'idoklad_due_on']))
      expect(Object.keys(a.after!)).not.toContain('idoklad_id')
    })

    test('IDEMPOTENCE: stejný doklad podruhé (i po zrušení záznamu) narazí na UNIQUE', async () => {
      await expect(service(ins(', idoklad_kind, idoklad_id', `'invoiced', 10000, '2026-09-01', 'confirmed', 'idoklad', 'FV-2026-0001-b', 'invoice', 1`))).rejects.toThrow(/duplicate|unique/i)
      await service(`UPDATE financial_record SET status = 'cancelled' WHERE idoklad_id = 1;`)
      await expect(service(ins(', idoklad_kind, idoklad_id', `'invoiced', 10000, '2026-09-01', 'confirmed', 'idoklad', 'FV-2026-0001-c', 'invoice', 1`))).rejects.toThrow(/duplicate|unique/i)
    })

    test('CHECKy: zdroj idoklad vyžaduje doklad; druh musí sedět na typ dokladu; splatnost jen u faktury; odkaz celý nebo žádný', async () => {
      await expect(service(ins('', `'invoiced', 1, '2026-09-01', 'confirmed', 'idoklad', 'A'`))).rejects.toThrow(/financial_record_idoklad_check/)
      await expect(service(ins(', idoklad_kind, idoklad_id', `'received', 1, '2026-09-01', 'confirmed', 'idoklad', 'A', 'invoice', 2`))).rejects.toThrow(/financial_record_idoklad_check/)
      await expect(service(ins(', idoklad_kind, idoklad_id', `'invoiced', 1, '2026-09-01', 'confirmed', 'idoklad', 'A', 'payment', 2`))).rejects.toThrow(/financial_record_idoklad_check/)
      await expect(service(ins(', idoklad_kind', `'invoiced', 1, '2026-09-01', 'confirmed', 'idoklad', 'A', 'invoice'`))).rejects.toThrow(/financial_record_idoklad_check/)
      await expect(service(ins(', idoklad_kind, idoklad_id, idoklad_due_on', `'received', 1, '2026-09-01', 'confirmed', 'idoklad', 'A', 'payment', 3, '2026-09-30'`))).rejects.toThrow(/financial_record_idoklad_check/)
      await expect(service(ins('', `'invoiced', 1, '2026-09-01', 'confirmed', 'neznamy', 'A'`))).rejects.toThrow(/financial_record_source_check/)
      await service(ins(', idoklad_kind, idoklad_id', `'received', 5000, '2026-10-01', 'confirmed', 'idoklad', 'FV-2026-0001', 'payment', 3`))
      // Platba a faktura se stejným číslem id se nepletou (klíč je dvojice).
      await service(ins(', idoklad_kind, idoklad_id', `'invoiced', 7, '2026-09-01', 'confirmed', 'idoklad', 'FV-3', 'invoice', 3`))
    })

    test('ruční záznam se dá později spárovat (zdroj zůstává), ale člověk odkaz na doklad nezapíše ani nepřepíše', async () => {
      await sales(ins('', `'invoiced', 8000, '2026-08-01', 'draft', 'rucne', NULL`))
      const id = (await one<{ id: number }>(`select id from financial_record where amount = 8000`)).id
      await expect(sales(`UPDATE financial_record SET idoklad_kind = 'invoice', idoklad_id = 99 WHERE id = ${id};`)).rejects.toThrow(/automatické načtení/)
      await expect(sales(`UPDATE financial_record SET idoklad_due_on = '2026-09-01' WHERE id = ${id};`)).rejects.toThrow(/automatické načtení/)
      await expect(sales(ins(', idoklad_kind, idoklad_id', `'invoiced', 9, '2026-08-01', 'draft', 'rucne', NULL, 'invoice', 98`))).rejects.toThrow(/automatické načtení/)
      await expect(sales(ins('', `'invoiced', 9, '2026-08-01', 'draft', 'idoklad', NULL`))).rejects.toThrow()
      // Běžná úprava člověkem dál funguje.
      await sales(`UPDATE financial_record SET note = 'poznámka' WHERE id = ${id};`)
      // Úloha spáruje a potvrdí; původní zdroj se nemění.
      await service(`UPDATE financial_record SET status = 'confirmed', external_ref = 'FV-8', idoklad_kind = 'invoice', idoklad_id = 8, idoklad_due_on = '2026-08-31' WHERE id = ${id};`)
      expect(await one(`select source, status, idoklad_id::int as i from financial_record where id = ${id}`)).toEqual({ source: 'rucne', status: 'confirmed', i: 8 })
    })
  })

  describe('idoklad_discrepancy: fronta rozdílů', () => {
    const insDisc = (over = '') => `
      INSERT INTO idoklad_discrepancy (kind, reason, idoklad_kind, idoklad_id, document_number, account_id, currency, idoklad_amount, record_amount, fingerprint)
      VALUES ('amount_mismatch', 'Faktura FV-9 má jinou částku než záznam', 'invoice', 9, 'FV-9', ${acc}, 'CZK', 100, 90, 'fp1') ${over};`

    test('dedupe_key je vygenerovaný a sedí s TypeScriptem; duplicita rozdílu narazí na UNIQUE', async () => {
      await service(insDisc())
      const r = await one<{ id: number; dedupe_key: string }>(`select id, dedupe_key from idoklad_discrepancy where idoklad_id = 9`)
      expect(r.dedupe_key).toBe(dedupeKey({ kind: 'amount_mismatch', idoklad_kind: 'invoice', idoklad_id: 9, record_id: null }))
      await expect(service(insDisc())).rejects.toThrow(/duplicate|unique/i)
      await service(`INSERT INTO idoklad_discrepancy (kind, reason, record_id, account_id, fingerprint)
        SELECT 'record_without_invoice', 'Záznam bez faktury', id, ${acc}, 'x' FROM financial_record WHERE amount = 8000;`)
      const k = (await one<{ dedupe_key: string }>(`select dedupe_key from idoklad_discrepancy where kind = 'record_without_invoice'`)).dedupe_key
      expect(k).toMatch(/^record_without_invoice:-:-:\d+$/)
    })

    test('CHECKy: druh, stav, dvojice dokladu, cíl, otevřený nemá rozhodnutí', async () => {
      await expect(service(`INSERT INTO idoklad_discrepancy (kind, reason, idoklad_kind, idoklad_id, fingerprint) VALUES ('jiny', 'r', 'invoice', 1, 'f');`)).rejects.toThrow(/idoklad_discrepancy_kind_check/)
      await expect(service(`INSERT INTO idoklad_discrepancy (kind, reason, fingerprint) VALUES ('amount_mismatch', 'r', 'f');`)).rejects.toThrow(/idoklad_discrepancy_target_check/)
      await expect(service(`INSERT INTO idoklad_discrepancy (kind, reason, idoklad_kind, fingerprint, record_id) VALUES ('amount_mismatch', 'r', 'invoice', 'f', 1);`)).rejects.toThrow(/doc_pair_check/)
      await expect(service(`INSERT INTO idoklad_discrepancy (kind, reason, idoklad_kind, idoklad_id, fingerprint, status) VALUES ('amount_mismatch', 'r', 'invoice', 55, 'f', 'resolved');`)).rejects.toThrow(/resolved_check/)
      await expect(service(`INSERT INTO idoklad_discrepancy (kind, reason, idoklad_kind, idoklad_id, fingerprint, resolution) VALUES ('amount_mismatch', 'r', 'invoice', 56, 'f', 'auto');`)).rejects.toThrow(/resolved_check/)
    })

    test('RLS: obchodní role rozdíly vidí, projektový manažer ne, bez AAL2 nikdo', async () => {
      expect(await countAs(U_SALES, 'idoklad_discrepancy')).toBeGreaterThan(0)
      expect(await countAs(U_API, 'idoklad_discrepancy')).toBeGreaterThan(0) // vedení
      expect(await countAs(U_PM, 'idoklad_discrepancy')).toBe(0)
      expect(await countAs(U_SALES, 'idoklad_discrepancy', 'true', 'aal1')).toBe(0)
    })

    test('člen týmu rozdíly nezakládá ani nemaže', async () => {
      await expect(sales(insDisc().replace("'fp1'", "'fp-user'").replace(', 9,', ', 90,'))).rejects.toThrow(/permission denied|row-level security/)
      await expect(sales(`DELETE FROM idoklad_discrepancy;`)).rejects.toThrow(/permission denied/)
    })

    test('rozhodnutí člověka: uzavře otevřený rozdíl jako on sám a teď; nic jiného nepřepíše; zpět neotevře', async () => {
      const id = (await one<{ id: number }>(`select id from idoklad_discrepancy where idoklad_id = 9`)).id
      await expect(sales(`UPDATE idoklad_discrepancy SET idoklad_amount = 5 WHERE id = ${id};`)).rejects.toThrow(/lze jen uzavřít/)
      await expect(sales(`UPDATE idoklad_discrepancy SET status = 'resolved', resolution = 'auto', resolved_at = now() WHERE id = ${id};`)).rejects.toThrow(/vyřešený nebo odložený/)
      await sales(`UPDATE idoklad_discrepancy SET status = 'dismissed', resolution = 'dismissed', resolved_at = '2000-01-01', resolved_by = '${U_PM}', resolution_note = 'Vysvětleno s klientem' WHERE id = ${id};`)
      const r = await one<{ status: string; resolved_by: string; resolved_at: string; resolution_note: string }>(`select status, resolved_by, resolved_at::text, resolution_note from idoklad_discrepancy where id = ${id}`)
      expect(r.status).toBe('dismissed')
      expect(r.resolved_by).toBe(U_SALES) // z auth.uid(), ne z požadavku
      expect(r.resolved_at.startsWith('2000')).toBe(false)
      await expect(sales(`UPDATE idoklad_discrepancy SET status = 'open', resolution = NULL, resolved_at = NULL WHERE id = ${id};`)).rejects.toThrow(/neotevírá/)
      await expect(sales(`UPDATE idoklad_discrepancy SET resolution_note = 'jiné' WHERE id = ${id};`)).rejects.toThrow(/nemění/)
      // Úloha ho smí znovu otevřít (změna otisku) — servisní zápis nemá omezení.
      await service(`UPDATE idoklad_discrepancy SET status = 'open', resolution = NULL, resolved_at = NULL, resolved_by = NULL, resolution_note = NULL, fingerprint = 'fp2' WHERE id = ${id};`)
      expect((await one<{ status: string }>(`select status from idoklad_discrepancy where id = ${id}`)).status).toBe('open')
    })

    test('audit: vznik a uzavření mají událost (id, druh, stav), číslo dokladu, důvod a částky jen názvem; last_seen_at není událost', async () => {
      await service(insDisc().replace("'fp1'", "'fp-audit'").replace(', 9,', ', 300,').replace("'FV-9'", "'FV-TAJNE-300'"))
      const created = await lastAudit('idoklad_discrepancy')
      expect(created).toMatchObject({ action: 'idoklad_discrepancy.created', actor_type: 'system', actor_id: 'job:idoklad-sync', info_state: 'source_fact' })
      expect(created.after).toMatchObject({ kind: 'amount_mismatch', status: 'open', idoklad_id: 300, idoklad_kind: 'invoice' })
      expect(created.after!._columns).toEqual(expect.arrayContaining(['reason', 'document_number', 'idoklad_amount', 'record_amount', 'currency', 'fingerprint']))
      expect(JSON.stringify(created)).not.toMatch(/FV-TAJNE-300|jinou částku|fp-audit/)
      const before = await auditCount(`entity_table = 'idoklad_discrepancy'`)
      await service(`UPDATE idoklad_discrepancy SET last_seen_at = now() + interval '1 day' WHERE idoklad_id = 300;`)
      expect(await auditCount(`entity_table = 'idoklad_discrepancy'`)).toBe(before)
      await service(`UPDATE idoklad_discrepancy SET status = 'resolved', resolution = 'auto', resolved_at = now() WHERE idoklad_id = 300;`)
      const resolved = await lastAudit('idoklad_discrepancy')
      expect(resolved).toMatchObject({ action: 'idoklad_discrepancy.updated' })
      expect(resolved.after).toMatchObject({ status: 'resolved', resolution: 'auto' })
    })

    test('historii rozdílů vidí jen obchodní role (RESTRICTIVE politika nad audit_event)', async () => {
      expect(await countAs(U_SALES, 'audit_event', `entity_table = 'idoklad_discrepancy'`)).toBeGreaterThan(0)
      expect(await countAs(U_PM, 'audit_event', `entity_table = 'idoklad_discrepancy'`)).toBe(0)
    })
  })
})
