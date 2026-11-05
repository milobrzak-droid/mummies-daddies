import type { ReactNode } from 'react'
import { FeaturePending } from '@/components/ui/FeaturePending'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { DataTable } from '@/components/DataTable'
import { ContactForm } from '@/components/ContactForm'
import { AccountForm } from '@/components/AccountForm'
import { Avatar } from '@/components/Avatar'
import { Chip } from '@/components/Chip'
import { ContactOptOutChip } from '@/components/DoNotContactChip'
import { createContact, updateContact } from '@/domain/crm/actions/contacts'
import { updateAccount } from '@/domain/crm/actions/accounts'
import { formatCzk, formatDate } from '@/lib/format'
import { getAccount, getContacts } from '@/domain/crm/queries/accounts'
import { getDealsForAccount } from '@/domain/crm/queries/deals'
import { listPartners } from '@/domain/crm/queries/partners'
import { listTeamMembers } from '@/lib/queries/team'
import { EXTERNAL_LINK_REL, safeExternalHref } from '@/core/untrusted'
import { getEngagementsForAccount } from '@/domain/delivery/queries/engagements'
import { createAdminClient } from '@/lib/supabase/admin'
import { ActivityForm } from '@/components/ActivityForm'
import { ActivityTimeline } from '@/components/ActivityTimeline'
import { createSalesActivity } from '@/domain/crm/actions/sales'
import { getSalesActivitiesForAccount } from '@/domain/crm/queries/sales'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { TaskListCompact } from '@/components/TaskListCompact'
import { TaskQuickForm } from '@/components/TaskQuickForm'
import { createTask } from '@/domain/crm/actions/tasks'
import { getOpenTasksForAccount, getDoneTaskCountForAccount, listAssignableMembers } from '@/domain/crm/queries/tasks'
import { SubscriptionListCompact } from '@/components/SubscriptionListCompact'
import { SubscriptionForm } from '@/components/SubscriptionForm'
import { createSubscription } from '@/domain/finance/actions/subscriptions'
import { getSubscriptionsForAccount } from '@/domain/finance/queries/subscriptions'
import { listAccountFinancialRecords } from '@/domain/finance/queries/records'
import { summarizeByKind } from '@/domain/finance/records'
import { FinanceKindSummary } from '@/components/FinanceKindTotals'
import { CompanyAliasForm } from '@/components/CompanyAliasForm'
import { CompanyRelationshipForm } from '@/components/CompanyRelationshipForm'
import {
  addCompanyAlias, removeCompanyAlias, addRelationship, removeRelationship,
} from '@/domain/crm/actions/companyRelationships'
import {
  listAliasesForAccount, listParentRelationships, listChildRelationships,
} from '@/domain/crm/queries/companyRelationships'
import { pragueDayOf, pragueToday } from '@/lib/pragueDate'
import {
  CLIENT_STATUS_TEXT, buildActiveDays, clientStatus, czPlural, describeDue, pickNextStep,
  summarizeDeals, summarizeEngagements, summarizeTasks, type ClientStatus,
} from '@/domain/crm/clientOverview'
import { ButtonLink } from '@/components/ui/Button'
import { Card, CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ClientTabs, type ClientTab } from '@/components/ui/ClientTabs'
import { ClientNumberTile } from '@/components/ui/ClientNumberTile'
import { ClientActiveDays } from '@/components/ui/ClientActiveDays'
import { ClientDealCard } from '@/components/ui/ClientDealCard'
import { ClientEngagementCard } from '@/components/ui/ClientEngagementCard'
import { ClientsSegments, type ClientsSegment } from '@/components/ui/ClientsSegments'
import { ClientsSidePanel } from '@/components/ui/ClientsSidePanel'
import { ClientsContactEditor } from '@/components/ui/ClientsContactEditor'
import { ClientsAliasList } from '@/components/ui/ClientsAliasList'
import { ClientsConfirmSubmit } from '@/components/ui/ClientsConfirmSubmit'
import { AutoIntakeBanner } from '@/components/ui/AutoIntakeBanner'
import { EmailLink } from '@/components/ui/EmailLink'
import { getAutoIntakeForAccount } from '@/domain/crm/queries/autoIntake'
import { isMailOfferPath } from '@/domain/crm/offerProposal'

const H2 = 'm-0 font-heading text-title2 font-bold'

// Celé názvy tříd (ne skládané): Tailwind jinak třídy z @layer components odstraní.
const STATUS_CLASS: Record<ClientStatus, string> = { aktivni: 'st done', klient: 'st info', prospekt: 'st' }

const ACTIVITY_FILTERS = [
  { key: 'email', label: 'Pošta' },
  { key: 'meeting', label: 'Schůzky' },
  { key: 'call', label: 'Telefonáty' },
  { key: 'note', label: 'Poznámky' },
] as const

