import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { Chip } from '@/components/Chip'
import { WorkChk, WorkStatus, levelWords, type WorkStatusTone } from '@/components/WorkUi'
import { WorkCaseButtons, type WorkCaseButton } from '@/components/WorkCaseButtons'
import {
  AddStepForm,
  NextStepApprovalForm,
  RecordDecisionForm,
  RequestApprovalForm,
  ResolveDecisionFreeForm,
} from '@/components/WorkCaseForms'
import { MigrationPendingNotice, WorkCaseNotice } from '@/components/WorkCaseNotice'
import { CaseTimeline } from '@/components/CaseTimeline'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { approvalKindLabel } from '@/components/DecisionCards'
import {
  addCaseStep,
  changeCaseStatus,
  changeStepStatus,
  recordCaseDecision,
  requestCaseApproval,
  resolveCaseDecision,
} from '@/core/actions/workCases'
import { requestNextStepApproval } from '@/core/actions/approvals'
import { getActivePolicies, getCaseOrigin, getLoopNodes, getWorkCase } from '@/core/loopQueries'
import {
  approvalActionsConfig,
  approvalTitle,
  executionSummary,
  fmtDay,
  isApprovalActionType,
  nextStepParams,
} from '@/core/approvalActions'
import { buildCaseTimeline } from '@/core/caseTimeline'
import { addDaysToPragueDay, pragueToday } from '@/lib/pragueDate'
import { proposalMethodLabel } from '@/core/agents/caseProposal'
import { EXTERNAL_COMMITMENT } from '@/core/authority'
import {
  caseCloseIssues,
  isCaseStatus,
  isStepStatus,
  isTerminalCase,
  nextCaseStatuses,
  nextStepStatuses,
  type CaseStatus,
  type StepStatus,
} from '@/core/workCase'
import {
  actorName,
  approvalStatusLabel,
  caseStatusLabel,
  nodeLabel,
  stepStatusLabel,
} from '@/core/workCaseFlow'
import { listAssignableMembers } from '@/domain/crm/queries/tasks'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { loadOwnerChangeContext } from '@/lib/queries/ownerChange'
import { canChangeOwner } from '@/lib/ownerChange'
import { OwnerChange } from '@/components/OwnerChange'
import { safeExternalHref, EXTERNAL_LINK_REL } from '@/core/untrusted'

// Anatomie detailu (docs/PROVOZ.md §13 Detaily): jednotná hlavička
// (zpět na seznam, nadpis, stav, jedna hlavní akce, záložky Práce /
// Schválení / Časová osa) a pravý sloupec Souvislosti (na mobilu pod obsahem).

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('cs-CZ') : '—')

type Tab = 'prace' | 'schvaleni' | 'osa'
const TABS: { id: Tab; label: string }[] = [
  { id: 'prace', label: 'Práce' },
  { id: 'schvaleni', label: 'Schválení' },
  { id: 'osa', label: 'Časová osa' },
]
const parseTab = (v: string | string[] | undefined): Tab => {
  const s = Array.isArray(v) ? v[0] : v
  return s === 'schvaleni' || s === 'osa' ? s : 'prace'
}

// Tlačítko přechodu stavu slovesem (stav sám je v hlavičce slovem a tečkou).
function caseVerb(from: CaseStatus, to: CaseStatus): string {
  if (to === 'done') return 'Uzavřít jako hotový'
  if (to === 'cancelled') return 'Zrušit případ'
  if (to === 'waiting') return 'Označit jako čekající'
  if (to === 'in_progress') return from === 'waiting' ? 'Vrátit do práce' : 'Začít pracovat'
  return caseStatusLabel(to)
}

const CASE_TONE: Record<string, WorkStatusTone> = { open: 'idle', in_progress: 'info', waiting: 'wait', done: 'done', cancelled: 'idle' }
const STEP_TONE: Record<string, WorkStatusTone> = { todo: 'idle', doing: 'info', blocked: 'fail', done: 'done', skipped: 'idle' }
const APPROVAL_TONE: Record<string, string> = { pending: 'warn', approved: 'pos', rejected: 'neg', expired: 'neutral' }

