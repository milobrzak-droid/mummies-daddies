import { notFound, redirect } from 'next/navigation'
import { FeaturePending } from '@/components/ui/FeaturePending'
import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { DealsSectionTabs } from '@/components/DealsSectionTabs'
import { Card, CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { buttonClass } from '@/components/ui/Button'
import { DealsSegmentedBar } from '@/components/DealsVisuals'
import { targetStatusParts } from '@/components/DealsTargetParts'
import { countByStatus } from '@/domain/crm/targetLists'
import { DataTable } from '@/components/DataTable'
import { Chip } from '@/components/Chip'
import { TargetListItemForm } from '@/components/TargetListItemForm'
import { TargetListStatusButtons } from '@/components/TargetListStatusButtons'
import { TargetSegmentSuggestButton } from '@/components/TargetSegmentSuggestButton'
import { getTargetList, type TargetListItem } from '@/domain/crm/queries/targetLists'
import { TARGET_STATUS_LABEL, targetEntityId, type TargetStatus } from '@/domain/crm/targetLists'
import { describeSegmentRule, segmentRuleFor } from '@/domain/crm/targetSegments'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { OwnerChange } from '@/components/OwnerChange'
import { loadOwnerChangeContext } from '@/lib/queries/ownerChange'
import { canChangeOwner } from '@/lib/ownerChange'
import { DoNotContactChip } from '@/components/DoNotContactChip'
import { accountFullyOptedOut, accountHasOptOut, type AccountOptOut } from '@/domain/crm/outreachContacts'

export const dynamic = 'force-dynamic'

const TONE: Record<TargetStatus, string> = { navrzeno: 'neutral', osloveno: 'info', odpovedel: 'pos', vyrazeno: 'neutral' }
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString('cs-CZ') : '—')

// Štítek u firmy: nesouhlasí všichni (nebo poznámka firmy) = bez doplňku,
// jinak kolik lidí z kolika.
function AccountOptOutChip({ s }: { s: AccountOptOut | null }) {
  if (!accountHasOptOut(s)) return null
  if (accountFullyOptedOut(s)) {
    return <DoNotContactChip title={s!.account_note ? 'Poznámka u firmy zakazuje oslovení.' : 'Nesouhlasí všichni lidé u firmy.'} />
  }
  return <DoNotContactChip detail={`${s!.opted_out} z ${s!.total}`} title="Někdo z lidí u firmy nesouhlasí s oslovením — jeho neoslovujte." />
}

const BACK = { href: '/cockpit/cilove-seznamy', label: 'Seznamy k oslovení' }

