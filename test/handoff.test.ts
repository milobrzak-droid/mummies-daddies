import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { completeHandoff, saveHandoff } from '@/domain/delivery/actions/milestones'
import {
  buildHandoffPackage,
  HANDOFF_HINT,
  HANDOFF_ITEMS,
  handoffSchema,
  validateHandoff,
  type HandoffSource,
} from '@/domain/delivery/milestone'
import { createSupabaseFake, hasOp, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Předávací balíček (kap. 6, 0054): skladba z více tabulek, validace,
// uložení a „Předat do realizace" jen s úplným balíčkem.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(),
  tryRequireUser: vi.fn(),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/core/evidence', () => ({ recordEvidence: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const USER = { id: '00000000-0000-4000-8000-000000000001' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue(USER as never)
  vi.mocked(dbAuditActive).mockResolvedValue(false)
})

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

const full: HandoffSource = {
  goal: 'Adopce Copilotu v obchodě',
  scope: 'Workshop + procesní mapa',
  deal_id: 4,
  deal_is_won: true,
  client_sponsor_contact_id: 9,
  started_on: '2026-10-01',
  due_on: '2026-12-15',
  baseline_ok: true,
  financial_frame: '180 000 Kč, fakturace po milnících',
  risks: [],
  documentCount: 1,
  milestoneOwnerCount: 1,
}

describe('buildHandoffPackage + validateHandoff', () => {
  test('úplný balíček projde', () => {
    expect(validateHandoff(buildHandoffPackage(full))).toEqual({ ok: true, missing: [] })
  })

  test('každá položka chybí samostatně', () => {
    const cases: [Partial<HandoffSource>, string][] = [
      [{ goal: '  ' }, 'goal'],
      [{ scope: null }, 'scope'],
      [{ deal_id: null }, 'approvedOffer'],
      [{ deal_is_won: false }, 'approvedOffer'],
      [{ client_sponsor_contact_id: null }, 'clientSponsor'],
      [{ due_on: null }, 'dates'],
      [{ started_on: null }, 'dates'],
      [{ baseline_ok: false }, 'baselineMetric'],
      [{ financial_frame: '' }, 'financialFrame'],
      [{ documentCount: 0 }, 'materials'],
      [{ risks: null }, 'risks'],
      [{ milestoneOwnerCount: 0 }, 'owner'],
    ]
    for (const [patch, key] of cases) {
      expect(validateHandoff(buildHandoffPackage({ ...full, ...patch })).missing).toEqual([key])
    }
  })

  test('každá položka má nápovědu', () => {
    for (const i of HANDOFF_ITEMS) expect(HANDOFF_HINT[i.key]).toBeTruthy()
  })
})

describe('handoffSchema — rizika', () => {
  const base = { goal: 'x', scope: 'y', financial_frame: 'z' }
  test('prázdná textarea bez zaškrtnutí = nevyplněno (null)', () => {
    const r = handoffSchema.safeParse({ ...base, risks_text: '  \n ' })
    expect(r.success && r.data.risks).toBe(null)
  })
  test('zaškrtnuté „žádná" = []', () => {
    const r = handoffSchema.safeParse({ ...base, risks_text: '', no_risks: 'on' })
    expect(r.success && r.data.risks).toEqual([])
  })
  test('řádky = rizika, prázdné vynechané', () => {
    const r = handoffSchema.safeParse({ ...base, risks_text: 'Licence\n\n  Data v Excelu  \r\n' })
    expect(r.success && r.data.risks).toEqual(['Licence', 'Data v Excelu'])
  })
  test('rizika i „žádná" zároveň nejde', () => {
    const r = handoffSchema.safeParse({ ...base, risks_text: 'Licence', no_risks: 'on' })
    expect(r.success).toBe(false)
  })
  test('prázdné textové pole = null, ne prázdný řetězec', () => {
    const r = handoffSchema.safeParse({ goal: '  ', scope: '', financial_frame: '', client_sponsor_contact_id: '', deal_id: '' })
    expect(r.success && r.data).toEqual({
      goal: null, scope: null, deal_id: null, client_sponsor_contact_id: null, financial_frame: null, risks: null,
    })
  })
  test('příliš mnoho rizik je odmítnuto', () => {
    const r = handoffSchema.safeParse({ risks_text: Array.from({ length: 31 }, (_, i) => `r${i}`).join('\n') })
    expect(r.success).toBe(false)
  })
})

