import Link from 'next/link'
import { getSalesDeals } from '@/domain/crm/queries/sales'
import { listAssignableMembers } from '@/domain/crm/queries/tasks'
import {
  getAccountListSummary, listAccountsPage, type AccountListRow,
} from '@/domain/crm/queries/accountList'
import {
  ACCOUNT_SORT_LABELS, EMPTY_STATUS_SETS, NONE_VALUE,
  accountListHref, accountStatus, czCount, deriveStatusSets, hasActiveFilters, lastContactAt,
  pageRange, parseAccountListParams, rankByOpenPipeline, type AccountSort, type AccountStatus, type FacetOption,
} from '@/domain/crm/accountList'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { ButtonLink, buttonClass } from '@/components/ui/Button'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ClientsSegments, type ClientsSegment } from '@/components/ui/ClientsSegments'
import { ClientsTable, ClientsRowLink, type ClientsColumn } from '@/components/ui/ClientsTable'
import { Pager } from '@/components/Pager'
import { Avatar } from '@/components/Avatar'
import { formatCzk, formatDate } from '@/lib/format'
import { OPEN_DEAL_STAGES } from '@/domain/crm/sales'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { czPlural, describeDue } from '@/domain/crm/clientOverview'
import { pragueToday } from '@/lib/pragueDate'

export const dynamic = 'force-dynamic'

const FIRMY = ['firma', 'firmy', 'firem'] as const
const KLIENTI = ['klient', 'klienti', 'klientů'] as const
const PROSPEKTY = ['prospekt', 'prospekty', 'prospektů'] as const
const OBCHODY = ['otevřený obchod', 'otevřené obchody', 'otevřených obchodů'] as const

// Stavová pilulka (.st) stejná jako v záhlaví detailu klienta.
// Celé názvy tříd (ne skládané): Tailwind jinak třídy z @layer components odstraní.
const STATUS_PILL: Record<AccountStatus, { cls: string; text: string }> = {
  aktivni: { cls: 'st done', text: 'Aktivní' },
  klient: { cls: 'st info', text: 'Klient' },
  prospekt: { cls: 'st', text: 'Prospekt' },
}

