import Link from 'next/link'
import { approvalKindLabel } from '@/components/DecisionCards'
import { approvalTitle } from '@/core/approvalActions'
import { PageHeader } from '@/components/PageHeader'
import { buttonClass } from '@/components/ui/Button'
import { SectionTabs, TODAY_TABS } from '@/components/SectionTabs'
import { SalesFocus } from '@/components/SalesFocus'
import { DeliveryOverview } from '@/components/DeliveryOverview'
import { DeliveryPortfolioPanel } from '@/components/DeliveryPortfolioPanel'
import { getDeliveryPortfolio } from '@/domain/delivery/queries/portfolio'
import {
  TodayApprovals, TodayBlocked, TodayMeetings, TodayNumbers, TodayOverdue, TodaySourcesPanel, TodayWonChart,
  type ApprovalPreview, type BlockedItem, type OverdueItem,
} from '@/components/ui/TodayCards'
import { BellIcon, TodayStageRing } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { getContractedOverTime, getDeliveryProjects } from '@/lib/queries/dashboard'
import { PRAGUE_TZ, pragueToday } from '@/lib/pragueDate'
import { logError } from '@/lib/log'
import { getMyCalendarConnection } from '@/domain/crm/queries/calendar'
import { getSalesActivities, getSalesDeals } from '@/domain/crm/queries/sales'
import { getMeetingsOnDay } from '@/domain/crm/queries/todayMeetings'
import { getMyTasks } from '@/domain/crm/queries/tasks'
import { updateTaskDueOn, updateTaskStatus } from '@/domain/crm/actions/tasks'
import { updateDealNextStep } from '@/domain/crm/actions/sales'
import { getLastSkillMeetingNoteAt } from '@/domain/crm/queries/meetingNotes'
import { listTeamMembers } from '@/lib/queries/team'
import { buildSalesDashboard } from '@/domain/crm/sales'
import { getDecisionInbox, getLoopNodes } from '@/core/loopQueries'
import { viewerCanDecide } from '@/core/workCaseFlow'
import { getConnectorState } from '@/core/connectorState'
import { ChangesCard } from '@/components/ui/ChangesCard'
import { TodayIntake, hasIntakeContent } from '@/components/ui/TodayIntake'
import { getRecentAutoIntakes, type AutoIntakeCard } from '@/domain/crm/queries/autoIntake'
import { TodayMail, hasMailContent } from '@/components/ui/TodayMail'
import { getMailContentCard, type MailContentCard } from '@/domain/crm/queries/mailContent'
import { ChangesSeen } from '@/components/ui/ChangesSeen'
import { WaitingCard } from '@/components/ui/WaitingCard'
import { buildChangeSections, resolveVisitWindow } from '@/domain/crm/changes'
import { getChangesView, loadChanges, type ChangesViewState } from '@/domain/crm/queries/changes'
import { getWaitingItems } from '@/domain/delivery/queries/waiting'
import type { Loaded } from '@/domain/delivery/queries/documents'
import type { WaitingItem } from '@/domain/delivery/waiting'
import { loadMailSourcesStatus } from '@/domain/crm/mailSyncService'
import { seesByznys } from '@/lib/domain'
import {
  buildTodaySources, daysAgoLabel, daysOverdue, greeting, lastMonths, openStageSlices, splitFocus,
  postponeTargets, todayEyebrow, webhookNote, plural,
} from '@/domain/crm/today'

export const dynamic = 'force-dynamic'

// Pomocné karty (schůzky, zdroje, graf…) nesmí shodit celou obrazovku:
// při chybě se zaloguje a karta ukáže klidný prázdný stav.
async function safe<T>(scope: string, promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise
  } catch (e) {
    logError(`dashboard.${scope}`, e)
    return fallback
  }
}

