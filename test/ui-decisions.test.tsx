import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { getDecisionInbox, getLoopNodes } from '@/core/loopQueries'
import { getDecisionHistory } from '@/core/decisionHistory'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { listAssignableMembers } from '@/domain/crm/queries/tasks'
import { KindCards, MilestonePrompt, splitMoney } from '@/components/FinanceCards'
import { CapacityDotMatrix, CapacityGauge } from '@/components/CapacityVisuals'
import { buildFinanceBoard, type FinancialRecordRow } from '@/domain/finance/records'
import { capacityPlan, weeksFrom } from '@/domain/delivery/capacity'
import { listAccountOptions, listFinancialRecords } from '@/domain/finance/queries/records'
import { listUninvoicedMilestones } from '@/domain/finance/queries/uninvoiced'
import { listOverdueInvoices } from '@/domain/finance/queries/overdue'
import { getIdokladStatus, listOpenDiscrepancies } from '@/domain/finance/queries/idoklad'
import { getOfferApprovalTargets } from '@/domain/crm/queries/scopeVersions'

// Nový vzhled Ke schválení, Kapacit a Financí: statické vykreslení se
// zamockovanými dotazy. Hlídá texty, čtyři akce, klidný prázdný stav
// a přístupné popisky grafů.

vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/rozhodnuti', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/core/loopQueries', async (orig) => ({
  ...(await orig<typeof import('@/core/loopQueries')>()),
  getDecisionInbox: vi.fn(),
  getLoopNodes: vi.fn(),
}))
vi.mock('@/core/decisionHistory', () => ({ getDecisionHistory: vi.fn() }))
vi.mock('@/core/actions/workCases', () => ({ decideApprovalRequest: vi.fn() }))
vi.mock('@/core/actions/approvals', () => ({ snoozeApprovalRequest: vi.fn(), retryApprovalExecution: vi.fn(), requestNextStepApproval: vi.fn() }))
vi.mock('@/domain/crm/queries/scopeVersions', () => ({ getOfferApprovalTargets: vi.fn(async () => new Map()) }))
vi.mock('@/lib/queries/currentMember', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))
vi.mock('@/domain/crm/queries/tasks', () => ({ listAssignableMembers: vi.fn() }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))
vi.mock('@/domain/finance/queries/records', () => ({ listFinancialRecords: vi.fn(), listAccountOptions: vi.fn() }))
vi.mock('@/domain/finance/queries/uninvoiced', () => ({ listUninvoicedMilestones: vi.fn() }))
vi.mock('@/domain/finance/queries/overdue', () => ({ listOverdueInvoices: vi.fn() }))
vi.mock('@/domain/finance/queries/idoklad', () => ({ listOpenDiscrepancies: vi.fn(), getIdokladStatus: vi.fn() }))
vi.mock('@/domain/finance/actions/idoklad', () => ({ applyDiscrepancy: vi.fn(), dismissDiscrepancy: vi.fn(), cancelRecordOfDiscrepancy: vi.fn() }))

const ME = '00000000-0000-4000-8000-00000000000a'
const OTHER = '00000000-0000-4000-8000-00000000000b'
const PM = '00000000-0000-4000-8000-00000000000c'

async function renderInbox(sp: { druh?: string } = {}) {
  const { default: Page } = await import('@/app/cockpit/rozhodnuti/page')
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getLoopNodes).mockResolvedValue([])
  vi.mocked(getDecisionHistory).mockResolvedValue([])
  vi.mocked(getCurrentMember).mockResolvedValue({
    user: { id: ME } as never,
    member: { full_name: 'Viktor', is_admin: true, role: 'vedeni' },
  })
  vi.mocked(listAssignableMembers).mockResolvedValue([
    { id: ME, full_name: 'Viktor' },
    { id: OTHER, full_name: 'Lenka' },
  ] as never)
  // Finance: výchozí stav bez faktur po splatnosti (0090) a s vypnutým iDokladem (0092).
  vi.mocked(listOverdueInvoices).mockResolvedValue({ state: 'ok', rows: [] })
  vi.mocked(getIdokladStatus).mockResolvedValue({ enabled: false, missing: [], days: 90, lastSuccessAt: null, lastError: null, consecutiveErrors: 0 })
  vi.mocked(listOpenDiscrepancies).mockResolvedValue({ state: 'ok', rows: [], total: 0 })
})

