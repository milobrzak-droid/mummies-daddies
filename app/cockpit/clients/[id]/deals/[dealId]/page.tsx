import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Chip, STAGE_CHIP_TONE } from '@/components/Chip'
import { DataTable } from '@/components/DataTable'
import { ActivityTimeline } from '@/components/ActivityTimeline'
import { DealsBar, DealsStageStrip, moneyParts } from '@/components/DealsVisuals'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ButtonLink, buttonClass } from '@/components/ui/Button'
import { DealsNextStep, DealsNextStepButton } from '@/components/DealsNextStep'
import { updateDealNextStep } from '@/domain/crm/actions/sales'
import { DealsDetailTabs, type DealDetailTab } from '@/components/DealsDetailTabs'
import { DealsOwnerCard } from '@/components/DealsOwnerCard'
import { OwnerChange } from '@/components/OwnerChange'
import { loadOwnerChangeContext } from '@/lib/queries/ownerChange'
import { canChangeOwner } from '@/lib/ownerChange'
import { DealsOfferCard, scopeLines } from '@/components/DealsOfferCard'
import { DealDeliveryCard } from '@/components/DealDeliveryCard'
import { isAutoDelivery, summarizeDealDeliveries } from '@/domain/delivery/autoDelivery'
import { formatCzk, formatDate, formatPct } from '@/lib/format'
import { defaultProbabilityForStage, dealKindLabel, dealStageLabel } from '@/lib/domain'
import { daysBetweenPragueDays, pragueDayOf, pragueToday } from '@/lib/pragueDate'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import {
  getDealForAccount, getDealPartnersWithNames, getEngagementsForDeal,
  getSalesActivitiesForDeal, getDealAuditHistory, summarizeAuditChange,
  type DealDetail,
} from '@/domain/crm/queries/dealDetail'
import { getDealScopeVersions } from '@/domain/crm/queries/scopeVersions'
import {
  SCOPE_VERSION_MISSING_MESSAGE, SCOPE_VERSION_STATUS_LABEL,
  draftDefaults, latestVersion, nextVersionNumber, scopeSendState, type ScopeVersionRow, type ScopeVersionStatus,
} from '@/domain/crm/scopeVersion'
import { NewScopeVersionForm, ScopeVersionButtons } from '@/components/ScopeVersionControls'
import { canPrintScopeVersion } from '@/domain/crm/offerPdfSource'
import { offerPdfHref } from '@/lib/export/href'
import { checkDealInvariant } from '@/domain/crm/dealInvariant'
import { OPEN_DEAL_STAGES, weightedValue } from '@/domain/crm/sales'

function formatMoney(v: number | string, currency: 'CZK' | 'EUR'): string {
  if (currency === 'CZK') return formatCzk(v)
  return `${Number(v).toLocaleString('cs-CZ', { maximumFractionDigits: 2 })} EUR`
}

// Nadpis oddílu uvnitř rozbalovacího bloku (Title 2).
const SECTION = 'm-0 mb-3 mt-6 font-heading text-title2 font-bold first:mt-0'
// Rozbalovací blok pod záložkami: partneři a historie až na požádání.
const DETAILS = 'group rounded-card border border-border bg-surface shadow-card'
const SUMMARY = 'flex min-h-[56px] cursor-pointer list-none items-center gap-3 px-5 py-3 [&::-webkit-details-marker]:hidden'

function followUpState(d: DealDetail): { label: string; tone: 'pos' | 'warn' | 'neg' | 'neutral' } {
  if (!d.next_step_due) return { label: 'Bez termínu', tone: 'neutral' }
  const today = pragueToday()
  if (d.next_step_due > today) return { label: 'V termínu', tone: 'pos' }
  if (d.last_activity_at && pragueDayOf(d.last_activity_at) >= d.next_step_due) {
    return { label: 'Proběhl', tone: 'pos' }
  }
  const days = daysBetweenPragueDays(d.next_step_due, today)
  return { label: days === 0 ? 'Termín dnes' : `Po termínu ${days} d`, tone: days === 0 ? 'warn' : 'neg' }
}