// Ranní přehled: „Co se změnilo" od poslední návštěvy a „Čeká na klienta".
// Obchodní druhy změn (pošta klientů, fáze obchodů, faktury) se bez
// can_see_sales vůbec nenačítají. Obě karty jsou pomocné: chyba se zaloguje
// a karta to řekne, obrazovka nespadne.
async function loadMorning(args: {
  now: Date
  userId: string | null
  canSeeSales: boolean
  members: readonly { id: string; full_name: string | null }[]
}) {
  const viewFallback: ChangesViewState = { state: 'error' }
  const view = args.userId ? await safe('changesView', getChangesView(args.userId), viewFallback) : viewFallback
  const range = resolveVisitWindow(view.state === 'ok' ? view.row : null, args.now, { tracked: view.state !== 'missing_migration' })
  const empty = buildChangeSections([], { canSeeSales: args.canSeeSales })
  const waitingFallback: Loaded<{ items: WaitingItem[] }> = { state: 'error', message: 'nedostupné' }
  const [changes, waiting] = await Promise.all([
    safe('changes', loadChanges({ window: range, meId: args.userId, canSeeSales: args.canSeeSales, members: args.members }), {
      sections: empty, unavailable: empty.map((s) => s.kind),
    }),
    safe('waiting', getWaitingItems(), waitingFallback),
  ])
  return { window: range, changes, waiting, trackVisit: view.state === 'ok' }
}

const monthFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: PRAGUE_TZ, month: 'long', year: 'numeric' })

