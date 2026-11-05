// Kapitola 5 — přechod na nové fáze obchodu (rozhodnutí vedení 28. 9. 2026).
// Hlídá: číselník podle rozhodnutí, převod starých hodnot (normalizér i SQL
// v 0050 říkají totéž), že převod nepohne čísly pipeline, a že staré klíče
// fází nezůstaly nikde v aplikačním kódu mimo normalizér a migrace.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DEAL_STAGES, DEAL_STAGE_KEYS, DEFAULT_DEAL_STAGE, OPEN_DEAL_STAGE_KEYS,
  dealStageLabel, defaultProbabilityForStage, isDealStageKey, stageForPhase, PHASES,
} from '@/lib/domain'
import {
  LEGACY_DEAL_STAGE_MAP, LEGACY_DEAL_STAGE_PROBABILITY, isLegacyDealStage,
  normalizeDealRow, normalizeDealRows, normalizeDealStage, withLegacyDealStages,
} from '@/lib/dealStageLegacy'
import { buildSalesDashboard, isOpenDeal, weightedValue, type SalesDealLike } from '@/domain/crm/sales'
import { dealStage } from '@/lib/validation/schemas'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

describe('DEAL_STAGES podle rozhodnutí 28. 9. 2026', () => {
  test('klíče, popisky, otevřenost a výchozí pravděpodobnosti', () => {
    expect(DEAL_STAGES.map(({ key, label, open, probability }) => ({ key, label, open, probability }))).toEqual([
      { key: 'kvalifikace', label: 'Poptávka', open: true, probability: 10 },
      { key: 'diagnostika', label: 'Upřesnění', open: true, probability: 30 },
      { key: 'rozsah_nabidka', label: 'Nabídka odeslána', open: true, probability: 55 },
      { key: 'rozhodovani', label: 'Zákazník rozhoduje', open: true, probability: 75 },
      { key: 'vyhráno', label: 'Vyhráno', open: false, probability: 100 },
      { key: 'prohráno', label: 'Prohráno', open: false, probability: 0 },
      { key: 'odloženo', label: 'Odloženo', open: false, probability: 0 },
    ])
  })

  test('odloženo je zavřená fáze', () => {
    expect(OPEN_DEAL_STAGE_KEYS).not.toContain('odloženo')
    expect(isOpenDeal('odloženo')).toBe(false)
  })

  test('výchozí fáze nového obchodu je kvalifikace', () => {
    expect(DEFAULT_DEAL_STAGE).toBe('kvalifikace')
  })

  test('zod schéma bere nové klíče a staré odmítá', () => {
    expect([...DEAL_STAGE_KEYS]).toEqual(DEAL_STAGES.map((s) => s.key))
    for (const key of DEAL_STAGE_KEYS) expect(dealStage.safeParse(key).success).toBe(true)
    for (const old of Object.keys(LEGACY_DEAL_STAGE_MAP)) expect(dealStage.safeParse(old).success).toBe(false)
  })

  test('stageForPhase vrací jen platné nové klíče', () => {
    for (const [pillar, phases] of Object.entries(PHASES)) {
      for (const phase of phases) {
        const stage = stageForPhase(pillar, phase.key)
        expect(stage === null || isDealStageKey(stage)).toBe(true)
      }
    }
  })
})

