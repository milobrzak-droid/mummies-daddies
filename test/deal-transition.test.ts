// Kapitola 5 — příležitost a povinná pole při přechodu fáze (migrace 0052).
// Hlídá: pravidla přechodu (zrcadlo DB triggeru), překlad DB kódů CR001/CR002,
// tolerantní zápis před nasazením 0052, zod pole příležitosti a shodu
// migrace s aplikačními konstantami.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'
import {
  DEAL_TRANSITION_DB_CODES, DEAL_TRANSITION_MESSAGES, dealTransitionDbMessage,
  transitionFieldErrors, transitionIssues,
} from '@/domain/crm/dealTransition'
import { DEAL_0052_COLUMNS, writeDealTolerant } from '@/domain/crm/dealWrite'
import { DEAL_KINDS, DEAL_KIND_KEYS, dealKindLabel, isDealKind } from '@/lib/domain'
import { dealSchema } from '@/lib/validation/schemas'
import { updateDealStage } from '@/domain/crm/actions/sales'
import { createDeal, updateDeal } from '@/domain/crm/actions/deals'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/connectors/cnb', () => ({ czkPerEur: vi.fn(async () => 25) }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(async () => ({ user: { id: 'user-1' }, member: { role: 'vedeni' } })),
  memberSeesSales: vi.fn((member: { role?: string | null } | null) => member?.role === 'vedeni' || member?.role === 'obchodnik'),
}))

