// Sdílený přípravek provozního přehledu (test/ops-report*.test.ts,
// digest-delivery*.test.ts, stránka Týden): tři dodávky, milníky, čekání na
// klienta, změny za týden, Ke schválení, kapacity a týdenní přehled.
// Záměrně obsahuje i citlivé údaje (rozsah nabídky, měření dopadu, kontakt
// klienta), aby testy mohly ověřit, že se do přehledu ani e-mailu nedostanou.
import { shapeApprovals, shapeDecisions } from '@/core/loopQueries'
import {
  buildChangeSections, deliveryChanges, intakeChanges, milestoneChanges, stageChanges, weekWindow,
  type AuditRow, type ChangeItem, type DealInfo,
} from '@/domain/crm/changes'
import { buildDigest, type DigestInput } from '@/domain/crm/digest'
import { buildOpsReport, type OpsReport, type OpsReportInput } from '@/domain/crm/opsReport'
import { buildPortfolio, type PortfolioEngagement, type PortfolioMilestone } from '@/domain/delivery/portfolio'
import { buildWaitingItems } from '@/domain/delivery/waiting'

export const TODAY = '2026-10-05' // pondělí, ISO týden 41
export const NOW = new Date('2026-10-05T05:00:00Z')
export const ME = 'u-viktor'
export const LENKA = 'u-lenka'
export const WIN = weekWindow(TODAY, 'minuly')

const eng = (o: Partial<PortfolioEngagement>): PortfolioEngagement => ({
  id: 1, account_id: 10, account_name: 'ALFATECH', deal_id: null, kind: 'it', phase: 'pilot', started_on: '2026-09-01',
  due_on: '2026-11-30', owner_id: ME, deputy_id: LENKA, updated_at: '2026-10-02T09:00:00Z', reference_worthy: false,
  handoff_completed_at: '2026-09-05T08:00:00Z', ...o,
})
const ms = (o: Partial<PortfolioMilestone>): PortfolioMilestone => ({
  id: 1, engagement_id: 1, title: 'M', owner_id: ME, deputy_id: null, status: 'v_praci', due_on: null, accepted_at: null,
  updated_at: '2026-10-02T09:00:00Z', ...o,
})

const ENGAGEMENTS = [
  eng({ id: 1, deal_id: 9 }),
  eng({ id: 2, account_id: 20, account_name: 'ACME', kind: 'edu', due_on: '2026-10-01', owner_id: null, handoff_completed_at: null, updated_at: '2026-09-10T09:00:00Z' }),
  eng({ id: 3, account_id: 30, account_name: 'Servis Climax', due_on: null, handoff_completed_at: null, updated_at: '2026-10-04T09:00:00Z' }),
]
const MILESTONES = [
  ms({ id: 11, engagement_id: 1, title: 'Workshop', status: 'prijato', due_on: '2026-09-11', accepted_at: '2026-09-10T08:00:00Z', updated_at: '2026-09-10T08:00:00Z' }),
  ms({ id: 12, engagement_id: 1, title: 'Procesní mapa', status: 'v_praci', due_on: '2026-10-07' }),
  ms({ id: 13, engagement_id: 1, title: 'Pilot', status: 'pripraveno', due_on: '2026-10-20' }),
  ms({ id: 21, engagement_id: 2, title: 'Školení', owner_id: LENKA, status: 'ceka_na_schvaleni', due_on: '2026-09-30', updated_at: '2026-09-15T08:00:00Z' }),
]

export const portfolioItems = () => buildPortfolio({
  today: TODAY,
  engagements: ENGAGEMENTS,
  milestones: MILESTONES,
  tasks: [{ engagement_id: 1, status: 'blocked', updated_at: '2026-10-02T09:00:00Z' }],
  offers: new Map([[9, { version: 2, scope: 'Tajný rozsah nabídky', decided_at: '2026-09-01T08:00:00Z' }]]),
  dealTitles: new Map([[9, 'Pilot objednávek']]),
  measures: [{ id: 1, engagement_id: 1, metric: 'Doba zpracování', unit: 'min', baseline: 18, actual: 4, observed_on: '2026-09-28' }],
  cards: [],
  loads: null,
  names: new Map([[ME, 'Viktor Kovář'], [LENKA, 'Lenka Horáková']]),
})

export const waitingItems = () => buildWaitingItems({
  milestones: [{
    id: 21, engagement_id: 2, title: 'Školení', owner_id: LENKA, status: 'ceka_na_schvaleni', due_on: '2026-09-30',
    updated_at: '2026-09-15T08:00:00Z', created_at: '2026-09-01T08:00:00Z',
    engagement: { id: 2, account_id: 20, kind: 'edu', phase: 'pilot', account_name: 'ACME' },
  }],
  moves: new Map(),
  openReminders: new Map(),
  contacts: new Map([[2, { name: 'Jana Klientová', email: 'jana@acme.cz' }]]),
  today: TODAY,
})