// Barva tečky u stavu verze nabídky (třída .st z globals.css).
const VERSION_ST: Record<ScopeVersionStatus, string> = {
  draft: '', sent: 'info', accepted: 'done', rejected: 'fail',
  superseded: 'idle',
}
const ACTIVITY_KIND: Record<string, string> = { call: 'Hovor', email: 'E-mail', meeting: 'Schůzka', note: 'Poznámka', other: 'Jiné' }
const OUTCOME_LABEL: Record<string, string> = {
  completed: 'Dokončeno', no_answer: 'Bez odpovědi', follow_up: 'Navázat', cancelled: 'Zrušeno', planned: 'Naplánováno',
}

export default async function DealDetailPage({ params, searchParams }: {
  params: Promise<{ id: string; dealId: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { id, dealId } = await params
  const { tab: tabParam } = await searchParams
  const accountId = Number(id)
  const deal = await getDealForAccount(accountId, Number(dealId))
  if (!deal) notFound()

  const [partners, engagements, canSeeSales, audit, ownerCtx] = await Promise.all([
    getDealPartnersWithNames(deal.id), getEngagementsForDeal(deal.id),
    canCurrentUserSeeSales(), getDealAuditHistory(deal.id, 20),
    loadOwnerChangeContext(),
  ])
  const [activities, scopeVersions] = canSeeSales
    ? await Promise.all([getSalesActivitiesForDeal(deal.id, 20), getDealScopeVersions(deal.id)])
    : [[], null]
  const fu = followUpState(deal)
  const isEur = deal.currency === 'EUR'
  const isOpen = (OPEN_DEAL_STAGES as string[]).includes(deal.stage)
  const violations = checkDealInvariant(deal)
  const missingStep = violations.includes('missing_next_step')
  const today = pragueToday()

  const probability = deal.probability_pct ?? defaultProbabilityForStage(deal.stage)
  const amount = Number(deal.amount_one_time ?? 0)
  const expected = weightedValue(deal)
  const big = moneyParts(amount)
  const daysLeft = isOpen && deal.expected_close ? daysBetweenPragueDays(today, deal.expected_close) : null

  const versions: ScopeVersionRow[] = scopeVersions?.state === 'ok'
    ? [...scopeVersions.versions].sort((a, b) => a.version - b.version)
    : []
  // Čekající žádosti o schválení odeslání (0084): u takové verze se neodesílá.
  const pendingSend = scopeVersions?.state === 'ok' ? scopeVersions.pendingSendVersionIds : []
  const latest = latestVersion(versions)
  const previous = latest ? [...versions].reverse().find((v) => v.version < latest.version) ?? null : null

  // Příležitost (0052). Před nasazením migrace sloupce chybí (undefined) —
  // záložka se pak nezobrazí vůbec.
  const hasOpportunity = deal.deal_kind !== undefined
  const opportunity: [string, React.ReactNode][] = [
    ['Problém', deal.problem || '—'],
    ['Očekávaný výsledek', deal.expected_outcome || '—'],
    ['Kdo rozhoduje', deal.decision_maker || '—'],
    ['Termín rozhodnutí', formatDate(deal.decision_due ?? null)],
    ['Rozhodovací proces', deal.decision_process || '—'],
    ['Zdroj odhadu hodnoty', deal.value_basis || '—'],
  ]
  const opportunityEmpty = opportunity.every(([, v]) => v === '—')

  // Záložky nesou hlavní obsah (příležitost, nabídky). Partneři, dodávky a
  // historie jsou pod <details> níž – staré odkazy ?tab=partneri / ?tab=historie
  // ten blok rovnou otevřou.
  const tabs: DealDetailTab[] = [
    ...(hasOpportunity ? [{ key: 'prilezitost', label: 'Příležitost' }] : []),
    ...(scopeVersions ? [{ key: 'nabidky', label: 'Nabídky' }] : []),
  ]
  const active = tabs.some((t) => t.key === tabParam)
    ? tabParam!
    : scopeVersions ? 'nabidky' : tabs[0]?.key ?? ''
  const base = `/cockpit/clients/${accountId}/deals/${deal.id}`
  const editHref = `${base}/edit`
  const clientName = deal.account?.name ?? 'Klient'

  const cellCls = 'rounded-full bg-[color:var(--c-soft)] px-3.5 py-2 text-footnote text-muted'
  const recent = activities.slice(0, 3)
  const nudges = [
    deal.follow_up_nudged_on ? `Připomenuto ${formatDate(deal.follow_up_nudged_on)}` : null,
    deal.follow_up_escalated_on ? `Eskalováno ${formatDate(deal.follow_up_escalated_on)}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <PageHeader
        title={deal.title}
        eyebrow="Obchod"
        back={{ href: `/cockpit/clients/${accountId}`, label: clientName }}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={STAGE_CHIP_TONE[deal.stage] ?? 'neutral'}>{dealStageLabel(deal.stage)}</Chip>
            {deal.deal_kind && <Chip tone="blue">Typ: {dealKindLabel(deal.deal_kind)}</Chip>}
            {deal.deal_kind === null && <Link href={editHref} className="text-footnote text-muted underline">Doplnit typ</Link>}
            {deal.status_blocker && <Chip tone="neg" dot>Blokováno</Chip>}
            {isOpen && missingStep && <Chip tone="warn" dot>Chybí další krok</Chip>}
            {isOpen && violations.includes('missing_owner') && <Chip tone="neg" dot>Bez vlastníka</Chip>}
          </span>
        }
      >
        <ButtonLink href={editHref} variant="outline">Upravit</ButtonLink>
        {isOpen && canSeeSales && <DealsNextStepButton />}
      </PageHeader>
      {deal.status_blocker && <p role="note" className="mb-4 rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-3 text-body text-neg">Blokace: {deal.status_blocker}</p>}

      {/* DALŠÍ KROK: úprava na místě (hlavní akce), bez přechodu na /edit */}
      {(isOpen || deal.next_step) && (
        <DealsNextStep
          dealId={deal.id}
          nextStep={deal.next_step}
          nextStepDue={deal.next_step_due}
          dueLabel={formatDate(deal.next_step_due)}
          followUp={fu}
          notes={nudges || undefined}
          overdue={fu.tone === 'neg'}
          missing={isOpen && missingStep}
          canEdit={canSeeSales && isOpen}
          updateNextStep={updateDealNextStep}
        />
      )}

      {/* DODÁVKA: po vyhrání se zakládá sama (0080), tlačítko jen jako záloha */}
      {deal.stage === 'vyhráno' && (
        <DealDeliveryCard accountId={accountId} dealId={deal.id} summary={summarizeDealDeliveries(engagements)} />
      )}

      {/* HODNOTA + POSTUP | SOUVISLOSTI (vlastník, poslední dění) – na mobilu pod sebou */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <div className="flex flex-wrap items-stretch gap-5">
              <div className="min-w-0 grow">
                <h2 className="eyebrow m-0">Hodnota obchodu</h2>
                <div className="big-num mt-2.5 text-[40px] md:text-[56px]">
                  {big.num}<small className="ml-2 font-heading text-title2 font-bold tracking-normal text-muted">{big.unit}</small>
                </div>
                {big.unit !== 'Kč' && <p className="m-0 mt-1 text-callout text-muted tabular-nums">{formatCzk(amount)}</p>}
              </div>
              <div className="flex w-full flex-col justify-center rounded-tile bg-[color:var(--c-soft)] px-4 py-3 md:w-[250px]">
                <span className="font-heading text-title1 font-bold tabular-nums">{formatCzk(expected)}</span>
                <p className="eyebrow m-0 mt-1">očekávaná hodnota (hodnota × šance)</p>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3.5">
              <span className="whitespace-nowrap text-callout font-semibold">Šance na výhru</span>
              <div className="grow"><DealsBar pct={probability} color="var(--d-orange)" label={`Šance na výhru ${probability} %`} thin={false} /></div>
              <b className="text-body tabular-nums">{probability} %</b>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {latest && <div className={cellCls}>Cena nabídky v{latest.version} <b className="ml-1 text-body text-ink tabular-nums">{formatMoney(latest.amount_one_time, latest.currency)}</b></div>}
              {Number(deal.expected_mrr ?? 0) > 0 && <div className={cellCls}>Měsíčně <b className="ml-1 text-body text-ink tabular-nums">{formatCzk(deal.expected_mrr)}</b></div>}
              <div className={cellCls}>Očekávané uzavření <b className="ml-1 text-body text-ink">{formatDate(deal.expected_close)}</b></div>
              {isEur && <div className={cellCls}>Měna <b className="ml-1 text-body text-ink">EUR {deal.amount_one_time_original ?? '—'} · kurz {deal.fx_rate ?? '—'}</b></div>}
            </div>
          </Card>

          <Card
            title="Postup obchodu"
            badge={
              <span className="flex flex-wrap items-center gap-2">
                {isOpen && <Chip tone="blue">Fáze {OPEN_DEAL_STAGES.indexOf(deal.stage) + 1} z {OPEN_DEAL_STAGES.length}</Chip>}
                {!isOpen && <Chip tone={STAGE_CHIP_TONE[deal.stage] ?? 'neutral'}>{dealStageLabel(deal.stage)}</Chip>}
                {daysLeft !== null && (
                  <Chip tone={daysLeft >= 0 ? 'neutral' : 'neg'}>
                    {daysLeft >= 0 ? `Zbývá ${daysLeft} ${daysLeft === 1 ? 'den' : daysLeft >= 2 && daysLeft <= 4 ? 'dny' : 'dní'}` : `Po termínu ${-daysLeft} d`}
                  </Chip>
                )}
              </span>
            }
          >
            <DealsStageStrip stage={deal.stage} />
            {deal.stage === 'prohráno' && deal.lost_reason && <p className="m-0 mt-3 text-callout text-muted">Důvod prohry: {deal.lost_reason}</p>}
          </Card>
        </div>

        <aside aria-label="Souvislosti" className="flex min-w-0 flex-col gap-4">
          <DealsOwnerCard
            name={deal.owner?.full_name ?? null}
            clientHref={`/cockpit/clients/${accountId}`}
            clientName={clientName}
            change={isOpen && canSeeSales ? (
              <OwnerChange
                kind="obchody"
                itemId={deal.id}
                itemLabel={deal.title}
                owner={{ id: deal.owner_id ?? null, name: deal.owner?.full_name ?? null }}
                members={ownerCtx.members}
                canChange={canChangeOwner('obchody', ownerCtx.actor, { ownerId: deal.owner_id ?? null })}
              />
            ) : undefined}
          />
          {canSeeSales && (
            <Card title="Poslední dění" href={`/cockpit/aktivity?account=${accountId}&deal=${deal.id}`} hrefLabel="Celá historie aktivit">
              {recent.length === 0 ? (
                <EmptyState compact title="Zatím žádná zaznamenaná aktivita." action={{ href: `/cockpit/aktivity?account=${accountId}&deal=${deal.id}`, label: 'Zapsat aktivitu' }} />
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {recent.map((a) => (
                    <li key={a.id} className="border-t border-[color:var(--c-line-2)] py-3 first:border-t-0 first:pt-0 last:pb-0">
                      <p className="eyebrow m-0">{ACTIVITY_KIND[a.kind] ?? a.kind}</p>
                      <b className="mt-0.5 block text-headline">{a.subject}</b>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <small className="text-footnote text-muted">{formatDate(a.occurred_at)}</small>
                        <span className={`st ${a.outcome === 'completed' ? 'done' : a.outcome === 'cancelled' ? 'fail' : ''}`}>{OUTCOME_LABEL[a.outcome] ?? a.outcome}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </aside>
      </div>

      {/* ZÁLOŽKY: příležitost a nabídky */}
      {tabs.length > 0 && (
        <div className="mt-8">
          <DealsDetailTabs base={base} tabs={tabs} active={active} />
        </div>
      )}

      {active === 'prilezitost' && hasOpportunity && (
        <div className="mt-4">
          {opportunityEmpty && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-card border border-dashed border-[color:var(--c-field-line)] bg-surface px-4 py-3">
              <span className="grow basis-56 text-callout font-semibold text-ink">Příležitost je zatím prázdná. Doplň, co se prodává.</span>
              <ButtonLink href={editHref} variant="outline" size="sm">Doplnit</ButtonLink>
            </div>
          )}
          <dl className="m-0 grid gap-3 sm:grid-cols-2">
            {opportunity.map(([k, v]) => (
              <div key={k} className="rounded-card border border-border bg-surface px-4 py-3 shadow-card">
                <dt className="eyebrow">{k}</dt>
                <dd className="m-0 mt-1 whitespace-pre-line text-body">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {active === 'nabidky' && scopeVersions && (
        <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card title="Verze nabídky">
            {scopeVersions.state === 'missing_migration' ? (
              <EmptyState compact title="Verze nabídky tu zatím nejsou">{SCOPE_VERSION_MISSING_MESSAGE}</EmptyState>
            ) : scopeVersions.state === 'error' ? (
              <EmptyState compact title="Verze nabídky se nepodařilo načíst.">Zkus stránku načíst znovu.</EmptyState>
            ) : (
              <>
                {versions.length === 0 ? (
                  <p className="m-0 mb-2 text-callout text-muted">Zatím žádná verze nabídky. Založ první verzi níže.</p>
                ) : (
                  <ul className="m-0 list-none p-0" aria-label="Verze nabídky">
                    {versions.map((v) => {
                      const first = scopeLines(v.scope)[0] ?? 'Rozsah nevyplněn'
                      return (
                        <li key={v.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-[color:var(--c-line-2)] py-3.5 first:border-t-0 first:pt-1">
                          <span className="tile grid h-[46px] w-[46px] shrink-0 place-items-center !p-0 font-bold">v{v.version}</span>
                          <div className="min-w-0 grow basis-52">
                            <b className="block text-headline">{first.length > 90 ? `${first.slice(0, 87)}…` : first}</b>
                            <small className="text-footnote text-muted">
                              {v.sent_at ? `odesláno ${formatDate(v.sent_at)}` : `založeno ${formatDate(v.created_at)}`}
                              {v.status === 'draft' && v.send_approved_at ? ` · schváleno k odeslání ${formatDate(v.send_approved_at)}` : ''}
                              {v.decided_at ? ` · rozhodnuto ${formatDate(v.decided_at)}` : ''}
                            </small>
                          </div>
                          <span className={`st ${VERSION_ST[v.status]}`}>{SCOPE_VERSION_STATUS_LABEL[v.status]}</span>
                          <b className="min-w-[110px] whitespace-nowrap text-right text-headline tabular-nums">{formatMoney(v.amount_one_time, v.currency)}</b>
                          <ScopeVersionButtons
                            accountId={accountId}
                            dealId={deal.id}
                            versionId={v.id}
                            version={v.version}
                            status={v.status}
                            sendState={scopeSendState(v, pendingSend)}
                          />
                          {canPrintScopeVersion(v) && (
                            // Obyčejný odkaz (ne next/link): GET se záznamem do auditu se nepřednačítá.
                            <a href={offerPdfHref(v.id)} download rel="nofollow" className={buttonClass('outline', 'sm')}
                              aria-label={`PDF nabídky pro zákazníka — verze ${v.version}`}>
                              PDF pro zákazníka
                            </a>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}

                {versions.length > 1 && versions.every((v) => v.currency === versions[0].currency) && (
                  <div className="mt-3 border-t border-border pt-3.5">
                    <p className="eyebrow mb-2.5">Cena podle verze</p>
                    <div className="flex flex-col gap-2.5">
                      {versions.map((v) => {
                        const max = Math.max(1, ...versions.map((x) => Number(x.amount_one_time)))
                        return (
                          <div key={v.id}>
                            <div className="mb-1 flex justify-between text-callout">
                              <span className="font-semibold">v{v.version} · {SCOPE_VERSION_STATUS_LABEL[v.status]}</span>
                              <b className="tabular-nums">{formatMoney(v.amount_one_time, v.currency)}</b>
                            </div>
                            <DealsBar pct={(Number(v.amount_one_time) / max) * 100} color="var(--d-graphite)" label={`Verze ${v.version}: ${formatMoney(v.amount_one_time, v.currency)}`} />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {versions.some((v) => scopeSendState(v, pendingSend) !== 'free') && (
                  <p className="m-0 mt-3 rounded-tile bg-[color:var(--c-soft)] px-4 py-3 text-callout text-muted">
                    Koncept jde označit jako odeslaný až po schválení jiným členem obchodu (čtyři oči). Cockpit nabídku
                    sám nikdy neodešle: po schválení dostane vlastník obchodu úkol ji poslat a pak ji tu označí jako odeslanou.
                  </p>
                )}

                <NewScopeVersionForm
                  accountId={accountId}
                  dealId={deal.id}
                  nextVersion={nextVersionNumber(scopeVersions.versions)}
                  defaults={draftDefaults(latestVersion(scopeVersions.versions), deal)}
                />
              </>
            )}
          </Card>
          <DealsOfferCard latest={latest} previous={previous} />
        </div>
      )}

      {/* PARTNEŘI, DODÁVKY, HISTORIE: až na požádání */}
      <div className="mt-8 flex flex-col gap-3">
        <details id="partneri" className={DETAILS} open={tabParam === 'partneri' || undefined}>
          <summary className={SUMMARY}>
            <Chevron />
            <span className="grow text-headline">Partneři a dodávky</span>
            <span className="text-footnote text-muted tabular-nums">{partners.length} {partners.length === 1 ? 'partner' : partners.length >= 2 && partners.length <= 4 ? 'partneři' : 'partnerů'} · {engagements.length} {engagements.length === 1 ? 'dodávka' : engagements.length >= 2 && engagements.length <= 4 ? 'dodávky' : 'dodávek'}</span>
          </summary>
          <div className="border-t border-[color:var(--c-line-2)] px-5 pb-5 pt-4">
            <h2 className={SECTION}>Partneři</h2>
            <DataTable mobile="cards" label="Partneři obchodu"
              rows={partners}
              empty="Žádní partneři."
              columns={[
                { header: 'Partner', cell: (p) => p.partner?.name ?? String(p.partner_id) },
                { header: 'Program', cell: (p) => p.program },
                { header: 'Atribuce', cell: (p) => formatPct(p.attribution_pct) },
                { header: 'Sourcing', cell: (p) => (p.is_sourcing ? 'Ano' : '—') },
              ]}
            />

            <h2 className={SECTION}>Dodávky</h2>
            <DataTable mobile="cards" label="Dodávky obchodu"
              rows={engagements}
              empty="K obchodu není navázaná žádná dodávka."
              columns={[
                { header: 'Druh', cell: (e) => <Link href={`/cockpit/clients/${accountId}/engagements/${e.id}/edit`}>{e.kind}</Link> },
                { header: 'Fáze', cell: (e) => <Chip>{e.phase}</Chip> },
                { header: 'Termín', cell: (e) => formatDate(e.due_on) },
                { header: 'Vznik', cell: (e) => (isAutoDelivery(e) ? 'Automaticky po vyhrání' : 'Ručně') },
              ]}
            />
          </div>
        </details>

        <details id="historie" className={DETAILS} open={tabParam === 'historie' || undefined}>
          <summary className={SUMMARY}>
            <Chevron />
            <span className="grow text-headline">Historie</span>
            <span className="text-footnote text-muted">{canSeeSales ? 'aktivity a změny' : 'změny'}</span>
          </summary>
          <div className="border-t border-[color:var(--c-line-2)] px-5 pb-5 pt-4">
            {canSeeSales && (
              <>
                <h2 className={SECTION}>Poslední aktivity</h2>
                <ActivityTimeline activities={activities} showAccount={false} />
              </>
            )}

            <h2 className={SECTION}>Historie změn</h2>
            {audit === null ? (
              <EmptyState compact title="Historie změn není dostupná." />
            ) : (
              <DataTable mobile="cards" label="Historie změn obchodu"
                rows={audit}
                empty="Zatím žádné zaznamenané změny."
                columns={[
                  { header: 'Kdy', cell: (a) => formatDate(a.occurred_at) },
                  { header: 'Akce', cell: (a) => a.action },
                  { header: 'Kdo', cell: (a) => a.actor_id ? `${a.actor_type}: ${a.actor_id}` : a.actor_type },
                  { header: 'Změna', cell: (a) => {
                    const lines = summarizeAuditChange(a.before, a.after)
                    return lines.length ? <ul className="m-0 p-0 list-none">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : '—'
                  } },
                ]}
              />
            )}
          </div>
        </details>
      </div>
    </>
  )
}

function Chevron() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted transition-transform duration-fast group-open:rotate-90">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}