describe('převod starých fází', () => {
  test('mapování', () => {
    expect(LEGACY_DEAL_STAGE_MAP).toEqual({
      lead: 'kvalifikace',
      'proběhlo_jednání': 'kvalifikace',
      'nabídka': 'rozsah_nabidka',
      'vyjednávání': 'rozhodovani',
    })
    // Cíl je vždy otevřená nová fáze.
    for (const next of Object.values(LEGACY_DEAL_STAGE_MAP)) expect(OPEN_DEAL_STAGE_KEYS).toContain(next)
    // Staré a nové klíče se nepřekrývají.
    for (const old of Object.keys(LEGACY_DEAL_STAGE_MAP)) expect(isDealStageKey(old)).toBe(false)
  })

  test('normalizeDealStage', () => {
    expect(normalizeDealStage('lead')).toBe('kvalifikace')
    expect(normalizeDealStage('proběhlo_jednání')).toBe('kvalifikace')
    expect(normalizeDealStage('nabídka')).toBe('rozsah_nabidka')
    expect(normalizeDealStage('vyjednávání')).toBe('rozhodovani')
    for (const key of DEAL_STAGE_KEYS) expect(normalizeDealStage(key)).toBe(key)
    expect(normalizeDealStage('neznama')).toBe('neznama')
    expect(normalizeDealStage('toString')).toBe('toString')
    expect(normalizeDealStage(null)).toBeNull()
    expect(normalizeDealStage(undefined)).toBeNull()
    expect(isLegacyDealStage('constructor')).toBe(false)
  })

  test('normalizeDealRow převádí fázi, zmrazí prázdnou pravděpodobnost a nemutuje vstup', () => {
    const row = { id: 1, title: 'X', stage: 'proběhlo_jednání', probability_pct: null }
    const out = normalizeDealRow(row)
    expect(out).toEqual({ id: 1, title: 'X', stage: 'kvalifikace', probability_pct: 30 })
    expect(row.stage).toBe('proběhlo_jednání')

    // Vyplněná pravděpodobnost zůstává.
    expect(normalizeDealRow({ stage: 'nabídka', probability_pct: 40 })).toEqual({ stage: 'rozsah_nabidka', probability_pct: 40 })
    // Bez sloupce probability_pct se nic nepřidává.
    expect(normalizeDealRow({ stage: 'lead' })).toEqual({ stage: 'kvalifikace' })
    // Nová fáze = tentýž objekt.
    const fresh = { stage: 'diagnostika', probability_pct: null }
    expect(normalizeDealRow(fresh)).toBe(fresh)
    expect(normalizeDealRow(null)).toBeNull()
    expect(normalizeDealRows([row, fresh]).map((r) => r.stage)).toEqual(['kvalifikace', 'diagnostika'])
  })

  test('popisek a pravděpodobnost snesou starou hodnotu', () => {
    expect(dealStageLabel('nabídka')).toBe('Nabídka odeslána')
    expect(dealStageLabel('lead')).toBe('Poptávka')
    expect(defaultProbabilityForStage('proběhlo_jednání')).toBe(30)
    expect(defaultProbabilityForStage('vyjednávání')).toBe(75)
    expect(isOpenDeal('vyjednávání')).toBe(true)
  })

  test('DB filtr otevřených fází obsahuje i staré hodnoty, které se na ně převádějí', () => {
    expect(withLegacyDealStages(['rozsah_nabidka'])).toEqual(['rozsah_nabidka', 'nabídka'])
    expect(withLegacyDealStages(['vyhráno'])).toEqual(['vyhráno'])
    expect(new Set(withLegacyDealStages(OPEN_DEAL_STAGE_KEYS)))
      .toEqual(new Set([...OPEN_DEAL_STAGE_KEYS, ...Object.keys(LEGACY_DEAL_STAGE_MAP)]))
  })
})

