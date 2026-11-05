// @vitest-environment node
// Založení databáze OD NULY (docs/NASAZENI.md, krok 3) — celý řetěz migrací
// tímtéž běhačem jako produkce (scripts/migrate-runner.mjs), včetně
// 0031/0032 (Vault + pgcrypto, které jiné PGlite testy přeskakují), pak seed
// a kontroly scripts/db-bootstrap-lib.mjs. Bez sítě.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import {
  SEED_MARKERS,
  SUPABASE_STUB_SQL,
  applyAllMigrations,
  migrationFilenames,
  pgliteClient,
  readCompanyExpectations,
  readSeed,
  verifyBootstrap,
} from '../scripts/db-bootstrap-lib.mjs'

type Db = {
  exec: (sql: string) => Promise<{ rows: Record<string, unknown>[] }[]>
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
  close: () => Promise<void>
}

let PGliteCtor: (new (o?: unknown) => Db) | null = null
let pgcrypto: unknown = null
try {
  PGliteCtor = ((await import('@electric-sql/pglite')) as unknown as { PGlite: new (o?: unknown) => Db }).PGlite
  pgcrypto = ((await import('@electric-sql/pglite/contrib/pgcrypto')) as { pgcrypto: unknown }).pgcrypto
} catch {
  PGliteCtor = null
}

const expected = { nodes: [...COMPANY.nodes], revenueLines: COMPANY.revenueLines!.map((l) => l.key) }

describe('readCompanyExpectations (čtení konfigurace bez TypeScriptu)', () => {
  test('z config/mummiesDaddies.ts vytáhne stejné uzly a linky jako @/config', () => {
    const got = readCompanyExpectations(readFileSync('config/mummiesDaddies.ts', 'utf8'))
    expect(got.nodes).toEqual(expected.nodes)
    expect(got.revenueLines).toEqual(expected.revenueLines)
  })

  test('seed opravdu obsahuje značky, podle kterých se hlídá produkce', () => {
    const seed = readSeed()
    for (const m of SEED_MARKERS) expect(seed).toContain(`'${m}'`)
  })
})

describe.skipIf(!PGliteCtor)('db-bootstrap: celý řetěz migrací od nuly (PGlite)', () => {
  async function fresh() {
    const db = new PGliteCtor!({ extensions: { pgcrypto } })
    await db.exec(SUPABASE_STUB_SQL)
    return { db, client: pgliteClient(db) }
  }

  test('všechny migrace projdou běhačem, ledger je úplný, kontroly bez nálezu', async () => {
    const { db, client } = await fresh()
    try {
      const applied = await applyAllMigrations(client)
      expect(applied).toEqual(migrationFilenames().map((f) => f.slice(0, 4)))
      expect(applied).toContain('0031')
      expect(applied).toContain('0032')
      expect(await verifyBootstrap(client, expected, { fresh: true })).toEqual([])

      // Šifrovací klíč tokenů vznikl ve Vaultu (0031) a otevřený text zmizel (0032).
      const key = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM vault.secrets WHERE name = 'calendar_token_key'`)).rows[0]
      expect(key.n).toBe(1)
      const cols = (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'calendar_token' AND column_name IN ('access_token', 'refresh_token')`)).rows
      expect(cols).toEqual([])

      // Druhý běh nemá co dělat (idempotence plánu).
      expect(await applyAllMigrations(client)).toEqual([])
    } finally {
      await db.close()
    }
  }, 300_000)

  test('seed na čerstvé databázi; kontrola produkce pak seed odhalí', async () => {
    const { db, client } = await fresh()
    try {
      await applyAllMigrations(client)
      await db.exec(readSeed())
      expect(await verifyBootstrap(client, expected, { seeded: true, fresh: true })).toEqual([])
      const prod = await verifyBootstrap(client, expected, { production: true })
      expect(prod.join('\n')).toMatch(/ukázková data/)
      // Bez seedu „čerstvá“ kontrola obchody nesnese.
      expect((await verifyBootstrap(client, expected, { fresh: true })).join('\n')).toMatch(/bez seedu má obchody/)
    } finally {
      await db.close()
    }
  }, 300_000)

  test('kontrola odhalí nesoulad uzlů s konfigurací a tabulku bez RLS', async () => {
    const { db, client } = await fresh()
    try {
      await applyAllMigrations(client)
      await db.exec(`CREATE TABLE public.zapomenuta (id int)`)
      const problems = await verifyBootstrap(client, { nodes: ['obchod'], revenueLines: expected.revenueLines })
      expect(problems.join('\n')).toMatch(/Tabulky bez RLS: zapomenuta/)
      expect(problems.join('\n')).toMatch(/Uzly loop_node/)
    } finally {
      await db.close()
    }
  }, 300_000)
})