// Seznam klientů po importu Obchodního radaru (~663 firem): stránkuje se po
// 50, filtruje a řadí v DB (domain/crm/queries/accountList.ts), stav filtru
// je celý v URL (sdílitelný odkaz, zpět v prohlížeči funguje). Počet dotazů
// na vykreslení je pevný — viz test/account-list-io.test.ts.
//
// Anatomie (docs/PROVOZ.md §13 „Klienti“): shrnutí v záhlaví a jedna
// hlavní akce, filtry v jednom řádku (stav jako segmenty + hledání + další
// filtry v rozbalovacím panelu), tabulka Firma · Stav · Další krok · Vlastník
// · Hodnota s celým řádkem klikacím.
export default async function ClientsPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams
  // Obchody a částky jen pro obchodní role (rozhodnutí 2026-09-28, DB: 0058).
  // Ostatním se deal vůbec nenačítá, sloupce pipeline/kroku se skryjí
  // a stav „aktivní" (otevřený obchod) ani řazení podle pipeline nenabízí.
  const canSeeSales = await canCurrentUserSeeSales()
  const params = parseAccountListParams(raw, { canSeeSales })

  const [deals, members] = await Promise.all([
    canSeeSales ? getSalesDeals() : Promise.resolve([] as Awaited<ReturnType<typeof getSalesDeals>>),
    listAssignableMembers(),
  ])
  const sets = canSeeSales ? deriveStatusSets(deals) : EMPTY_STATUS_SETS
  const ranking = canSeeSales && params.sort === 'pipeline' ? rankByOpenPipeline(deals) : []
  const [list, summary] = await Promise.all([
    listAccountsPage(params, sets, ranking),
    getAccountListSummary(sets),
  ])

  const openDealsByAccount = new Map<number, typeof deals>()
  for (const deal of deals) {
    if (!OPEN_DEAL_STAGES.includes(deal.stage)) continue
    const bucket = openDealsByAccount.get(deal.account_id) ?? []
    bucket.push(deal)
    openDealsByAccount.set(deal.account_id, bucket)
  }

  const today = pragueToday()
  const { total: allCount, missingIco } = summary.facets
  const activeCount = sets.openIds.length
  const clientCount = summary.clientCount
  const prospectCount = Math.max(0, allCount - activeCount - clientCount)
  const filtered = hasActiveFilters(params)
  const { from } = pageRange(list.page)
  const shownFrom = list.rows.length > 0 ? from + 1 : 0
  const shownTo = from + list.rows.length
  const hrefForPage = (page: number) => accountListHref({ ...params, page })

  const openAmount = [...openDealsByAccount.values()].flat()
    .reduce((sum, deal) => sum + Number(deal.amount_one_time ?? 0), 0)

  // Shrnutí v jedné větě: kolik firem, kolik z nich má rozjednaný obchod a za kolik.
  const subtitle = [
    czCount(allCount, FIRMY),
    ...(canSeeSales
      ? [`${activeCount.toLocaleString('cs-CZ')} s otevřeným obchodem${activeCount > 0 ? ` za ${formatCzk(openAmount)}` : ''}`]
      : []),
    czCount(clientCount, KLIENTI),
    czCount(prospectCount, PROSPEKTY),
  ].join(' · ')

  const segment = (status: AccountStatus | null, label: string, count: number): ClientsSegment => ({
    key: status ?? 'vse', href: accountListHref({ ...params, status, page: 1 }), label, count, active: params.status === status,
  })
  const segments: ClientsSegment[] = [
    segment(null, 'Vše', allCount),
    ...(canSeeSales ? [segment('aktivni', 'Aktivní', activeCount)] : []),
    segment('klient', 'Klienti', clientCount),
    segment('prospekt', 'Prospekty', prospectCount),
  ]

  const openOf = (a: AccountListRow) => openDealsByAccount.get(a.id) ?? []
  const nextOf = (a: AccountListRow) => openOf(a)
    .filter((deal) => deal.next_step_due)
    .sort((x, y) => (x.next_step_due ?? '').localeCompare(y.next_step_due ?? ''))[0]
  const amountOf = (a: AccountListRow) => openOf(a).reduce((sum, deal) => sum + Number(deal.amount_one_time ?? 0), 0)
  const detailLine = (a: AccountListRow) =>
    [a.ico ? `IČO ${a.ico}` : null, a.industry, a.region, a.referred_by ? `přes ${a.referred_by.name}` : null]
      .filter(Boolean).join(' · ')

  const columns: ClientsColumn<AccountListRow>[] = [
    {
      header: 'Firma',
      cell: (a) => (
        <div className="flex items-center gap-3 min-w-[14rem]">
          <Avatar name={a.name} size={32} />
          <div className="min-w-0">
            <ClientsRowLink href={`/cockpit/clients/${a.id}`}>{a.name}</ClientsRowLink>
            {detailLine(a) && <span className="block text-footnote text-muted truncate max-w-[22rem]">{detailLine(a)}</span>}
          </div>
        </div>
      ),
    },
    {
      header: 'Stav',
      cell: (a) => {
        const pill = STATUS_PILL[accountStatus(a, sets)]
        const at = lastContactAt(a)
        return (
          <div className="whitespace-nowrap">
            <span className={pill.cls}>{pill.text}</span>
            {at && <span className="block mt-1 text-footnote text-muted">naposledy {formatDate(at)}</span>}
          </div>
        )
      },
    },
    ...(canSeeSales ? [{
      header: 'Další krok',
      cell: (a: AccountListRow) => {
        const next = nextOf(a)
        if (!next) return <span className="text-muted">—</span>
        const late = describeDue(next.next_step_due, today).startsWith('po termínu')
        return (
          <div className="min-w-[10rem] max-w-[20rem]">
            <span className="block truncate text-ink">{next.next_step ?? 'Bez popisu'}</span>
            <span className={`block text-footnote ${late ? 'text-neg' : 'text-muted'}`}>
              {formatDate(next.next_step_due)} · {describeDue(next.next_step_due, today)}
            </span>
          </div>
        )
      },
    }] : []),
    { header: 'Vlastník', cell: (a) => a.owner?.full_name ?? <span className="text-muted">—</span> },
    ...(canSeeSales ? [{
      header: 'Hodnota',
      align: 'right' as const,
      cell: (a: AccountListRow) => {
        const open = openOf(a)
        if (open.length === 0) return <span className="text-muted">—</span>
        return (
          <div className="whitespace-nowrap">
            <span className="font-semibold text-ink">{formatCzk(amountOf(a))}</span>
            <span className="block text-footnote text-muted">{open.length} {czPlural(open.length, OBCHODY)}</span>
          </div>
        )
      },
    }] : []),
  ]

  return (
    <>
      <PageHeader title="Klienti" eyebrow="Firmy" subtitle={`${subtitle}.`}>
        <ButtonLink href="/cockpit/clients/new" variant="primary">Založit klienta</ButtonLink>
      </PageHeader>
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />

      <div className="mb-4 flex flex-wrap items-start gap-3">
        <ClientsSegments items={segments} label="Filtr podle stavu firmy" />
        <AccountFilters
          params={params}
          canSeeSales={canSeeSales}
          industries={summary.facets.industries}
          regions={summary.facets.regions}
          members={members.map((m) => ({ id: m.id, full_name: m.full_name }))}
          filtered={filtered}
        />
      </div>

      {[...summary.notices, ...list.notices].map((notice) => (
        <p key={notice} className="text-muted text-footnote mt-0 mb-3">{notice}</p>
      ))}

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="m-0 text-callout text-muted" aria-live="polite">
          {filtered
            ? `Filtru ${list.total === 1 ? 'odpovídá' : list.total >= 2 && list.total <= 4 ? 'odpovídají' : 'odpovídá'} ${czCount(list.total, FIRMY)}`
            : `Celkem ${czCount(list.total, FIRMY)}`}
          {list.total > 0 && ` · zobrazeno ${shownFrom.toLocaleString('cs-CZ')}–${shownTo.toLocaleString('cs-CZ')}`}
          {` · řazeno: ${ACCOUNT_SORT_LABELS[params.sort].toLowerCase()}`}
        </p>
        {missingIco > 0 && (
          // Tichý odkaz, ne banner — chybějící IČO není blokující problém,
          // jen drobná administrativa, kterou stránka /clients/doplnit-ico
          // dělá levnou (kandidáti z ARESu na jeden klik).
          <p className="m-0 text-callout text-muted">
            <Link href="/cockpit/clients/doplnit-ico" className="underline hover:text-ink">
              {czCount(missingIco, KLIENTI)} {missingIco === 1 ? 'nemá' : missingIco <= 4 ? 'nemají' : 'nemá'} vyplněné IČO — doplnit
            </Link>
            {!params.bezIco && (
              <>
                {' · '}
                <Link href={accountListHref({ ...params, bezIco: true, page: 1 })} className="underline hover:text-ink">
                  zobrazit v seznamu
                </Link>
              </>
            )}
          </p>
        )}
      </div>

      {list.rows.length === 0 ? (
        <div className={CARD}>
          {filtered ? (
            <EmptyState title="Filtru neodpovídá žádná firma." action={{ href: '/cockpit/clients', label: 'Zrušit filtry' }}>
              Zkus uvolnit filtry nebo hledat jinak napsaný název.
            </EmptyState>
          ) : (
            <EmptyState title="Zatím tu nejsou žádní klienti." action={{ href: '/cockpit/clients/new', label: 'Založit klienta' }}>
              Firmy, se kterými jednáš nebo pracuješ, se ukážou tady.
            </EmptyState>
          )}
        </div>
      ) : (
        <>
          <ul className="md:hidden m-0 p-0 list-none space-y-3" aria-label="Klienti">
            {list.rows.map((a) => {
              const pill = STATUS_PILL[accountStatus(a, sets)]
              const open = openOf(a)
              const next = nextOf(a)
              return (
                <li key={a.id} className={`${CARD} relative p-4 transition-colors duration-fast hover:bg-[color:var(--c-soft)] focus-within:bg-[color:var(--c-soft)]`}>
                  <div className="flex items-start gap-3">
                    <Avatar name={a.name} size={36} />
                    <div className="min-w-0 flex-1">
                      <ClientsRowLink href={`/cockpit/clients/${a.id}`}>{a.name}</ClientsRowLink>
                      {detailLine(a) && <span className="block text-footnote text-muted">{detailLine(a)}</span>}
                    </div>
                    <span className={pill.cls}>{pill.text}</span>
                  </div>
                  {canSeeSales && open.length > 0 && (
                    <p className="m-0 mt-3 text-callout text-[color:#3A424E]">
                      <span className="font-semibold text-ink">{formatCzk(amountOf(a))}</span>
                      {next && <span className="text-muted"> · {next.next_step ?? 'Bez popisu'} · {formatDate(next.next_step_due)}</span>}
                    </p>
                  )}
                  <p className="m-0 mt-1 text-footnote text-muted">
                    {[a.owner?.full_name, lastContactAt(a) ? `naposledy ${formatDate(lastContactAt(a))}` : null].filter(Boolean).join(' · ') || 'Bez vlastníka'}
                  </p>
                </li>
              )
            })}
          </ul>
          <div className="hidden md:block">
            <ClientsTable label="Klienti" rows={list.rows} rowKey={(a) => a.id} columns={columns} />
          </div>
        </>
      )}

      <Pager page={list.page} pageCount={list.pageCount} hrefFor={hrefForPage} label="Stránkování seznamu klientů" />
    </>
  )
}