function fake(resolve: (call: QueryCall) => QueryResult) {
  const f = createSupabaseFake({ user: { id: 'user-1' }, resolve })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

beforeEach(() => { vi.clearAllMocks() })

describe('transitionIssues', () => {
  const decided = { decision_maker: 'CFO Novák', decision_due: '2026-10-15' }

  test('do rozhodování bez rozhodovatele a termínu', () => {
    expect(transitionIssues({ stage: 'rozsah_nabidka', decision_maker: null, decision_due: null }, 'rozhodovani'))
      .toEqual(['missing_decision_maker', 'missing_decision_due'])
    expect(transitionIssues({ stage: 'rozsah_nabidka', decision_maker: '  ', decision_due: '2026-10-15' }, 'rozhodovani'))
      .toEqual(['missing_decision_maker'])
    expect(transitionIssues({ stage: 'rozsah_nabidka', decision_maker: 'CFO', decision_due: '' }, 'rozhodovani'))
      .toEqual(['missing_decision_due'])
  })

  test('s rozhodovatelem a termínem projde', () => {
    expect(transitionIssues({ stage: 'diagnostika', ...decided }, 'rozhodovani')).toEqual([])
  })

  test('obchod, který ve fázi už je, se nekontroluje (0050 backfill)', () => {
    expect(transitionIssues({ stage: 'rozhodovani', decision_maker: null, decision_due: null }, 'rozhodovani')).toEqual([])
    // Stará hodnota se převádí stejně jako v triggeru: vyjednávání = rozhodovani.
    expect(transitionIssues({ stage: 'vyjednávání', decision_maker: null, decision_due: null }, 'rozhodovani')).toEqual([])
    expect(transitionIssues({ stage: 'prohráno', lost_reason: null }, 'prohráno')).toEqual([])
  })

  test('nový obchod (stage null) rovnou v rozhodování = přechod', () => {
    expect(transitionIssues({ stage: null, decision_maker: null, decision_due: null }, 'rozhodovani'))
      .toEqual(['missing_decision_maker', 'missing_decision_due'])
  })

  test('prohráno vyžaduje důvod', () => {
    expect(transitionIssues({ stage: 'kvalifikace', lost_reason: '' }, 'prohráno')).toEqual(['missing_lost_reason'])
    expect(transitionIssues({ stage: 'kvalifikace' }, 'prohráno')).toEqual(['missing_lost_reason'])
    expect(transitionIssues({ stage: 'kvalifikace', lost_reason: 'Rozpočet' }, 'prohráno')).toEqual([])
  })

  test('ostatní fáze bez povinných polí', () => {
    for (const to of ['kvalifikace', 'diagnostika', 'rozsah_nabidka', 'vyhráno', 'odloženo']) {
      expect(transitionIssues({ stage: 'kvalifikace' }, to)).toEqual([])
    }
  })

  test('před 0052 (sloupce v řádku chybí) se rozhodovatel ani termín nekontrolují', () => {
    expect(transitionIssues({ stage: 'rozsah_nabidka' }, 'rozhodovani')).toEqual([])
  })

  test('fieldErrors míří na pole formuláře', () => {
    expect(transitionFieldErrors(['missing_decision_maker', 'missing_lost_reason'])).toEqual({
      decision_maker: DEAL_TRANSITION_MESSAGES.missing_decision_maker,
      lost_reason: DEAL_TRANSITION_MESSAGES.missing_lost_reason,
    })
  })
})

describe('DB kódy z triggeru 0052', () => {
  test('CR001/CR002 → česká hláška', () => {
    expect(dealTransitionDbMessage({ code: 'CR001' })).toMatch(/Rozhodování/)
    expect(dealTransitionDbMessage({ code: 'CR002' })).toMatch(/důvod prohry/)
  })
  test('jiné chyby nechá na dbErrorMessage', () => {
    expect(dealTransitionDbMessage({ code: '23505' })).toBeNull()
    expect(dealTransitionDbMessage({ code: 'toString' })).toBeNull()
    expect(dealTransitionDbMessage(null)).toBeNull()
    expect(dealTransitionDbMessage({})).toBeNull()
  })
})

describe('writeDealTolerant', () => {
  const row = { title: 'A', no_next_step_reason: 'x', deal_kind: 'workshop', decision_due: null }

  test('bez chyby zapíše jednou celý řádek', async () => {
    const write = vi.fn().mockResolvedValue({ error: null })
    await writeDealTolerant(row, write)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toEqual(row)
  })

  test('před 0052 (a po 0047) zahodí jen sloupce 0052', async () => {
    const write = vi.fn()
      .mockResolvedValueOnce({ error: { code: 'PGRST204' } })
      .mockResolvedValueOnce({ error: null })
    const res = await writeDealTolerant(row, write)
    expect(res.error).toBeNull()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0]).toEqual({ title: 'A', no_next_step_reason: 'x' })
  })

  test('před 0047 i 0052 zahodí postupně obojí', async () => {
    const write = vi.fn()
      .mockResolvedValueOnce({ error: { code: '42703' } })
      .mockResolvedValueOnce({ error: { code: '42703' } })
      .mockResolvedValueOnce({ error: null })
    const res = await writeDealTolerant(row, write)
    expect(res.error).toBeNull()
    expect(write.mock.calls[2][0]).toEqual({ title: 'A' })
  })

  test('řádek bez sloupců 0052 rovnou zkusí bez 0047', async () => {
    const write = vi.fn()
      .mockResolvedValueOnce({ error: { code: 'PGRST204' } })
      .mockResolvedValueOnce({ error: null })
    await writeDealTolerant({ title: 'A', no_next_step_reason: null }, write)
    expect(write.mock.calls[1][0]).toEqual({ title: 'A' })
  })

  test('jiné chyby (i CR001) se neopakují', async () => {
    const write = vi.fn().mockResolvedValue({ error: { code: 'CR001' } })
    const res = await writeDealTolerant(row, write)
    expect(res.error?.code).toBe('CR001')
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('dealSchema — pole příležitosti', () => {
  const base = { account_id: 1, title: 'T', revenue_line: 'svatebni_hostina' }

  test('prázdné = null', () => {
    const d = dealSchema.parse({ ...base, deal_kind: '', problem: ' ', decision_due: '' })
    expect(d.deal_kind).toBeNull()
    expect(d.problem).toBeNull()
    expect(d.decision_due).toBeNull()
    expect(d.decision_maker).toBeNull()
  })

  test('typ obchodu jen z číselníku', () => {
    for (const k of DEAL_KIND_KEYS) expect(dealSchema.parse({ ...base, deal_kind: k }).deal_kind).toBe(k)
    expect(dealSchema.safeParse({ ...base, deal_kind: 'konzultace' }).success).toBe(false)
  })

  test('trim a délky jako CHECKy v DB', () => {
    expect(dealSchema.parse({ ...base, decision_maker: '  CFO  ' }).decision_maker).toBe('CFO')
    expect(dealSchema.safeParse({ ...base, decision_maker: 'x'.repeat(200) }).success).toBe(true)
    expect(dealSchema.safeParse({ ...base, decision_maker: 'x'.repeat(201) }).success).toBe(false)
    expect(dealSchema.safeParse({ ...base, problem: 'x'.repeat(2001) }).success).toBe(false)
    expect(dealSchema.safeParse({ ...base, expected_outcome: 'x'.repeat(2001) }).success).toBe(false)
    expect(dealSchema.safeParse({ ...base, decision_process: 'x'.repeat(2001) }).success).toBe(false)
    expect(dealSchema.safeParse({ ...base, value_basis: 'x'.repeat(501) }).success).toBe(false)
  })

  test('termín rozhodnutí musí být datum', () => {
    expect(dealSchema.parse({ ...base, decision_due: '2026-10-15' }).decision_due).toBe('2026-10-15')
    expect(dealSchema.safeParse({ ...base, decision_due: 'zítra' }).success).toBe(false)
  })

  test('číselník typů', () => {
    expect(DEAL_KINDS.map((k) => k.key)).toEqual(['workshop', 'implementace', 'provoz', 'jine'])
    expect(isDealKind('workshop')).toBe(true)
    expect(isDealKind('lead')).toBe(false)
    expect(dealKindLabel('implementace')).toBe('Jednorázová akce')
    expect(dealKindLabel(null)).toBeNull()
  })
})

describe('updateDealStage — přetažení v pipeline', () => {
  test('do rozhodování bez rozhodovatele vrátí důvod a nezapisuje', async () => {
    const f = fake((call) => call.table === 'team_member'
      ? { data: { role: 'vedeni' }, error: null }
      : hasOp(call, 'maybeSingle')
        ? { data: { account_id: 5, stage: 'rozsah_nabidka', decision_maker: null, decision_due: null }, error: null }
        : { data: null, error: null })
    const res = await updateDealStage(7, 'rozhodovani')
    expect(res.success).toBe(false)
    expect(res.error).toContain(DEAL_TRANSITION_MESSAGES.missing_decision_maker)
    expect(res.error).toContain(DEAL_TRANSITION_MESSAGES.missing_decision_due)
    expect(f.calls.some((c) => c.table === 'deal' && hasOp(c, 'update'))).toBe(false)
  })

  test('s rozhodovatelem projde a zapíše', async () => {
    const f = fake((call) => call.table === 'team_member'
      ? { data: { role: 'vedeni' }, error: null }
      : hasOp(call, 'maybeSingle')
        ? { data: { account_id: 5, stage: 'rozsah_nabidka', decision_maker: 'CFO', decision_due: '2026-10-15' }, error: null }
        : { data: null, error: null })
    expect(await updateDealStage(7, 'rozhodovani')).toEqual({ success: true })
    const upd = f.calls.find((c) => c.table === 'deal' && hasOp(c, 'update'))
    expect((opArgs(upd!, 'update')?.[0] as { stage: string }).stage).toBe('rozhodovani')
  })

  test('před 0052 (sloupce chybí) nechá rozhodnout DB; CR001 z DB přeloží', async () => {
    fake((call) => call.table === 'team_member'
      ? { data: { role: 'vedeni' }, error: null }
      : hasOp(call, 'maybeSingle')
        ? { data: { account_id: 5, stage: 'rozsah_nabidka' }, error: null }
        : hasOp(call, 'update') ? { data: null, error: { code: 'CR001', message: 'raw' } } : { data: null, error: null })
    expect(await updateDealStage(7, 'rozhodovani'))
      .toEqual({ success: false, error: DEAL_TRANSITION_DB_CODES.CR001 })
  })
})

describe('updateDeal / createDeal — formulář', () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries({ title: 'Obchod', revenue_line: 'svatebni_hostina', ...fields })) fd.set(k, v)
    return fd
  }
  const existing = (stage: string) => (call: QueryCall): QueryResult => {
    if (call.table === 'deal' && hasOp(call, 'maybeSingle')) {
      return { data: { account_id: 5, stage, closed_at: null, won_at: null, currency: 'CZK', amount_one_time: 0, amount_one_time_original: null, fx_rate: null }, error: null }
    }
    return { data: null, error: null }
  }

  test('přechod do rozhodování bez polí → fieldErrors, bez zápisu', async () => {
    const f = fake(existing('rozsah_nabidka'))
    const res = await updateDeal(5, 7, null, form({ stage: 'rozhodovani' }))
    expect(res.success).toBe(false)
    expect(Object.keys(res.fieldErrors ?? {}).sort()).toEqual(['decision_due', 'decision_maker'])
    expect(f.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('obchod už v rozhodování jde upravit i bez polí', async () => {
    const f = fake(existing('rozhodovani'))
    const res = await updateDeal(5, 7, null, form({ stage: 'rozhodovani', note: 'x' }))
    expect(res).toBeUndefined() // úspěch končí redirectem (mock)
    expect(f.calls.some((c) => c.table === 'deal' && hasOp(c, 'update'))).toBe(true)
  })

  test('pole příležitosti jdou do zápisu; před 0052 zápis zopakuje bez nich', async () => {
    let attempts = 0
    const f = fake((call) => {
      if (call.table === 'deal' && hasOp(call, 'update')) {
        attempts++
        return attempts === 1 ? { data: null, error: { code: 'PGRST204' } } : { data: null, error: null }
      }
      return existing('diagnostika')(call)
    })
    await updateDeal(5, 7, null, form({
      stage: 'rozhodovani', decision_maker: 'CFO', decision_due: '2026-10-15', deal_kind: 'workshop',
    }))
    const updates = f.calls.filter((c) => c.table === 'deal' && hasOp(c, 'update'))
    expect(updates).toHaveLength(2)
    const first = opArgs(updates[0], 'update')?.[0] as Record<string, unknown>
    const second = opArgs(updates[1], 'update')?.[0] as Record<string, unknown>
    expect(first).toMatchObject({ deal_kind: 'workshop', decision_maker: 'CFO', decision_due: '2026-10-15' })
    for (const col of DEAL_0052_COLUMNS) expect(second).not.toHaveProperty(col)
    expect(second.stage).toBe('rozhodovani')
  })

  test('CR002 z DB se přeloží', async () => {
    fake((call) => call.table === 'deal' && hasOp(call, 'update')
      ? { data: null, error: { code: 'CR002' } }
      : existing('kvalifikace')(call))
    const res = await updateDeal(5, 7, null, form({ stage: 'prohráno', lost_reason: 'Rozpočet' }))
    expect(res).toEqual({ success: false, error: DEAL_TRANSITION_DB_CODES.CR002 })
  })

  test('nový obchod rovnou v rozhodování vyžaduje pole', async () => {
    const f = fake(() => ({ data: null, error: null }))
    const res = await createDeal(5, null, form({ stage: 'rozhodovani' }))
    expect(res.fieldErrors).toHaveProperty('decision_maker')
    expect(f.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })
})

describe('migrace 0052 odpovídá aplikaci', () => {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0052_deal_opportunity.sql'), 'utf8')

  test('CHECK typu obchodu = DEAL_KINDS', () => {
    const m = /deal_kind IN \(([^)]*)\)/.exec(sql)
    expect(m).not.toBeNull()
    expect([...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1])).toEqual([...DEAL_KIND_KEYS])
  })

  test('kódy chyb v triggeru = DEAL_TRANSITION_DB_CODES', () => {
    const codes = [...sql.matchAll(/ERRCODE = '(\w+)'/g)].map((x) => x[1]).sort()
    expect(codes).toEqual(Object.keys(DEAL_TRANSITION_DB_CODES).sort())
  })

  test('všechny sloupce 0052 přidává migrace', () => {
    for (const col of DEAL_0052_COLUMNS) expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`))
  })

  test('trigger na INSERT i změnu fáze, UPDATE beze změny fáze propustí', () => {
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF stage ON deal/)
    expect(sql).toMatch(/OLD\.stage IS NOT DISTINCT FROM NEW\.stage/)
  })
})