const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// „čtvrtek 1. 10." — den v týdnu + datum, ať je termín čitelný na první pohled.
function dayLabel(day: string): string {
  return new Date(`${day.slice(0, 10)}T12:00:00`).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' })
}

// Detail klienta (docs/PROVOZ.md §13 „Klienti“ a „Detaily“): záhlaví
// s názvem, stavem a jednou hlavní akcí; obsah v záložkách přes ?tab=
// (Přehled / Obchody / Dodávky / Kontakty / Historie / Peníze / O firmě);
// vpravo sloupec „Souvislosti“ (na mobilu pod obsahem). Úprava firmy
// (?upravit=firma) a kontaktu (?kontakt=ID) je v bočním panelu na místě;
// samostatné stránky /clients/[id]/edit a /kontakty/[id]/edit zůstávají
// jako záložní cesta.
export default async function AccountDetail({
  params, searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const query = await searchParams
  const accountId = Number(id)
  const [account, canSeeSales] = await Promise.all([getAccount(accountId), canCurrentUserSeeSales()])
  if (!account) notFound()

  // Obchody a částky (projekty/dealy, nasmlouváno, předplatné MRR, aktivity)
  // jen pro obchodní role — rozhodnutí 2026-09-28, v DB vynucuje 0058.
  // Ostatním se nic z toho nenačítá a sekce se nevykreslí (žádné prázdné bloky).
  const [
    deals, contacts, engagements, activities, openTasks, doneTaskCount, members, subscriptions,
    aliases, parentRelationships, childRelationships, autoIntake,
  ] = await Promise.all([
    canSeeSales ? getDealsForAccount(accountId) : Promise.resolve([] as Awaited<ReturnType<typeof getDealsForAccount>>),
    getContacts(accountId), getEngagementsForAccount(accountId),
    canSeeSales ? getSalesActivitiesForAccount(accountId) : Promise.resolve([]),
    getOpenTasksForAccount(accountId), getDoneTaskCountForAccount(accountId), listAssignableMembers(),
    canSeeSales
      ? getSubscriptionsForAccount(accountId)
      : Promise.resolve([] as Awaited<ReturnType<typeof getSubscriptionsForAccount>>),
    listAliasesForAccount(accountId), listParentRelationships(accountId), listChildRelationships(accountId),
    // Štítek „vzniklo automaticky z e-mailu" (0081): jen obchodní role, bez migrace null.
    canSeeSales ? getAutoIntakeForAccount(accountId) : Promise.resolve(null),
  ])
  // Finanční záznamy (0063): čtyři oddělené druhy, jen obchodní role.
  const finance = canSeeSales ? await listAccountFinancialRecords(accountId) : null

  // Podpisy PDF nabídek se generují jen pro obchody (obchodní role).
  const admin = createAdminClient()
  const pdfLinks = new Map<number, string>()
  const signed = await Promise.all(deals.filter((d) => d.source_pdf_path && !isMailOfferPath(d.source_pdf_path)).map(async (d) => {
    const { data } = await admin.storage.from('nabidky').createSignedUrl(d.source_pdf_path!, 3600)
    return [d.id, data?.signedUrl] as const
  }))
  for (const [dealId, url] of signed) if (url) pdfLinks.set(dealId, url)

  const today = pragueToday()
  const base = `/cockpit/clients/${accountId}`
  const dealSum = summarizeDeals(deals)
  const engSum = summarizeEngagements(engagements)
  const taskSum = summarizeTasks(openTasks, today)
  const nextStep = pickNextStep(deals, openTasks)
  const status = clientStatus(account, deals)
  const blockers = deals.filter((d) => d.status_blocker).length

  // Záložky: co uživatel smí vidět. Obchody, historie a peníze jen obchodní role.
  const tabs: ClientTab[] = [
    { key: 'prehled', label: 'Přehled' },
    ...(canSeeSales ? [{ key: 'obchody', label: 'Obchody', count: deals.length }] : []),
    { key: 'dodavky', label: 'Dodávky', count: engagements.length },
    { key: 'kontakty', label: 'Kontakty', count: contacts.length },
    ...(canSeeSales ? [
      { key: 'aktivity', label: 'Historie', count: activities.length },
      { key: 'penize', label: 'Peníze' },
    ] : []),
    { key: 'firma', label: 'O firmě' },
  ]
  const requested = firstParam(query.tab)
  const tab = tabs.some((t) => t.key === requested) ? (requested as string) : 'prehled'
  const tabHref = (key: string) => (key === 'prehled' ? base : `${base}?tab=${key}`)
  const withParam = (href: string, param: string) => `${href}${href.includes('?') ? '&' : '?'}${param}`
  const here = tabHref(tab)

  // Panely úprav na místě (URL): firma a kontakt tohoto klienta.
  const editingAccount = firstParam(query.upravit) === 'firma'
  const contactParam = Number(firstParam(query.kontakt))
  const editingContact = Number.isSafeInteger(contactParam) ? contacts.find((c) => c.id === contactParam) ?? null : null
  const [partners, teamMembers] = editingAccount
    ? await Promise.all([listPartners(), listTeamMembers()])
    : [[], []]

  // Hlavní tlačítko: obchodní role zapisují aktivitu, ostatní přidají úkol.
  const primary = canSeeSales
    ? { href: `${base}?tab=aktivity#zapsat-aktivitu`, label: 'Zapsat aktivitu' }
    : { href: `${base}#pridat-ukol`, label: 'Přidat úkol' }

  const web = account.web ? (() => {
    // Web může pocházet z ARES nebo z importu — jen https odkaz, jinak prostý text.
    const href = safeExternalHref(`https://${account.web.replace(/^https?:\/\//, '')}`)
    return href
      ? <a href={href} target="_blank" rel={EXTERNAL_LINK_REL} className="text-ink hover:text-[color:var(--c-accent-text)]">{account.web}</a>
      : <span>{account.web}</span>
  })() : null
  const subtitleParts: ReactNode[] = [
    account.industry,
    account.ico ? `IČO ${account.ico}` : null,
    web,
    account.owner ? <>Vlastník <span className="text-ink">{account.owner.full_name}</span></> : null,
  ].filter(Boolean)

  return (
    <>
      {/* Záhlaví detailu (plán vlny 2 „Detaily“): zpět na seznam, nadpis,
          stavová pilulka na začátku řádku kontextu, jedna hlavní akce. */}
      <PageHeader
        back={{ href: '/cockpit/clients', label: 'Klienti' }}
        eyebrow={[account.region, account.is_reference ? 'referenční klient' : null].filter(Boolean).join(' · ') || undefined}
        title={account.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={STATUS_CLASS[status]}>{CLIENT_STATUS_TEXT[status]}</span>
            {subtitleParts.map((part, i) => (
              <span key={i} className="inline-flex items-center gap-2">
                <span aria-hidden="true">·</span>
                {part}
              </span>
            ))}
          </span>
        }
      >
        <ButtonLink href={withParam(here, 'upravit=firma')} variant="outline" scroll={false}>Upravit</ButtonLink>
        <ButtonLink href={primary.href} variant="primary">{primary.label}</ButtonLink>
      </PageHeader>

      {autoIntake && <AutoIntakeBanner item={autoIntake} />}

      <ClientTabs base={base} tabs={tabs} active={tab} />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {tab === 'prehled' && (
            <OverviewTab
              canSeeSales={canSeeSales}
              base={base}
              today={today}
              notes={account.notes}
              activities={activities}
              openTasks={openTasks}
              doneTaskCount={doneTaskCount}
              members={members}
              accountId={accountId}
              nextStep={nextStep}
              numbers={
                <div className={`grid gap-4 ${canSeeSales ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
                  {canSeeSales && (
                    <ClientNumberTile
                      tone="lav"
                      label="Obchody"
                      value={String(dealSum.open)}
                      caption={dealSum.total === 0 ? 'zatím žádný obchod' : czPlural(dealSum.open, ['otevřený obchod', 'otevřené obchody', 'otevřených obchodů'])}
                      strong={dealSum.open > 0 ? formatCzk(dealSum.openAmount) : undefined}
                      cells={dealSum.total > 0 ? [
                        { label: 'Celkem', value: String(dealSum.total) },
                        { label: 'Vyhráno', value: String(dealSum.won) },
                        { label: 'Brzdí', value: String(blockers) },
                      ] : []}
                      href={`${base}?tab=obchody`}
                      ariaLabel={`Obchody: ${dealSum.open} otevřených, otevřít záložku Obchody`}
                    />
                  )}
                  <ClientNumberTile
                    tone="mint"
                    label="Dodávky"
                    value={String(engSum.running)}
                    caption={engSum.total === 0 ? 'zatím žádná dodávka' : czPlural(engSum.running, ['dodávka běží', 'dodávky běží', 'dodávek běží'])}
                    strong={engSum.current ? `Teď: ${engSum.current.phaseLabel}` : undefined}
                    cells={engSum.total > 0 ? [
                      { label: 'Celkem', value: String(engSum.total) },
                      { label: 'Uzavřeno', value: String(engSum.closed) },
                      { label: 'Reference', value: String(engSum.referenceWorthy) },
                    ] : []}
                    href={`${base}?tab=dodavky`}
                    ariaLabel={`Dodávky: ${engSum.running} běží, otevřít záložku Dodávky`}
                  />
                  <ClientNumberTile
                    tone="peach"
                    label="Úkoly"
                    value={String(taskSum.open)}
                    caption={czPlural(taskSum.open, ['otevřený úkol', 'otevřené úkoly', 'otevřených úkolů'])}
                    strong={taskSum.nearestDue ? `Nejbližší: ${describeDue(taskSum.nearestDue, today)}` : undefined}
                    cells={taskSum.open > 0 ? [
                      { label: 'Po termínu', value: String(taskSum.overdue) },
                      { label: 'Do týdne', value: String(taskSum.thisWeek) },
                      { label: 'Důležité', value: String(taskSum.highPriority) },
                    ] : []}
                    href={`${base}#ukoly`}
                    ariaLabel={`Úkoly: ${taskSum.open} otevřených, přejít na úkoly`}
                  />
                </div>
              }
            />
          )}

          {tab === 'kontakty' && (
            <>
              <DataTable mobile="cards" label="Kontakty klienta"
                rows={contacts}
                empty="Zatím žádný kontakt."
                emptyHint="Lidé u klienta, se kterými jednáme. Přidej prvního formulářem níž."
                emptyAction={{ href: '#novy-kontakt', label: 'Přidat kontakt' }}
                columns={[
                  {
                    header: 'Jméno',
                    cell: (c) => (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Avatar name={c.full_name} size={28} />
                        <span>{c.full_name}</span>
                        {c.is_champion && <Chip tone="sun">Champion</Chip>}
                        <ContactOptOutChip contact={c} />
                      </div>
                    ),
                  },
                  { header: 'Role', cell: (c) => c.role ?? <span className="text-muted">—</span> },
                  { header: 'E-mail', cell: (c) => <EmailLink email={c.email} /> },
                  { header: 'Telefon', cell: (c) => c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : <span className="text-muted">—</span> },
                  {
                    header: 'Úprava',
                    align: 'right',
                    cell: (c) => (
                      <ButtonLink
                        href={withParam(tabHref('kontakty'), `kontakt=${c.id}`)}
                        variant="quiet"
                        size="sm"
                        scroll={false}
                        aria-label={`Upravit kontakt ${c.full_name}`}
                      >
                        Upravit
                      </ButtonLink>
                    ),
                  },
                ]}
              />
              <Card id="novy-kontakt" title="Přidat kontakt" sub="Jméno stačí, ostatní jde doplnit později." className="scroll-mt-4">
                <ContactForm action={createContact.bind(null, accountId)} submitVariant="default" />
              </Card>
            </>
          )}

          {tab === 'obchody' && canSeeSales && (
            <section aria-labelledby="obchody-nadpis" className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="obchody-nadpis" className={H2}>Obchody</h2>
                {deals.length > 0 && <ButtonLink href={`${base}/deals/new`} variant="outline" size="sm">Založit obchod</ButtonLink>}
              </div>
              {deals.length === 0 ? (
                <div className={CARD}>
                  <EmptyState title="Zatím žádný obchod." action={{ href: `${base}/deals/new`, label: 'Založit obchod' }}>
                    Obchod drží fázi, částku a další krok. Ukáže se tady i na tabuli obchodů.
                  </EmptyState>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {deals.map((d) => (
                    <ClientDealCard key={d.id} deal={d} href={`${base}/deals/${d.id}/edit`} pdfUrl={pdfLinks.get(d.id)} today={today} />
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === 'dodavky' && (
            // Sekce se vykresluje vždy, i při nule: bez odkazu „Založit dodávku" by
            // se na dodávkovou agendu (měření dopadu, brány kvality, reference)
            // z aplikace nedalo dostat.
            <section aria-labelledby="dodavky-nadpis" className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="dodavky-nadpis" className={H2}>Dodávky a měřený dopad</h2>
                {engagements.length > 0 && <ButtonLink href={`${base}/engagements/new`} variant="outline" size="sm">Založit dodávku</ButtonLink>}
              </div>
              {engagements.length === 0 ? (
                <div className={CARD}>
                  <EmptyState title="Zatím žádná dodávka." action={{ href: `${base}/engagements/new`, label: 'Založit dodávku' }}>
                    Tady se eviduje využívání před a po, počet vyškolených, návratnost a šest bran kvality
                    podle standardu dodávky — bez toho nejde doložit dopad, na kterém stojí reference.
                  </EmptyState>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  {engagements.map((e) => (
                    <ClientEngagementCard key={e.id} engagement={e} href={`${base}/engagements/${e.id}/edit`} />
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === 'aktivity' && canSeeSales && (
            <ActivitiesTab
              base={base}
              activities={activities}
              kindParam={firstParam(query.druh)}
              formSlot={
                <ActivityForm
                  action={createSalesActivity}
                  accounts={[account]}
                  deals={deals}
                  contacts={contacts}
                  initialAccountId={accountId}
                />
              }
            />
          )}

          {tab === 'penize' && canSeeSales && (
            <>
              {finance && (
                <Card title="Finance" sub="Součty finančních záznamů firmy podle druhu." href={`/cockpit/finance?firma=${accountId}`} hrefLabel="Záznamy firmy ve Financích">
                  {finance.state === 'ok' && <FinanceKindSummary summary={summarizeByKind(finance.records)} />}
                  {finance.state === 'missing_migration' && (
                    <p className="text-callout text-muted m-0"><FeaturePending variant="inline" migration="0063" title="Finanční záznamy se připravují." /></p>
                  )}
                  {finance.state === 'error' && <p className="text-callout text-muted m-0">Finanční záznamy se nepodařilo načíst. Zkus stránku obnovit.</p>}
                </Card>
              )}
              <section aria-labelledby="predplatna-nadpis" className="space-y-4">
                <h2 id="predplatna-nadpis" className={H2}>Předplatná</h2>
                <SubscriptionListCompact subscriptions={subscriptions} accountId={accountId} />
                <details className={`${CARD} group`} id="pridat-predplatne">
                  <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-3 px-5 text-headline text-ink sm:px-6 [&::-webkit-details-marker]:hidden">
                    Přidat předplatné
                    <Chevron />
                  </summary>
                  <div className="px-5 pb-5 sm:px-6 sm:pb-6">
                    <SubscriptionForm action={createSubscription.bind(null, accountId)} accountId={accountId} />
                  </div>
                </details>
              </section>
            </>
          )}

          {tab === 'firma' && (
            <>
              <Card
                title="Údaje o firmě"
                sub={account.profile ? undefined : 'Profil firmy zatím není vyplněný. Doplň ho v úpravě, nebo z ARESu podle IČO.'}
                actions={<ButtonLink href={withParam(here, 'upravit=firma')} variant="outline" size="sm" scroll={false}>Upravit údaje</ButtonLink>}
              >
                {account.profile && <p className="m-0 mb-5 text-body leading-relaxed text-[color:#3A424E]">{account.profile}</p>}
                <dl className="m-0 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  {companyFacts(account).map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="eyebrow">{label}</dt>
                      <dd className="m-0 mt-1 break-words text-body text-ink">{value}</dd>
                    </div>
                  ))}
                </dl>
                {account.nace && account.nace.length > 0 && (
                  <p className="m-0 mt-4 text-footnote text-muted">Kódy NACE (dle ARES): {account.nace.join(', ')}</p>
                )}
              </Card>

              {/* Aliasy domén/názvů a mateřské/dceřiné vztahy (kapitola 4 plánu
                  přestavby, „Firma a oslovování") — účel je dedup a kontext, ne
                  vizualizace skupiny firem. Vzácně potřebné, proto pod <details>. */}
              <details className={`${CARD} group`}>
                <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-3 px-5 sm:px-6 [&::-webkit-details-marker]:hidden">
                  <span className="text-headline text-ink">
                    Aliasy domén a názvů
                    <span className="ml-2 text-callout font-normal text-muted">{aliases.length === 0 ? 'žádné' : aliases.length}</span>
                  </span>
                  <Chevron />
                </summary>
                <div className="px-5 pb-5 sm:px-6 sm:pb-6">
                  <p className="m-0 mb-3 text-callout text-muted">Jiná e-mailová doména nebo dřívější název, pod kterým firmu vídáme.</p>
                  <ClientsAliasList
                    aliases={aliases}
                    remove={removeCompanyAlias.bind(null, accountId)}
                    add={addCompanyAlias.bind(null, accountId)}
                  />
                  <CompanyAliasForm action={addCompanyAlias.bind(null, accountId)} />
                </div>
              </details>

              <details className={`${CARD} group`}>
                <summary className="flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-3 px-5 sm:px-6 [&::-webkit-details-marker]:hidden">
                  <span className="text-headline text-ink">
                    Mateřská a dceřiné firmy
                    <span className="ml-2 text-callout font-normal text-muted">
                      {parentRelationships.length + childRelationships.length === 0 ? 'žádné' : parentRelationships.length + childRelationships.length}
                    </span>
                  </span>
                  <Chevron />
                </summary>
                <div className="px-5 pb-5 sm:px-6 sm:pb-6">
                  {parentRelationships.length === 0 && childRelationships.length === 0 ? (
                    <p className="m-0 mb-4 text-callout text-muted">Žádné evidované vztahy k jiným firmám.</p>
                  ) : (
                    <ul className="m-0 mb-4 list-none divide-y divide-[color:var(--c-line-2)] p-0">
                      {[
                        ...parentRelationships.map((r) => ({ id: r.id, kind: 'Mateřská firma', other: r.parent })),
                        ...childRelationships.map((r) => ({ id: r.id, kind: 'Dceřiná firma', other: r.child })),
                      ].map((r) => (
                        <li key={r.id} className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-3 gap-y-2 py-1.5 text-body">
                          <span>
                            <span className="text-muted">{r.kind}: </span>
                            {r.other ? <Link href={`/cockpit/clients/${r.other.id}`}>{r.other.name}</Link> : '—'}
                          </span>
                          {/* Odebrání vazby je nevratné (plán vlny 2): potvrzení na místě. */}
                          <form action={removeRelationship.bind(null, accountId, r.id)}>
                            <ClientsConfirmSubmit
                              label="Odebrat"
                              confirmLabel="Odebrat vazbu"
                              pendingLabel="Odebírám…"
                              question="Vazba se smaže u obou firem."
                              ariaLabel={`Odebrat vztah: ${r.kind.toLowerCase()} ${r.other?.name ?? ''}`.trim()}
                            />
                          </form>
                        </li>
                      ))}
                    </ul>
                  )}
                  <CompanyRelationshipForm action={addRelationship.bind(null, accountId)} accountId={accountId} />
                </div>
              </details>
            </>
          )}
        </div>

        <ContextColumn
          tab={tab}
          base={base}
          today={today}
          canSeeSales={canSeeSales}
          contacts={contacts}
          activities={activities}
          openTasks={openTasks}
          contactHref={(cid) => withParam(tabHref('kontakty'), `kontakt=${cid}`)}
        />
      </div>

      {editingAccount && (
        <ClientsSidePanel title="Upravit údaje o firmě" description={account.name} closeHref={here}>
          <AccountForm action={updateAccount.bind(null, account.id)} initial={account} partners={partners} members={teamMembers} />
        </ClientsSidePanel>
      )}
      {editingContact && (
        <ClientsSidePanel title="Upravit kontakt" description={editingContact.full_name} closeHref={here}>
          <ClientsContactEditor
            action={updateContact.bind(null, editingContact.id)}
            contact={editingContact}
            optOutInfo={optOutInfoFor(editingContact, members)}
            closeHref={here}
          />
          <p className="m-0 mt-6 border-t border-border pt-4 text-callout text-muted">
            Export údajů (GDPR) a smazání kontaktu jsou na{' '}
            <Link href={`/cockpit/kontakty/${editingContact.id}/edit`} className="underline hover:text-ink">samostatné stránce kontaktu</Link>.
          </p>
        </ClientsSidePanel>
      )}
    </>
  )
}

type Account = NonNullable<Awaited<ReturnType<typeof getAccount>>>
type Activities = Awaited<ReturnType<typeof getSalesActivitiesForAccount>>
type Contacts = Awaited<ReturnType<typeof getContacts>>
type OpenTasks = Awaited<ReturnType<typeof getOpenTasksForAccount>>
type Members = Awaited<ReturnType<typeof listAssignableMembers>>

// Údaje o firmě jako seznam štítek → hodnota; prázdné se nevypisují (nic se nedoplňuje).
function companyFacts(a: Account): [string, ReactNode][] {
  const facts: [string, ReactNode | null | undefined][] = [
    ['IČO', a.ico],
    ['Obor', a.industry],
    ['Region / sídlo', a.region],
    ['Velikost', a.size_band],
    ['Vlastník', a.owner?.full_name],
    ['Klient od', a.client_since ? formatDate(a.client_since) : null],
    ['Doporučil', a.referred_by ? <Chip tone="turquoise">{a.referred_by.name}</Chip> : 'Přímý (bez partnera)'],
    ['Právní forma', a.legal_form],
    ['Založeno', a.founded_on ? formatDate(a.founded_on) : null],
    ['Referenční klient', a.is_reference ? 'Ano' : null],
  ]
  return facts.filter((f): f is [string, ReactNode] => f[1] != null && f[1] !== '')
}

// Kdo a kdy nesouhlas s oslovením zapsal (0087) — stejná věta jako na /kontakty/[id]/edit.
function optOutInfoFor(c: Contacts[number], members: Members): string | undefined {
  if (!c.do_not_contact || !c.do_not_contact_at) return undefined
  const by = c.do_not_contact_by ? members.find((m) => m.id === c.do_not_contact_by)?.full_name ?? null : null
  return `Zapsáno ${formatDate(c.do_not_contact_at)}${by ? ` (${by})` : ''}. Odškrtnutím se nesouhlas zruší.`
}

function Chevron() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted transition-transform duration-fast group-open:rotate-180"><path d="m6 9 6 6 6-6" /></svg>
  )
}

// Záložka Přehled: další krok, tři čísla, poznámka a aktivní dny, úkoly.
function OverviewTab({
  canSeeSales, base, today, notes, activities, openTasks, doneTaskCount, members, accountId, nextStep, numbers,
}: {
  canSeeSales: boolean
  base: string
  today: string
  notes: string | null
  activities: Activities
  openTasks: OpenTasks
  doneTaskCount: number
  members: Members
  accountId: number
  nextStep: ReturnType<typeof pickNextStep>
  numbers: ReactNode
}) {
  const days = canSeeSales ? buildActiveDays(activities, today) : null
  // Historie se načítá po 50 záznamech; u hodně živé firmy by matice
  // podhodnotila starší týdny — řekneme to.
  const truncated = days != null && activities.length >= 50
    && pragueDayOf(activities[activities.length - 1].occurred_at) > days.cells[0].day
  const late = nextStep?.due ? describeDue(nextStep.due, today).startsWith('po termínu') : false
  return (
    <>
      {/* DALŠÍ KROK – jedna věta, co s klientem dál. Hlavní akce je v záhlaví. */}
      <section aria-labelledby="dalsi-krok" className={`${CARD} p-5 sm:p-6`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 id="dalsi-krok" className="eyebrow m-0 font-medium">Další krok</h2>
          {nextStep?.due && (
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-callout font-semibold ${late ? 'bg-[color:var(--c-neg-soft)] text-neg' : 'bg-[color:var(--c-soft)] text-ink'}`}>
              {dayLabel(nextStep.due)}
            </span>
          )}
          {nextStep && (
            <span className="text-callout text-muted">
              {describeDue(nextStep.due, today)}
              {nextStep.context ? ` · k obchodu ${nextStep.context}` : nextStep.source === 'task' ? ' · úkol' : ''}
            </span>
          )}
        </div>
        {nextStep ? (
          <p className="m-0 mt-2 font-heading text-title1 font-bold text-ink [text-wrap:balance]">{nextStep.title}</p>
        ) : (
          <p className="m-0 mt-2 text-body text-muted">
            Další krok zatím není domluvený. {canSeeSales ? 'Zapiš aktivitu nebo přidej úkol s termínem.' : 'Přidej úkol s termínem.'}
          </p>
        )}
      </section>

      {numbers}

      {(notes || days) && (
        <div className={`grid gap-4 ${notes && days ? 'lg:grid-cols-2' : ''}`}>
          {notes && (
            <Card title="Poznámka">
              <p className="m-0 text-body leading-relaxed text-[color:#3A424E] whitespace-pre-line">{notes}</p>
            </Card>
          )}
          {days && (
            <Card title="Aktivní dny" href={`${base}?tab=aktivity`} hrefLabel="Celá historie">
              <ClientActiveDays data={days} />
              {truncated && (
                <p className="mt-3 mb-0 text-footnote text-muted">Počítáno z posledních {activities.length} aktivit, starší týdny mohou chybět.</p>
              )}
            </Card>
          )}
        </div>
      )}

      <section id="ukoly" aria-labelledby="ukoly-nadpis" className="scroll-mt-4 space-y-3">
        <h2 id="ukoly-nadpis" className={H2}>Úkoly</h2>
        <TaskListCompact tasks={openTasks} doneCount={doneTaskCount} members={members} emptyText="Žádné otevřené úkoly. Přidej první níž." />
      </section>
      <Card id="pridat-ukol" title="Přidat úkol" className="scroll-mt-4">
        <TaskQuickForm action={createTask} members={members} accountId={accountId} />
      </Card>
    </>
  )
}

// Pravý sloupec „Souvislosti“ (plán vlny 2, Detaily): kontakty, poslední
// aktivita a úkoly. Na širokém displeji vedle obsahu, na užším pod ním.
// Co je na aktuální záložce vidět celé, se tu neopakuje.
function ContextColumn({
  tab, base, today, canSeeSales, contacts, activities, openTasks, contactHref,
}: {
  tab: string
  base: string
  today: string
  canSeeSales: boolean
  contacts: Contacts
  activities: Activities
  openTasks: OpenTasks
  contactHref: (id: number) => string
}) {
  const showContacts = tab !== 'kontakty'
  const showActivity = canSeeSales && tab !== 'aktivity' && tab !== 'prehled'
  const showLatest = canSeeSales && tab === 'prehled'
  const showTasks = tab !== 'prehled'
  return (
    <aside aria-label="Souvislosti" className="min-w-0 space-y-4">
      <h2 className="eyebrow m-0 font-medium">Souvislosti</h2>
      {showContacts && (
        <Card title="Kontakty" headingLevel={3} href={`${base}?tab=kontakty`} hrefLabel="Všechny kontakty">
          {contacts.length === 0 ? (
            <EmptyState compact title="Zatím žádný kontakt." action={{ href: `${base}?tab=kontakty#novy-kontakt`, label: 'Přidat kontakt' }} className="!px-0 !py-2" />
          ) : (
            <ul className="m-0 -mx-2 list-none space-y-1 p-0">
              {contacts.slice(0, 4).map((c) => (
                <li key={c.id}>
                  <Link href={contactHref(c.id)} scroll={false} className="flex min-h-[44px] items-center gap-3 rounded-btn px-2 py-1.5 no-underline hover:bg-[color:var(--c-soft)]">
                    <Avatar name={c.full_name} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-headline text-ink">{c.full_name}</span>
                      {c.role && <span className="block truncate text-footnote text-muted">{c.role}</span>}
                    </span>
                    {c.is_champion && <Chip tone="sun">Champion</Chip>}
                    <ContactOptOutChip contact={c} />
                  </Link>
                </li>
              ))}
              {contacts.length > 4 && (
                <li className="px-2 pt-1 text-footnote text-muted">a {contacts.length - 4} {czPlural(contacts.length - 4, ['další', 'další', 'dalších'])}</li>
              )}
            </ul>
          )}
        </Card>
      )}
      {(showActivity || showLatest) && (
        <Card title="Poslední aktivita" headingLevel={3} href={`${base}?tab=aktivity`} hrefLabel="Celá historie">
          {activities.length === 0 ? (
            <EmptyState compact title="Zatím žádná aktivita." action={{ href: `${base}?tab=aktivity#zapsat-aktivitu`, label: 'Zapsat aktivitu' }} className="!px-0 !py-2" />
          ) : (
            <ul className="m-0 list-none space-y-3 p-0">
              {activities.slice(0, 3).map((a) => (
                <li key={a.id} className="min-w-0">
                  <span className="block text-headline text-ink [overflow-wrap:anywhere]">{a.subject}</span>
                  <span className="block text-footnote text-muted">
                    {formatDate(a.occurred_at)}{a.author ? ` · ${a.author.full_name}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {showTasks && (
        <Card title="Úkoly" headingLevel={3} href={`${base}#ukoly`} hrefLabel="Všechny úkoly klienta">
          {openTasks.length === 0 ? (
            <EmptyState compact tone="calm" title="Nic otevřeného." action={{ href: `${base}#pridat-ukol`, label: 'Přidat úkol' }} className="!px-0 !py-2" />
          ) : (
            <ul className="m-0 list-none space-y-3 p-0">
              {openTasks.slice(0, 3).map((t) => {
                const due = t.due_on ? describeDue(t.due_on, today) : null
                return (
                  <li key={t.id} className="min-w-0">
                    <span className="block text-headline text-ink [overflow-wrap:anywhere]">{t.title}</span>
                    <span className={`block text-footnote ${due?.startsWith('po termínu') ? 'text-neg' : 'text-muted'}`}>{due ?? 'bez termínu'}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}
    </aside>
  )
}

// Záložka Historie (?tab=aktivity): filtr podle druhu (segmenty, stav v URL), formulář a osa.
function ActivitiesTab({
  base, activities, kindParam, formSlot,
}: {
  base: string
  activities: Activities
  kindParam: string | undefined
  formSlot: ReactNode
}) {
  const kind = ACTIVITY_FILTERS.find((f) => f.key === kindParam)?.key ?? null
  const filtered = kind ? activities.filter((a) => a.kind === kind) : activities
  const items: ClientsSegment[] = [
    { key: 'vse', href: `${base}?tab=aktivity`, label: 'Vše', count: activities.length, active: kind === null },
    ...ACTIVITY_FILTERS.map((f) => ({
      key: f.key,
      href: `${base}?tab=aktivity&druh=${f.key}`,
      label: f.label,
      count: activities.filter((a) => a.kind === f.key).length,
      active: kind === f.key,
    })),
  ]
  return (
    <div className="grid items-start gap-6 2xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card id="zapsat-aktivitu" title="Zapsat aktivitu" sub="Hovor, e-mail, schůzka nebo poznámka ke klientovi." className="scroll-mt-4">
        {formSlot}
      </Card>
      <section aria-labelledby="historie-nadpis" className="min-w-0 space-y-4">
        <h2 id="historie-nadpis" className={H2}>Historie vztahu</h2>
        <ClientsSegments items={items} label="Filtr historie podle druhu" />
        {kind && filtered.length === 0 ? (
          <div className={CARD}>
            <EmptyState compact title="V téhle skupině zatím nic není." action={{ href: `${base}?tab=aktivity`, label: 'Zobrazit vše' }} />
          </div>
        ) : (
          <ActivityTimeline activities={filtered} showAccount={false} />
        )}
      </section>
    </div>
  )
}
