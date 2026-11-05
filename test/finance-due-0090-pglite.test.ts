// 0090 (financial_record.due_on – splatnost faktury) v opravdovém Postgresu
// (PGlite = PostgreSQL ve WASM, bez sítě a bez živé DB). Nad zjednodušeným
// schématem z test/helpers/auditPgliteSchema.ts běží SKUTEČNÁ 0063 (tabulka,
// CHECKy, guard, RLS) a nad ní 0090. Audit trigger (0082) je tu jen stub
// funkce – jeho allow-list hlídá test/audit-coverage-0064.test.ts proti
// core/auditCoverage.ts; tady se ověřuje, že ho 0090 předefinuje s due_on.
// PGlite je devDependency – import je statický.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA, U_PM, U_SALES } from './helpers/auditPgliteSchema'

const M0063 = readFileSync('supabase/migrations/0063_financial_record.sql', 'utf8')
const M0090 = readFileSync('supabase/migrations/0090_financial_due_on.sql', 'utf8')

const STUBS = `
CREATE TYPE deal_currency AS ENUM ('CZK', 'EUR');
CREATE FUNCTION audit_row_change_soft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
`

type Who = { sub?: string; aal?: 'aal1' | 'aal2' }

describe('0090 splatnost faktury v Postgresu (PGlite)', () => {
  let db: PGlite
  let accountId = 0

  async function as<T>(who: Who, fn: () => Promise<T>): Promise<T> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) })])
      await db.query('SET LOCAL ROLE authenticated')
      return await fn()
    } finally {
      await db.query('ROLLBACK')
    }
  }
  let seq = 0
  const insert = (kind: string, extra = '', cols = '') =>
    db.query<{ id: number }>(
      `INSERT INTO financial_record (account_id, kind, amount, period_month, status, source, external_ref${cols})
       VALUES (${accountId}, '${kind}', 1000, '2026-09-01', 'confirmed', 'rucne', 'FA-${++seq}'${extra}) RETURNING id`,
    )
  // Příkaz, který musí selhat (transakce se vrací, ať test nezůstane v chybě).
  const fails = async (sql: string, msg: RegExp) => {
    await db.query('BEGIN')
    try {
      await expect(db.query(sql)).rejects.toThrow(msg)
    } finally {
      await db.query('ROLLBACK')
    }
  }

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(AUDIT_SCHEMA)
    await db.exec(STUBS)
    await db.exec(M0063)
    await db.exec(`GRANT SELECT, INSERT, UPDATE ON financial_record TO authenticated; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;`)
    accountId = (await db.query<{ id: number }>(`INSERT INTO account (name) VALUES ('Firma') RETURNING id`)).rows[0].id
    // Řádek z doby před 0090 – po migraci musí zůstat beze změny a bez splatnosti.
    await insert('invoiced')
    await db.exec(M0090)
    await db.exec(M0090) // idempotence
  }, 90_000)

  test('sloupec je volitelný a starý řádek zůstal bez splatnosti; migrace se zapsala jednou', async () => {
    const col = (await db.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'financial_record' AND column_name = 'due_on'`,
    )).rows
    expect(col).toEqual([{ data_type: 'date', is_nullable: 'YES' }])
    expect((await db.query<{ due_on: string | null }>(`SELECT due_on FROM financial_record ORDER BY id LIMIT 1`)).rows[0].due_on).toBeNull()
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0090'`)).rows[0].n).toBe(1)
  })

  test('idempotence: trigger, CHECK i index jednou; audit trigger je předefinovaný s due_on', async () => {
    const n = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n
    expect(await n(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'financial_record_due_guard' AND NOT tgisinternal`)).toBe(1)
    expect(await n(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'audit_row_change_soft' AND NOT tgisinternal`)).toBe(1)
    expect(await n(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'financial_record_due_on_check'`)).toBe(1)
    expect(await n(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'financial_record_due_idx'`)).toBe(1)
    const args = (await db.query<{ a: string }>(
      `SELECT encode(tgargs, 'escape') AS a FROM pg_trigger WHERE tgname = 'audit_row_change_soft' AND tgrelid = 'financial_record'::regclass`,
    )).rows[0].a
    const safe = args.split('\\000')[0].split(',')
    expect(safe).toContain('due_on')
    expect(safe).not.toEqual(expect.arrayContaining(['external_ref']))
    expect(safe).not.toEqual(expect.arrayContaining(['note']))
  })

  test('splatnost jen u vyfakturovaného a v rozumném rozsahu', async () => {
    await insert('invoiced', `, '2026-10-15'`, ', due_on')
    for (const kind of ['potential', 'contracted', 'received']) {
      await fails(
        `INSERT INTO financial_record (account_id, kind, amount, period_month, status, source, due_on)
         VALUES (${accountId}, '${kind}', 5, '2026-09-01', 'draft', 'rucne', '2026-10-15')`,
        /financial_record_due_on_check/,
      )
    }
    for (const day of ['1999-12-31', '2101-01-01']) {
      await fails(
        `INSERT INTO financial_record (account_id, kind, amount, period_month, status, source, due_on)
         VALUES (${accountId}, 'invoiced', 5, '2026-09-01', 'draft', 'rucne', '${day}')`,
        /financial_record_due_on_check/,
      )
    }
  })

  test('splatnost jde měnit u návrhu i potvrzené faktury, u zrušené ne (samostatný zámek)', async () => {
    const id = (await insert('invoiced', `, '2026-10-01'`, ', due_on')).rows[0].id
    await db.query(`UPDATE financial_record SET due_on = '2026-10-20' WHERE id = ${id}`)
    await db.query(`UPDATE financial_record SET due_on = NULL WHERE id = ${id}`)
    await db.query(`UPDATE financial_record SET due_on = '2026-10-25' WHERE id = ${id}`)
    await db.query(`UPDATE financial_record SET status = 'cancelled' WHERE id = ${id}`)
    await fails(`UPDATE financial_record SET due_on = '2026-11-30' WHERE id = ${id}`, /Zrušený finanční záznam se už nemění/)
    await fails(`UPDATE financial_record SET due_on = NULL WHERE id = ${id}`, /Zrušený finanční záznam se už nemění/)
    // beze změny splatnosti se zrušený záznam dotknout nedá jen kvůli jinému sloupci (zámek 0063 zůstal)
    await fails(`UPDATE financial_record SET note = 'x' WHERE id = ${id}`, /Zrušený finanční záznam se už nemění/)
    expect((await db.query<{ d: string }>(`SELECT to_char(due_on, 'YYYY-MM-DD') AS d FROM financial_record WHERE id = ${id}`)).rows[0].d).toBe('2026-10-25')
  })

  test('RLS z 0063 platí i na splatnost: obchodní role s 2FA ano, ostatní ne', async () => {
    const id = (await insert('invoiced', `, '2026-10-01'`, ', due_on')).rows[0].id
    const read = (who: Who) => as(who, async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM financial_record WHERE due_on IS NOT NULL`)).rows[0].n)
    expect(await read({ sub: U_SALES })).toBeGreaterThan(0)
    expect(await read({ sub: U_PM })).toBe(0) // projektový manažer peníze nevidí
    expect(await read({ sub: U_SALES, aal: 'aal1' })).toBe(0) // bez 2FA nic
    const upd = (who: Who) => as(who, async () => (await db.query(`UPDATE financial_record SET due_on = '2026-12-01' WHERE id = ${id}`)).affectedRows)
    expect(await upd({ sub: U_SALES })).toBe(1)
    expect(await upd({ sub: U_PM })).toBe(0)
    expect(await upd({ sub: U_SALES, aal: 'aal1' })).toBe(0)
  })

  test('guard: bez tabulky financial_record nebo bez audit funkce srozumitelná chyba', async () => {
    const bare = new PGlite()
    try {
      await bare.exec(`CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz DEFAULT now(), note text);`)
      await expect(bare.exec(M0090)).rejects.toThrow(/0090 vyžaduje tabulku financial_record/)
      await bare.exec(`CREATE TABLE financial_record (id bigserial PRIMARY KEY, kind text, status text)`)
      await expect(bare.exec(M0090)).rejects.toThrow(/0090 vyžaduje audit_row_change_soft\(\)/)
    } finally {
      await bare.close()
    }
  }, 60_000)
})
