// Pojistky workflow Migrace databáze (.github/workflows/migrate.yml), které
// nesmí potichu zmizet: oba joby jen z main a oba v prostředí cíle — oba
// totiž dostávají připojovací řetězec a spouštějí skript z vybrané větve.
// YAML parser v repu není, proto kontrola nad textem po blocích jobů.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const text = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'migrate.yml'), 'utf8')

function jobBlock(name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  expect(start, `job ${name}`).toBeGreaterThan(0)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z_-]+:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

describe('migrate.yml', () => {
  for (const job of ['plan', 'apply']) {
    test(`${job}: běží v prostředí cíle a odmítne jinou větev než main`, () => {
      const block = jobBlock(job)
      expect(block).toMatch(/\n {4}environment: \$\{\{ inputs\.target \}\}\n/)
      expect(block).toContain('REF: ${{ github.ref }}')
      expect(block).toContain('if [ "$REF" != "refs/heads/main" ]; then')
      // Kontrola větve je první krok — před checkoutem a před secrets.
      expect(block.indexOf('refs/heads/main')).toBeLessThan(block.indexOf('actions/checkout'))
    })
  }

  test('bloky jobů jsou oddělené (kontrola výše netestuje cizí job)', () => {
    expect(jobBlock('plan')).not.toContain('name: Provedení')
    expect(jobBlock('apply')).not.toContain('name: Plán')
  })

  test('aplikace má podmínku main i na úrovni jobu', () => {
    expect(jobBlock('apply')).toMatch(/\n {4}if: github\.ref == 'refs\/heads\/main' && /)
  })

  test('vstupy: akce plan (výchozí) / apply / baseline a potvrzení názvem cíle', () => {
    expect(text).toMatch(/\n {6}action:\n[\s\S]*?options: \[plan, apply, baseline\]\n {8}default: plan\n/)
    expect(text).toMatch(/\n {6}baseline:\n/)
    expect(text).toMatch(/\n {6}confirm:\n/)
  })

  test('provedení běží jen pro apply/baseline, s potvrzením a s neprázdným plánem', () => {
    const block = jobBlock('apply')
    expect(block).toContain("inputs.action != 'plan'")
    expect(block).toContain("needs.plan.outputs.pending != ''")
    expect(block).toContain('inputs.confirm == inputs.target')
  })

  test('plán vždy jede jako --dry-run; --apply je jen v provedení a s --expect', () => {
    const plan = jobBlock('plan')
    const apply = jobBlock('apply')
    expect(plan).toContain('--dry-run')
    expect(plan).not.toContain('--apply')
    expect(apply).toContain('--apply --expect="$EXPECTED"')
    expect(apply).not.toContain('--dry-run')
    expect(apply).toContain('--yes-production')
  })

  test('žádné vstupy ani tajemství přímo v příkazu (jen přes proměnné prostředí)', () => {
    // Skript `run:` nesmí obsahovat ${{ … }} — vstup od uživatele by šel do shellu.
    for (const m of text.matchAll(/\n {8}run: \|\n((?: {10}.*\n|\n)+)/g)) {
      expect(m[1]).not.toContain('${{')
    }
    expect(text).not.toMatch(/run: .*\$\{\{/)
    // Připojovací řetězce se předávají jen jako env.
    expect(text).toMatch(/SUPABASE_DB_URL: \$\{\{ inputs\.target == 'production' && secrets\.SUPABASE_DB_URL \|\| '' \}\}/)
    expect(text).not.toMatch(/echo .*(DB_URL|secrets\.)/)
  })
})
