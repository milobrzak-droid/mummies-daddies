// PGlite (PostgreSQL ve WASM) je devDependency, aby testy migrací proti
// skutečnému Postgresu běžely v bráně před nasazením (npm run build:release,
// env -i) i v CI. Soubory *-pglite.test.ts a auto-delivery-migration.test.ts
// se bez PGlite tiše přeskočí (describe.skipIf) — přeskočený test se ve výpisu
// netváří jako červený. Tenhle test proto selže, kdyby PGlite z devDependencies
// zmizel nebo se nedal načíst, a „přeskočeno“ se tak nikdy nezamění za „zelené“.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const PGLITE_MODULE = '@electric-sql/pglite'

describe('PGlite pro testy migrací', () => {
  test('je v devDependencies (ne v dependencies — do produkčního bundlu nepatří)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.devDependencies?.[PGLITE_MODULE]).toBeTruthy()
    expect(pkg.dependencies?.[PGLITE_MODULE]).toBeUndefined()
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { dev?: boolean }> }
    expect(lock.packages[`node_modules/${PGLITE_MODULE}`]?.dev).toBe(true)
  })

  test('jde načíst a spustit dotaz (bez sítě)', async () => {
    const { PGlite } = (await import(/* @vite-ignore */ PGLITE_MODULE)) as {
      PGlite: new () => { query: <T>(sql: string) => Promise<{ rows: T[] }>; close: () => Promise<void> }
    }
    const db = new PGlite()
    try {
      expect((await db.query<{ v: number }>('select 1 + 1 as v')).rows[0].v).toBe(2)
    } finally {
      await db.close()
    }
  }, 60_000)
})