type Route = (call: QueryCall) => QueryResult | undefined
// deal_public (0058): výchozí = obchod 4 firmy 1, vyhraný. Test ho přepíše
// přes `rpcImpl` (jiná firma, nevyhraný, chybějící funkce, chyba AAL2).
const WON_DEAL = { id: 4, account_id: 1, title: 'Nabídka Copilot', is_won: true }
let rpcImpl: (name: string, args: unknown) => QueryResult = () => ({ data: [WON_DEAL], error: null })
const MISSING_FN = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.deal_public' } }
function fakeWith(...routes: Route[]) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      for (const r of routes) {
        const out = r(call)
        if (out) return out
      }
      return { data: null, error: null }
    },
    rpc: (name, args) => rpcImpl(name, args),
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}
const isRead = (c: QueryCall) => !hasOp(c, 'update') && !hasOp(c, 'insert') && !hasOp(c, 'delete')

describe('saveHandoff', () => {
  beforeEach(() => { rpcImpl = () => ({ data: [WON_DEAL], error: null }) })
  const engagement: Route = (c) => (c.table === 'engagement' && isRead(c) ? { data: { id: 2, account_id: 1 }, error: null } : undefined)

  test('uloží pět položek na dodávku firmy', async () => {
    const fake = fakeWith(engagement, (c) => (c.table === 'contact' ? { data: { id: 1 }, error: null } : undefined), (c) =>
      hasOp(c, 'update') ? { data: [{ id: 2 }], error: null } : undefined,
    )
    const r = await saveHandoff(1, 2, undefined, fd({
      goal: 'Cíl', scope: 'Rozsah', deal_id: '4', client_sponsor_contact_id: '9', financial_frame: 'Rámec', risks_text: 'A\nB',
    }))
    expect(r).toEqual({ success: true })
    const upd = fake.calls.find((c) => c.table === 'engagement' && hasOp(c, 'update'))!
    expect(upd.ops.find((o) => o.method === 'update')!.args[0]).toEqual({
      goal: 'Cíl', scope: 'Rozsah', deal_id: 4, client_sponsor_contact_id: 9, financial_frame: 'Rámec', risks: ['A', 'B'],
    })
    expect(upd.ops).toContainEqual({ method: 'eq', args: ['account_id', 1] })
    // Sponzor i obchod ověřené proti firmě dodávky.
    expect(fake.calls.find((c) => c.table === 'contact')!.ops).toContainEqual({ method: 'eq', args: ['account_id', 1] })
    // Obchod přes deal_public (0058) jen v rámci firmy dodávky — na tabulku
    // deal se nesahá, takže to funguje i projekťákovi.
    expect(fake.rpc).toHaveBeenCalledWith('deal_public', { p_account_id: 1 })
    expect(fake.calls.some((c) => c.table === 'deal')).toBe(false)
  })

  test('před migrací 0058 (deal_public chybí) → ověření přímo nad deal ve firmě dodávky', async () => {
    rpcImpl = () => MISSING_FN
    const fake = fakeWith(
      engagement,
      (c) => (c.table === 'deal' ? { data: [{ id: 4, account_id: 1, title: 'N', stage: 'vyhráno' }], error: null } : undefined),
      (c) => (hasOp(c, 'update') ? { data: [{ id: 2 }], error: null } : undefined),
    )
    expect(await saveHandoff(1, 2, undefined, fd({ deal_id: '4' }))).toEqual({ success: true })
    const deal = fake.calls.find((c) => c.table === 'deal')!
    expect(deal.ops).toContainEqual({ method: 'eq', args: ['account_id', 1] })
    expect(deal.ops.find((o) => o.method === 'select')!.args[0]).toBe('id, account_id, title, stage')
  })

  test('deal_public odmítne (např. bez AAL2) → chyba, žádný update', async () => {
    rpcImpl = () => ({ data: null, error: { code: '42501', message: 'Vyžadováno dvoufázové ověření (AAL2)' } })
    const fake = fakeWith(engagement)
    const r = await saveHandoff(1, 2, undefined, fd({ deal_id: '4' }))
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
    expect(fake.calls.some((c) => c.table === 'deal')).toBe(false)
  })

  test('sponzor z jiné firmy → chyba, žádný update', async () => {
    const fake = fakeWith(engagement, (c) => (c.table === 'contact' ? { data: null, error: null } : undefined))
    const r = await saveHandoff(1, 2, undefined, fd({ client_sponsor_contact_id: '9' }))
    expect(r.fieldErrors?.client_sponsor_contact_id).toBeTruthy()
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('obchod z jiné firmy → chyba, žádný update', async () => {
    rpcImpl = () => ({ data: [{ ...WON_DEAL, id: 5 }], error: null })
    const fake = fakeWith(engagement)
    const r = await saveHandoff(1, 2, undefined, fd({ deal_id: '4' }))
    expect(r.fieldErrors?.deal_id).toBeTruthy()
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('před migrací 0054 (chybějící sloupec) → klidná hláška', async () => {
    fakeWith(engagement, (c) => (hasOp(c, 'update') ? { data: null, error: { code: 'PGRST204', message: 'column' } } : undefined))
    const r = await saveHandoff(1, 2, undefined, fd({ goal: 'x' }))
    expect(r).toEqual({ success: false, error: 'Předávací balíček ještě není dostupný — čeká na migraci 0054.' })
  })

  test('vyprázdnění předané dodávky (CHECK 23514) → srozumitelná hláška', async () => {
    fakeWith(engagement, (c) => (hasOp(c, 'update') ? { data: null, error: { code: '23514', message: 'check' } } : undefined))
    const r = await saveHandoff(1, 2, undefined, fd({ goal: '' }))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Předaná dodávka/)
  })
})

describe('completeHandoff — „Předat do realizace"', () => {
  const engRow = {
    account_id: 1, kind: 'edu', deal_id: 4, started_on: '2026-10-01', due_on: '2026-12-15', baseline_adoption_pct: 17,
    goal: 'Cíl', scope: 'Rozsah', client_sponsor_contact_id: 9, financial_frame: 'Rámec', risks: [], handoff_completed_at: null,
  }
  beforeEach(() => { rpcImpl = () => ({ data: [WON_DEAL], error: null }) })
  const routes = (row: Record<string, unknown>, extra: Route[] = []): Route[] => [
    ...extra,
    (c) => (c.table === 'engagement' && isRead(c) ? { data: row, error: null } : undefined),
    (c) => (c.table === 'engagement_document' ? { data: [{ id: 5 }], error: null } : undefined),
    (c) => (c.table === 'engagement_milestone' ? { data: [{ owner_id: USER.id }, { owner_id: null }], error: null } : undefined),
    (c) => (c.table === 'engagement' && hasOp(c, 'update') ? { data: [{ id: 2 }], error: null } : undefined),
    // Výchozí stav hlavní metriky (0088): u vzdělávání je výchozí adopce.
    (c) => (c.table === 'metric_observation'
      ? { data: [{ id: 1, metric_key: 'adopce', baseline: '17', actual: null, observed_on: '2026-09-01' }], error: null }
      : undefined),
  ]
  const selectsImpact = (c: QueryCall) => c.table === 'engagement' && String(c.ops.find((o) => o.method === 'select')?.args[0]).includes('impact_')
  const noObservations: Route = (c) => (c.table === 'metric_observation' ? { data: [], error: null } : undefined)

  describe('výchozí metrika (P1.3, 0088)', () => {
    test('měření jiné metriky nestačí: IT dodávka se starou „adopcí 0" neprojde', async () => {
      const fake = fakeWith(...routes({ ...engRow, kind: 'it', baseline_adoption_pct: 0 }))
      const r = await completeHandoff(1, 2)
      expect(r.error).toBe('Předávací balíček není úplný — chybí: Výchozí metrika.')
      expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
    })

    test('výchozí měření zvolené metriky projde', async () => {
      fakeWith(...routes({ ...engRow, kind: 'it', impact_metric_key: 'adopce' }))
      expect(await completeHandoff(1, 2)).toEqual({ success: true })
    })

    test('doložené „zatím nelze měřit" projde i bez měření', async () => {
      const row = { ...engRow, kind: 'it', impact_unmeasurable_reason: 'Klient dodá data z ERP až v listopadu.', impact_unmeasurable_at: '2026-09-29T10:00:00Z' }
      fakeWith(...routes(row, [noObservations]))
      expect(await completeHandoff(1, 2)).toEqual({ success: true })
    })

    test('bez měření a bez důvodu chybí, i když je vyplněná stará Adopce %', async () => {
      fakeWith(...routes(engRow, [noObservations]))
      expect((await completeHandoff(1, 2)).error).toBe('Předávací balíček není úplný — chybí: Výchozí metrika.')
    })

    test('před 0088 (chybí sloupce) platí staré pravidlo z Adopce %', async () => {
      const missing: Route = (c) => (selectsImpact(c) ? { data: null, error: { code: '42703', message: 'column engagement.impact_metric_key does not exist' } } : undefined)
      const missingKey: Route = (c) => (c.table === 'metric_observation' && String(c.ops[0]?.args[0]).includes('metric_key')
        ? { data: null, error: { code: '42703', message: 'column metric_key does not exist' } }
        : c.table === 'metric_observation' ? { data: [], error: null } : undefined)
      fakeWith(...routes(engRow, [missing, missingKey]))
      expect(await completeHandoff(1, 2)).toEqual({ success: true })
      fakeWith(...routes({ ...engRow, baseline_adoption_pct: null }, [missing, missingKey]))
      expect((await completeHandoff(1, 2)).error).toMatch(/Výchozí metrika/)
    })
  })

  test('úplný balíček → zapíše handoff_completed_at + handoff_by jen pokud ještě nebyl předán', async () => {
    const fake = fakeWith(...routes(engRow))
    expect(await completeHandoff(1, 2)).toEqual({ success: true })
    const upd = fake.calls.find((c) => c.table === 'engagement' && hasOp(c, 'update'))!
    const payload = upd.ops.find((o) => o.method === 'update')!.args[0] as Record<string, unknown>
    expect(payload.handoff_by).toBe(USER.id)
    expect(typeof payload.handoff_completed_at).toBe('string')
    expect(upd.ops).toContainEqual({ method: 'is', args: ['handoff_completed_at', null] })
    expect(recordAudit).toHaveBeenCalledWith('engagement', 2, 'engagement.handoff_completed', expect.anything(), expect.anything(), { type: 'user', id: USER.id }, { infoState: 'human_confirmed' })
  })

  test('po migraci 0064 zapíše předání DB trigger → appka audit nepíše', async () => {
    vi.mocked(dbAuditActive).mockResolvedValue(true)
    const fake = fakeWith(...routes(engRow))
    expect(await completeHandoff(1, 2)).toEqual({ success: true })
    expect(fake.calls.some((c) => c.table === 'engagement' && hasOp(c, 'update'))).toBe(true)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('neúplný balíček → vyjmenuje chybějící položky česky, nic nezapíše', async () => {
    const fake = fakeWith(...routes({ ...engRow, goal: null, risks: null }, [
      (c) => (c.table === 'engagement_document' ? { data: [], error: null } : undefined),
    ]))
    const r = await completeHandoff(1, 2)
    expect(r.success).toBe(false)
    expect(r.error).toBe('Předávací balíček není úplný — chybí: Cíl, Podklady, Rizika.')
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('úplný balíček: „vyhráno" z deal_public, na tabulku deal se nesahá (projekťák)', async () => {
    const fake = fakeWith(...routes(engRow))
    expect(await completeHandoff(1, 2)).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('deal_public', { p_account_id: 1 })
    expect(fake.calls.some((c) => c.table === 'deal')).toBe(false)
  })

  test('obchod, který není vyhraný, není schválená nabídka', async () => {
    rpcImpl = () => ({ data: [{ ...WON_DEAL, is_won: false }], error: null })
    fakeWith(...routes(engRow))
    const r = await completeHandoff(1, 2)
    expect(r.error).toMatch(/Schválená nabídka/)
  })

  test('obchod jiné firmy se jako schválená nabídka nepočítá', async () => {
    rpcImpl = () => ({ data: [], error: null })
    fakeWith(...routes(engRow))
    expect((await completeHandoff(1, 2)).error).toMatch(/Schválená nabídka/)
  })

  test('před migrací 0058 (42883) → fáze z deal, vyhráno projde', async () => {
    rpcImpl = () => ({ data: null, error: { code: '42883', message: 'function deal_public(bigint) does not exist' } })
    const fake = fakeWith(...routes(engRow, [
      (c) => (c.table === 'deal' ? { data: [{ id: 4, account_id: 1, title: 'N', stage: 'vyhráno' }], error: null } : undefined),
    ]))
    expect(await completeHandoff(1, 2)).toEqual({ success: true })
    expect(fake.calls.find((c) => c.table === 'deal')!.ops).toContainEqual({ method: 'eq', args: ['account_id', 1] })
  })

  test('před migrací 0058 → nevyhraný obchod z deal neprojde', async () => {
    rpcImpl = () => MISSING_FN
    fakeWith(...routes(engRow, [
      (c) => (c.table === 'deal' ? { data: [{ id: 4, account_id: 1, title: 'N', stage: 'rozhodovani' }], error: null } : undefined),
    ]))
    expect((await completeHandoff(1, 2)).error).toMatch(/Schválená nabídka/)
  })

  test('deal_public selže jinak → chyba, nic se nezapíše', async () => {
    rpcImpl = () => ({ data: null, error: { code: '42501', message: 'Jen pro člena týmu' } })
    const fake = fakeWith(...routes(engRow))
    const r = await completeHandoff(1, 2)
    expect(r.success).toBe(false)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('před migrací 0042/0051 (chybí tabulky) → položky chybí, nepadá', async () => {
    const missing = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    fakeWith(...routes(engRow, [
      (c) => (c.table === 'engagement_document' || c.table === 'engagement_milestone' ? missing : undefined),
    ]))
    const r = await completeHandoff(1, 2)
    expect(r.error).toBe('Předávací balíček není úplný — chybí: Podklady, Vlastník.')
  })

  test('před migrací 0054 → klidná hláška', async () => {
    fakeWith((c) => (c.table === 'engagement' ? { data: null, error: { code: '42703', message: 'column engagement.goal does not exist' } } : undefined))
    expect(await completeHandoff(1, 2)).toEqual({ success: false, error: 'Předávací balíček ještě není dostupný — čeká na migraci 0054.' })
  })

  test('už předaná nebo cizí dodávka', async () => {
    fakeWith(...routes({ ...engRow, handoff_completed_at: '2026-09-01T00:00:00Z' }))
    expect((await completeHandoff(1, 2)).error).toMatch(/už je předaná/)
    fakeWith(...routes({ ...engRow, account_id: 99 }))
    expect((await completeHandoff(1, 2)).error).toBe('Dodávka nebyla nalezena.')
  })
})

describe('migrace', () => {
  const m42 = readFileSync('supabase/migrations/0042_engagement_milestone.sql', 'utf8')
  const m54 = readFileSync('supabase/migrations/0054_handoff_package.sql', 'utf8')

  test('0042: akceptace v CHECKu a FK dokumentu na milník ON DELETE SET NULL hlídaná to_regclass', () => {
    expect(m42).toMatch(/status NOT IN \('prijato', 'uzavreno'\)\s*OR \(accepted_at IS NOT NULL AND acceptance_evidence_id IS NOT NULL\)/)
    expect(m42).toMatch(/to_regclass\('public\.engagement_document'\)/)
    expect(m42).toMatch(/FOREIGN KEY \(milestone_id\) REFERENCES engagement_milestone\(id\) ON DELETE SET NULL/)
    expect(m42).toMatch(/schválený/i)
  })

  test('0054: pět položek + předání, sponzor SET NULL, sponzor mimo CHECK předání', () => {
    for (const col of ['goal', 'scope', 'client_sponsor_contact_id', 'financial_frame', 'risks', 'handoff_completed_at', 'handoff_by']) {
      expect(m54).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`))
    }
    expect(m54).toMatch(/client_sponsor_contact_id bigint\s+REFERENCES contact\(id\) ON DELETE SET NULL/)
    const check = m54.match(/engagement_handoff_complete_check\s+CHECK \(([\s\S]*?)\)\);/)?.[1] ?? ''
    expect(check).toMatch(/risks IS NOT NULL/)
    expect(check).not.toMatch(/client_sponsor_contact_id/)
    // risks bez DEFAULT — NULL (nevyplněno) ≠ '{}' (vědomě žádná).
    expect(m54).not.toMatch(/risks text\[\][^;]*DEFAULT/)
  })
})
