import { PageHeader } from '@/components/PageHeader'
import { WorkCaseCreateForm } from '@/components/WorkCaseForms'
import { MigrationPendingNotice, WorkCaseNotice } from '@/components/WorkCaseNotice'
import { createWorkCase } from '@/core/actions/workCases'
import { getLoopNodesResult, listCaseDealOptions } from '@/core/loopQueries'
import { NODES, isNode } from '@/core/workCase'
import { CASE_TEMPLATES, NODE_LABELS, findTemplate } from '@/core/workCaseFlow'
import { getAccountOption } from '@/domain/crm/queries/accounts'
import { listAssignableMembers } from '@/domain/crm/queries/tasks'

const posInt = (v: string | undefined) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

export default async function NewWorkCasePage({
  searchParams,
}: { searchParams: Promise<{ node?: string; account?: string; deal?: string; template?: string }> }) {
  const sp = await searchParams
  const nodesRes = await getLoopNodesResult()

  if (nodesRes.state !== 'ok') {
    return (
      <>
        <PageHeader title="Nový případ" eyebrow="Práce · Případy" back={{ href: '/cockpit/pripady', label: 'Případy' }} />
        {nodesRes.state === 'missing_migration' ? (
          <MigrationPendingNotice />
        ) : (
          <WorkCaseNotice>Formulář se nepodařilo načíst. Zkuste to prosím později.</WorkCaseNotice>
        )}
      </>
    )
  }

  // Obchody jen pro toho, kdo vidí Byznys (listCaseDealOptions to ověří sám).
  // Klient se ve formuláři hledá — načte se jen ten předvybraný z URL.
  const [members, account, deals] = await Promise.all([listAssignableMembers(), getAccountOption(posInt(sp.account)), listCaseDealOptions()])
  const dealFromUrl = posInt(sp.deal)
  const template = findTemplate(sp.template)
  const node = isNode(sp.node) ? sp.node : (template?.suggestedNode ?? NODES[0])

  return (
    <>
      <PageHeader
        title="Nový případ"
        eyebrow="Práce · Případy"
        back={{ href: '/cockpit/pripady', label: 'Případy' }}
        subtitle="Každý případ má jednu oblast a jednoho vlastníka. Šablona předvyplní kroky."
      />
      <div className="max-w-2xl">
        <WorkCaseCreateForm
          action={createWorkCase}
          nodes={NODES.map((n) => ({
            value: n,
            label: NODE_LABELS[n],
            ownerId: nodesRes.nodes.find((r) => r.node === n)?.owner_id ?? null,
          }))}
          templates={CASE_TEMPLATES.map((t) => ({ id: t.id, label: t.label, suggestedNode: t.suggestedNode, steps: t.steps }))}
          members={members.map((m) => ({ id: m.id, full_name: m.full_name }))}
          deals={deals}
          initial={{ node, account, dealId: dealFromUrl && deals.some((d) => d.id === dealFromUrl) ? dealFromUrl : null, template: template?.id ?? '' }}
        />
      </div>
    </>
  )
}
