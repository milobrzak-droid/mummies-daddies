// Čtení pro „Co se změnilo": pošta klientů, posuny fází, rozhodnutí, nové
// úkoly a případy, milníky dodávek a faktury/platby v daném okně.
// Skládá čisté funkce z domain/crm/changes.ts nad skutečnými daty.
//
// ZDROJE
//   mail_event (0041)      — přijaté e-maily spárované na klienta (jen metadata;
//                            čtení přes service role, viz loadEmails a 0069)
//   audit_event (0028/0034/0064) — posun fáze obchodu, změny milníků,
//                            posunuté a zrušené schůzky (sales_activity.updated,
//                            typicky kontrola kalendáře; jen obchodní role)
//   approval_request, decision (0039) — schválená/zamítnutá rozhodnutí
//   task, work_case        — nové úkoly a případy (podle created_at)
//   engagement (0080)      — dodávky, které Cockpit sám založil po vyhrání obchodu
//   audit_event team_member (0088) — předání práce člověka, deaktivace s otevřenou prací
//   engagement_milestone   — jména milníků a dodávek; záloha pro změny bez auditu
//   engagement_document_finding (0094) — nálezy denní kontroly dokumentů dodávek
//                            (změnil se od schválení, zmizel, bez přístupu)
//   financial_record (0063) — nové faktury a platby
//   auto_intake (0081)     — poptávky založené automaticky z e-mailu (jen aktivní)
//
// OPRÁVNĚNÍ: e-maily klientů, fáze obchodů a peníze se čtou jen s canSeeSales
// (RLS je navíc drží dole: deal/financial_record/audit deal jen obchodní role).
//
// ODOLNOST: každý druh změn se načítá zvlášť. Chybějící tabulka (migrace
// ještě není) je tichý „nic"; jiná chyba se zaloguje a druh se ohlásí v
// `unavailable`, aby karta neříkala „nic se nezměnilo", když to nevíme.
//
// KLIENT: výchozí je session přihlášeného (RLS). Provozní přehled pro cron
// (domain/crm/queries/opsReport.ts) předá klienta se service role a jen
// druhy, které potřebuje (`kinds`) — ostatní se vůbec nedotazují.
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import { AUTO_DELIVERY_ORIGIN } from '@/domain/delivery/autoDelivery'
import {
  buildChangeSections,
  decisionChanges,
  deliveryChanges,
  documentChanges,
  emailChanges,
  handoverChanges,
  intakeChanges,
  isMeetingShiftEvent,
  meetingChanges,
  HANDOVER_ACTIONS,
  milestoneChanges,
  moneyChanges,
  stageChanges,
  workChanges,
  type ActorAuditRow,
  type ApprovalRow,
  type AuditRow,
  type CaseRow,
  type ChangeItem,
  type ChangeKind,
  type ChangeSection,
  type ChangeWindow,
  type DealInfo,
  type DecisionRow,
  type DeliveryRow,
  type DocumentFindingRow,
  type HandoverEvent,
  type IntakeRow,
  type MailRow,
  type MeetingInfo,
  type MilestoneInfo,
  type MoneyRow,
  type TaskRow,
  type ViewRow,
} from '@/domain/crm/changes'

type Db = Awaited<ReturnType<typeof createClient>>
type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

// --- Čas poslední návštěvy (0075) -------------------------------------------

export type ChangesViewState =
  | { state: 'ok'; row: ViewRow | null }
  | { state: 'missing_migration' }
  | { state: 'error' }

/** Řádek vlastního času návštěvy; RLS vrací jen řádek přihlášeného. */
export async function getChangesView(userId: string): Promise<ChangesViewState> {
  const s = await createClient()
  const { data, error } = await s.from('changes_view').select('baseline_at, last_open_at').eq('member_id', userId).maybeSingle()
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) {
    logError('changes.view', error)
    return { state: 'error' }
  }
  return { state: 'ok', row: (data as ViewRow | null) ?? null }
}

// --- Jednotlivé zdroje ------------------------------------------------------

const LIMIT = 500

