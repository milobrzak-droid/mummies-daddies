import { PageHeader } from '@/components/PageHeader'
import { FeaturePending } from '@/components/ui/FeaturePending'
import {
  ApprovalCard,
  CalmEmpty,
  DecisionHistory,
  DecisionKindFilter,
  QuestionCard,
  approvalKindLabel,
  type DecisionKind,
} from '@/components/DecisionCards'
import { decideApprovalRequest } from '@/core/actions/workCases'
import { retryApprovalExecution, snoozeApprovalRequest } from '@/core/actions/approvals'
import { getDecisionHistory } from '@/core/decisionHistory'
import { getDecisionInbox, getLoopNodes } from '@/core/loopQueries'
import { actorName, viewerCanDecide } from '@/core/workCaseFlow'
import { approvalConsequences, approvalTitle, isSnoozed, offerParams } from '@/core/approvalActions'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { ConnectorProposalsSection, loadConnectorProposals } from '@/components/ConnectorProposalsSection'
import { canApproveConnectorProposals } from '@/domain/crm/connectorProposals'
import { listAssignableMembers } from '@/domain/crm/queries/tasks'
import { getOfferApprovalTargets } from '@/domain/crm/queries/scopeVersions'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Anatomie (docs/PROVOZ.md §13): souhrn (segment s počty) → karty →
// historie. Jeden sloupec, ať se čte shora dolů jako fronta.

function parseKind(v: string | string[] | undefined): DecisionKind | null {
  const s = Array.isArray(v) ? v[0] : v
  return s === 'schvaleni' || s === 'otazky' ? s : null
}

const today = () =>
  new Intl.DateTimeFormat('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Prague' }).format(new Date())

export default async function DecisionInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ druh?: string | string[] }>
}) {
  const kind = parseKind((await searchParams).druh)
  const now = new Date()
  const [inbox, loopNodes, { user, member }, members, history] = await Promise.all([
    getDecisionInbox(now),
    getLoopNodes(),
    getCurrentMember(),
    listAssignableMembers(),
    getDecisionHistory(),
  ])
  const names = new Map(members.map((m) => [m.id, m.full_name]))
  // Návrhy zakázek z konektoru (Claude): jen obchodní role (RLS to hlídá i tak).
  const connector = memberSeesSales(member) ? await loadConnectorProposals() : null
  const viewer = user ? { id: user.id, teamRole: member?.role ?? null } : null

  const approvals = inbox.state === 'ok' ? inbox.approvals : []
  const decisions = inbox.state === 'ok' ? inbox.decisions : []
  // Nabídky k odeslání (0084): částky a obchod jen pro obchodní role (RLS sales_only).
  const offerIds = approvals.flatMap((a) => (a.action_type === 'send_offer' ? [offerParams(a.params)?.version_id ?? 0] : [])).filter(Boolean)
  const offers = memberSeesSales(member) ? await getOfferApprovalTargets(offerIds) : new Map()
  const waiting = approvals.length + decisions.length
  const snoozed = approvals.filter((a) => !a.expired && isSnoozed(a, now)).length
  const showApprovals = kind !== 'otazky'
  const showQuestions = kind !== 'schvaleni'
  const visible = (showApprovals ? approvals.length : 0) + (showQuestions ? decisions.length : 0)
  const waitingText = waiting === 1 ? '1 návrh čeká' : waiting < 5 ? `${waiting} návrhy čekají` : `${waiting} návrhů čeká`

  return (
    <>
      <PageHeader
        title="Ke schválení"
        eyebrow={today()}
        subtitle={
          inbox.state !== 'ok'
            ? 'Návrhy, které čekají na tvoje rozhodnutí, s důkazy.'
            : waiting === 0
              ? 'Nic nečeká. Nový návrh se ukáže tady.'
              : `${waitingText} na rozhodnutí${snoozed ? ` (odložené: ${snoozed})` : ''}. Nic se nezmění, dokud sám nerozhodneš.`
        }
      />
      {/* Návrhy zakázek z konektoru (Claude): jen obchodní role, schvaluje vedení/admin. */}
      {connector && (
        <div className="mb-6 max-w-[960px]">
          <ConnectorProposalsSection res={connector} canDecide={canApproveConnectorProposals(member)} />
        </div>
      )}
      {inbox.state === 'missing_migration' && (
        <FeaturePending card migration="0039">
          Pak se tu objeví čekající schválení a otevřené otázky.
        </FeaturePending>
      )}
      {inbox.state === 'error' && (
        <div className={CARD}>
          <EmptyState title="Návrhy ke schválení se nepodařilo načíst." action={{ href: '/cockpit/rozhodnuti', label: 'Zkusit znovu' }}>
            Zkus to prosím za chvíli.
          </EmptyState>
        </div>
      )}
      {inbox.state === 'ok' && (
        <div className="flex max-w-[960px] flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <DecisionKindFilter
              current={kind}
              counts={{ all: waiting, schvaleni: approvals.length, otazky: decisions.length }}
            />
            {snoozed > 0 && <span className="text-callout text-muted">Odložené: {snoozed}</span>}
          </div>
          <section aria-label="Čekající návrhy" className="flex min-w-0 flex-col gap-4">
            {visible === 0 && <CalmEmpty filtered={waiting > 0} />}
            {showApprovals &&
              approvals.map((a) => (
                <ApprovalCard
                  key={`a${a.id}`}
                  a={a}
                  requester={actorName(a.requested_by, names)}
                  canDecide={viewerCanDecide(a, viewer, loopNodes)}
                  action={decideApprovalRequest}
                  // Odložení na serveru jen s migrací 0084 (sloupec snoozed_until existuje).
                  snoozeAction={'snoozed_until' in a ? snoozeApprovalRequest : null}
                  title={approvalTitle(a, approvalKindLabel)}
                  consequences={approvalConsequences(a, names)}
                  offer={offers.get(offerParams(a.params)?.version_id ?? 0) ?? null}
                  snoozedByName={a.snoozed_by ? actorName(a.snoozed_by, names) : null}
                  now={now}
                />
              ))}
            {showQuestions && decisions.map((d) => <QuestionCard key={`d${d.id}`} d={d} />)}
          </section>
          <DecisionHistory items={history} names={names} retryAction={retryApprovalExecution} />
          <p className="m-0 text-footnote text-muted">
            Schválit nebo zamítnout může jen někdo jiný než žadatel (čtyři oči) s dostatečnou rolí: vedení
            a vlastník oblasti schválí cokoli, zástupce oblasti jen menší věci. Odeslání nabídky schvaluje jen
            člen s přístupem k obchodu a Cockpit ji ani po schválení sám neodešle.
          </p>
        </div>
      )}
    </>
  )
}
