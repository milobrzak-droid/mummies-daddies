import { redirect } from 'next/navigation'
import { FeaturePending } from '@/components/ui/FeaturePending'
import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { FormField } from '@/components/FormField'
import { ConfirmedBars, KindCards, KindFilter, MilestonePrompt, OverdueInvoicesCard } from '@/components/FinanceCards'
import { FinanceRecordCreatePanel } from '@/components/FinanceRecordForms'
import { FinanceRecordsTable } from '@/components/FinanceRecordsTable'
import { FinanceDiscrepancies } from '@/components/FinanceDiscrepancies'
import { TodayNote } from '@/components/ui/TodayParts'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { buttonClass } from '@/components/ui/Button'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { pragueToday } from '@/lib/pragueDate'
import { COMPANY } from '@/config'
import { listAccountOptions, listFinancialRecords } from '@/domain/finance/queries/records'
import { listOverdueInvoices, type OverdueResult } from '@/domain/finance/queries/overdue'
import { listUninvoicedMilestones } from '@/domain/finance/queries/uninvoiced'
import { getIdokladStatus, listOpenDiscrepancies } from '@/domain/finance/queries/idoklad'
import { idokladNote } from '@/domain/finance/idokladStatus'
import {
  buildFinanceBoard,
  CURRENCIES,
  isFinancialKind,
  monthLabel,
  monthOf,
  parseFinanceFilters,
  type FinancialKind,
  type FinancialRecordRow,
} from '@/domain/finance/records'

// Finance (kap. 10, 0063): čtyři oddělené druhy peněz po měsících.
// Potenciál, nasmlouváno, vyfakturováno a přijato se nikdy nesčítají do
// jednoho obratu — stránka proto nemá žádné „celkem" přes druhy.
// Jen obchodní role (rozhodnutí vlastníka; v DB sales_only).
// Anatomie (docs/PROVOZ.md §13): záhlaví s jednou akcí (Přidat záznam
// → boční panel) → filtr v jednom řádku → čtyři karty → karta faktur po
// splatnosti (jediná se sytou barvou, jen když nějaké jsou) → tabulka se součtem.
// Po splatnosti = potvrzená vyfakturovaná položka se splatností před dneškem
// bez potvrzeného záznamu Přijato se stejným číslem dokladu (0090).

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  if (!(await canCurrentUserSeeSales())) redirect('/cockpit')
  const currentMonth = monthOf(pragueToday())
  const sp = await searchParams
  const filters = parseFinanceFilters(sp, currentMonth)
  const kindParam = first(sp.druh)
  const kind: FinancialKind | null = isFinancialKind(kindParam) ? kindParam : null
  const today = pragueToday()
  const dueOnly = first(sp.splatnost) === 'po'
  const [result, accounts, milestones, overdue, discrepancies, idokladStatus] = await Promise.all([
    listFinancialRecords(filters),
    listAccountOptions(),
    listUninvoicedMilestones(),
    listOverdueInvoices({ today, accountId: filters.accountId, currency: filters.currency }),
    listOpenDiscrepancies(),
    getIdokladStatus(),
  ])
  const note = idokladNote(idokladStatus)
  const accounting = COMPANY.accountingSystem
  const filtersActive = ['od', 'do', 'firma', 'mena', 'navrhy', 'splatnost'].some((k) => first(sp[k]) !== undefined && first(sp[k]) !== '')

  // Odkaz na druh záznamů zachová ostatní filtry.
  const hrefForKind = (k: FinancialKind | null) => {
    const p = new URLSearchParams()
    for (const key of ['od', 'do', 'firma', 'mena', 'navrhy']) {
      const v = first(sp[key])
      if (v) p.set(key, v)
    }
    if (k) p.set('druh', k)
    const q = p.toString()
    return q ? `/cockpit/finance?${q}` : '/cockpit/finance'
  }

  // Odkaz z karty po splatnosti: jen nezaplacené faktury po splatnosti, ostatní filtry zůstanou.
  const dueHref = (() => {
    const p = new URLSearchParams()
    for (const key of ['firma', 'mena', 'navrhy']) {
      const v = first(sp[key])
      if (v) p.set(key, v)
    }
    p.set('druh', 'invoiced')
    p.set('splatnost', 'po')
    return `/cockpit/finance?${p.toString()}`
  })()

  const canAdd = result.state === 'ok' && accounts.length > 0
  return (
    <>
      <PageHeader
        title="Finance"
        eyebrow="Obchod"
        subtitle="Čtyři čísla, každé zvlášť: potenciál, nasmlouváno, vyfakturováno a přijato se nesčítají do jednoho obratu."
      >
        {canAdd && <FinanceRecordCreatePanel accounts={accounts} defaultMonth={currentMonth} accountingSystem={accounting} />}
      </PageHeader>

      <div className="flex flex-col gap-6">
        {/* TodayNote nese vlastní horní okraj; v sloupci s mezerou ho vyrovnáme. */}
        <div className="-mt-4"><TodayNote problem={note.tone === 'problem'}>{note.text}</TodayNote></div>

        {discrepancies.state === 'ok' && discrepancies.rows.length > 0 && (
          <FinanceDiscrepancies rows={discrepancies.rows} total={discrepancies.total} accounts={accounts} />
        )}
        {discrepancies.state === 'error' && (
          <TodayNote problem>Rozdíly z iDokladu se nepodařilo načíst. Zkus to prosím za chvíli.</TodayNote>
        )}
        {discrepancies.state === 'missing_migration' && idokladStatus.enabled && (
          <TodayNote><FeaturePending variant="inline" migration="0092" title="Porovnání s iDokladem se připravuje." /></TodayNote>
        )}

        <form method="get" aria-label="Filtr finančních záznamů" className={`${CARD} flex flex-wrap items-end gap-3 px-4 py-3`}>
          {kind && <input type="hidden" name="druh" value={kind} />}
          <div className="w-[calc(50%-6px)] sm:w-40">
            <FormField label="Od měsíce">
              <input type="month" name="od" defaultValue={filters.from} className="w-full" />
            </FormField>
          </div>
          <div className="w-[calc(50%-6px)] sm:w-40">
            <FormField label="Do měsíce">
              <input type="month" name="do" defaultValue={filters.to} className="w-full" />
            </FormField>
          </div>
          <div className="w-full min-w-[12rem] sm:w-auto sm:flex-1">
            <FormField label="Firma">
              <select name="firma" defaultValue={filters.accountId ?? ''} className="w-full">
                <option value="">Všechny</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </FormField>
          </div>
          <div className="w-[calc(50%-6px)] sm:w-28">
            <FormField label="Měna">
              <select name="mena" defaultValue={filters.currency ?? ''} className="w-full">
                <option value="">Všechny</option>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </FormField>
          </div>
          <div className="w-[calc(50%-6px)] sm:w-40">
            <FormField label="Návrhy">
              <select name="navrhy" defaultValue={filters.showDrafts ? '1' : '0'} className="w-full">
                <option value="1">Zobrazit</option>
                <option value="0">Jen potvrzené</option>
              </select>
            </FormField>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" className={buttonClass('secondary')}>Filtrovat</button>
            {filtersActive && <Link href={kind ? `/cockpit/finance?druh=${kind}` : '/cockpit/finance'} className={buttonClass('quiet')}>Zrušit filtry</Link>}
          </div>
        </form>

        {result.state === 'missing_migration' && (
          <FeaturePending card migration="0063">
            Pak tu půjde zapisovat potenciál, nasmlouvané, vyfakturované a přijaté částky.
          </FeaturePending>
        )}
        {result.state === 'error' && (
          <div className={CARD}>
            <EmptyState title="Finanční záznamy se nepodařilo načíst." action={{ href: '/cockpit/finance', label: 'Zkusit znovu' }}>
              Zkus to prosím za chvíli.
            </EmptyState>
          </div>
        )}
        {result.state === 'ok' && accounts.length === 0 && (
          <div className={CARD}>
            <EmptyState title="Zatím tu není žádná firma." action={{ href: '/cockpit/clients/new', label: 'Založit klienta' }}>
              Finanční záznam patří vždy k firmě. Nejdřív ji založ v sekci Klienti.
            </EmptyState>
          </div>
        )}
        {result.state === 'ok' && (
          <FinanceBoardView
            records={filters.showDrafts ? result.records : result.records.filter((r) => r.status !== 'draft')}
            showDrafts={filters.showDrafts}
            accounting={accounting}
            currentMonth={currentMonth}
            kind={dueOnly ? 'invoiced' : kind}
            hrefForKind={hrefForKind}
            milestones={milestones}
            overdue={overdue}
            dueHref={dueHref}
            dueOnly={dueOnly}
            periodLabel={`${monthLabel(filters.from)} až ${monthLabel(filters.to)}`}
          />
        )}
      </div>
    </>
  )
}