// Popisek tlačítka podle cílového stavu kroku.
const STEP_VERB: Record<StepStatus, string> = {
  todo: 'Vrátit k udělání',
  doing: 'Začít',
  blocked: 'Blokováno',
  done: 'Hotovo',
  skipped: 'Přeskočit',
}

export default async function WorkCaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ tab?: string | string[] }>
}) {
  const { id: raw } = await params
  const tab = parseTab((await searchParams)?.tab)
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) notFound()

  // Obchodní role: obchod z deal (embed) + odkaz; ostatní: jen název z deal_public.
  const seesSales = await canCurrentUserSeeSales()
  const res = await getWorkCase(id, { includeDeal: seesSales })
  if (res.state === 'not_found') notFound()
  if (res.state !== 'ok') {
    return (
      <>
        <PageHeader title="Případ" eyebrow="Práce · Případy" back={{ href: '/cockpit/pripady', label: 'Případy' }} />
        {res.state === 'missing_migration' ? (
          <MigrationPendingNotice />
        ) : (
          <WorkCaseNotice>Případ se nepodařilo načíst. Zkuste to prosím později.</WorkCaseNotice>
        )}
      </>
    )
  }

  const [members, policies, origin, ownerCtx, nodes] = await Promise.all([
    listAssignableMembers(), getActivePolicies(), getCaseOrigin(id), loadOwnerChangeContext(), getLoopNodes(),
  ])
  const names = new Map(members.map((m) => [m.id, m.full_name]))
  const c = res.case
  const status = isCaseStatus(c.status) ? c.status : null
  const locked = status === null || isTerminalCase(status)
  const steps = res.steps
  const typedSteps = steps.filter((s) => isStepStatus(s.status)) as { status: StepStatus }[]
  const closeIssues = status ? caseCloseIssues(status, typedSteps) : []
  const openDecisions = res.decisions.filter((d) => !d.decided_at)
  const closedDecisions = res.decisions.filter((d) => d.decided_at)
  // Obecná žádost jen zapisuje; druhy akcí s provedením (0084) mají vlastní formulář.
  const knownKinds = policies
    .filter((p) => !isApprovalActionType(p.action_kind))
    .map((p) => ({ kind: p.action_kind, level: p.level }))
  if (!knownKinds.some((k) => k.kind === EXTERNAL_COMMITMENT)) knownKinds.push({ kind: EXTERNAL_COMMITMENT, level: 'L2' })
  const approvalsCfg = approvalActionsConfig()
  const executions = new Map(res.executions.map((e) => [e.request_id, e]))
  // Typované žádosti jen s migrací 0084 (getWorkCase pak čte action_type).
  const actionsReady = res.approvals.length === 0 || res.approvals.some((a) => 'action_type' in a)
  const assignable = members.filter((m) => m.role !== 'partner')
  const decidedOptions = closedDecisions.map((d) => ({ id: d.id, label: `${d.question} → ${d.chosen}` }))
  const timeline = buildCaseTimeline(
    { created_at: c.created_at, created_by: c.created_by, steps, decisions: res.decisions, approvals: res.approvals, executions: res.executions },
    names,
    approvalKindLabel,
  )

  const caseButtons: WorkCaseButton[] = status
    ? nextCaseStatuses(status)
        .filter((to) => to !== 'done' || closeIssues.length === 0)
        .map((to) => ({
          label: caseVerb(status, to),
          fields: { case_id: c.id, to },
          primary: to === 'done' || (to === 'in_progress' && !nextCaseStatuses(status).includes('done')),
          ...(to === 'done'
            ? { confirm: 'Uzavřený případ už nejde měnit ani znovu otevřít.', confirmLabel: 'Ano, uzavřít' }
            : to === 'cancelled'
              ? { confirm: 'Zrušený případ už nejde znovu otevřít. Historie zůstane.', confirmLabel: 'Ano, zrušit' }
              : {}),
        }))
    : []
  // Jedna hlavní akce v hlavičce; ostatní přechody jsou v Souvislostech.
  const mainButton = caseButtons.find((b) => b.primary) ?? null
  const otherButtons = caseButtons.filter((b) => b !== mainButton)
  const pendingApprovals = res.approvals.filter((a) => a.status === 'pending').length
  const tabHref = (t: Tab) => (t === 'prace' ? `/cockpit/pripady/${c.id}` : `/cockpit/pripady/${c.id}?tab=${t}`)
  const tabCount: Record<Tab, number | null> = {
    prace: steps.filter((s) => s.status !== 'done' && s.status !== 'skipped').length + openDecisions.length,
    schvaleni: pendingApprovals,
    osa: null,
  }

  return (
    <>
      <PageHeader
        title={c.title}
        eyebrow={`Případ · ${nodeLabel(c.node)}`}
        back={{ href: '/cockpit/pripady', label: 'Případy' }}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <WorkStatus tone={CASE_TONE[c.status] ?? 'idle'}>{caseStatusLabel(c.status)}</WorkStatus>
            <span>Vlastník {c.lead_owner_name ?? 'neobsazeno'}{c.account_name ? ` · ${c.account_name}` : ''}</span>
          </span>
        }
      >
        {!locked && mainButton && <WorkCaseButtons action={changeCaseStatus} buttons={[mainButton]} size="md" coral />}
      </PageHeader>

      <nav aria-label="Části případu" className="seg mb-6">
        {TABS.map((t) => (
          <Link key={t.id} href={tabHref(t.id)} aria-current={tab === t.id ? 'page' : undefined} className="seg-item">
            {t.label}
            {tabCount[t.id] ? <span className="seg-count tabular-nums">{tabCount[t.id]}</span> : null}
          </Link>
        ))}
      </nav>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          {tab === 'prace' && (
            <>
              <Card title="Kroky" sub={steps.length ? `${steps.filter((s) => s.status === 'done').length} z ${steps.length} hotovo` : undefined}>
                {steps.length === 0 ? (
                  <EmptyState title="Případ zatím nemá kroky." compact>
                    {locked ? 'Případ je uzavřený.' : 'Přidej první krok níže.'}
                  </EmptyState>
                ) : (
                  <ol className="m-0 list-none divide-y divide-[color:var(--c-line-2)] p-0">
                    {steps.map((s, i) => (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                        <div className="flex min-w-0 items-center gap-3">
                          <WorkChk done={s.status === 'done'} label={`Krok ${i + 1}: ${s.status === 'done' ? 'hotovo' : 'nehotovo'}`} />
                          <span className="text-headline text-ink">{s.title}</span>
                          <WorkStatus tone={STEP_TONE[s.status] ?? 'idle'}>{stepStatusLabel(s.status)}</WorkStatus>
                        </div>
                        {!locked && isStepStatus(s.status) && (
                          <WorkCaseButtons
                            action={changeStepStatus}
                            buttons={nextStepStatuses(s.status).map((to) => ({
                              label: STEP_VERB[to],
                              fields: { step_id: s.id, to },
                              primary: to === 'done',
                              ariaLabel: `${STEP_VERB[to]} — ${s.title}`,
                            }))}
                          />
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                {!locked && (
                  <div className="mt-4 border-t border-[color:var(--c-line-2)] pt-4">
                    <AddStepForm action={addCaseStep} caseId={c.id} />
                  </div>
                )}
              </Card>

              <Card title="Rozhodnutí" sub={openDecisions.length ? `${openDecisions.length} čeká na odpověď` : undefined}>
                <div className="flex flex-col gap-3">
                  {openDecisions.length === 0 && closedDecisions.length === 0 && (
                    <EmptyState title="Žádná rozhodnutí." compact>Otázku, o které je potřeba rozhodnout, zapíšeš níže.</EmptyState>
                  )}
                  {openDecisions.map((d) => (
                    <div key={d.id} className="flex flex-col gap-2.5 rounded-tile bg-[color:var(--c-soft)] p-4">
                      <p className="m-0 text-headline text-ink">{d.question}</p>
                      {d.options.length > 0 ? (
                        <WorkCaseButtons
                          action={resolveCaseDecision}
                          buttons={d.options.map((o) => ({
                            label: o,
                            fields: { decision_id: d.id, chosen: o },
                            ariaLabel: `${d.question} — ${o}`,
                          }))}
                        />
                      ) : (
                        <ResolveDecisionFreeForm action={resolveCaseDecision} decisionId={d.id} question={d.question} />
                      )}
                    </div>
                  ))}
                  {closedDecisions.length > 0 && (
                    <ul className="m-0 list-none divide-y divide-[color:var(--c-line-2)] p-0">
                      {closedDecisions.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-body">
                          <span className="text-ink">{d.question}</span>
                          <Chip tone="pos">{d.chosen}</Chip>
                          <span className="text-footnote text-muted">{actorName(d.decided_by, names)} · {fmt(d.decided_at)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!locked && (
                    <details className="group border-t border-[color:var(--c-line-2)] pt-1">
                      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 text-callout font-semibold text-ink [&::-webkit-details-marker]:hidden">
                        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
                        Přidat otázku k rozhodnutí
                      </summary>
                      <div className="pt-2"><RecordDecisionForm action={recordCaseDecision} caseId={c.id} /></div>
                    </details>
                  )}
                </div>
              </Card>
            </>
          )}

          {tab === 'schvaleni' && (
            <Card title="Schválení" sub="O požadavku rozhoduje jiný člen týmu (čtyři oči).">
              <div className="flex flex-col gap-4">
                {res.approvals.length === 0 ? (
                  <EmptyState title="Zatím žádná žádost o schválení." compact>
                    {locked ? 'Případ je uzavřený.' : 'Další krok nebo závazek vůči klientovi pošleš ke schválení níže.'}
                  </EmptyState>
                ) : (
                  <ul className="m-0 list-none divide-y divide-[color:var(--c-line-2)] p-0 text-body">
                    {res.approvals.map((a) => {
                      const step = a.action_type === 'confirm_next_step' ? nextStepParams(a.params) : null
                      const ex = executions.get(a.id)
                      const sum = ex ? executionSummary(ex, a, names, approvalsCfg) : null
                      return (
                        <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0">
                          <span className="text-headline text-ink">{approvalTitle(a, approvalKindLabel)}</span>
                          <Chip tone="blue">{levelWords(a.requested_level)}</Chip>
                          <Chip tone={APPROVAL_TONE[a.status] ?? 'neutral'}>{approvalStatusLabel(a.status)}</Chip>
                          <span className="text-footnote text-muted">
                            žádá {actorName(a.requested_by, names)} {fmt(a.created_at)}
                            {a.decided_at && a.decided_by ? ` · rozhodl ${actorName(a.decided_by, names)} ${fmt(a.decided_at)}` : ''}
                            {a.expires_at && a.status === 'pending' ? ` · platí do ${fmt(a.expires_at)}` : ''}
                          </span>
                          {step && (
                            <span className="w-full text-callout text-muted">
                              Krok „{step.title}“ · řeší {names.get(step.assignee_id) ?? 'nepřiřazeno'} · do {fmtDay(step.due_on)}
                            </span>
                          )}
                          {sum && (
                            <span className="flex w-full flex-wrap items-center gap-2 text-callout">
                              <WorkStatus tone={sum.tone === 'done' ? 'done' : sum.tone === 'fail' ? 'fail' : 'wait'}>{sum.label}</WorkStatus>
                              <span className="text-muted">{sum.text}</span>
                            </span>
                          )}
                          {a.decision_note && <span className="w-full text-footnote text-muted">„{a.decision_note}“</span>}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {pendingApprovals > 0 && (
                  <p className="m-0 text-callout text-muted">
                    Čekající žádosti rozhoduje jiný člen týmu na stránce <Link href="/cockpit/rozhodnuti" className="font-semibold underline">Ke schválení</Link>.
                  </p>
                )}
              </div>
            </Card>
          )}
          {tab === 'schvaleni' && !locked && actionsReady && approvalsCfg && (
            <NextStepApprovalForm
              action={requestNextStepApproval}
              caseId={c.id}
              members={assignable}
              defaultAssignee={c.lead_owner_id}
              defaultDue={addDaysToPragueDay(pragueToday(), 7)}
              decisions={decidedOptions}
              validityDays={approvalsCfg.confirmNextStep.validityDays}
            />
          )}
          {tab === 'schvaleni' && !locked && (
            <details className="group">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 text-callout font-semibold text-ink [&::-webkit-details-marker]:hidden">
                <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
                Obecná žádost o schválení
              </summary>
              <div className="pt-2"><RequestApprovalForm action={requestCaseApproval} caseId={c.id} knownKinds={knownKinds} /></div>
            </details>
          )}

          {tab === 'osa' && (
            <Card title="Časová osa" sub="Co se v případu stalo, nejnovější nahoře.">
              {timeline.length === 0 ? (
                <EmptyState title="Zatím se nic nestalo." compact />
              ) : (
                <CaseTimeline events={timeline} />
              )}
            </Card>
          )}
        </div>

        <aside aria-label="Souvislosti" className="flex min-w-0 flex-col gap-4">
          <Card title="Souvislosti" headingLevel={2}>
            <dl className="m-0 grid grid-cols-1 gap-3 text-body">
              <div>
                <dt className="eyebrow">Vlastník</dt>
                <dd className="m-0 mt-0.5 font-semibold text-ink">{c.lead_owner_name ?? 'neobsazeno'}{c.deputy_name ? ` (zástup: ${c.deputy_name})` : ''}</dd>
                {/* Změna vlastníka a zástupce na místě (0093): stejná pravidla jako
                    „Předat práci", jen pro jednu věc, se Zpět. Zavřený případ ne. */}
                {!locked && (
                  <dd className="m-0 mt-1.5">
                    <OwnerChange
                      kind="pripady"
                      itemId={c.id}
                      itemLabel={c.title}
                      owner={{ id: c.lead_owner_id, name: c.lead_owner_name }}
                      deputy={{ id: c.deputy_id ?? null, name: c.deputy_name }}
                      members={ownerCtx.members}
                      canChange={canChangeOwner('pripady', ownerCtx.actor, {
                        ownerId: c.lead_owner_id,
                        deputyId: c.deputy_id ?? null,
                        nodeOwnerId: nodes.find((n) => n.node === c.node)?.owner_id ?? null,
                      })}
                    />
                  </dd>
                )}
              </div>
              <div>
                <dt className="eyebrow">Klient</dt>
                <dd className="m-0 mt-0.5 font-semibold text-ink">{c.account_id && c.account_name ? <Link href={`/cockpit/clients/${c.account_id}`}>{c.account_name}</Link> : '—'}</dd>
              </div>
              {/* Název obchodu vidí každý (ne-obchodní role přes deal_public,
                  bez částek); odkaz na detail obchodu jen obchodní role. */}
              <div>
                <dt className="eyebrow">Obchod</dt>
                <dd className="m-0 mt-0.5 font-semibold text-ink">
                  {c.deal_id && c.deal_title ? (
                    seesSales && c.deal_account_id ? (
                      <Link href={`/cockpit/clients/${c.deal_account_id}/deals/${c.deal_id}`}>{c.deal_title}</Link>
                    ) : c.deal_title
                  ) : '—'}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Založeno</dt>
                <dd className="m-0 mt-0.5 text-muted">{actorName(c.created_by, names)} {fmt(c.created_at)} · změněno {fmt(c.updated_at)}</dd>
              </div>
            </dl>
            {origin && (
              <p className="m-0 mt-4 border-t border-[color:var(--c-line-2)] pt-3 text-footnote text-muted">
                Vznikl přijetím návrhu ({proposalMethodLabel(origin.method)}, {fmt(origin.created_at)}): {origin.rationale}
                {safeExternalHref(origin.evidence_link) && (
                  <>
                    {' · '}
                    <a href={safeExternalHref(origin.evidence_link)!} target="_blank" rel={EXTERNAL_LINK_REL} className="underline">Doklad: zpráva v Outlooku</a>
                  </>
                )}
              </p>
            )}
            {!locked && (otherButtons.length > 0 || closeIssues.length > 0 || status === 'open') && (
              <div className="mt-4 flex flex-col gap-2 border-t border-[color:var(--c-line-2)] pt-3">
                <p className="eyebrow m-0">Změnit stav</p>
                <WorkCaseButtons action={changeCaseStatus} buttons={otherButtons} />
                {status && nextCaseStatuses(status).includes('done') && closeIssues.length > 0 && (
                  <p className="m-0 text-footnote text-muted">Uzavřít zatím nejde: {closeIssues.join(', ')}.</p>
                )}
                {status === 'open' && (
                  <p className="m-0 text-footnote text-muted">Hotovo vede přes „Rozpracovaný“ — případ musí projít prací.</p>
                )}
              </div>
            )}
          </Card>
        </aside>
      </div>
    </>
  )
}
