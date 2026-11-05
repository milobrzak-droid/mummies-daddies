import Link from 'next/link'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { EngagementForm } from '@/components/EngagementForm'
import { ReferenceCardForm } from '@/components/ReferenceCardForm'
import { updateEngagement } from '@/domain/delivery/actions/engagements'
import { createReferenceCard } from '@/domain/delivery/actions/reference-cards'
import { getEngagement, getReferenceCards } from '@/domain/delivery/queries/engagements'
import { getEngagementDocuments } from '@/domain/delivery/queries/documents'
import { DataTable } from '@/components/DataTable'
import { DeliveryGates } from '@/components/DeliveryGates'
import { EngagementDocuments } from '@/components/EngagementDocuments'
import { MilestoneList, type MilestoneInvoicing } from '@/components/MilestoneList'
import { OwnerChange } from '@/components/OwnerChange'
import { clientOwnerContext, loadOwnerChangeContext } from '@/lib/queries/ownerChange'
import { canChangeOwner } from '@/lib/ownerChange'
import { getInvoicedMilestoneIds } from '@/domain/finance/queries/records'
import { HandoffPackage } from '@/components/HandoffPackage'
import { HandoffChecklistCard, type HandoffChecklistItem } from '@/components/HandoffChecklistCard'
import { getEngagementHandoff, getEngagementMilestones, getMilestoneAcceptedVersions } from '@/domain/delivery/queries/milestones'
import { getWaitingItems } from '@/domain/delivery/queries/waiting'
import { WaitingCard } from '@/components/ui/WaitingCard'
import { logError } from '@/lib/log'
import { buildHandoffPackage, HANDOFF_HINT, HANDOFF_ITEMS, validateHandoff } from '@/domain/delivery/milestone'
import { listTeamMembers } from '@/lib/queries/team'
import { getContacts } from '@/domain/crm/queries/accounts'
import { getDealsForAccount } from '@/domain/crm/queries/deals'
import { DEAL_STAGES } from '@/lib/domain'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getDealPublic, WON_DEAL_STAGE } from '@/lib/queries/dealPublic'
import { pragueToday } from '@/lib/pragueDate'
import { EngagementAllocations } from '@/components/EngagementAllocations'
import { getEngagementAllocations } from '@/domain/delivery/queries/capacity'
import { describeAllocations, targetKey } from '@/domain/delivery/capacity'
import { EngagementImpact } from '@/components/EngagementImpact'
import { EngagementOwnership } from '@/components/EngagementOwnership'
import { ReferenceConsent } from '@/components/ReferenceConsent'
import { getMetricObservations } from '@/domain/delivery/queries/impact'
import { ImpactPrimaryMetric } from '@/components/ImpactPrimaryMetric'
import { baselineMetricOk, defaultMetricKey, hasImpactSettings, primaryImpact } from '@/domain/delivery/impactMetric'
import { filesScopeEnabled } from '@/connectors/graph'
import { DOC_SYNC_CONNECTOR, docSyncEnabledFromEnv } from '@/domain/delivery/documentSyncConfig'
import { getConnectorState } from '@/core/connectorState'
import { getAccount } from '@/domain/crm/queries/accounts'
import { createClient } from '@/lib/supabase/server'
import { loadTeamCapacity } from '@/domain/delivery/queries/capacity'
import { EngagementTabs, parseEngagementTab, type EngagementTabKey } from '@/components/EngagementTabs'
import { EngagementImpactSummary } from '@/components/EngagementImpactSummary'
import { EngagementTeamSummary, buildTeamRows } from '@/components/EngagementTeamSummary'
import { GanttLegend, GanttMissingDue, WorkGantt, buildGantt } from '@/components/WorkGantt'
import { WorkLogo, WorkStatus } from '@/components/WorkUi'
import { buttonClass } from '@/components/ui/Button'
import { CARD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Avatar } from '@/components/Avatar'
import { daysBetweenPragueDays } from '@/lib/pragueDate'
import { deliveryPhaseLabel, engagementKindLabel } from '@/lib/domain'
import { formatDate } from '@/lib/format'

