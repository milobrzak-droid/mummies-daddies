import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// D4 z bezpečnostní revize 30. 9.: auto_intake_undo (0081/0086) hledá cizí práci
// v katalogu jen přes JEDNOSLOUPCOVÉ cizí klíče přímo na account, deal, contact a
// work_case a maže úkol, aktivitu a alias vzniklé z poptávky. Dnes žádná tabulka
// nemá vícesloupcový FK na tyto tabulky a tabulky, které ukazují na mazané řádky
// (task, sales_activity, company_alias), jsou známé a ošetřené. Tenhle test to
// zamkne: nová tabulka s takovým FK ho shodí a člověk musí projít auto_intake_undo
// (0086), případně ji doplnit do seznamu níž s poznámkou, proč je to v pořádku.

const DIR = join(__dirname, '..', 'supabase', 'migrations')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
// Těla funkcí ($$ … $$) se přeskakují: v nich se jen odkazuje na tabulky, nedefinují se.
const statements = files.flatMap((f) =>
  stripComments(readFileSync(join(DIR, f), 'utf8')).replace(/\$\$[\s\S]*?\$\$/g, '').split(';').map((stmt) => ({ f, stmt })))

const UNDO_TARGETS = ['account', 'deal', 'contact', 'work_case', 'task', 'sales_activity', 'company_alias']

describe('auto_intake_undo: cizí klíče, které funkce neumí posoudit', () => {
  test('žádný vícesloupcový FK na tabulky, které Zpět maže nebo kontroluje', () => {
    const composite: string[] = []
    for (const { f, stmt } of statements) {
      for (const m of stmt.matchAll(/FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+(?:public\.)?(\w+)/gi)) {
        if (UNDO_TARGETS.includes(m[2]) && m[1].includes(',')) composite.push(`${f}: (${m[1].trim()}) → ${m[2]}`)
      }
    }
    expect(composite).toEqual([])
  })

  test('tabulky s FK na úkol, aktivitu a alias (mazané řádky poptávky) jsou beze změny', () => {
    const owned = ['task', 'sales_activity', 'company_alias']
    const found: Record<string, Set<string>> = {}
    for (const { stmt } of statements) {
      const m = /^\s*(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: IF EXISTS)?(?: ONLY)?)\s+(\w+)/i.exec(stmt)
      if (!m) continue
      for (const x of stmt.matchAll(/REFERENCES\s+(?:public\.)?(\w+)\s*\(/gi)) {
        if (owned.includes(x[1])) (found[x[1]] ??= new Set()).add(m[1])
      }
    }
    const asList = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].sort()]))
    expect(asList).toEqual({
      // auto_intake: samotný ledger. engagement_milestone: termín převzatý ze schůzky (ON DELETE SET NULL).
      sales_activity: ['auto_intake', 'engagement_milestone', 'meeting_note_intake'],
      // engagement_document_finding: nález dokumentu ukazuje na úkol (ON DELETE SET NULL).
      // agent_outbox (0104): úkol k zablokované zprávě fronty (ON DELETE SET NULL).
      task: ['agent_outbox', 'auto_intake', 'engagement_document_finding'],
      company_alias: ['auto_intake'],
    })
  })
})