function FinanceBoardView({
  records,
  showDrafts,
  accounting,
  currentMonth,
  kind,
  hrefForKind,
  milestones,
  periodLabel,
  overdue,
  dueHref,
  dueOnly,
}: {
  records: (FinancialRecordRow & { account_name: string | null })[]
  showDrafts: boolean
  accounting: string
  currentMonth: string
  kind: FinancialKind | null
  hrefForKind: (k: FinancialKind | null) => string
  milestones: Awaited<ReturnType<typeof listUninvoicedMilestones>>
  periodLabel: string
  overdue: OverdueResult
  dueHref: string
  dueOnly: boolean
}) {
  const board = buildFinanceBoard(records)
  // Filtr „po splatnosti" čte faktury napříč obdobími (stejně jako karta), aby tabulka sedla s číslem na kartě.
  const shown = dueOnly && overdue.state === 'ok' ? overdue.rows : kind ? records.filter((r) => r.kind === kind) : records
  const overdueDays = new Map(overdue.state === 'ok' ? overdue.rows.map((r) => [r.id, r.daysLate] as const) : [])
  return (
    <>
      <section aria-labelledby="fin-kinds-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="fin-kinds-h" className="m-0 text-title1">Čtyři druhy peněz</h2>
          <p className="m-0 text-callout text-muted">{periodLabel}{showDrafts ? ' · včetně návrhů' : ' · jen potvrzené'}</p>
        </div>
        <KindCards board={board} showDrafts={showDrafts} currentMonth={currentMonth} />
      </section>

      <OverdueInvoicesCard result={overdue} href={dueHref} />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="flex min-w-0 flex-col gap-3" aria-labelledby="fin-records-h">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="fin-records-h" className="m-0 text-title1">Záznamy</h2>
            {dueOnly && (
              <p className="m-0 text-callout text-muted">
                Jen faktury po splatnosti · <Link href={hrefForKind('invoiced')} className="font-semibold underline">Zobrazit všechny</Link>
              </p>
            )}
          </div>
          <FinanceRecordsTable
            rows={shown}
            overdue={overdueDays}
            kind={kind}
            showDrafts={showDrafts}
            accountingSystem={accounting}
            toolbar={<KindFilter current={kind} hrefFor={hrefForKind} />}
          />
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          {milestones.state === 'ok' && <MilestonePrompt milestones={milestones.milestones} />}
          {showDrafts && <ConfirmedBars board={board} />}
        </div>
      </div>
    </>
  )
}
