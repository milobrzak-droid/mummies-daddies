import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { buttonClass } from '@/components/ui/Button'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  EMPTY_SEARCH_RESULTS,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  normalizeSearchQuery,
  search,
  type SearchResult,
} from '@/domain/crm/queries/search'
import { canCurrentUserSeeSales } from '@/lib/queries/access'

export const dynamic = 'force-dynamic'

const GROUP_LABELS = {
  accounts: 'Firmy',
  contacts: 'Kontakty',
  deals: 'Obchody',
  partners: 'Partneři',
} as const

// Barva = druh záznamu (docs/PROVOZ.md §4): firma modrá, kontakt
// fialová, obchod žlutá, partner tyrkysová. Červená ne – ta znamená problém.
const KIND_TILE: Record<SearchResult['kind'], string> = {
  account: 'tile-sky',
  contact: 'tile-lav',
  deal: 'tile-sun',
  partner: 'tile-mint',
}

function ResultGroup({ title, items }: { title: string; items: SearchResult[] }) {
  if (items.length === 0) return null
  return (
    <section className={`${CARD} p-5 sm:p-6`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="m-0 font-heading text-title2 font-bold">{title}</h2>
        <span className="seg-count tabular-nums">{items.length}</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`}>
            <Link
              href={item.href}
              className="flex min-h-[52px] items-center gap-3 rounded-tile px-2 py-2 no-underline transition-colors duration-fast hover:bg-[color:var(--c-soft)]"
            >
              <span aria-hidden="true" className={`tile ${KIND_TILE[item.kind]} inline-grid !h-10 !w-10 shrink-0 place-items-center !p-0 font-heading text-[15px] font-bold text-ink`}>
                {(item.title.trim()[0] ?? '?').toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-headline text-ink">{item.title}</span>
              {item.subtitle && <span className="hidden max-w-[45%] truncate text-callout text-muted sm:inline">{item.subtitle}</span>}
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted"><path d="m9 18 6-6-6-6" /></svg>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default async function SearchPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const raw = (await searchParams).q ?? ''
  const query = normalizeSearchQuery(raw)
  // Obchody hledají jen obchodní role (rozhodnutí 2026-09-28, DB: 0058).
  const canSeeSales = await canCurrentUserSeeSales()
  const results = query ? await search(query, { includeDeals: canSeeSales }) : EMPTY_SEARCH_RESULTS
  const total = results.accounts.length + results.contacts.length + results.deals.length + results.partners.length

  return (
    <>
      <PageHeader title="Hledat" eyebrow="Klienti a partneři" subtitle="Firmy, kontakty, obchody a partneři na jednom místě." />

      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />

      <form method="GET" role="search" className="mb-6 flex max-w-2xl flex-wrap items-center gap-2">
        <label htmlFor="search-q" className="sr-only">Hledat</label>
        <div className="relative min-w-[220px] flex-1">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            id="search-q"
            type="text"
            name="q"
            defaultValue={raw}
            placeholder={canSeeSales ? 'Firma, kontakt, obchod nebo partner…' : 'Firma, kontakt nebo partner…'}
            minLength={SEARCH_MIN_LENGTH}
            maxLength={SEARCH_MAX_LENGTH}
            autoFocus
            className="min-h-[48px] w-full !rounded-full border border-border bg-surface !pl-11 !pr-4 text-sm font-body shadow-card focus:border-[color:var(--c-accent)]"
          />
        </div>
        <button type="submit" className={buttonClass('primary', 'lg')}>Hledat</button>
      </form>

      {!query && raw.trim().length === 0 && (
        <div className={CARD}>
          <EmptyState
            title={`Napiš aspoň ${SEARCH_MIN_LENGTH} znaky a stiskni Enter.`}
            icon={<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>}
          >
            Hledá se ve firmách, kontaktech, partnerech i v obchodech (pokud je smíš vidět). Odkudkoli to jde i přes ⌘K.
          </EmptyState>
        </div>
      )}
      {!query && raw.trim().length > 0 && (
        <p role="alert" className="rounded-tile bg-[color:var(--c-soft)] px-4 py-3 text-callout text-muted">
          Dotaz musí mít {SEARCH_MIN_LENGTH}–{SEARCH_MAX_LENGTH} znaků.
        </p>
      )}
      {query && total === 0 && (
        <div className={CARD}>
          <EmptyState title={`Nic jsme nenašli pro „${query}“.`} action={{ href: '/cockpit/clients/new', label: 'Založit klienta' }}>
            Zkus kratší nebo jinak napsaný výraz. Když firma v evidenci chybí, založ ji.
          </EmptyState>
        </div>
      )}
      {query && total > 0 && (
        <>
          <p role="status" className="mb-4 text-callout text-muted">
            Nalezeno {total} pro „{query}“.
          </p>
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            <ResultGroup title={GROUP_LABELS.accounts} items={results.accounts} />
            <ResultGroup title={GROUP_LABELS.contacts} items={results.contacts} />
            {canSeeSales && <ResultGroup title={GROUP_LABELS.deals} items={results.deals} />}
            <ResultGroup title={GROUP_LABELS.partners} items={results.partners} />
          </div>
        </>
      )}
    </>
  )
}