function AccountFilters({
  params, canSeeSales, industries, regions, members, filtered,
}: {
  params: ReturnType<typeof parseAccountListParams>
  canSeeSales: boolean
  industries: FacetOption[]
  regions: FacetOption[]
  members: { id: string; full_name: string }[]
  filtered: boolean
}) {
  // Hodnota z URL, která mezi fasetami (už) není, zůstane ve výběru —
  // jinak by select tiše ukazoval „Všechny" a filtr přitom platil.
  const withCurrent = (options: FacetOption[], current: string | null) =>
    current && current !== NONE_VALUE && !options.some((o) => o.value === current)
      ? [...options, { value: current, count: 0 }]
      : options
  const sorts: AccountSort[] = canSeeSales ? ['nazev', 'aktivita', 'pipeline'] : ['nazev', 'aktivita']
  const label = 'eyebrow mb-1 block'
  // Kolik rozšířených filtrů platí (bez stavu a hledání, ty jsou vidět v řádku).
  const advancedCount = [params.obor, params.region, params.owner, params.bezIco || null, params.sort !== 'nazev' ? params.sort : null]
    .filter(Boolean).length

  return (
    // GET formulář bez JS: odeslání = nová URL (stránka se vrací na 1,
    // protože `page` ve formuláři není). Stav firmy (segmenty vedle
    // formuláře) se přenáší skrytým polem.
    <form action="/cockpit/clients" role="search" aria-label="Filtr klientů" className="flex min-w-[16rem] flex-1 flex-wrap items-center gap-2">
      {params.status && <input type="hidden" name="stav" value={params.status} />}
      <label className="relative min-w-[12rem] flex-1">
        <span className="sr-only">Hledat firmu</span>
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          type="search"
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Název nebo IČO…"
          maxLength={100}
          className="!rounded-full !pl-10"
        />
      </label>
      <button type="submit" className={buttonClass('secondary')}>Hledat</button>
      {/* Další filtry: rozbalovací panel pod tlačítkem (bez JS, <details>).
          Když některý platí, tlačítko nese jejich počet. */}
      <details className="group open:basis-full sm:relative sm:open:basis-auto">
        <summary className={`${buttonClass('outline')} list-none [&::-webkit-details-marker]:hidden`}>
          Další filtry
          {advancedCount > 0 && <span className="seg-count tabular-nums">{advancedCount}</span>}
        </summary>
        {/* Na mobilu se panel rozbalí pod řádkem v toku stránky, od sm plave pod tlačítkem. */}
        <div className={`${CARD} mt-2 w-full p-4 sm:absolute sm:right-0 sm:top-full sm:z-20 sm:w-[min(34rem,calc(100vw-2rem))] sm:shadow-e3`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={label}>Obor</span>
              <select name="obor" defaultValue={params.obor ?? ''} className="">
                <option value="">Všechny obory</option>
                {withCurrent(industries, params.obor).map((o) => (
                  <option key={o.value} value={o.value}>{o.value}{o.count > 0 ? ` (${o.count})` : ''}</option>
                ))}
                <option value={NONE_VALUE}>— bez oboru —</option>
              </select>
            </label>
            <label className="block">
              <span className={label}>Region</span>
              <select name="region" defaultValue={params.region ?? ''} className="">
                <option value="">Všechny regiony</option>
                {withCurrent(regions, params.region).map((o) => (
                  <option key={o.value} value={o.value}>{o.value}{o.count > 0 ? ` (${o.count})` : ''}</option>
                ))}
                <option value={NONE_VALUE}>— bez regionu —</option>
              </select>
            </label>
            <label className="block">
              <span className={label}>Vlastník</span>
              <select name="vlastnik" defaultValue={params.owner ?? ''} className="">
                <option value="">Všichni</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                <option value={NONE_VALUE}>— bez vlastníka —</option>
              </select>
            </label>
            <label className="block">
              <span className={label}>Řazení</span>
              <select name="sort" defaultValue={params.sort} className="">
                {sorts.map((s) => <option key={s} value={s}>{ACCOUNT_SORT_LABELS[s]}</option>)}
              </select>
            </label>
            <label className="inline-flex min-h-[44px] items-center gap-2 text-body text-ink sm:col-span-2">
              <input type="checkbox" name="bez_ico" value="1" defaultChecked={params.bezIco} className="!w-auto" />
              Jen firmy bez IČO
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="submit" className={buttonClass('secondary', 'sm')}>Použít filtry</button>
          </div>
        </div>
      </details>
      {filtered && (
        <Link
          href={accountListHref({ ...params, q: null, status: null, obor: null, region: null, owner: null, bezIco: false, page: 1 })}
          className={buttonClass('quiet')}
        >
          Zrušit filtry
        </Link>
      )}
    </form>
  )
}
