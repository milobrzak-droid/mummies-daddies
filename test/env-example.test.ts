// .env.example je šablona: jen názvy a popisy, žádné hodnoty. Hlídá, že
// (a) každá proměnná, kterou aplikace čte, v šabloně je (aspoň v komentáři),
// (b) nikde není vyplněná hodnota a (c) šablona nevypíná 2FA — dřív v ní bylo
// MFA_ENFORCED=false, a kdo by ji zkopíroval do produkce, 2FA by vypnul.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const TEMPLATE = readFileSync('.env.example', 'utf8')
const ROOTS = ['app', 'lib', 'core', 'domain', 'connectors', 'worker', 'components', 'config', 'proxy.ts', 'next.config.ts']

function files(p: string): string[] {
  if (statSync(p).isFile()) return /\.(ts|tsx|mjs)$/.test(p) ? [p] : []
  return readdirSync(p).flatMap((f) => files(join(p, f)))
}

// process.env.X i env.X (funkce, které dostávají env jako parametr).
const readNames = new Set(
  ROOTS.flatMap(files).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/\benv(?:\.|\[')([A-Z][A-Z0-9_]{2,})/g)].map((m) => m[1]),
  ),
)

describe('.env.example', () => {
  test('obsahuje každou proměnnou, kterou aplikace čte', () => {
    expect(readNames.size).toBeGreaterThan(20)
    const missing = [...readNames].filter((n) => !new RegExp(`\\b${n}\\b`).test(TEMPLATE))
    expect(missing).toEqual([])
  })

  test('žádná vyplněná hodnota (jen NÁZEV= bez hodnoty)', () => {
    const filled = TEMPLATE.split('\n')
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .filter((l) => l.slice(l.indexOf('=') + 1).trim() !== '')
    expect(filled).toEqual([])
  })

  test('2FA se šablonou nevypne: MFA_ENFORCED není aktivní řádek', () => {
    expect(TEMPLATE).not.toMatch(/^MFA_ENFORCED=/m)
    expect(TEMPLATE).toMatch(/^# MFA_ENFORCED=$/m)
  })
})