const tabIsDocuments = (z: string | string[] | undefined) => (Array.isArray(z) ? z[0] : z) === 'dokumenty'

const WON_LABEL = DEAL_STAGES.find((st) => st.key === WON_DEAL_STAGE)?.label ?? 'Vyhráno'

export default async function EditEngagement({ params, searchParams }: {
  params: Promise<{ id: string; engagementId: string }>
  searchParams: Promise<{ alokace?: string | string[]; zalozka?: string | string[] }>
}) {
  const { id, engagementId } = await params
  const { alokace, zalozka } = await searchParams
  const editAllocationId = Number(Array.isArray(alokace) ? alokace[0] : alokace)
  const accountId = Number(id)
  const engagement = await getEngagement(Number(engagementId))
  if (!engagement) notFound()
  const cards = engagement.reference_worthy ? await getReferenceCards(engagement.id) : []
  // Výběr schválené nabídky: obchodní role vidí fázi obchodu, ostatní jen
  // název a „vyhráno" z deal_public (0058) — bez částek a fáze.
  const canSeeSales = await canCurrentUserSeeSales()
  const [docsResult, milestonesResult, handoffResult, acceptedVersions, members, contacts, deals, invoicedResult, allocationsResult, impactResult, account, teamCapacity, waitingResult, ownerCtx] = await Promise.all([
    getEngagementDocuments(engagement.id),
    getEngagementMilestones(engagement.id),
    getEngagementHandoff(engagement.id),
    getMilestoneAcceptedVersions(engagement.id),
    listTeamMembers(),
    getContacts(accountId),
    canSeeSales
      ? getDealsForAccount(accountId).then((ds) => ds.map((d) => ({
          id: d.id,
          title: d.title,
          is_won: d.stage === WON_DEAL_STAGE,
          stageLabel: DEAL_STAGES.find((st) => st.key === d.stage)?.label ?? String(d.stage),
        })))
      : getDealPublic(accountId).then((ds) => ds.map((d) => ({
          id: d.id,
          title: d.title,
          is_won: d.is_won,
          stageLabel: d.is_won ? WON_LABEL : 'není vyhraný',
        }))),
    // Podklady k fakturaci (0063) — peníze jen pro obchodní role.
    canSeeSales ? getInvoicedMilestoneIds(engagement.id) : Promise.resolve(null),
    getEngagementAllocations(engagement.id),
    getMetricObservations(engagement.id),
    getAccount(accountId),
    createClient().then(loadTeamCapacity),
    // Hlídání čekání je pomocná karta: když selže, přehled dodávky se ukáže dál.
    getWaitingItems({ engagementId: engagement.id }).catch((e) => {
      logError('engagement.waiting', e)
      return { state: 'error' as const, message: 'nedostupné' }
    }),
    // Kdo smí měnit vlastníka a koho jde vybrat (0093); bez toho se tlačítko neukáže.
    loadOwnerChangeContext(),
  ])
  const invoicing: MilestoneInvoicing =
    invoicedResult === null || invoicedResult.state === 'error'
      ? { state: 'hidden' }
      : invoicedResult.state === 'missing_migration'
        ? { state: 'missing_migration' }
        : { state: 'ok', invoicedMilestoneIds: invoicedResult.ids }
  // Stav denní kontrola dokumentů: chyba (chybí oprávnění, token) se ukáže na záložce Dokumenty.
  const docWatchEnabled = docSyncEnabledFromEnv(process.env)
  const docSyncState = docWatchEnabled && tabIsDocuments(zalozka) ? await getConnectorState(DOC_SYNC_CONNECTOR).catch(() => null) : null
  const documents = docsResult.state === 'ok' ? docsResult.documents : []
  const milestones = milestonesResult.state === 'ok' ? milestonesResult.milestones : []
  const people = members.map((m) => ({ id: m.id, full_name: m.full_name }))
  const contactOptions = contacts.map((c) => ({ id: c.id, full_name: c.full_name }))
  const docOptions = documents.map((d) => ({ id: d.id, title: d.title }))
  const today = pragueToday()
  // Sloupce vlastnictví z 0061: select('*') je vrátí až po migraci.
  const ownershipAvailable = 'owner_id' in engagement
  const dealOptions = deals.map((d) => ({ id: d.id, title: d.title, stageLabel: d.stageLabel }))
  // Kdo na tom pracuje (kap. 10, 0062): cíl je vždy tahle dodávka.
  const allocationRows = allocationsResult.state === 'ok'
    ? describeAllocations(
        allocationsResult.allocations,
        new Map(people.map((p) => [p.id, p.full_name])),
        new Map([[targetKey({ engagement_id: engagement.id, work_case_id: null }), { label: 'tato dodávka', href: null }]]),
        today,
      )
    : []

  // Hlavní metrika dopadu (0088). Bez 0088 (chybí sloupce) platí pro předání
  // staré pravidlo a dopad ukazuje nejnovější úplné měření.
  const impactObservations = impactResult.state === 'ok' ? impactResult.observations : null
  const impactSettings = hasImpactSettings(engagement) && (impactResult.state !== 'ok' || impactResult.metricKeys) ? engagement : null
  const primary = impactSettings ? primaryImpact(impactSettings, impactObservations ?? []) : undefined
  const baselineOk = baselineMetricOk({
    kind: engagement.kind,
    settings: impactSettings,
    observations: impactObservations,
    baselineAdoptionPct: engagement.baseline_adoption_pct,
  })

  // Kontrolní seznam předání (kap. 6) — stejná skladba jako completeHandoff.
  const handoff = handoffResult.state === 'ok' ? handoffResult.handoff : null
  const linkedDeal = engagement.deal_id !== null ? deals.find((d) => d.id === engagement.deal_id) : undefined
  const pkg = buildHandoffPackage({
    goal: handoff?.goal ?? null,
    scope: handoff?.scope ?? null,
    deal_id: engagement.deal_id,
    deal_is_won: linkedDeal?.is_won ?? false,
    client_sponsor_contact_id: handoff?.client_sponsor_contact_id ?? null,
    started_on: engagement.started_on,
    due_on: engagement.due_on,
    baseline_ok: baselineOk,
    financial_frame: handoff?.financial_frame ?? null,
    risks: handoff?.risks ?? null,
    documentCount: documents.length,
    milestoneOwnerCount: milestones.filter((m) => m.owner_id !== null).length,
  })
  const missing = new Set(validateHandoff(pkg).missing)
  const checklist: HandoffChecklistItem[] = HANDOFF_ITEMS.map((i) => ({
    key: i.key,
    label: i.label,
    ok: !missing.has(i.key),
    hint: HANDOFF_HINT[i.key],
  }))
  const handoffByName = handoff?.handoff_by ? members.find((m) => m.id === handoff.handoff_by)?.full_name ?? null : null

  // ---- Hlavička: fáze, lidé, termíny ----
  const basePath = `/cockpit/clients/${accountId}/engagements/${engagement.id}/edit`
  const tabHref = (t: EngagementTabKey) => (t === 'prehled' ? basePath : `${basePath}?zalozka=${t}`)
  const hasAllocationParam = Number.isSafeInteger(editAllocationId) && editAllocationId > 0
  const tab = parseEngagementTab(zalozka, hasAllocationParam ? 'tym' : 'prehled')
  const title = linkedDeal?.title ?? engagementKindLabel(engagement.kind)
  const accountName = account?.name ?? '—'
  const personName = (id: string | null | undefined) => (id ? people.find((p) => p.id === id)?.full_name ?? null : null)
  const ownerName = personName(engagement.owner_id)
  const deputyName = personName(engagement.deputy_id)
  const closed = engagement.phase === 'uzavreno'
  const left = engagement.due_on ? daysBetweenPragueDays(today, engagement.due_on) : null
  const total = engagement.started_on && engagement.due_on ? daysBetweenPragueDays(engagement.started_on, engagement.due_on) : null
  const elapsed = engagement.started_on ? daysBetweenPragueDays(engagement.started_on, today) : null
  const progress = total !== null && total > 0 && elapsed !== null ? Math.max(0, Math.min(100, Math.round((elapsed / total) * 100))) : null
  const late = !closed && left !== null && left < 0
  const daysWord = (n: number) => (n === 1 ? 'den' : n >= 2 && n <= 4 ? 'dny' : 'dní')
  const remaining = closed
    ? 'Dodávka je uzavřená'
    : left === null
      ? 'Bez termínu předání'
      : left < 0
        ? `Po termínu o ${-left} ${daysWord(-left)}`
        : left === 0
          ? 'Termín předání je dnes'
          : `Zbývá ${left} ${daysWord(left)}`

  const gantt = milestonesResult.state === 'ok'
    ? buildGantt(milestonesResult.milestones, { startedOn: engagement.started_on, dueOn: engagement.due_on, today })
    : null
  const todayDay = Number(today.slice(8, 10))
  const teamRows = buildTeamRows({
    allocations: allocationRows,
    people,
    capacity: new Map(teamCapacity.ok ? teamCapacity.members.map((m) => [m.id, m.weekly_capacity_hours]) : []),
    ownerId: engagement.owner_id ?? null,
    deputyId: engagement.deputy_id ?? null,
  })
  const impactState = impactResult.state
  const observations = impactResult.state === 'ok' ? impactResult.observations : []

  const ganttCard = (
    <Card
      className="min-w-0"
      title="Časová osa dodávky"
      sub={gantt?.rangeLabel}
      href={tab === 'prehled' && gantt ? tabHref('milniky') : undefined}
      hrefLabel="Otevřít milníky"
    >
      {gantt ? (
        <>
          <WorkGantt model={gantt} todayDay={todayDay} />
          <GanttLegend />
          <GanttMissingDue model={gantt} href={tabHref('milniky')} />
        </>
      ) : milestonesResult.state === 'ok' ? (
        <EmptyState
          compact
          title="Zatím žádné milníky"
          action={tab === 'milniky' ? undefined : { href: tabHref('milniky'), label: 'Přidat milník' }}
        >
          Milníky rozdělí dodávku na kroky, které klient odsouhlasí.
        </EmptyState>
      ) : (
        <FeaturePending variant="compact" migration="0042">Pak tu půjde plánovat milníky dodávky.</FeaturePending>
      )}
    </Card>
  )

  const phaseLabel = deliveryPhaseLabel(engagement.phase)

  return (
    <>
      <PageHeader
        title={`Dodávka: ${title}`}
        eyebrow={`Práce · Dodávky · ${accountName}`}
        back={{ href: '/cockpit/dodavky', label: 'Dodávky' }}
        subtitle={`${engagementKindLabel(engagement.kind)} pro ${accountName}. ${remaining}${engagement.due_on && !closed ? ` (termín předání ${formatDate(engagement.due_on)})` : ''}.`}
      >
        <WorkStatus tone={closed ? 'done' : 'info'}>Fáze: {phaseLabel}</WorkStatus>
        {tab !== 'udaje' && (
          // Sekundární (grafit): koralová je na záložce jen jedna – hlavní krok
          // obsahu (Připomenout klientovi, Předat do realizace, Zapsat měření).
          <Link href={tabHref('udaje')} className={buttonClass('secondary')}>Upravit dodávku</Link>
        )}
      </PageHeader>

      <EngagementTabs basePath={basePath} current={tab} />

      {tab === 'prehled' && (
        <div className="flex flex-col gap-5">
          <section className={`${CARD} flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4`} aria-label="Klient, lidé a termíny">
            <dl className="m-0 flex flex-wrap items-center gap-x-8 gap-y-4">
              <div>
                <dt className="eyebrow">Klient</dt>
                <dd className="m-0 mt-1.5">
                  <Link href={`/cockpit/clients/${accountId}`} className="flex items-center gap-2 text-headline no-underline">
                    <WorkLogo name={accountName} size={28} />{accountName}
                  </Link>
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Vlastník</dt>
                <dd className="m-0 mt-1.5 flex items-center gap-2 text-headline">
                  {ownerName ? <><Avatar name={ownerName} size={28} />{ownerName}</> : <span className="font-semibold text-muted">nepřiřazen</span>}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Zástupce</dt>
                <dd className="m-0 mt-1.5 flex items-center gap-2 text-headline">
                  {deputyName ? <><Avatar name={deputyName} size={28} />{deputyName}</> : <span className="font-semibold text-muted">nepřiřazen</span>}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Zahájení</dt>
                <dd className="m-0 mt-1.5 text-headline tabular-nums">{formatDate(engagement.started_on)}</dd>
              </div>
              <div>
                <dt className="eyebrow">Termín předání</dt>
                <dd className="m-0 mt-1.5 text-headline tabular-nums">{formatDate(engagement.due_on)}</dd>
              </div>
            </dl>
            {ownershipAvailable && !closed && (
              <OwnerChange
                kind="dodavky"
                itemId={engagement.id}
                itemLabel={`dodávka ${title}`}
                owner={{ id: engagement.owner_id ?? null, name: ownerName }}
                deputy={{ id: engagement.deputy_id ?? null, name: deputyName }}
                members={ownerCtx.members}
                canChange={canChangeOwner('dodavky', ownerCtx.actor, { ownerId: engagement.owner_id ?? null, deputyId: engagement.deputy_id ?? null })}
                className="w-full sm:w-[300px]"
              />
            )}
            <div className="min-w-[200px] flex-1 sm:ml-auto sm:flex-none">
              <WorkStatus tone={late ? 'fail' : closed ? 'done' : 'info'}>{remaining}</WorkStatus>
              {progress !== null && !closed && (
                <div
                  className={`bar thin mt-2 ${late ? 'red' : 'green'}`}
                  role="img"
                  aria-label={`Uplynulo ${progress} % času od zahájení do termínu předání`}
                >
                  <i style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          </section>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
            {ganttCard}
            <Card title="Kontrola kvality">
              <DeliveryGates
                engagement={engagement}
                milestones={milestones.map((m) => ({ status: m.status, accepted_at: m.accepted_at }))}
              />
            </Card>
          </div>
          <WaitingCard result={waitingResult} scope="engagement" max={8} />
          <EngagementImpactSummary observations={observations} state={impactState} tabHref={tabHref('dopad')} primary={primary} />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px] items-start">
            <EngagementTeamSummary rows={teamRows} state={allocationsResult.state} tabHref={tabHref('tym')} />
            {handoffResult.state === 'ok' ? (
              <HandoffChecklistCard
                items={checklist}
                completedLabel={
                  handoffResult.handoff.handoff_completed_at
                    ? `Předáno do realizace ${formatDate(handoffResult.handoff.handoff_completed_at)}${handoffByName ? ` · ${handoffByName}` : ''}`
                    : null
                }
                action={<Link href={tabHref('predani')} className="inline-flex min-h-[44px] items-center text-callout font-bold text-white underline underline-offset-2 hover:!text-white">Otevřít předání</Link>}
              />
            ) : (
              <Card title="Předání">
                {handoffResult.state === 'missing_migration' ? (
                  <FeaturePending variant="compact" migration="0054">Pak tu půjde připravit předání do realizace.</FeaturePending>
                ) : (
                  <EmptyState compact title="Předání ještě není dostupné">Nepodařilo se načíst. Zkus to prosím později.</EmptyState>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'milniky' && (
        <div className="flex flex-col gap-5">
          {ganttCard}
          <MilestoneList
            accountId={accountId}
            engagementId={engagement.id}
            members={people}
            contacts={contactOptions}
            documents={documents}
            today={today}
            invoicing={invoicing}
            ownerContext={clientOwnerContext(ownerCtx)}
            acceptedVersions={acceptedVersions}
            {...(milestonesResult.state === 'ok'
              ? { state: 'ok', milestones: milestonesResult.milestones }
              : { state: milestonesResult.state })}
          />
        </div>
      )}

      {tab === 'predani' && (
        <HandoffPackage
          accountId={accountId}
          engagementId={engagement.id}
          checklist={checklist}
          contacts={contactOptions}
          deals={dealOptions}
          dealId={engagement.deal_id}
          handoffByName={handoffByName}
          {...(handoffResult.state === 'ok'
            ? { state: 'ok', handoff: handoffResult.handoff }
            : { state: handoffResult.state })}
        />
      )}

      {tab === 'tym' && (
        <div className="flex flex-col gap-5">
          <EngagementTeamSummary rows={teamRows} state={allocationsResult.state} />
          <h2 id="kdo-na-tom-pracuje" className="m-0 scroll-mt-6 font-heading text-title1 font-bold">Kdo na tom pracuje</h2>
          <EngagementAllocations
            accountId={accountId}
            engagementId={engagement.id}
            members={people}
            today={today}
            editId={hasAllocationParam ? editAllocationId : null}
            {...(allocationsResult.state === 'ok'
              ? { state: 'ok', allocations: allocationRows }
              : { state: allocationsResult.state })}
          />
          <h2 className="m-0 font-heading text-title1 font-bold">Vlastnictví</h2>
          <EngagementOwnership
            accountId={accountId}
            engagementId={engagement.id}
            members={people}
            ownerId={engagement.owner_id ?? null}
            deputyId={engagement.deputy_id ?? null}
            deliveryTeam={engagement.delivery_team ?? null}
            available={ownershipAvailable}
            ownerContext={clientOwnerContext(ownerCtx)}
            closed={closed}
          />
        </div>
      )}

      {tab === 'dopad' && (
        <div className="flex flex-col gap-5">
          {primary && impactState === 'ok' ? (
            <ImpactPrimaryMetric
              accountId={accountId}
              engagementId={engagement.id}
              primary={primary}
              kindLabel={engagementKindLabel(engagement.kind)}
              defaultKey={defaultMetricKey(engagement.kind)}
              documents={docOptions}
              today={today}
              unmeasurableByName={personName(primary.unmeasurable?.by)}
            />
          ) : (
            <EngagementImpactSummary observations={observations} state={impactState} />
          )}
          <EngagementImpact
            accountId={accountId}
            engagementId={engagement.id}
            documents={docOptions}
            today={today}
            primaryKey={primary?.metric.key ?? null}
            {...(impactResult.state === 'ok'
              ? { state: 'ok', observations: impactResult.observations }
              : { state: impactResult.state })}
          />
        </div>
      )}

      {tab === 'dokumenty' && (
        <EngagementDocuments
          accountId={accountId}
          engagementId={engagement.id}
          milestones={milestones.map((m) => ({ id: m.id, title: m.title }))}
          metadataEnabled={filesScopeEnabled()}
          watchEnabled={docWatchEnabled}
          syncProblem={docSyncState && docSyncState.consecutive_errors > 0 ? docSyncState.last_error : null}
          memberNames={Object.fromEntries(people.map((p) => [p.id, p.full_name ?? 'člen týmu']))}
          {...(docsResult.state === 'ok'
            ? { state: 'ok', documents: docsResult.documents }
            : { state: docsResult.state })}
        />
      )}

      {tab === 'udaje' && (
        <div className="flex flex-col gap-5">
          <Card title="Údaje dodávky" sub="Druh, fáze, termíny a navázaný obchod.">
            <EngagementForm action={updateEngagement.bind(null, accountId, engagement.id)} initial={engagement} />
          </Card>
          {engagement.reference_worthy && (
            <Card title="Referenční karty">
              <DataTable mobile="cards" label="Referenční karty"
                rows={cards}
                empty="Zatím žádná referenční karta."
                columns={[
                  { header: 'Titulek', cell: (c) => c.headline ?? '—' },
                  { header: 'Schváleno', cell: (c) => (c.approved_public ? 'Ano' : '—') },
                  { header: 'Souhlas doložen', cell: (c) => (c.consent_at ? new Date(c.consent_at).toLocaleDateString('cs-CZ') : '—') },
                  { header: 'MS anchor', cell: (c) => (c.is_ms_anchor ? 'Ano' : '—') },
                ]}
              />
              {cards.length > 0 && (
                <div className="flex flex-col gap-3 my-4">
                  {cards.map((c) => (
                    <ReferenceConsent key={c.id} accountId={accountId} engagementId={engagement.id} card={c} documents={docOptions} today={today} />
                  ))}
                </div>
              )}
              <ReferenceCardForm action={createReferenceCard.bind(null, accountId, engagement.id)} />
            </Card>
          )}
        </div>
      )}
    </>
  )
}