describe('převod nepohne čísly pipeline', () => {
  // Stav před změnou, natvrdo (to je smysl snímku): otevřené byly čtyři
  // staré fáze s pevnými pravděpodobnostmi, odloženo zavřené.
  const OLD_OPEN = ['lead', 'proběhlo_jednání', 'nabídka', 'vyjednávání']
  const OLD_PROBABILITY: Record<string, number> = { lead: 10, 'proběhlo_jednání': 30, 'nabídka': 55, 'vyjednávání': 75 }

  const now = new Date('2026-09-28T10:00:00.000Z')
  const base = {
    owner_id: 'a', expected_close: '2026-10-10', next_step_due: '2026-10-01',
    last_activity_at: '2026-09-25T00:00:00.000Z', created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z', won_at: null, closed_at: null,
    account: { id: 1, name: 'Acme' }, owner: null, primary_contact: null,
  }
  const legacyDeals = [
    { id: 1, stage: 'lead', amount_one_time: 100_000, probability_pct: null },
    { id: 2, stage: 'proběhlo_jednání', amount_one_time: 250_000, probability_pct: null },
    { id: 3, stage: 'proběhlo_jednání', amount_one_time: 80_000, probability_pct: 40 },
    { id: 4, stage: 'nabídka', amount_one_time: 580_000, probability_pct: 50 },
    { id: 5, stage: 'vyjednávání', amount_one_time: 1_200_000, probability_pct: null },
    { id: 6, stage: 'vyhráno', amount_one_time: 300_000, probability_pct: 100, won_at: '2026-09-10', closed_at: '2026-09-10' },
    { id: 7, stage: 'prohráno', amount_one_time: 90_000, probability_pct: 0, closed_at: '2026-09-12' },
    { id: 8, stage: 'odloženo', amount_one_time: 400_000, probability_pct: null },
  ].map((d) => ({ ...base, ...d })) as unknown as SalesDealLike[]

  const money = (v: unknown) => Number(v) || 0
  const before = {
    open: legacyDeals.filter((d) => OLD_OPEN.includes(d.stage)).reduce((s, d) => s + money(d.amount_one_time), 0),
    weighted: legacyDeals.filter((d) => OLD_OPEN.includes(d.stage))
      .reduce((s, d) => s + money(d.amount_one_time) * (d.probability_pct ?? OLD_PROBABILITY[d.stage]) / 100, 0),
    won: legacyDeals.filter((d) => d.stage === 'vyhráno').reduce((s, d) => s + money(d.amount_one_time), 0),
    lost: legacyDeals.filter((d) => d.stage === 'prohráno').reduce((s, d) => s + money(d.amount_one_time), 0),
    openCount: legacyDeals.filter((d) => OLD_OPEN.includes(d.stage)).length,
  }

  // Simulace 0050 (stejná pravidla jako SQL): nová fáze + zmrazení
  // výchozí pravděpodobnosti staré fáze tam, kde byla prázdná.
  const migrated = legacyDeals.map((d) => LEGACY_DEAL_STAGE_MAP[d.stage] ? {
    ...d,
    stage: LEGACY_DEAL_STAGE_MAP[d.stage],
    probability_pct: d.probability_pct ?? LEGACY_DEAL_STAGE_PROBABILITY[d.stage],
  } : d) as SalesDealLike[]

  function after(deals: SalesDealLike[]) {
    const open = deals.filter((d) => isOpenDeal(d.stage))
    return {
      open: open.reduce((s, d) => s + money(d.amount_one_time), 0),
      weighted: open.reduce((s, d) => s + weightedValue(d), 0),
      won: deals.filter((d) => d.stage === 'vyhráno').reduce((s, d) => s + money(d.amount_one_time), 0),
      lost: deals.filter((d) => d.stage === 'prohráno').reduce((s, d) => s + money(d.amount_one_time), 0),
      openCount: open.length,
    }
  }

  test('snímek před převodem', () => {
    expect(before).toEqual({ open: 2_210_000, weighted: 1_307_000, won: 300_000, lost: 90_000, openCount: 5 })
  })

  test('po migraci 0050 (data v DB převedená)', () => {
    expect(after(migrated)).toEqual(before)
  })

  test('před migrací 0050 (kód čte staré hodnoty přes normalizér)', () => {
    expect(after(normalizeDealRows(legacyDeals))).toEqual(before)
  })

  test('buildSalesDashboard dává stejná čísla nad převedenými i normalizovanými daty', () => {
    const a = buildSalesDashboard(migrated, [], [], now)
    const b = buildSalesDashboard(normalizeDealRows(legacyDeals), [], [], now)
    for (const d of [a, b]) {
      expect(d.openPipeline).toBe(before.open)
      expect(d.weightedPipeline).toBeCloseTo(before.weighted)
      expect(d.wonThisMonth).toBe(before.won)
    }
  })
})