describe('Ke schválení', () => {
  test('karta s důkazem a čtyřmi akcemi, bez L-úrovní a pojmů z hovoru', async () => {
    vi.mocked(getDecisionInbox).mockResolvedValue({
      state: 'ok',
      approvals: [
        {
          id: 7, action_kind: 'external_commitment', requested_level: 'L2', requested_by: `user:${OTHER}`,
          created_at: '2026-09-27T10:00:00Z', expires_at: null, case_title: 'Pilot pro HANZU', case_id: 5,
          case_node: 'obchod', ageDays: 2, expired: false,
          // Řádek po migraci 0084 (sloupce akce a odložení existují, žádost je „jen záznam").
          action_type: null, target_table: null, target_id: null, params: null, snoozed_until: null, snoozed_by: null,
        },
      ],
      decisions: [
        { id: 3, question: 'Jaký rozsah pilotu?', options: ['Malý', 'Velký'], created_at: '2026-09-28T10:00:00Z', case_title: 'KAPPA', evidence_link: 'https://example.com/x', case_id: 9, ageDays: 1 },
      ],
    })
    const html = await renderInbox()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Ke schválení')
    expect(html).toContain('2 návrhy čekají')
    for (const a of ['Schválit —', 'Upravit v případu —', 'Odložit —', 'Zamítnout —']) expect(html).toContain(a)
    expect(html).toContain('href="/cockpit/pripady/5"')
    expect(html).toContain('Otevřít důkaz')
    expect(html).toContain('2 z 4')
    expect(html).not.toMatch(/\bL[1-4]\b/)
    expect(html).not.toContain('Loop Core')
    expect(html).toContain('Lenka')
    // Obecná žádost poctivě říká, že se po ní nic neprovede.
    expect(html).toContain('Po schválení se nic samo neprovede')
  })

  test('žadatel sám nevidí tlačítka, vypršelé nejdou rozhodnout', async () => {
    vi.mocked(getDecisionInbox).mockResolvedValue({
      state: 'ok',
      approvals: [
        { id: 1, action_kind: 'external_commitment', requested_level: 'L2', requested_by: `user:${ME}`, created_at: '2026-09-27T10:00:00Z', expires_at: null, case_title: 'A', case_id: 1, case_node: null, ageDays: 1, expired: false },
        { id: 2, action_kind: 'external_commitment', requested_level: 'L2', requested_by: `user:${OTHER}`, created_at: '2026-09-20T10:00:00Z', expires_at: '2026-09-21T10:00:00Z', case_title: 'B', case_id: 2, case_node: null, ageDays: 9, expired: true },
      ],
      decisions: [],
    })
    const html = await renderInbox()
    expect(html).not.toContain('Schválit —')
    expect(html).toContain('Rozhodnout může jen někdo jiný než žadatel')
    expect(html).toContain('Žádost vypršela')
  })

  test('klidný prázdný stav a historie', async () => {
    vi.mocked(getDecisionInbox).mockResolvedValue({ state: 'ok', approvals: [], decisions: [] })
    vi.mocked(getDecisionHistory).mockResolvedValue([
      { id: 4, action_kind: 'external_commitment', status: 'approved', decided_by: `user:${OTHER}`, decided_at: '2026-09-25T12:00:00Z', case_id: 1, case_title: 'Pilot' },
    ])
    const html = await renderInbox()
    expect(html).toContain('Nic nečeká na tebe')
    expect(html).toContain('Historie rozhodnutí')
    expect(html).toContain('Schváleno')
    expect(html).toContain('Lenka')
  })

  test('filtr druhu a chybové stavy', async () => {
    vi.mocked(getDecisionInbox).mockResolvedValue({
      state: 'ok', approvals: [],
      decisions: [{ id: 3, question: 'Q?', options: [], created_at: '2026-09-28T10:00:00Z', case_title: null, evidence_link: null, case_id: null, ageDays: 0 }],
    })
    const filtered = await renderInbox({ druh: 'schvaleni' })
    expect(filtered).toContain('Tady nic nečeká')
    expect(filtered).not.toContain('Q?</h2>')
    vi.mocked(getDecisionInbox).mockResolvedValue({ state: 'missing_migration' })
    const pending = await renderInbox()
    expect(pending).toContain('Tahle část se připravuje.')
    expect(pending).not.toContain('0039')
  })
})

