// Statická kontrola 0055 — seed cílových seznamů. Firma cílové seznamy zatím
// nepoužívá (outbound = fáze 2), proto migrace žádný seznam nezakládá
// a nenese žádný e-mail; číslo zůstává kvůli souvislé řadě migrací.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const SQL = readFileSync(
  join(__dirname, '..', 'supabase', 'migrations', '0055_seed_target_lists.sql'),
  'utf8',
)

describe('0055_seed_target_lists.sql', () => {
  test('nezakládá žádný cílový seznam ani nehledá člověka podle e-mailu', () => {
    expect(SQL).not.toMatch(/INSERT INTO target_list/)
    expect(SQL).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/)
  })

  test('zapisuje verzi 0055 do schema_migration', () => {
    expect(SQL).toMatch(/INSERT INTO\s+schema_migration\s*\(version, note\)\s*\n\s*VALUES\s*\(\s*'0055'/)
  })
})
