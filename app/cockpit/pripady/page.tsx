import Link from 'next/link'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, WORK_TABS } from '@/components/SectionTabs'
import { DataTable } from '@/components/DataTable'
import { NodeTiles, WorkCaseBoard } from '@/components/WorkCaseBoard'
import { WorkSegNav, WorkStatus } from '@/components/WorkUi'
import { buttonClass } from '@/components/ui/Button'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Chip } from '@/components/Chip'
import { ProposalDecideButtons } from '@/components/ProposalDecideButtons'
import { MailQueueCard } from '@/components/MailQueueCard'
import { MigrationPendingNotice, WorkCaseNotice } from '@/components/WorkCaseNotice'
import { decideCaseProposal } from '@/core/actions/caseProposals'
import { proposalMethodLabel } from '@/core/agents/caseProposal'
import {
  countPendingProposals,
  listPendingProposals,
  listWorkCases,
  type CaseProposalItem,
  type WorkCaseListItem,
} from '@/core/loopQueries'
import { CASE_STATUSES } from '@/core/workCase'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { isMailContentCapability } from '@/domain/crm/mailContent'
import {
  getMailContentStats,
  getMailProposalEvidence,
  listQueuedMail,
  type MailProposalEvidence,
} from '@/domain/crm/queries/mailContent'
import { CASE_STATUS_LABELS, caseStatusLabel, nodeLabel, parseCaseFilter, type CaseFilter } from '@/core/workCaseFlow'
import { safeExternalHref, EXTERNAL_LINK_REL } from '@/core/untrusted'

const STATUS_TONE: Record<string, 'wait' | 'done' | 'fail' | 'info' | 'idle'> = {
  open: 'idle', in_progress: 'info', waiting: 'wait', done: 'done', cancelled: 'idle',
}

type SearchParams = { node?: string | string[]; status?: string | string[]; view?: string | string[]; zobrazeni?: string | string[] }

const PROPOSALS_VIEW = 'navrhy'
const MAIL_VIEW = 'posta'
const fmt = (iso: string) => new Date(iso).toLocaleDateString('cs-CZ')

type Mode = 'nastenka' | 'seznam'

function hrefFor(f: CaseFilter, mode: Mode): string {
  const p = new URLSearchParams()
  if (f.node) p.set('node', f.node)
  if (f.status !== 'active') p.set('status', f.status)
  if (mode === 'seznam') p.set('zobrazeni', 'seznam')
  const q = p.toString()
  return q ? `/cockpit/pripady?${q}` : '/cockpit/pripady'
}