describe('Ke schválení: schválení s provedením (0084)', () => {
  const base = {
    requested_level: 'L2', requested_by: `user:${OTHER}`, created_at: '2026-09-27T10:00:00Z', ageDays: 2, expired: false,
    snoozed_until: null, snoozed_by: null,
  }
  const nextStep = {
    ...base, id: 11, action_kind: 'confirm_next_step', action_type: 'confirm_next_step', target_table: 'work_case', target_id: 5,
    params: { title: 'Technická analýza', assignee_id: OTHER, due_on: '2026-10-03', decision_id: null },
    expires_at: '2026-10-06T22:00:00Z', case_title: 'Workshop ALFATECH', case_id: 5, case_node: 'vedeni',
  }
  const offer = {
    ...base, id: 12, action_kind: 'send_offer', action_type: 'send_offer', target_table: 'deal_scope_version', target_id: 40,
    params: { deal_id: 9, version_id: 40, version: 2 }, expires_at: '2026-10-04T22:00:00Z', case_title: null, case_id: null,
    case_node: 'obchod',
  }

  test('karta říká, co se po schválení stane: krok a úkol s termínem a řešitelem', async () => {
    vi.mocked(getDecisionInbox).mockResolvedValue({ state: 'ok', approvals: [{ ...nextStep }], decisions: [] })
    const html = await renderInbox()
    expect(html).toContain('<h2 class="m-0 mt-1 font-heading text-title2 font-bold">Potvrdit další krok</h2>')
    expect(html).toContain('Po schválení se v případu založí krok „Technická analýza“ a úkol s termínem 3. 10. 2026 · řeší Lenka.')
    expect(html).toContain('vlastník případu úkol rozhodnout, jak dál')
    expect(html).toContain('Odložit —')
  })

  test('nabídka: nic se neodesílá; obchodní role vidí částku, žadatel tlačítka ne', async () => {
    vi.mocked(getDecisionInbox).mockResolvedValue({ state: 'ok', approvals: [{ ...offer }], decisions: [] })
    vi.mocked(getOfferApprovalTargets).mockResolvedValueOnce(new Map([[40, {
      version_id: 40, version: 2, amount_one_time: 150000, expected_mrr: 0, currency: 'CZK', deal_id: 9, deal_title: 'Pilot ALFATECH', account_id: 3,
    }]]))
    const html = await renderInbox()
    expect(html).toContain('Odeslat nabídku klientovi')
    expect(html).toContain('Po schválení Cockpit nic neodešle: verze 2 nabídky se označí jako schválená k odeslání a vlastník obchodu dostane úkol „Odeslat nabídku klientovi“ do 1 pracovního dne. Odesílá člověk.')
    expect(html).toMatch(/150\s000\sKč/)
    expect(html).toContain('href="/cockpit/clients/3/deals/9?tab=nabidky"')
    expect(html).toContain('Schválit —')

    // Projekťák nabídku nevidí: bez částky a bez tlačítek.
    vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: ME } as never, member: { full_name: 'Pavla', is_admin: false, role: 'projektak' } })
    vi.mocked(getLoopNodes).mockResolvedValue([{ node: 'obchod', owner_id: ME, deputy_id: null }])
    const other = await renderInbox()
    expect(other).toContain('Částky vidí jen obchodní role')
    expect(other).not.toContain('Schválit —')
    expect(other).toContain('s přístupem k obchodu')
  })

  test('odložená žádost: jeden řádek pro všechny, s tím, kdo odložil; vrátit jen schvalovatel', async () => {
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString()
    vi.mocked(getDecisionInbox).mockResolvedValue({
      state: 'ok', approvals: [{ ...nextStep, snoozed_until: until, snoozed_by: `user:${ME}` }], decisions: [],
    })
    const html = await renderInbox()
    expect(html).toContain('Odloženo do')
    expect(html).toContain('odložil(a) Viktor')
    expect(html).toContain('Vrátit mezi čekající — Potvrdit další krok — Workshop ALFATECH')
    expect(html).not.toContain('Schválit —')
    expect(html).toContain('(odložené: 1)')

    vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: PM } as never, member: { full_name: 'Pavla', is_admin: false, role: 'projektak' } })
    const other = await renderInbox()
    expect(other).toContain('Odloženo do')
    expect(other).not.toContain('Vrátit mezi čekající')
  })

  test('historie ukazuje výsledek provedení a u selhání „Zkusit znovu"', async () => {
    vi.mocked(getDecisionInbox).mockResolvedValue({ state: 'ok', approvals: [], decisions: [] })
    vi.mocked(getDecisionHistory).mockResolvedValue([
      {
        id: 21, action_kind: 'confirm_next_step', action_type: 'confirm_next_step', status: 'approved', decided_by: `user:${OTHER}`,
        decided_at: '2026-09-28T12:00:00Z', case_id: 5, case_title: 'Workshop ALFATECH',
        params: { title: 'Technická analýza', assignee_id: ME, due_on: '2026-10-03', decision_id: null },
        execution: { request_id: 21, status: 'completed', request_status: 'approved', result: { step_id: 1, task_id: 2, assignee_id: ME, due_on: '2026-10-03' }, attempts: 1, executed_by: `user:${OTHER}`, executed_at: '2026-09-28T12:00:00Z' },
      },
      {
        id: 22, action_kind: 'send_offer', action_type: 'send_offer', status: 'approved', decided_by: `user:${OTHER}`,
        decided_at: '2026-09-28T13:00:00Z', case_id: null, case_title: null, params: { deal_id: 9, version_id: 40, version: 2 },
        execution: { request_id: 22, status: 'failed', request_status: 'approved', result: { sqlstate: '23514' }, attempts: 1, executed_by: `user:${OTHER}`, executed_at: '2026-09-28T13:00:00Z' },
      },
      {
        id: 23, action_kind: 'confirm_next_step', action_type: 'confirm_next_step', status: 'expired', decided_by: null,
        decided_at: '2026-09-29T06:00:00Z', case_id: 5, case_title: 'Workshop ALFATECH',
        params: { title: 'Pilot', assignee_id: ME, due_on: '2026-10-03', decision_id: null },
        execution: { request_id: 23, status: 'completed', request_status: 'expired', result: { reason: 'returned_to_owner', task_id: 3, assignee_id: OTHER }, attempts: 1, executed_by: 'system:approval-expiry', executed_at: '2026-09-29T06:00:00Z' },
      },
    ])
    const html = await renderInbox()
    expect(html).toContain('Provedeno')
    expect(html).toContain('Založen krok „Technická analýza“ a úkol · řeší Viktor · do 3. 10. 2026.')
    expect(html).toContain('Provedení selhalo')
    expect(html).toContain('Zkusit provést znovu — Odeslat nabídku klientovi')
    expect(html).toContain('Vráceno vlastníkovi')
    expect(html).toContain('Úkol rozhodnout, jak dál · řeší Lenka.')
    expect(html).toContain('Vypršelo')
  })
})