export default async function Dashboard() {
  const now = new Date()
  const today = pragueToday(now)
  const [{ user, member: me }, calendar] = await Promise.all([
    getCurrentMember(), getMyCalendarConnection(),
  ])

  // Role bez přístupu k obchodu (projekťák/lektor/partner) vidí jen dodávky —
  // obchodní čísla, částky ani obchodní fronty se jim vůbec nenačítají.
  const canSeeByznys = seesByznys(me?.role)

  // Hledání klienta dělá paleta ⌘K (tlačítko „Hledat" v postranním panelu),
  // hlavička nese jen akce: jedna hlavní „Zapsat aktivitu", import nabídky vedle.
  const header = (
    <PageHeader title={greeting(now)} eyebrow={todayEyebrow(now)}>
      {/* Import nabídky zakládá obchod s částkami — jen obchodní role. */}
      {canSeeByznys && (
        <Link href="/cockpit/nabidka/import" className={buttonClass('outline')}>
          Nahrát nabídku
        </Link>
      )}
      {canSeeByznys && (
        <Link href="/cockpit/aktivity" className={buttonClass('primary')}>
          <span aria-hidden="true" className="text-lg leading-none">+</span>Zapsat aktivitu
        </Link>
      )}
    </PageHeader>
  )

  const calendarCard = (
    <Card title="Schůzky" href="/cockpit/nastaveni" hrefLabel="Nastavení Outlooku">
      {calendar.connected ? (
        <div>
          <div className="text-headline text-ink">Outlook je připojený</div>
          <div className="mt-1 text-footnote text-muted">{calendar.email ?? '—'}</div>
        </div>
      ) : (
        <EmptyState compact icon={<BellIcon size={20} />} title="Napoj Outlook" action={{ href: '/cockpit/nastaveni', label: 'Připojit Outlook' }}>
          Uvidíš tu schůzky a synchronizuješ úkoly rovnou do kalendáře.
        </EmptyState>
      )}
    </Card>
  )

  // Role bez obchodu: od 0058 na tabulku deal nevidí. Přehled se skládá
  // z dodávek + deal_public (název a „vyhráno"), bez částek, nákladů a marží.
  if (!canSeeByznys) {
    const [delivery, teamMembers] = await Promise.all([getDeliveryProjects(), safe('members', listTeamMembers(), [])])
    const morning = await loadMorning({ now, userId: user?.id ?? null, canSeeSales: false, members: teamMembers })
    return (
      <>
        {header}
        <DeliveryOverview projects={delivery} today={today} calendarCard={calendarCard}>
          <ChangesCard sections={morning.changes.sections} windowLabel={morning.window.label} note={morning.window.note} unavailable={morning.changes.unavailable} mode="today" />
          {morning.trackVisit && <ChangesSeen />}
          <WaitingCard result={morning.waiting} />
        </DeliveryOverview>
      </>
    )
  }

  // Obchodní role (vedení, obchodník): obchody, schůzky, schvalování, zdroje.
  const [salesDeals, salesActivities, members] = await Promise.all([
    getSalesDeals(), getSalesActivities(250), listTeamMembers(),
  ])
  const sales = buildSalesDashboard(salesDeals, salesActivities, members, now)
  // Panel Dodávky (portfolio): pomocná karta, načítá se souběžně s ostatními.
  const portfolioPromise = safe('portfolio', getDeliveryPortfolio({ today, canSeeSales: true }), { state: 'error' as const, message: 'nedostupné' })

  const intakeFallback: AutoIntakeCard = { state: 'error' }
  const mailContentFallback: MailContentCard = { state: 'error' }
  const [myTasks, meetings, inbox, loopNodes, mail, calendarState, lastNoteAt, contracted, morning, intake, mailContent] = await Promise.all([
    safe('tasks', getMyTasks(), []),
    safe('meetings', getMeetingsOnDay(today), []),
    getDecisionInbox(now),
    getLoopNodes(),
    loadMailSourcesStatus(),
    safe('calendarState', getConnectorState('graph_calendar'), null),
    safe('lastNote', getLastSkillMeetingNoteAt(), null),
    safe('contracted', getContractedOverTime(), []),
    loadMorning({ now, userId: user?.id ?? null, canSeeSales: true, members }),
    // Poptávky, které Cockpit založil sám z e-mailu (0081); bez migrace nebo při chybě karta zmizí.
    safe('intake', getRecentAutoIntakes(now), intakeFallback),
    // Pošta ze složky „Cockpit" k zařazení (0091); bez migrace, přepínače nebo zpráv karta zmizí.
    safe('mailContent', getMailContentCard(), mailContentFallback),
  ])

  // Co dnes udělat / po termínu
  const { todo, overdue } = splitFocus(sales.focus)
  const openTasks = myTasks.filter((t) => t.status !== 'done')
  const tasksToday = openTasks.filter((t) => t.due_on === today)
  const overdueItems: (OverdueItem & { days: number })[] = [
    ...overdue.map((item): OverdueItem & { days: number } => {
      const days = daysOverdue(item.deal.next_step_due ?? today, today)
      return {
        key: `d${item.deal.id}`,
        href: item.deal.account_id ? `/cockpit/clients/${item.deal.account_id}/deals/${item.deal.id}/edit` : '/cockpit/pipeline',
        title: item.deal.next_step ?? 'Domluvit další krok',
        sub: item.deal.account?.name ?? item.deal.title,
        late: daysAgoLabel(days),
        severe: days >= 3,
        kind: 'deal',
        days,
        dealId: item.deal.id,
        nextStep: item.deal.next_step,
        due: item.deal.next_step_due,
      }
    }),
    ...openTasks.filter((t) => t.due_on && t.due_on < today).map((t): OverdueItem & { days: number } => {
      const days = daysOverdue(t.due_on ?? today, today)
      return { key: `t${t.id}`, href: '/cockpit/tasks', title: t.title, sub: t.account?.name ?? 'Úkol', late: daysAgoLabel(days), severe: days >= 3, kind: 'task', days, taskId: t.id, taskStatus: t.status, due: t.due_on }
    }),
  ].sort((a, b) => b.days - a.days)

  // Ke schválení: jen to, o čem může přihlášený opravdu rozhodnout (čtyři oči + role).
  const viewer = user ? { id: user.id, teamRole: me?.role ?? null } : null
  const inboxOk = inbox.state === 'ok'
  const decidable = inbox.state === 'ok' ? inbox.approvals.filter((a) => !a.expired && viewerCanDecide(a, viewer, loopNodes)) : []
  const decisions = inbox.state === 'ok' ? inbox.decisions : []
  const approvalItems: ApprovalPreview[] = [
    ...decidable.map((a) => {
      // Stejný čitelný název jako na /rozhodnuti (ne syrový action_kind).
      const kind = approvalTitle(a, approvalKindLabel)
      return { id: `a${a.id}`, title: a.case_title ?? kind, sub: a.case_title ? kind : 'Schválení', age: daysAgoLabel(a.ageDays) }
    }),
    ...decisions.map((d) => ({ id: `r${d.id}`, title: d.question, sub: d.case_title ?? 'Rozhodnutí', age: daysAgoLabel(d.ageDays) })),
  ]

  // Obchody: prstenec, čísla, blokery
  const slices = openStageSlices(salesDeals)
  const openCount = slices.reduce((n, s) => n + s.count, 0)
  const blocked: BlockedItem[] = salesDeals
    .filter((d) => !!d.status_blocker)
    .map((d) => ({
      id: d.id,
      href: d.account_id ? `/cockpit/clients/${d.account_id}` : '/cockpit/pipeline',
      firm: d.account?.name ?? '—',
      title: d.title,
      blocker: d.status_blocker ?? '',
    }))

  // Vyhráno po měsících: jen skutečná data (pohled v_contracted_over_time).
  const wonByMonth = new Map(contracted.map((r) => [r.month, r.amount]))
  const months = lastMonths(today, 6)
  const wonValues = months.map((m) => wonByMonth.get(m) ?? 0)

  const sources = buildTodaySources({ mail, calendar: calendarState, lastMeetingNoteAt: lastNoteAt, now })
  const note = webhookNote(mail.webhook)

  // Pořadí podle priority (docs/PROVOZ.md §13 „Dnes"): nahoře co
  // udělat a o čem rozhodnout, pod tím čísla a co se změnilo, dole přehledy
  // a stav zdrojů (sbalený, sám se rozbalí při problému). Na mobilu je to
  // jeden sloupec ve stejném pořadí – DOM jde odshora dolů podle důležitosti.
  return (
    <>
      {header}
      <SectionTabs tabs={TODAY_TABS} label="Dnes a týden" />

      <div className="flex flex-col gap-4">
        {/* 1. Co udělat a o čem rozhodnout */}
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
          <div className="flex min-w-0 flex-col gap-4">
            <SalesFocus items={todo} tasksToday={tasksToday} completeTask={updateTaskStatus} />
            {hasIntakeContent(intake) && <TodayIntake card={intake} />}
            {hasMailContent(mailContent) && <TodayMail card={mailContent} />}
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1">
            <TodayApprovals items={approvalItems.slice(0, 3)} total={approvalItems.length} available={inboxOk} />
            <TodayOverdue items={overdueItems} targets={postponeTargets(today)} postpone={updateDealNextStep} postponeTask={updateTaskDueOn} completeTask={updateTaskStatus} />
            <div className="md:col-span-2 xl:col-span-1"><TodayMeetings meetings={meetings} outlookConnected={calendar.connected} /></div>
          </div>
        </div>

        {/* 2. Obchody v číslech */}
        <TodayNumbers
          open={sales.openPipeline}
          weighted={sales.weightedPipeline}
          won={sales.wonThisMonth}
          openCount={openCount}
          monthLabel={monthFmt.format(now)}
        />

        {/* 3. Ranní přehled: co se změnilo od poslední návštěvy */}
        <ChangesCard sections={morning.changes.sections} windowLabel={morning.window.label} note={morning.window.note} unavailable={morning.changes.unavailable} mode="today" />
        {morning.trackVisit && <ChangesSeen />}

        {/* 4. Kde se čeká a co blokuje */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <WaitingCard result={morning.waiting} />
          <TodayBlocked items={blocked} />
        </div>

        {/* 5. Dodávky */}
        <DeliveryPortfolioPanel result={await portfolioPromise} />

        {/* 6. Přehledy obchodů */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <Card title="Fáze obchodů" sub={openCount === 0 ? undefined : `${openCount} ${plural(openCount, 'otevřený obchod', 'otevřené obchody', 'otevřených obchodů')}`} href="/cockpit/pipeline" hrefLabel="Otevřít tabuli obchodů" className="h-full">
            <TodayStageRing slices={slices} />
          </Card>
          <TodayWonChart months={months} values={wonValues} />
        </div>

        {/* 7. Stav zdrojů dat: dole, sbalený; při problému rozbalený */}
        <TodaySourcesPanel rows={sources} note={note} />
      </div>
    </>
  )
}