// Návrhy případů od schopností Loop Core (kapitola 11): čekají na člověka.
// `mailEvidence`: úryvky ze zpráv ze složky „Cockpit" (jen obchodní role, jiným
// RLS nevrátí nic a návrh se ukáže bez citace).
function ProposalList({ proposals, mailEvidence }: { proposals: CaseProposalItem[]; mailEvidence: Map<number, MailProposalEvidence> }) {
  if (proposals.length === 0) {
    return (
      <div className={CARD}>
        <EmptyState tone="calm" title="Žádné návrhy nečekají na rozhodnutí">
          Návrhy případů z příchozích e-mailů a zápisů schůzek se objeví tady.
        </EmptyState>
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-3">
      {proposals.map((p) => (
        <li key={p.id} className="tile tile-sun flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5 min-w-0 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 text-headline text-ink">{p.title}</h2>
              <Chip tone="warn">{proposalMethodLabel(p.method)}</Chip>
              <Chip tone="blue">{nodeLabel(p.node)}</Chip>
            </div>
            <p className="m-0 text-body text-ink">{p.rationale}</p>
            {mailEvidence.get(p.id)?.excerpt && (
              <blockquote className="m-0 border-l-2 border-border pl-3 text-callout text-ink">
                <span className="eyebrow block">Úryvek ze zprávy (vidí vedení a obchod)</span>
                <span className="whitespace-pre-wrap">{mailEvidence.get(p.id)?.excerpt}</span>
              </blockquote>
            )}
            <p className="m-0 text-footnote text-muted">
              {p.account_id && p.account_name ? <Link href={`/cockpit/clients/${p.account_id}`}>{p.account_name}</Link> : 'Firma neuvedena'}
              {' · '}zpráva {fmt(p.occurred_at)}
              {safeExternalHref(p.evidence_link) ? (
                <>
                  {' · '}
                  <a href={safeExternalHref(p.evidence_link)!} target="_blank" rel={EXTERNAL_LINK_REL}>Doklad: zpráva v Outlooku</a>
                </>
              ) : (
                ' · doklad uložený v evidenci'
              )}
            </p>
          </div>
          <ProposalDecideButtons action={decideCaseProposal} proposalId={p.id} label={p.title} />
        </li>
      ))}
    </ul>
  )
}

async function ProposalsView() {
  const res = await listPendingProposals()
  if (res.state === 'missing_migration') {
    return (
      <FeaturePending card migration="0067">
        Pak sem budou chodit návrhy případů z příchozích e-mailů k přijetí.
      </FeaturePending>
    )
  }
  if (res.state === 'error') return <WorkCaseNotice>Návrhy se nepodařilo načíst. Zkus to prosím později.</WorkCaseNotice>
  // Úryvky jen u návrhů z pošty; dotaz vůbec neběží, když žádný takový není.
  const mailIds = res.proposals.filter((p) => isMailContentCapability(p.capability)).map((p) => p.id)
  const mailEvidence = await getMailProposalEvidence(mailIds)
  return <ProposalList proposals={res.proposals} mailEvidence={mailEvidence} />
}

// Fronta „Pošta k zařazení": zprávy ze složky „Cockpit" (docs/PROVOZ.md),
// které Cockpit nedokázal jistě přiřadit ke klientovi nebo dodávce. Jen obchodní
// role (obsah pošty klientů je obchodní data, RLS 0091).
async function MailQueueView() {
  let queue: Awaited<ReturnType<typeof listQueuedMail>>
  try {
    queue = await listQueuedMail(50)
  } catch {
    return <WorkCaseNotice>Poštu k zařazení se nepodařilo načíst. Zkus to prosím později.</WorkCaseNotice>
  }
  if (queue.length === 0) {
    return (
      <div className={CARD}>
        <EmptyState tone="calm" title="Žádná pošta k zařazení" action={{ href: '/cockpit/pripady?view=navrhy', label: 'Otevřít návrhy' }}>
          Zprávy, které přesuneš v Outlooku do složky Cockpit, se čtou ráno. Co Cockpit nezařadí sám, čeká tady.
        </EmptyState>
      </div>
    )
  }
  return (
    <>
      <p className="m-0 max-w-2xl text-callout text-muted">
        Cockpit z těchto zpráv uložil jen předmět, krátký úryvek a názvy příloh, celé tělo ne. Po přiřazení vznikne
        návrh v <Link href="/cockpit/pripady?view=navrhy" className="underline">Návrzích</Link>; nic se nezmění, dokud ho nepřijmeš.
        Zahozená zpráva se smaže včetně úryvku. Zpráva s nabídkou v příloze ukazuje návrh zakázky (klient, cena z PDF):
        zkontroluj ho a potvrď, teprve pak vznikne klient a obchod.
      </p>
      <ul className="m-0 list-none space-y-4 p-0">
        {queue.map((m) => <MailQueueCard key={m.id} mail={m} />)}
      </ul>
    </>
  )
}

export default async function WorkCasesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const viewParam = Array.isArray(sp.view) ? sp.view[0] : sp.view
  // Poštu s obsahem vidí jen obchodní role (obsah zpráv klientů je obchodní data).
  const canSeeMail = await canCurrentUserSeeSales()
  const view = viewParam === PROPOSALS_VIEW ? 'proposals' : viewParam === MAIL_VIEW && canSeeMail ? 'mail' : 'cases'
  const mode: Mode = (Array.isArray(sp.zobrazeni) ? sp.zobrazeni[0] : sp.zobrazeni) === 'seznam' ? 'seznam' : 'nastenka'
  const filter = parseCaseFilter(sp)
  const [res, pendingCount, mailStats] = await Promise.all([
    view === 'cases' ? listWorkCases(filter) : Promise.resolve(null),
    countPendingProposals(),
    canSeeMail ? getMailContentStats().catch(() => null) : Promise.resolve(null),
  ])
  const mailQueued = mailStats?.queued ?? 0
  // Dlaždice oblastí ukazují počty všech oblastí i když je jedna vybraná.
  const overall = res?.state === 'ok' && filter.node ? await listWorkCases({ ...filter, node: null }) : res

  const caseCount = res?.state === 'ok' ? res.cases.length : null
  const subtitle = view === 'proposals'
    ? 'Návrhy případů čekají na tvoje přijetí nebo zamítnutí.'
    : view === 'mail'
      ? 'Zprávy ze složky Cockpit, které si Cockpit nebyl jistý přiřadit. Vyber klienta, nebo zprávu zahoď.'
      : caseCount === null
      ? 'Pracovní případy: kroky, rozhodnutí a schválení na jednom místě.'
      : caseCount === 0
        ? 'Pro tento výběr tu není žádný případ.'
        : `Ve výběru ${caseCount} ${caseCount === 1 ? 'případ' : caseCount < 5 ? 'případy' : 'případů'}. Kroky, rozhodnutí a schválení na jednom místě.`

  return (
    <>
      <PageHeader title="Případy" eyebrow="Práce" subtitle={subtitle}>
        <WorkSegNav
          label="Případy, návrhy nebo pošta k zařazení"
          items={[
            { href: '/cockpit/pripady', label: 'Případy', active: view === 'cases' },
            { href: `/cockpit/pripady?view=${PROPOSALS_VIEW}`, label: 'Návrhy', active: view === 'proposals', count: pendingCount || undefined },
            // Pošta k zařazení se ukáže jen, když něco čeká (nebo je právě otevřená).
            ...(canSeeMail && (mailQueued > 0 || view === 'mail')
              ? [{ href: `/cockpit/pripady?view=${MAIL_VIEW}`, label: 'Pošta k zařazení', active: view === 'mail', count: mailQueued || undefined }]
              : []),
          ]}
        />
        {res?.state !== 'missing_migration' && (
          <Link href="/cockpit/pripady/nova" className={buttonClass('primary')}>Založit případ</Link>
        )}
      </PageHeader>
      <SectionTabs tabs={WORK_TABS} label="Práce" />
      <div className="flex flex-col gap-6">
        {view === 'proposals' && <ProposalsView />}
        {view === 'mail' && <MailQueueView />}
        {res?.state === 'missing_migration' && <MigrationPendingNotice />}
        {res?.state === 'error' && <WorkCaseNotice>Případy se nepodařilo načíst. Zkus to prosím později.</WorkCaseNotice>}
        {res?.state === 'ok' && (
          <>
            <section aria-labelledby="pripady-souhrn">
              <h2 id="pripady-souhrn" className="sr-only">Případy podle oblasti</h2>
              <NodeTiles
                cases={overall?.state === 'ok' ? overall.cases : res.cases}
                hrefFor={(node) => hrefFor({ ...filter, node: node as CaseFilter['node'] }, mode)}
                activeNode={filter.node}
              />
            </section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <WorkSegNav
                label="Filtr podle stavu"
                items={[
                  { href: hrefFor({ ...filter, status: 'active' }, mode), label: 'Aktivní', active: filter.status === 'active' },
                  ...CASE_STATUSES.map((st) => ({ href: hrefFor({ ...filter, status: st }, mode), label: CASE_STATUS_LABELS[st], active: filter.status === st })),
                  { href: hrefFor({ ...filter, status: 'all' }, mode), label: 'Vše', active: filter.status === 'all' },
                ]}
              />
              <WorkSegNav
                label="Zobrazení"
                items={[
                  { href: hrefFor(filter, 'nastenka'), label: 'Nástěnka', active: mode === 'nastenka' },
                  { href: hrefFor(filter, 'seznam'), label: 'Seznam', active: mode === 'seznam' },
                ]}
              />
            </div>
            {mode === 'nastenka' ? (
              <WorkCaseBoard cases={res.cases} statusFilter={filter.status} />
            ) : res.cases.length === 0 ? (
              <div className={CARD}>
                <EmptyState title="Žádné případy pro tento výběr" action={{ href: '/cockpit/pripady/nova', label: 'Založit případ' }}>
                  Změň oblast nebo stav nahoře, nebo založ nový případ.
                </EmptyState>
              </div>
            ) : (
              <DataTable<WorkCaseListItem> mobile="cards"
                label="Případy"
                empty="Žádné případy pro tento filtr."
                rows={res.cases}
                columns={[
                  { header: 'Případ', cell: (r) => <Link href={`/cockpit/pripady/${r.id}`} className="font-semibold">{r.title}</Link> },
                  { header: 'Oblast', cell: (r) => nodeLabel(r.node) },
                  { header: 'Stav', cell: (r) => <WorkStatus tone={STATUS_TONE[r.status] ?? 'idle'}>{caseStatusLabel(r.status)}</WorkStatus> },
                  { header: 'Kroky', cell: (r) => <span className="tabular-nums">{r.steps_total ? `${r.steps_done}/${r.steps_total}` : '—'}</span> },
                  { header: 'Vlastník', cell: (r) => r.lead_owner_name ?? '—' },
                  {
                    header: 'Klient',
                    cell: (r) => (r.account_id && r.account_name ? <Link href={`/cockpit/clients/${r.account_id}`}>{r.account_name}</Link> : '—'),
                  },
                  { header: 'Změněno', cell: (r) => <span className="tabular-nums">{fmt(r.updated_at)}</span> },
                ]}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}