describe('migrace 0049/0050 odpovídají kódu', () => {
  const expand = read('supabase/migrations/0049_deal_stages_expand.sql')
  const backfill = read('supabase/migrations/0050_deal_stages_backfill.sql')
  const code = (sql: string) => sql.replace(/--[^\n]*/g, '')

  test('0049 přidává právě nové otevřené fáze', () => {
    const added = [...code(expand).matchAll(/ADD VALUE IF NOT EXISTS '([^']+)'/g)].map((m) => m[1])
    expect(added).toEqual(OPEN_DEAL_STAGE_KEYS)
  })

  test('0050 převádí podle stejného mapování a stejných pravděpodobností', () => {
    const sql = code(backfill)
    const cases = [...sql.matchAll(/CASE d\.stage([\s\S]*?)END/g)].map((m) => m[1])
    expect(cases).toHaveLength(2)
    const pairs = (body: string) => Object.fromEntries(
      [...body.matchAll(/WHEN '([^']+)'\s+THEN '?([^'\s]+)'?/g)].map((m) => [m[1], m[2]]),
    )
    expect(pairs(cases[0])).toEqual(LEGACY_DEAL_STAGE_MAP)
    expect(Object.fromEntries(Object.entries(pairs(cases[1])).map(([k, v]) => [k, Number(v)])))
      .toEqual(LEGACY_DEAL_STAGE_PROBABILITY)
  })

  test('0050: audit trigger vypnutý jen po dobu převodu, jeden remap řádek', () => {
    const sql = code(backfill)
    const off = sql.indexOf('DISABLE TRIGGER deal_audit_price_stage_trigger')
    const upd = sql.indexOf('UPDATE deal d')
    const on = sql.indexOf('ENABLE TRIGGER deal_audit_price_stage_trigger')
    expect(off).toBeGreaterThan(-1)
    expect(upd).toBeGreaterThan(off)
    expect(on).toBeGreaterThan(upd)
    expect(sql).toContain("'deal.stage_remapped'")
    expect(sql).toContain("'migration:0050'")
    expect(sql).toMatch(/ALTER COLUMN stage SET DEFAULT 'kvalifikace'/)
  })

  test('0050: v_pipeline_by_line je allow-list otevřených fází se security_invoker', () => {
    const sql = code(backfill)
    const view = /CREATE OR REPLACE VIEW v_pipeline_by_line[\s\S]*?WHERE stage IN \(([^)]*)\)/.exec(sql)
    expect(view).not.toBeNull()
    const allowed = [...view![1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(allowed).toEqual(OPEN_DEAL_STAGE_KEYS)
    expect(sql).toMatch(/v_pipeline_by_line\s+WITH \(security_invoker = on\)/)
  })
})

describe('staré klíče fází nikde mimo normalizér a migrace', () => {
  const DIRS = ['app', 'components', 'domain', 'lib', 'connectors', 'core', 'worker', 'scripts', 'cowork-skill']
  const ALLOWED = new Set(['lib/dealStageLegacy.ts'])
  const EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql)$/
  const OLD_LITERAL = /['"`](lead|proběhlo_jednání|nabídka|vyjednávání)['"`]/

  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return out }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (EXT.test(name)) out.push(full)
    }
    return out
  }

  test('žádný výskyt', () => {
    const offenders: string[] = []
    for (const d of DIRS) {
      for (const file of walk(join(root, d))) {
        const rel = relative(root, file)
        if (ALLOWED.has(rel)) continue
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (OLD_LITERAL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    for (const f of ['supabase/seed.sql', 'proxy.ts']) {
      read(f).split('\n').forEach((line, i) => {
        if (OLD_LITERAL.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