describe('Finance: karty', () => {
  const rec = (p: Partial<FinancialRecordRow>): FinancialRecordRow => ({
    id: 1, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'potential', amount: 100,
    currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'rucne', evidence_id: null,
    external_ref: null, note: null, created_at: '2026-09-01T00:00:00Z', ...p,
  })

  test('velká čísla po druzích, každý druh zvlášť', () => {
    expect(splitMoney(2_670_300, 'CZK')).toEqual({ value: '2,67', unit: 'mil. Kč' })
    expect(splitMoney(360_000, 'CZK')).toEqual({ value: '360', unit: 'tis. Kč' })
    expect(splitMoney(950, 'EUR')).toEqual({ value: '950', unit: '€' })
    const board = buildFinanceBoard([
      rec({ kind: 'potential', amount: 2_000_000 }),
      rec({ kind: 'contracted', amount: 360_000, period_month: '2026-08-01' }),
    ])
    const html = renderToStaticMarkup(<KindCards board={board} showDrafts currentMonth="2026-09" />)
    for (const k of ['Potenciál', 'Nasmlouváno', 'Vyfakturováno', 'Přijato']) expect(html).toContain(k)
    expect(html).toContain('>2<')
    expect(html).toContain('mil. Kč')
    expect(html).toContain('360')
    // žádný souhrnný součet 2 360 000 přes druhy
    expect(html).not.toContain('2,36')
  })

  test('prázdné období je klidné a graf má popisek', () => {
    const board = buildFinanceBoard([rec({ kind: 'invoiced', amount: 60_000 })])
    const html = renderToStaticMarkup(<KindCards board={board} showDrafts currentMonth="2026-09" />)
    expect(html).toContain('V tomto období nic.')
    expect(html).toContain('role="img"')
    expect(html).toContain('Vyfakturováno po měsících')
  })

  test('výzva k milníkům: počet a odkaz do dodávky, jinak klidný stav', () => {
    const m = { id: 1, title: 'Procesní mapa', engagement_id: 4, account_id: 2, account_name: 'ALFATECH', accepted_at: null }
    const html = renderToStaticMarkup(<MilestonePrompt milestones={[m]} />)
    expect(html).toContain('Přijaté milníky bez fakturačního podkladu')
    expect(html).toContain('href="/cockpit/clients/2/engagements/4/edit"')
    expect(html).toContain('Vytvořit fakturační podklad')
    expect(renderToStaticMarkup(<MilestonePrompt milestones={[]} />)).toContain('Všechny přijaté milníky mají podklad')
  })
})