export default async function TargetListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const { id: raw } = await params
  const id = Number(raw)
  if (!targetEntityId.safeParse(id).success) notFound()
  const [res, ownerCtx] = await Promise.all([getTargetList(id), loadOwnerChangeContext()])

  if (res.state === 'missing_migration') {
    return (
      <>
        <PageHeader title="Cílový seznam" eyebrow="Seznam k oslovení" back={BACK} />
        <DealsSectionTabs />
        <FeaturePending card migration="0048">Pak se tu zobrazí firmy v seznamu.</FeaturePending>
      </>
    )
  }
  if (res.state === 'error') {
    return (
      <>
        <PageHeader title="Cílový seznam" eyebrow="Seznam k oslovení" back={BACK} />
        <DealsSectionTabs />
        <div className={CARD}>
          <EmptyState title="Seznam se nepodařilo načíst." action={{ href: `/cockpit/cilove-seznamy/${id}`, label: 'Zkusit znovu' }}>
            Může jít o chvilkový výpadek spojení.
          </EmptyState>
        </div>
      </>
    )
  }
  if (!res.list) notFound()
  // Firmu a kontakt si formulář hledá sám (AccountPicker) — žádné celé seznamy.
  const list = res.list
  const segmentRule = segmentRuleFor(list.segment)
  const counts = countByStatus(res.items)

  const firms = counts.total === 1 ? 'firma' : counts.total >= 2 && counts.total <= 4 ? 'firmy' : 'firem'

  return (
    <>
      <PageHeader title={list.name} eyebrow="Seznam k oslovení" subtitle={`Segment: ${list.segment}`} back={BACK}>
        <a href="#pridat-firmu" className={buttonClass('primary')}>Přidat firmu</a>
      </PageHeader>
      <DealsSectionTabs />
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card title="Stav firem" sub={`${counts.total} ${firms} v seznamu`}>
            <DealsSegmentedBar parts={targetStatusParts(counts)} />
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-2 p-0">
              {targetStatusParts(counts).map((p) => (
                <li key={p.label} className="st tabular-nums">{p.label}: {p.value}</li>
              ))}
            </ul>
          </Card>
          <Card title="Proč tenhle seznam">
            <dl className="m-0 grid gap-2 text-body">
              <div><dt className="eyebrow">Proč oslovit</dt><dd className="m-0 mt-0.5">{list.rationale}</dd></div>
              <div><dt className="eyebrow">Hypotéza hodnoty</dt><dd className="m-0 mt-0.5">{list.value_hypothesis ?? '—'}</dd></div>
              <div>
                <dt className="eyebrow">Vlastník seznamu</dt>
                <dd className="m-0 mt-0.5">{ownerCtx.nameOf(list.owner_id) ?? 'nikdo'}</dd>
                <dd className="m-0 mt-1.5">
                  <OwnerChange
                    kind="seznamy"
                    itemId={list.id}
                    itemLabel={list.name}
                    owner={{ id: list.owner_id, name: ownerCtx.nameOf(list.owner_id) }}
                    members={ownerCtx.members}
                    canChange={canChangeOwner('seznamy', ownerCtx.actor, { ownerId: list.owner_id })}
                  />
                </dd>
              </div>
            </dl>
            <p className="m-0 mt-3 text-callout text-muted">
              Označení firmy jako „Osloveno“ zapíše na firmu aktivitu (první oslovení). Obchod se tím nezakládá —
              ten vzniká až ze skutečné poptávky na tabuli obchodů.
            </p>
          </Card>
        </div>
        <section aria-labelledby="firmy-v-seznamu">
          <h2 id="firmy-v-seznamu" className="m-0 mb-3 font-heading text-title2 font-bold">Firmy v seznamu</h2>
          <DataTable<TargetListItem> mobile="cards" label="Firmy v cílovém seznamu"
            empty="V seznamu zatím nejsou žádné firmy. Přidej první níže, nebo nech navrhnout firmy podle segmentu."
            rows={res.items}
            columns={[
              {
                header: 'Firma',
                cell: (r) => (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <Link href={`/cockpit/clients/${r.account_id}`}>{r.account?.name ?? `#${r.account_id}`}</Link>
                    <AccountOptOutChip s={r.account_opt_out} />
                  </span>
                ),
              },
              { header: 'Důvod', cell: (r) => r.reason },
              {
                header: 'Koho',
                cell: (r) => (r.contact ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span>{r.contact.full_name}</span>
                    {r.contact_opt_out && (
                      <DoNotContactChip
                        detail={r.contact_opt_out === 'note' ? 'podle poznámky' : undefined}
                        title="Tenhle člověk nesouhlasí s oslovením — vyberte jiný kontakt, nebo firmu vyřaďte."
                      />
                    )}
                  </span>
                ) : '—'),
              },
              { header: 'Další krok', cell: (r) => (r.next_step ? `${r.next_step} (${fmtDate(r.next_step_due)})` : '—') },
              { header: 'Stav', cell: (r) => <Chip tone={TONE[r.status]}>{TARGET_STATUS_LABEL[r.status]}</Chip> },
              {
                header: 'Změnit',
                cell: (r) => (
                  <TargetListStatusButtons
                    itemId={r.id}
                    status={r.status}
                    itemLabel={r.account?.name ?? `#${r.account_id}`}
                  />
                ),
              },
            ]}
          />
        </section>
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <section id="pridat-firmu" aria-labelledby="pridat-firmu-h" className="scroll-mt-24">
            <h2 id="pridat-firmu-h" className="m-0 mb-3 font-heading text-title2 font-bold">Přidat firmu</h2>
            <TargetListItemForm listId={list.id} />
          </section>
          <Card title="Návrhy podle segmentu" headingLevel={2} className="lg:mt-9">
            {segmentRule ? (
              <div className="space-y-3 text-body">
                <dl className="m-0 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
                  {describeSegmentRule(segmentRule.key, segmentRule.rule).map((line) => (
                    <div key={line.term} className="contents">
                      <dt className="text-muted">{line.term}:</dt>
                      <dd className="m-0">{line.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="m-0 text-callout text-muted">
                  Firmy se přidají jako „Navrženo“ s důvodem z pravidla. Oslovit nebo vyřadit je musí člověk.
                </p>
                <TargetSegmentSuggestButton listId={list.id} />
              </div>
            ) : (
              <p className="m-0 text-callout text-muted">
                Segment „{list.segment}“ zatím nemá pravidlo pro automatické návrhy, proto tu tlačítko
                „Navrhnout firmy podle segmentu“ není. Pravidla se přidávají v konfiguraci firmy —
                soubor <code>config/mummiesDaddies.ts</code>, položka <code>targetSegments</code>; klíč pravidla musí
                odpovídat segmentu seznamu.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