async function loadIntakes(s: Db, win: ChangeWindow): Promise<ChangeItem[]> {
  const { data, error } = await s
    .from('auto_intake')
    .select('id, account_id, created_at, occurred_at, account:account!auto_intake_account_id_fkey(name), deal:deal!auto_intake_deal_id_fkey(next_step_due)')
    .eq('status', 'active')
    .not('account_id', 'is', null)
    .gte('created_at', win.since.toISOString())
    .lt('created_at', win.until.toISOString())
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw error
  const rows = ((data ?? []) as unknown as {
    id: number; account_id: number | null; created_at: string; occurred_at: string
    account: Joined<{ name: string | null }>; deal: Joined<{ next_step_due: string | null }>
  }[])
    .filter((r): r is typeof r & { account_id: number } => r.account_id !== null)
    .map((r): IntakeRow => ({
      id: r.id, account_id: r.account_id, created_at: r.created_at, occurred_at: r.occurred_at,
      account_name: one(r.account)?.name ?? null, next_step_due: one(r.deal)?.next_step_due ?? null,
    }))
  return intakeChanges(rows)
}

// mail_event čte od 0069 jen service role (metadata Viktorovy schránky nečte nikdo
// s uživatelskou session). Karta je pro obchodní role a volá se jen po kontrole
// canSeeSales; z tabulky se berou jen čas a firma, nikdy adresa ani obsah.
async function loadEmails(_s: Db, win: ChangeWindow): Promise<ChangeItem[]> {
  const { data, error } = await createAdminClient()
    .from('mail_event')
    .select('id, occurred_at, account_id, account(name)')
    .eq('direction', 'inbound')
    .eq('match_status', 'matched')
    .gte('occurred_at', win.since.toISOString())
    .lt('occurred_at', win.until.toISOString())
    .order('occurred_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw error
  const rows = ((data ?? []) as unknown as { id: number; occurred_at: string; account_id: number | null; account: Joined<{ name: string | null }> }[])
    .filter((r): r is typeof r & { account_id: number } => r.account_id !== null)
    .map((r): MailRow => ({ id: r.id, occurred_at: r.occurred_at, account_id: r.account_id, account_name: one(r.account)?.name ?? null }))
  return emailChanges(rows)
}

async function loadStages(s: Db, win: ChangeWindow): Promise<ChangeItem[]> {
  const { data, error } = await s
    .from('audit_event')
    .select('id, action, entity_id, occurred_at, before, after')
    .eq('entity_table', 'deal')
    .in('action', ['deal.stage_changed', 'deal.created'])
    .gte('occurred_at', win.since.toISOString())
    .lt('occurred_at', win.until.toISOString())
    .order('occurred_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw error
  const events = (data ?? []) as unknown as AuditRow[]
  if (events.length === 0) return []
  const ids = [...new Set(events.map((e) => e.entity_id))]
  const { data: deals, error: dealsError } = await s.from('deal').select('id, title, account_id, account:account!deal_account_id_fkey(name)').in('id', ids)
  // Bez názvů se změny stejně ukážou (jako „Obchod č. N"); chyba se jen zaloguje.
  if (dealsError) logError('changes.deals', dealsError)
  const map = new Map<number, DealInfo>()
  for (const d of (dealsError ? [] : (deals ?? [])) as unknown as { id: number; title: string | null; account_id: number | null; account: Joined<{ name: string | null }> }[]) {
    map.set(d.id, { id: d.id, title: d.title, account_id: d.account_id, account_name: one(d.account)?.name ?? null })
  }
  return stageChanges(events, map)
}

/**
 * Posunuté a zrušené schůzky: řádkové změny sales_activity z auditu (0064
 * zapisuje occurred_at a outcome s hodnotami), jen posun začátku nebo
 * zrušení. Názvy a klienti schůzek se dočítají pod RLS (jen obchodní role).
 */
async function loadMeetings(s: Db, win: ChangeWindow): Promise<ChangeItem[]> {
  const { data, error } = await s
    .from('audit_event')
    .select('id, action, entity_id, occurred_at, before, after, actor_type, actor_id')
    .eq('entity_table', 'sales_activity')
    .eq('action', 'sales_activity.updated')
    .gte('occurred_at', win.since.toISOString())
    .lt('occurred_at', win.until.toISOString())
    .order('occurred_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw error
  const events = ((data ?? []) as unknown as ActorAuditRow[]).filter(isMeetingShiftEvent)
  if (events.length === 0) return []
  const ids = [...new Set(events.map((e) => e.entity_id))]
  const { data: rows, error: rowsError } = await s
    .from('sales_activity')
    .select('id, subject, occurred_at, outcome, account_id, account:account!sales_activity_account_id_fkey(name)')
    .eq('kind', 'meeting')
    .in('id', ids)
  if (rowsError) throw rowsError
  const meetings = new Map<number, MeetingInfo>()
  for (const r of (rows ?? []) as unknown as (Omit<MeetingInfo, 'account_name'> & { account: Joined<{ name: string | null }> })[]) {
    meetings.set(r.id, {
      id: r.id, subject: r.subject, occurred_at: r.occurred_at, outcome: r.outcome, account_id: r.account_id,
      account_name: one(r.account)?.name ?? null,
    })
  }
  return meetingChanges(events, meetings)
}

async function loadDecisions(s: Db, win: ChangeWindow, names: ReadonlyMap<string, string>): Promise<ChangeItem[]> {
  const since = win.since.toISOString()
  const until = win.until.toISOString()
  const [approvals, decisions] = await Promise.all([
    s.from('approval_request')
      .select('id, status, decided_at, decided_by, action_kind, case_id, work_case(title)')
      .in('status', ['approved', 'rejected'])
      .gte('decided_at', since).lt('decided_at', until)
      .order('decided_at', { ascending: false }).limit(LIMIT),
    s.from('decision')
      .select('id, question, chosen, decided_at, decided_by, case_id, work_case(title)')
      .not('decided_at', 'is', null)
      .gte('decided_at', since).lt('decided_at', until)
      .order('decided_at', { ascending: false }).limit(LIMIT),
  ])
  if (approvals.error) throw approvals.error
  if (decisions.error) throw decisions.error
  type WithCase = { work_case: Joined<{ title: string | null }> }
  const approvalRows = ((approvals.data ?? []) as unknown as (Omit<ApprovalRow, 'case_title'> & WithCase)[])
    .map(({ work_case, ...r }): ApprovalRow => ({ ...r, case_title: one(work_case)?.title ?? null }))
  const decisionRows = ((decisions.data ?? []) as unknown as (Omit<DecisionRow, 'case_title'> & WithCase)[])
    .map(({ work_case, ...r }): DecisionRow => ({ ...r, case_title: one(work_case)?.title ?? null }))
  return decisionChanges({ approvals: approvalRows, decisions: decisionRows }, names)
}

async function loadWork(s: Db, win: ChangeWindow, meId: string | null): Promise<ChangeItem[]> {
  const since = win.since.toISOString()
  const until = win.until.toISOString()
  let tasksQuery = s.from('task')
    .select('id, title, created_at, created_by, assignee_id, due_on, status, account:account!task_account_id_fkey(name)')
    .neq('status', 'done')
    .gte('created_at', since).lt('created_at', until)
    .order('created_at', { ascending: false }).limit(LIMIT)
  // Moje úkoly a ty bez řešitele; úkoly někoho jiného mě nezajímají.
  tasksQuery = meId ? tasksQuery.or(`assignee_id.eq.${meId},assignee_id.is.null`) : tasksQuery.is('assignee_id', null)
  const [tasks, cases] = await Promise.all([
    tasksQuery,
    s.from('work_case')
      .select('id, title, created_at, created_by, status, account(name)')
      .neq('status', 'cancelled')
      .gte('created_at', since).lt('created_at', until)
      .order('created_at', { ascending: false }).limit(LIMIT),
  ])
  if (tasks.error) throw tasks.error
  // Případy jsou od 0039; bez nich se ukážou aspoň úkoly.
  if (cases.error && !isMissingRelation(cases.error)) throw cases.error
  const taskRows = ((tasks.data ?? []) as unknown as (Omit<TaskRow, 'account_name'> & { account: Joined<{ name: string | null }> })[])
    .map(({ account, ...r }): TaskRow => ({ ...r, account_name: one(account)?.name ?? null }))
  const caseRows = ((cases.error ? [] : (cases.data ?? [])) as unknown as (Omit<CaseRow, 'account_name'> & { account: Joined<{ name: string | null }> })[])
    .map(({ account, ...r }): CaseRow => ({ ...r, account_name: one(account)?.name ?? null }))
  return workChanges({ tasks: taskRows, cases: caseRows }, meId)
}

const MILESTONE_ACTIONS = ['milestone.status', 'milestone.accepted', 'engagement_milestone.updated', 'engagement_milestone.created']
const MILESTONE_SELECT = 'id, title, status, updated_at, engagement_id, engagement(account_id, account(name))'

type RawMilestoneInfo = {
  id: number; title: string; status: string; updated_at: string | null; engagement_id: number
  engagement: Joined<{ account_id: number | null; account: Joined<{ name: string | null }> }>
}
const toMilestoneInfo = (r: RawMilestoneInfo): MilestoneInfo => {
  const eng = one(r.engagement)
  return {
    id: r.id, title: r.title, status: r.status, updated_at: r.updated_at, engagement_id: r.engagement_id,
    account_id: eng?.account_id ?? null, account_name: one(eng?.account ?? null)?.name ?? null,
  }
}

async function loadMilestones(s: Db, win: ChangeWindow, freshEngagementIds: ReadonlySet<number>): Promise<ChangeItem[]> {
  const since = win.since.toISOString()
  const until = win.until.toISOString()
  const [audit, touched] = await Promise.all([
    s.from('audit_event')
      .select('id, action, entity_id, occurred_at, before, after')
      .eq('entity_table', 'engagement_milestone')
      .in('action', MILESTONE_ACTIONS)
      .gte('occurred_at', since).lt('occurred_at', until)
      .order('occurred_at', { ascending: false }).limit(LIMIT),
    // Záloha pro změny, které audit nezachytil (audit se přidával postupně).
    s.from('engagement_milestone')
      .select(MILESTONE_SELECT)
      .gte('updated_at', since).lt('updated_at', until)
      .order('updated_at', { ascending: false }).limit(LIMIT),
  ])
  if (touched.error) {
    if (isMissingRelation(touched.error)) return []
    throw touched.error
  }
  if (audit.error) logError('changes.milestoneAudit', audit.error)
  const events = (audit.error ? [] : (audit.data ?? [])) as unknown as AuditRow[]
  const milestones = new Map<number, MilestoneInfo>()
  for (const r of (touched.data ?? []) as unknown as RawMilestoneInfo[]) milestones.set(r.id, toMilestoneInfo(r))
  const missing = [...new Set(events.map((e) => e.entity_id))].filter((id) => !milestones.has(id))
  if (missing.length > 0) {
    const { data, error } = await s.from('engagement_milestone').select(MILESTONE_SELECT).in('id', missing)
    if (error) logError('changes.milestoneInfo', error)
    else for (const r of (data ?? []) as unknown as RawMilestoneInfo[]) milestones.set(r.id, toMilestoneInfo(r))
  }
  return milestoneChanges({ events, milestones: [...milestones.values()], freshEngagementIds }, win)
}

// Předání práce (0088), jednotlivá změna vlastníka (0093) a deaktivace s otevřenou prací: audit team_member
// (entity_ref = uuid člověka, 0082). Před 0082 sloupec entity_ref chybí →
// tichý „nic" (žádné takové záznamy ještě nemohly vzniknout).
async function loadHandovers(s: Db, win: ChangeWindow, names: ReadonlyMap<string, string>, canSeeSales: boolean): Promise<ChangeItem[]> {
  const { data, error } = await s
    .from('audit_event')
    .select('id, action, entity_ref, actor_id, occurred_at, after')
    .eq('entity_table', 'team_member')
    .in('action', [...HANDOVER_ACTIONS])
    .gte('occurred_at', win.since.toISOString())
    .lt('occurred_at', win.until.toISOString())
    .order('occurred_at', { ascending: false })
    .limit(LIMIT)
  if (error) {
    if (isMissingColumn(error)) return []
    throw error
  }
  return handoverChanges((data ?? []) as unknown as HandoverEvent[], names, { canSeeSales })
}

/**
 * Dodávky založené automaticky v okně (engagement.origin, 0080). Před nasazením
 * migrace sloupec chybí — pak je to tichý „nic", ne chyba karty.
 */
async function loadDeliveryRows(s: Db, win: ChangeWindow): Promise<DeliveryRow[]> {
  const { data, error } = await s
    .from('engagement')
    .select('id, kind, created_at, account_id, account(name)')
    .eq('origin', AUTO_DELIVERY_ORIGIN)
    .gte('created_at', win.since.toISOString())
    .lt('created_at', win.until.toISOString())
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  if (error) {
    if (isMissingColumn(error) || isMissingRelation(error)) return []
    throw error
  }
  return ((data ?? []) as unknown as (Omit<DeliveryRow, 'account_name'> & { account: Joined<{ name: string | null }> })[])
    .map(({ account, ...r }): DeliveryRow => ({ ...r, account_name: one(account)?.name ?? null }))
}

/**
 * Nálezy denní kontroly dokumentů (0094) v okně. Názvy, stav a verze se dočítají
 * pod RLS členovy session (dodávkové role smí číst dokumenty i verze). Bez
 * migrace 0094 tabulka není → isMissingRelation → tichý „nic".
 */
async function loadDocuments(s: Db, win: ChangeWindow): Promise<ChangeItem[]> {
  const { data, error } = await s
    .from('engagement_document_finding')
    .select('id, kind, detected_at, resolved_at, document_id, version_id')
    .gte('detected_at', win.since.toISOString())
    .lt('detected_at', win.until.toISOString())
    .order('detected_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw error
  const findings = (data ?? []) as unknown as { id: number; kind: string; detected_at: string; resolved_at: string | null; document_id: number; version_id: number | null }[]
  if (findings.length === 0) return []
  const docIds = [...new Set(findings.map((f) => f.document_id))]
  const { data: docs, error: docsError } = await s
    .from('engagement_document')
    .select('id, title, status, engagement_id, approved_version_id, engagement(account_id, account(name))')
    .in('id', docIds)
  if (docsError) throw docsError
  type RawDoc = {
    id: number; title: string; status: string; engagement_id: number; approved_version_id: number | null
    engagement: Joined<{ account_id: number | null; account: Joined<{ name: string | null }> }>
  }
  const docMap = new Map(((docs ?? []) as unknown as RawDoc[]).map((d) => [d.id, d]))
  const versionIds = [...new Set([
    ...findings.map((f) => f.version_id),
    ...[...docMap.values()].map((d) => d.approved_version_id),
  ].filter((v): v is number => v !== null))]
  const labels = new Map<number, string | null>()
  if (versionIds.length > 0) {
    const { data: versions, error: versionsError } = await s.from('engagement_document_version').select('id, version_label').in('id', versionIds)
    // Bez čísel verzí se nález ukáže i tak („jiná verze"); chyba se jen zaloguje.
    if (versionsError) logError('changes.documentVersions', versionsError)
    else for (const v of (versions ?? []) as unknown as { id: number; version_label: string | null }[]) labels.set(v.id, v.version_label)
  }
  const rows: DocumentFindingRow[] = []
  for (const f of findings) {
    const d = docMap.get(f.document_id)
    if (!d) continue
    const eng = one(d.engagement)
    rows.push({
      id: f.id, kind: f.kind, detected_at: f.detected_at, resolved_at: f.resolved_at,
      document_id: d.id, title: d.title, status: d.status, engagement_id: d.engagement_id,
      account_id: eng?.account_id ?? null, account_name: one(eng?.account ?? null)?.name ?? null,
      seen_version: f.version_id !== null ? (labels.get(f.version_id) ?? null) : null,
      approved_version: d.approved_version_id !== null ? (labels.get(d.approved_version_id) ?? null) : null,
    })
  }
  return documentChanges(rows)
}

async function loadMoney(s: Db, win: ChangeWindow): Promise<ChangeItem[]> {
  const { data, error } = await s
    .from('financial_record')
    .select('id, kind, status, amount, currency, created_at, account(name)')
    .in('kind', ['invoiced', 'received'])
    .neq('status', 'cancelled')
    .gte('created_at', win.since.toISOString())
    .lt('created_at', win.until.toISOString())
    .order('created_at', { ascending: false })
    .limit(LIMIT)
  if (error) throw error
  const rows = ((data ?? []) as unknown as (Omit<MoneyRow, 'account_name'> & { account: Joined<{ name: string | null }> })[])
    .map(({ account, ...r }): MoneyRow => ({ ...r, account_name: one(account)?.name ?? null }))
  return moneyChanges(rows)
}

// --- Vstupní bod ------------------------------------------------------------

export type ChangesResult = {
  sections: ChangeSection[]
  /** Druhy změn, které se nepodařilo načíst (chyba, ne prázdno). */
  unavailable: ChangeKind[]
}

export async function loadChanges(input: {
  window: ChangeWindow
  meId: string | null
  canSeeSales: boolean
  members: readonly { id: string; full_name: string | null }[]
  perSection?: number
  /** Jen tyhle druhy (výchozí všechny); ostatní se nedotazují a zůstanou prázdné. */
  kinds?: readonly ChangeKind[]
  /** Klient databáze; výchozí je session přihlášeného (RLS). */
  db?: Db
}): Promise<ChangesResult> {
  const s = input.db ?? await createClient()
  const wanted = (kind: ChangeKind) => !input.kinds || input.kinds.includes(kind)
  const names = new Map(input.members.map((m) => [m.id, m.full_name?.trim() || 'člen týmu']))
  // Nové dodávky čtou dva druhy: samy o sobě a milníky (ty jejich vznik
  // nehlásí po jednom). Dotaz proto běží jednou a sdílí se.
  const deliveryRows: Promise<DeliveryRow[]> = wanted('delivery') || wanted('milestone')
    ? loadDeliveryRows(s, input.window)
    : Promise.resolve([])
  deliveryRows.catch(() => undefined)
  const all: { kind: ChangeKind; run: () => Promise<ChangeItem[]> }[] = [
    { kind: 'delivery', run: async () => deliveryChanges(await deliveryRows) },
    { kind: 'decision', run: () => loadDecisions(s, input.window, names) },
    { kind: 'work', run: () => loadWork(s, input.window, input.meId) },
    { kind: 'handover', run: () => loadHandovers(s, input.window, names, input.canSeeSales) },
    { kind: 'document', run: () => loadDocuments(s, input.window) },
    {
      kind: 'milestone',
      run: async () => loadMilestones(s, input.window, new Set(await deliveryRows.then((rows) => rows.map((r) => r.id), () => []))),
    },
  ]
  // Obchodní druhy se bez can_see_sales vůbec nedotazují.
  if (input.canSeeSales) {
    all.push(
      // Bez migrace 0081 tabulka není: isMissingRelation → tichý „nic".
      { kind: 'intake', run: () => loadIntakes(s, input.window) },
      { kind: 'email', run: () => loadEmails(s, input.window) },
      { kind: 'stage', run: () => loadStages(s, input.window) },
      { kind: 'meeting', run: () => loadMeetings(s, input.window) },
      { kind: 'money', run: () => loadMoney(s, input.window) },
    )
  }
  const jobs = all.filter((j) => wanted(j.kind))
  const settled = await Promise.all(jobs.map(async (j) => {
    try {
      return { kind: j.kind, items: await j.run(), failed: false }
    } catch (e) {
      if (isMissingRelation(e as { code?: string; message?: string })) return { kind: j.kind, items: [] as ChangeItem[], failed: false }
      logError(`changes.${j.kind}`, e)
      return { kind: j.kind, items: [] as ChangeItem[], failed: true }
    }
  }))
  return {
    sections: buildChangeSections(settled.flatMap((r) => r.items), { canSeeSales: input.canSeeSales, perSection: input.perSection }),
    unavailable: settled.filter((r) => r.failed).map((r) => r.kind),
  }
}