describe('Kapacity: grafy', () => {
  const weeks = weeksFrom('2026-09-28', 3)
  const plan = capacityPlan(
    [{ id: 'a' }, { id: 'b', weekly_capacity_hours: 20 }],
    [
      { id: 1, member_id: 'a', hours_per_week: 20, starts_on: '2026-09-01', ends_on: null, substitute_id: null },
      { id: 2, member_id: 'b', hours_per_week: 30, starts_on: '2026-09-01', ends_on: null, substitute_id: null },
    ],
    weeks,
  )
  const people = plan.map((p, i) => ({ id: p.member.id, name: ['Alena', 'Bořek'][i], capacity: p.capacity, weeks: p.weeks }))

  test('půlkruh: procenta, popisek a hodiny textem', () => {
    const html = renderToStaticMarkup(<CapacityGauge people={people} weeksCount={3} />)
    // 20*3 + 30*3 = 150 h z (40+20)*3 = 180 h → 83 %
    expect(html).toContain('83 %')
    expect(html).toContain('role="img"')
    expect(html).toContain('Alena 60 h')
    expect(html).toContain('Bořek 90 h')
    expect(html).toContain('volno 30 h')
  })

  test('matice: přetížení je v popisku textem, ne jen barvou', () => {
    const html = renderToStaticMarkup(<CapacityDotMatrix people={people} weeks={weeks} currentWeekKey={weeks[0].key} />)
    expect(html).toContain('Bořek, T40: 30 z 20 h, přetížení')
    expect(html).toContain('Alena, T40: 20 z 40 h')
    expect(html).toContain('1 tečka = půl dne')
  })
})

