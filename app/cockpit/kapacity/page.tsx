import { PageHeader } from '@/components/PageHeader'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { SectionTabs, WORK_TABS } from '@/components/SectionTabs'
import { CapacityDotMatrix, CapacityGauge, personColor } from '@/components/CapacityVisuals'
import { AllocationTiles, DeputiesCard } from '@/components/CapacityPanels'
import { DataTable } from '@/components/DataTable'
import { WorkSegNav } from '@/components/WorkUi'
import { buttonClass } from '@/components/ui/Button'
import { CARD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Chip } from '@/components/Chip'
import { CapacityGrid, type CapacityGridRow } from '@/components/CapacityGrid'
import { AllocationTable } from '@/components/AllocationTable'
import { AllocationCreateForm, AllocationEditForm, CapacityForm } from '@/components/AllocationForms'
import { getCapacityOverview } from '@/domain/delivery/queries/capacity'
import {
  PLAN_WEEKS,
  canSetCapacity,
  capacityPlan,
  capacityWarnings,
  describeAllocations,
  formatHours,
  formatHoursValue,
  isCurrentOrFuture,
  overlapsWeek,
  substitutionSummary,
  weekLabel,
  weeksFrom,
  type CapacityWarning,
  type IsoWeek,
  type TargetInfo,
} from '@/domain/delivery/capacity'
import { getCurrentMember, memberIsAdmin } from '@/lib/queries/currentMember'
import { pragueToday } from '@/lib/pragueDate'

// Kapacity (kap. 10, migrace 0062): plán na 8 týdnů proti kapacitě, alokace
// s úpravou a ukončením, zastupitelnost a týdenní kapacita lidí. Bez peněz —
// stránka je pro celý tým.

function Notice({ title, children, action }: { title: string; children?: React.ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className={CARD}>
      <EmptyState title={title} action={action}>{children}</EmptyState>
    </div>
  )
}