const audit = (id: number, action: string, entity: number, at: string, before: unknown, after: unknown): AuditRow =>
  ({ id, action, entity_id: entity, occurred_at: at, before, after })

export function changeItems(): ChangeItem[] {
  const deals = new Map<number, DealInfo>([
    [5, { id: 5, title: 'AI agent', account_id: 10, account_name: 'ALFATECH' }],
    [6, { id: 6, title: 'Licence', account_id: 20, account_name: 'ACME' }],
    [7, { id: 7, title: 'Školení AI', account_id: 40, account_name: 'Beta' }],
  ])
  return [
    ...stageChanges([
      audit(100, 'deal.created', 5, '2026-09-29T08:00:00Z', null, { stage: 'kvalifikace' }),
      audit(101, 'deal.stage_changed', 6, '2026-09-30T08:00:00Z', { stage: 'rozhodovani' }, { stage: 'vyhráno' }),
      audit(102, 'deal.stage_changed', 7, '2026-10-01T08:00:00Z', { stage: 'rozsah_nabidka' }, { stage: 'prohráno' }),
    ], deals),
    ...intakeChanges([{ id: 3, account_id: 43, created_at: '2026-10-01T07:31:00Z', occurred_at: '2026-10-01T07:30:00Z', account_name: 'Acme Stroje', next_step_due: '2026-10-02' }]),
    ...milestoneChanges({
      events: [audit(200, 'engagement_milestone.updated', 12, '2026-10-02T09:00:00Z', { status: 'pripraveno' }, { status: 'v_praci', _columns: ['status'] })],
      milestones: [{ id: 12, title: 'Procesní mapa', status: 'v_praci', updated_at: '2026-10-02T09:00:00Z', engagement_id: 1, account_id: 10, account_name: 'ALFATECH' }],
    }, WIN),
    ...deliveryChanges([{ id: 3, kind: 'it', created_at: '2026-10-02T05:40:00Z', account_id: 30, account_name: 'Servis Climax' }]),
  ]
}

export const digestInput = (): DigestInput => ({
  followUps: [{ deal_id: 11, account_id: 3, title: 'Agentizace', account_name: 'Škoda', due: '2026-10-01', days_overdue: 4, level: 'manager' }],
  outreach: [
    { account_id: 7, name: 'Tichá s.r.o.', last_direction: 'us', last_at: '2026-08-01', days_silent: 65 },
    { account_id: 8, name: 'Další', last_direction: 'us', last_at: '2026-09-01', days_silent: 34 },
  ],
  blockedDeals: [{ id: 21, account_id: 5, title: 'Rollout', account_name: 'Continental', status_blocker: 'čeká na podpis smlouvy' }],
  connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null },
  lastMeetingNoteAt: null,
  outlookMailSyncEnabled: false,
  generatedAt: NOW,
})

export function opsInput(o: Partial<OpsReportInput> = {}): OpsReportInput {
  const di = digestInput()
  return {
    today: TODAY,
    generatedAt: NOW,
    window: WIN,
    week: 'minuly',
    canSeeSales: true,
    changes: { sections: buildChangeSections(changeItems(), { canSeeSales: true, perSection: 100 }), unavailable: [] },
    portfolio: { state: 'ok', items: portfolioItems(), unavailable: [] },
    waiting: { state: 'ok', items: waitingItems() },
    capacity: {
      state: 'ok',
      members: [{ id: ME, full_name: 'Viktor Kovář', weekly_capacity_hours: 40 }, { id: LENKA, full_name: 'Lenka Horáková', weekly_capacity_hours: 40 }],
      allocations: [
        { id: 1, member_id: ME, hours_per_week: 46, starts_on: '2026-09-01', ends_on: null, substitute_id: LENKA },
        { id: 2, member_id: LENKA, hours_per_week: 20, starts_on: '2026-09-01', ends_on: null, substitute_id: ME },
      ],
    },
    inbox: {
      state: 'ok',
      approvals: shapeApprovals([
        { id: 7, action_kind: 'external_commitment', requested_level: 'L2', requested_by: 'user:x', created_at: '2026-10-01T08:00:00Z', expires_at: null, case_title: 'Závazek pro ALFATECH', case_id: 4 },
        { id: 8, action_kind: 'external_commitment', requested_level: 'L2', requested_by: 'user:x', created_at: '2026-09-20T08:00:00Z', expires_at: '2026-09-25T00:00:00Z', case_title: 'Vypršelá', case_id: 5 },
      ], NOW),
      decisions: shapeDecisions([
        { id: 2, question: 'Pokračovat analýzou?', options: ['ano', 'ne'], created_at: '2026-10-04T08:00:00Z', case_title: null, evidence_link: null, case_id: null },
      ], NOW),
    },
    pendingProposals: 2,
    unmatchedNotes: 1,
    digest: { digest: buildDigest(di), source: di },
    ...o,
  }
}

/** Hotový přehled z přípravku (pondělí 5. 10. 2026, obchodní role). */
export const opsReport = (o: Partial<OpsReportInput> = {}): OpsReport => buildOpsReport(opsInput(o))