describe('stránka /finance', () => {
  async function renderFinance(sp: Record<string, string> = {}) {
    const { default: Page } = await import('@/app/cockpit/finance/page')
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(sp) }))
  }

  test('čtyři karty, tabulka, výzva, filtr druhu a formulář', async () => {
    // iDoklad vypnutý (výchozí): jedna klidná věta, žádná karta rozdílů.
    vi.mocked(getIdokladStatus).mockResolvedValue({ enabled: false, missing: [], days: 90, lastSuccessAt: null, lastError: null, consecutiveErrors: 0 })
    vi.mocked(listOpenDiscrepancies).mockResolvedValue({ state: 'ok', rows: [], total: 0 })
    vi.mocked(listAccountOptions).mockResolvedValue([{ id: 1, name: 'ALFATECH' }])
    vi.mocked(listUninvoicedMilestones).mockResolvedValue({
      state: 'ok',
      milestones: [{ id: 1, title: 'Mapa', engagement_id: 4, account_id: 1, account_name: 'ALFATECH', accepted_at: null }],
    })
    vi.mocked(listOverdueInvoices).mockResolvedValue({ state: 'ok', rows: [] })
    vi.mocked(listFinancialRecords).mockResolvedValue({
      state: 'ok',
      records: [
        { id: 1, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'contracted', amount: 360000, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'rucne', evidence_id: null, external_ref: null, note: null, created_at: '2026-09-01T00:00:00Z', account_name: 'ALFATECH' },
        { id: 2, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'potential', amount: 1000, currency: 'CZK', period_month: '2026-10-01', status: 'draft', source: 'rucne', evidence_id: null, external_ref: null, note: null, created_at: '2026-09-01T00:00:00Z', account_name: 'ALFATECH' },
      ],
    })
    const html = await renderFinance()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Přidat záznam')
    expect(html).toContain('Přijaté milníky bez fakturačního podkladu')
    // bez faktur po splatnosti je celá stránka klidná: žádná karta se sytou barvou
    expect(html).toContain('Nic není po splatnosti')
    expect(html).not.toContain('tile-solid')
    expect(html).toContain('Kolik je potvrzeno')
    expect(html).toContain('Potvrzeno')
    const onlyContracted = await renderFinance({ druh: 'contracted' })
    expect(onlyContracted).toContain('aria-current="page"')
    vi.mocked(listFinancialRecords).mockResolvedValue({ state: 'missing_migration' })
    expect(await renderFinance()).toContain('Tahle část se připravuje.')
  })

  test('faktura po splatnosti: jediná sytá karta, odkaz na filtr; filtr ukáže jen ty faktury napříč obdobími', async () => {
    const inv = {
      id: 9, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'invoiced' as const, amount: 80000,
      currency: 'CZK' as const, period_month: '2026-03-01', status: 'confirmed' as const, source: 'rucne' as const, evidence_id: null,
      external_ref: 'FA-77', note: null, created_at: '2026-03-01T00:00:00Z', due_on: '2026-04-15', account_name: 'ALFATECH', daysLate: 168,
    }
    vi.mocked(listAccountOptions).mockResolvedValue([{ id: 1, name: 'ALFATECH' }])
    vi.mocked(listUninvoicedMilestones).mockResolvedValue({
      state: 'ok',
      milestones: [{ id: 1, title: 'Mapa', engagement_id: 4, account_id: 1, account_name: 'ALFATECH', accepted_at: null }],
    })
    vi.mocked(listFinancialRecords).mockResolvedValue({ state: 'ok', records: [{ ...inv, id: 1, kind: 'contracted', due_on: null, period_month: '2026-09-01', external_ref: null }] })
    vi.mocked(listOverdueInvoices).mockResolvedValue({ state: 'ok', rows: [inv] })
    const html = await renderFinance()
    expect((html.match(/tile-solid/g) ?? []).length).toBe(1)
    expect(html).toContain('Po splatnosti a nezaplaceno')
    expect(html).toContain('splatnost=po')
    expect(html).toContain('druh=invoiced')
    // filtrovaný pohled: tabulka z faktur po splatnosti (i mimo období filtru), ne z období
    const filtered = await renderFinance({ druh: 'invoiced', splatnost: 'po' })
    expect(filtered).toContain('FA-77')
    expect(filtered).toContain('Jen faktury po splatnosti')
    expect(filtered).toContain('po splatnosti o 168 d')
    // filtry firmy a měny se přenesou do dotazu na faktury
    await renderFinance({ firma: '1', mena: 'CZK' })
    expect(vi.mocked(listOverdueInvoices)).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 1, currency: 'CZK' }))
  })

  test('iDoklad: vypnuto = věta o vypnutí a žádná karta; zapnuto s rozdíly = karta Rozdíly k vyřešení nad filtrem', async () => {
    vi.mocked(listAccountOptions).mockResolvedValue([{ id: 1, name: 'ALFATECH' }])
    vi.mocked(listUninvoicedMilestones).mockResolvedValue({ state: 'ok', milestones: [] })
    vi.mocked(listFinancialRecords).mockResolvedValue({ state: 'ok', records: [] })
    vi.mocked(getIdokladStatus).mockResolvedValue({ enabled: false, missing: [], days: 90, lastSuccessAt: null, lastError: null, consecutiveErrors: 0 })
    vi.mocked(listOpenDiscrepancies).mockResolvedValue({ state: 'ok', rows: [], total: 0 })
    const off = await renderFinance()
    expect(off).toContain('Čtení z iDokladu je vypnuté')
    expect(off).not.toContain('Rozdíly k vyřešení')

    vi.mocked(getIdokladStatus).mockResolvedValue({ enabled: true, missing: [], days: 90, lastSuccessAt: '2026-09-30T04:00:00Z', lastError: null, consecutiveErrors: 0 })
    vi.mocked(listOpenDiscrepancies).mockResolvedValue({
      state: 'ok',
      rows: [{ id: 1, kind: 'amount_mismatch', reason: 'Jiná částka.', idoklad_kind: 'invoice', idoklad_id: 7, document_number: 'FV1', account_id: 1, account_name: 'ALFATECH', record_id: 2, currency: 'CZK', idoklad_amount: 10, record_amount: 9, first_seen_at: '2026-09-29T04:00:00Z', last_seen_at: '2026-09-30T04:00:00Z' }],
      total: 1,
    })
    const on = await renderFinance()
    expect(on).toContain('Rozdíly k vyřešení')
    expect(on.indexOf('Rozdíly k vyřešení')).toBeLessThan(on.indexOf('Filtr finančních záznamů'))
    expect(on).toContain('Převzít z iDokladu')

    vi.mocked(listOpenDiscrepancies).mockResolvedValue({ state: 'missing_migration' })
    expect(await renderFinance()).toContain('Porovnání s iDokladem se připravuje.')
    vi.mocked(listOpenDiscrepancies).mockResolvedValue({ state: 'error' })
    expect(await renderFinance()).toContain('Rozdíly z iDokladu se nepodařilo načíst')
  })
})