// Nadpis oddílu stránky (Title 1) s jednou větou kontextu a akcí vpravo.
function SectionHead({ id, title, sub, children }: { id: string; title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 max-w-3xl">
        <h2 id={id} className="m-0 scroll-mt-6 font-heading text-title1 font-bold">{title}</h2>
        {sub && <p className="m-0 mt-1 text-callout text-muted">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

// 1 alokace / 2–4 alokace / 5+ alokací.
function allocationCount(n: number): string {
  return `${n} ${n >= 5 || n === 0 ? 'alokací' : 'alokace'}`
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function hrefWith(params: { vse: boolean; alokace?: number }): string {
  const p = new URLSearchParams()
  if (params.vse) p.set('vse', '1')
  if (params.alokace) p.set('alokace', String(params.alokace))
  const q = p.toString()
  return q ? `/cockpit/kapacity?${q}` : '/cockpit/kapacity'
}

function warningText(
  w: CapacityWarning,
  names: Map<string, string>,
  targetOf: (allocationId: number) => string,
  weeksByKey: Map<string, IsoWeek>,
): { tone: string; label: string; text: string } {
  const name = (id: string) => names.get(id) ?? 'Neznámý člen týmu'
  const wk = (key: string) => {
    const week = weeksByKey.get(key)
    return week ? weekLabel(week) : key
  }
  switch (w.kind) {
    case 'overload':
      return {
        tone: 'neg',
        label: 'Přetížení',
        text: `${name(w.memberId)}: ${w.weekKeys.map(wk).join(', ')} — až ${formatHours(w.peakLoad)} při kapacitě ${formatHours(w.capacity)}.`,
      }
    case 'substitute_no_room':
      return {
        tone: 'warn',
        label: 'Zástup bez rezervy',
        text: `${name(w.memberId)} — ${targetOf(w.allocationId)}: ${name(w.substituteId)} má v ${wk(w.weekKey)} volno jen ${formatHours(Math.max(0, w.free))}, zastoupení by vyžadovalo ${formatHours(w.needed)}.`,
      }
    case 'no_substitute':
      return {
        tone: 'warn',
        label: 'Bez zástupu',
        text: `${name(w.memberId)} — ${targetOf(w.allocationId)}: nikdo nezastupuje.`,
      }
  }
}

export default async function CapacityPage({
  searchParams,
}: {
  searchParams: Promise<{ vse?: string | string[]; alokace?: string | string[] }>
}) {
  const sp = await searchParams
  const showEnded = first(sp.vse) === '1'
  const editId = Number(first(sp.alokace))
  const today = pragueToday()
  const weeks = weeksFrom(today, PLAN_WEEKS)
  const [overview, { user, member }] = await Promise.all([
    getCapacityOverview({ from: weeks[0].start, today, includeEnded: showEnded }),
    getCurrentMember(),
  ])
  const currentWeekKey = weeks[0].key

  const header = (
    <>
      <PageHeader
        title="Kapacity"
        eyebrow="Práce"
        subtitle={`Kolik hodin má kdo v příštích ${PLAN_WEEKS} týdnech, na čem pracuje a kdo koho zastupuje.`}
      >
        {overview.state === 'ok' && overview.members.length > 0 && (
          <a href="#pridat-alokaci" className={buttonClass('primary')}>Přidat alokaci</a>
        )}
      </PageHeader>
      <SectionTabs tabs={WORK_TABS} label="Práce" />
    </>
  )

  if (overview.state === 'missing_migration') {
    return (
      <>
        {header}
        <FeaturePending card migration="0062">
          Pak tu půjde plánovat, kdo na čem pracuje, hlídat přetížení a zastupitelnost.
        </FeaturePending>
      </>
    )
  }
  if (overview.state === 'error') {
    return (
      <>
        {header}
        <Notice title="Kapacity se nepodařilo načíst" action={{ href: hrefWith({ vse: showEnded }), label: 'Zkusit znovu' }}>
          Zkus to prosím za chvíli znovu.
        </Notice>
      </>
    )
  }

  const { members, allocations, targets, capacityColumn, endedCount } = overview
  const names = new Map(members.map((m) => [m.id, m.full_name]))
  const targetInfo = new Map<string, TargetInfo>(targets.map((t) => [t.key, { label: t.label, href: t.href }]))
  const described = describeAllocations(allocations, names, targetInfo, today)
  const listed = showEnded ? described : described.filter((a) => isCurrentOrFuture(a, today))
  const editing = Number.isSafeInteger(editId) && editId > 0 ? described.find((a) => a.id === editId) : undefined
  const targetLabelOf = (allocationId: number) => described.find((a) => a.id === allocationId)?.target.label ?? 'alokace'

  const plan = capacityPlan(members, allocations, weeks)
  const gridRows: CapacityGridRow[] = plan.map((p, i) => ({
    id: p.member.id,
    name: p.member.full_name,
    capacity: p.capacity,
    weeks: p.weeks,
    color: personColor(i),
  }))
  const visualPeople = gridRows.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity, weeks: r.weeks }))
  const capacityById = new Map(plan.map((p) => [p.member.id, p.capacity]))
  const colorIndexById = new Map(plan.map((p, i) => [p.member.id, i]))
  const inPlanAllocations = described.filter((a) => isCurrentOrFuture(a, today) && weeks.some((w) => overlapsWeek(a, w)))
  const relevant = allocations.filter((a) => isCurrentOrFuture(a, today))
  const withSubstitute = relevant.filter((a) => a.substitute_id && a.substitute_id !== a.member_id).length
  const warnings = capacityWarnings(members, allocations, weeks, today)
  const weeksByKey = new Map(weeks.map((w) => [w.key, w]))
  const substitution = substitutionSummary(members, allocations, today)
  const people = members.map((m) => ({ id: m.id, full_name: m.full_name }))
  const inPlan = allocations.filter((a) => weeks.some((w) => overlapsWeek(a, w))).length
  const viewer = user ? { id: user.id, teamRole: member?.role ?? null, isAdmin: memberIsAdmin(member) } : null

  const totalHours = plan.reduce((sum, p) => sum + p.capacity, 0)

  return (
    <>
      {header}

      <div className="flex flex-col gap-8">
        {/* 1. Souhrn: na co si dát pozor, využití týmu a týdny */}
        <section aria-labelledby="warnings-heading" className="flex flex-col gap-4">
          <h2 id="warnings-heading" className="sr-only">Na co si dát pozor</h2>
          {warnings.length === 0 ? (
            <div className={`${CARD} flex flex-wrap items-center gap-3.5 px-5 py-3`}>
              <span className="chk done" aria-hidden="true">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              <b className="min-w-0 flex-1 basis-64 text-headline">Nikdo není přetížený a každá alokace v plánu má zástup s rezervou.</b>
              <span className="st done">V pořádku</span>
            </div>
          ) : (
            <div className="tile tile-sun !p-0">
              <p className="eyebrow m-0 px-5 pt-4 !text-[color:#39414D]">Na co si dát pozor · {warnings.length}</p>
              <ul className="m-0 list-none px-5 pb-2">
                {warnings.map((w, i) => {
                  const t = warningText(w, names, targetLabelOf, weeksByKey)
                  return (
                    <li key={i} className="flex flex-wrap items-start gap-2 border-b border-black/10 py-3 text-body last:border-0">
                      <Chip tone={t.tone}>{t.label}</Chip>
                      <span className="min-w-0 flex-1 text-ink">{t.text}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {members.length > 0 && (
            <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
              <Card title="Využití týmu" badge={<span className="st info">{formatHoursValue(totalHours)} h týdně</span>}>
                <CapacityGauge people={visualPeople} weeksCount={weeks.length} />
              </Card>
              <Card
                className="min-w-0"
                title={`Týdny ${weekLabel(weeks[0])} až ${weekLabel(weeks[weeks.length - 1])}`}
                badge={<span className="st info">Po až Pá, 1 tečka = půl dne</span>}
              >
                <CapacityDotMatrix people={visualPeople} weeks={weeks} currentWeekKey={currentWeekKey} />
              </Card>
            </div>
          )}
        </section>

        {/* 2. Seznam: plán po týdnech a alokace */}
        <section aria-labelledby="plan-heading" className="flex flex-col gap-4">
          <SectionHead
            id="plan-heading"
            title="Zatížení podle týdnů"
            sub={<>Naplánované hodiny / týdenní kapacita. Alokace, která začne nebo skončí uprostřed týdne, se počítá poměrem pracovních dnů (Po–Pá). {inPlan === 0 && 'V plánu zatím není žádná alokace.'}</>}
          />
          <CapacityGrid rows={gridRows} weeks={weeks} currentWeekKey={currentWeekKey} />
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card
              title="Alokace v plánu"
              badge={<span className="st info">{allocationCount(inPlanAllocations.length)}</span>}
            >
              <AllocationTiles
                allocations={inPlanAllocations}
                capacityOf={(id) => capacityById.get(id) ?? 40}
                colorIndexOf={(id) => colorIndexById.get(id) ?? 0}
              />
            </Card>
            <DeputiesCard summary={substitution} names={names} withSubstitute={withSubstitute} total={relevant.length} />
          </div>
        </section>

        <section aria-labelledby="allocations-heading" className="flex flex-col gap-4">
          <SectionHead id="allocations-heading" title="Alokace" sub="Kdo na čem pracuje, kolik hodin týdně a kdo ho zastoupí. Úpravu otevře odkaz v řádku.">
            <WorkSegNav
              label="Filtr alokací"
              items={[
                { href: hrefWith({ vse: false }), label: 'Aktuální a plánované', active: !showEnded },
                {
                  href: hrefWith({ vse: true }),
                  label: 'Včetně skončených',
                  active: showEnded,
                  count: endedCount !== null && endedCount > 0 ? endedCount : undefined,
                },
              ]}
            />
          </SectionHead>

          {editing && (
            <div id="upravit-alokaci" className="flex scroll-mt-6 flex-col gap-2">
              <h3 className="m-0 font-heading text-title2 font-bold">Upravit alokaci</h3>
              <AllocationEditForm
                key={editing.id}
                allocation={{
                  id: editing.id,
                  member_id: editing.member_id,
                  memberName: editing.memberName,
                  targetLabel: editing.target.label,
                  hours_per_week: editing.hours_per_week,
                  starts_on: editing.starts_on,
                  ends_on: editing.ends_on,
                  substitute_id: editing.substitute_id,
                  note: editing.note,
                }}
                members={people}
                closeHref={hrefWith({ vse: showEnded })}
              />
            </div>
          )}

          <AllocationTable
            rows={listed}
            showTarget
            editHref={(id) => `${hrefWith({ vse: showEnded, alokace: id })}#upravit-alokaci`}
            empty={showEnded ? 'Zatím žádné alokace.' : 'Žádné běžící ani naplánované alokace. Přidej první níže.'}
          />
        </section>

        {/* 3. Formulář: přidat alokaci */}
        <section aria-labelledby="pridat-alokaci" className="flex flex-col gap-4">
          <SectionHead id="pridat-alokaci" title="Přidat alokaci" sub="Člověk, práce (dodávka nebo případ), hodiny týdně a kdo ho zastoupí." />
          {members.length === 0 ? (
            <Notice title="V týmu zatím nikdo není" action={{ href: '/cockpit/tym', label: 'Otevřít tým' }}>
              Alokace půjde přidat, až bude v týmu aspoň jeden člověk.
            </Notice>
          ) : (
            <AllocationCreateForm
              members={people}
              targets={targets.filter((t) => t.active).map((t) => ({ key: t.key, kind: t.kind, label: t.label }))}
              today={today}
            />
          )}
        </section>

        {/* Podrobnosti a vzácná nastavení až na požádání */}
        <details className={`${CARD} group`}>
          <summary className="flex min-h-[56px] cursor-pointer list-none items-center gap-3 rounded-card px-5 py-3 [&::-webkit-details-marker]:hidden">
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
            <span className="min-w-0 flex-1">
              <span className="block font-heading text-title2 font-bold">Zastupitelnost a týdenní kapacita</span>
              <span className="block text-callout text-muted">Kdo koho zastupuje po lidech a kolik hodin týdně kdo má.</span>
            </span>
          </summary>
          <div className="flex flex-col gap-6 px-5 pb-5 pt-1">
            <section aria-labelledby="substitution-heading" className="flex flex-col gap-3">
              <div>
                <h2 id="substitution-heading" className="m-0 font-heading text-title2 font-bold">Zastupitelnost</h2>
                <p className="m-0 mt-1 text-callout text-muted">Z běžících a plánovaných alokací: kdo koho zastupuje a kde zástup chybí.</p>
              </div>
              <DataTable mobile="cards"
                label="Zastupitelnost"
                rows={substitution}
                empty="V týmu zatím nikdo není."
                columns={[
                  { header: 'Člověk', cell: (s) => names.get(s.memberId) ?? '—' },
                  { header: 'Kdo zastupuje', cell: (s) => (s.substitutes.length ? s.substitutes.map((id) => names.get(id) ?? '—').join(', ') : '—') },
                  { header: 'Koho zastupuje', cell: (s) => (s.substitutesFor.length ? s.substitutesFor.map((id) => names.get(id) ?? '—').join(', ') : '—') },
                  {
                    header: 'Bez zástupu',
                    cell: (s) => (s.withoutSubstitute > 0 ? <Chip tone="warn">{allocationCount(s.withoutSubstitute)}</Chip> : '—'),
                  },
                ]}
              />
            </section>

            <section aria-labelledby="capacity-heading" className="flex flex-col gap-3">
              <div>
                <h2 id="capacity-heading" className="m-0 font-heading text-title2 font-bold">Týdenní kapacita</h2>
                <p className="m-0 mt-1 text-callout text-muted">
                  Kolik hodin týdně má člověk na práci (0–80, výchozí 40). Kolegům ji mění vedení nebo admin, každý může
                  upravit svou.
                </p>
              </div>
              {!capacityColumn && (
                <p role="status" className="m-0 rounded-btn bg-[color:var(--c-warn-soft)] px-3 py-2 text-callout">
                  <FeaturePending variant="inline" migration="0062" title="Změna kapacity se připravuje. Zatím se počítá se 40 h pro každého." />
                </p>
              )}
              <DataTable mobile="cards"
                label="Týdenní kapacita"
                rows={plan}
                empty="V týmu zatím nikdo není."
                columns={[
                  { header: 'Člověk', cell: (p) => p.member.full_name },
                  {
                    header: 'Kapacita',
                    cell: (p) =>
                      capacityColumn && canSetCapacity(viewer, p.member.id) ? (
                        <CapacityForm memberId={p.member.id} memberName={p.member.full_name} current={p.capacity} />
                      ) : (
                        <span className="tabular-nums">{formatHoursValue(p.capacity)} h</span>
                      ),
                  },
                  {
                    header: 'Přetížené týdny',
                    cell: (p) => (p.overloadedWeeks > 0 ? <Chip tone="neg">{p.overloadedWeeks} z {PLAN_WEEKS}</Chip> : '—'),
                  },
                ]}
              />
            </section>
          </div>
        </details>
      </div>
    </>
  )
}
