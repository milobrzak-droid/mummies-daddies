// Prezentační díly stránky Finance: čtyři bílé karty s barevným proužkem
// (každý druh peněz zvlášť, nikdy součet přes druhy), pruhy potvrzeno/návrh,
// značky druhu a stavu, filtr druhu, výzva k milníkům bez podkladu
// k fakturaci a karta faktur po splatnosti. Plná barva má jediná karta:
// nezaplacené faktury po splatnosti (když nějaké jsou); jinak je stránka klidná.
// Serverové komponenty nad daty z domain/finance/records.ts.
import Link from 'next/link'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { Card } from '@/components/ui/Card'
import { buttonClass } from '@/components/ui/Button'
import { KindAmounts } from '@/components/FinanceKindTotals'
import { summarizeBars, type BarChartDatum } from '@/components/BarChart'
import {
  CURRENCIES,
  FINANCIAL_KINDS,
  FINANCIAL_KIND_LABEL,
  formatMoney,
  totalOverdue,
  type Currency,
  type FinanceBoard,
  type FinancialKind,
  type FinancialStatus,
  type KindColumn,
} from '@/domain/finance/records'
import type { UninvoicedMilestone } from '@/domain/finance/queries/uninvoiced'
import type { OverdueResult } from '@/domain/finance/queries/overdue'

// Druh peněz = barva značky (proužek karty a tečka): fialová potenciál
// (rozhoduje se), modrá nasmlouváno (probíhá), žlutá vyfakturováno (čeká na
// platbu), tyrkysová přijato (hotovo). Tečka je datový tón --d-*.
const KIND_STYLE: Record<FinancialKind, { tile: string; dot: string; bar: string }> = {
  potential: { tile: 'tile-lav', dot: 'var(--d-violet)', bar: 'violet' },
  contracted: { tile: 'tile-sky', dot: 'var(--d-blue)', bar: 'blue' },
  invoiced: { tile: 'tile-sun', dot: 'var(--d-yellow)', bar: 'yellow' },
  received: { tile: 'tile-mint', dot: 'var(--d-turquoise)', bar: 'turquoise' },
}

const SHORT_MONTHS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro']
const shortMonth = (m: string) => SHORT_MONTHS[Number(m.slice(5, 7)) - 1] ?? m

const SYMBOL: Record<Currency, string> = { CZK: 'Kč', EUR: '€' }
const num = (n: number, digits = 2) => new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: digits }).format(n)

/** Velké číslo karty: 2 670 300 → „2,67" + „mil. Kč". */
export function splitMoney(amount: number, currency: Currency): { value: string; unit: string } {
  const sym = SYMBOL[currency]
  if (amount >= 1_000_000) return { value: num(amount / 1_000_000), unit: `mil. ${sym}` }
  if (amount >= 1_000) return { value: num(amount / 1_000, 1), unit: `tis. ${sym}` }
  return { value: num(amount, 0), unit: sym }
}

function primaryCurrency(col: KindColumn<FinancialKind>): Currency | null {
  const has = (c: Currency) => {
    const v = col.total.byCurrency[c]
    return !!v && (v.confirmed > 0 || v.draft > 0)
  }
  return CURRENCIES.find(has) ?? null
}

function plural(n: number, one: string, few: string, many: string) {
  return `${n} ${n === 1 ? one : n < 5 && n > 0 ? few : many}`
}

/** Druh peněz: barevná tečka + slovo (barva nikdy sama). */
export function KindBadge({ kind }: { kind: FinancialKind }) {
  const st = KIND_STYLE[kind]
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-callout font-semibold text-ink">
      <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: st.dot }} />
      {FINANCIAL_KIND_LABEL[kind]}
    </span>
  )
}

const STATUS_CLS: Record<FinancialStatus, string> = { draft: 'st', confirmed: 'st done', cancelled: 'st fail' }
export function StatusPill({ status, label }: { status: FinancialStatus; label: string }) {
  return <span className={STATUS_CLS[status]}>{label}</span>
}

// --- Čtyři karty -------------------------------------------------------------

export function KindCard({
  col,
  showDrafts,
  currentMonth,
}: {
  col: KindColumn<FinancialKind>
  showDrafts: boolean
  currentMonth: string
}) {
  const st = KIND_STYLE[col.kind]
  const cur = primaryCurrency(col)
  const totals = cur ? col.total.byCurrency[cur]! : null
  const bigAmount = totals ? (totals.confirmed > 0 || !showDrafts ? totals.confirmed : totals.draft) : 0
  const big = cur ? splitMoney(bigAmount, cur) : null
  const count = CURRENCIES.reduce((s, c) => s + (col.total.byCurrency[c]?.count ?? 0), 0)

  // Poslední měsíce s daty (nejvýš 6), od nejstaršího; výška jen z hlavní měny.
  const months = cur
    ? col.months
        .slice(0, 6)
        .reverse()
        .map((m) => {
          const v = m.byCurrency[cur]
          return { month: m.month, value: v ? v.confirmed + (showDrafts ? v.draft : 0) : 0 }
        })
    : []
  const max = Math.max(1, ...months.map((m) => m.value))
  const data: BarChartDatum[] = months.map((m) => ({ label: shortMonth(m.month), value: m.value }))

  return (
    <section className={`tile ${st.tile} flex min-h-[248px] flex-col gap-2 !p-5`} aria-labelledby={`fin-${col.kind}`}>
      <div className="flex h-7 items-center gap-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: st.dot }} />
        <h2 id={`fin-${col.kind}`} className="m-0 flex-1 text-headline">{col.label}</h2>
      </div>
      <div className="big-num whitespace-nowrap text-[clamp(34px,3.6vw,48px)] text-ink">
        {big ? big.value : '—'}
        {big && <small className="ml-1 text-base font-bold text-muted">{big.unit}</small>}
      </div>
      <div>
        <div className="text-footnote font-semibold text-ink">{count === 0 ? 'Zatím nic' : plural(count, 'záznam', 'záznamy', 'záznamů')}</div>
        <div className="mt-0.5 text-footnote text-muted">
          {count === 0 ? 'V tomto období nic.' : <KindAmounts totals={col.total} showDrafts={showDrafts} />}
        </div>
      </div>
      {months.length > 0 && (
        <div className="mt-auto">
          <div
            role="img"
            aria-label={summarizeBars(data, `${col.label} po měsících`, (v) => (cur ? formatMoney(v, cur) : String(v)))}
            className="flex h-16 items-end gap-1.5"
          >
            {months.map((m) => {
              const cls = m.month === currentMonth
              return (
                <i
                  key={m.month}
                  aria-hidden="true"
                  className="block flex-1 rounded-xl"
                  style={
                    m.value === 0
                      ? { height: 5, border: '1.5px dashed rgba(20,25,34,.3)' }
                      : {
                          height: `${Math.max(10, (m.value / max) * 100)}%`,
                          border: `1px solid ${cls ? 'var(--c-navy)' : 'var(--c-hatch-line)'}`,
                          background: cls
                            ? 'repeating-linear-gradient(135deg,transparent 0 5px,rgba(255,255,255,.35) 5px 6px),var(--c-navy)'
                            : 'repeating-linear-gradient(135deg,transparent 0 5px,rgba(20,25,34,.3) 5px 6px),rgba(255,255,255,.8)',
                        }
                  }
                />
              )
            })}
          </div>
          <div aria-hidden="true" className="mt-1.5 flex gap-1.5 text-center text-[11px] font-semibold text-muted">
            {months.map((m) => (
              <span key={m.month} className={`flex-1 ${m.month === currentMonth ? 'font-extrabold text-ink' : ''}`}>{shortMonth(m.month)}</span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

export function KindCards({ board, showDrafts, currentMonth }: { board: FinanceBoard; showDrafts: boolean; currentMonth: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {FINANCIAL_KINDS.map((k) => (
        <KindCard key={k} col={board[k]} showDrafts={showDrafts} currentMonth={currentMonth} />
      ))}
    </div>
  )
}

// --- Potvrzeno vs. návrhy po druhu (proužkované pruhy) -----------------------

export function ConfirmedBars({ board }: { board: FinanceBoard }) {
  return (
    <Card title="Kolik je potvrzeno" sub="U každého druhu zvlášť: potvrzené částky proti návrhům.">
      <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
        {FINANCIAL_KINDS.map((k) => {
          const col = board[k]
          const cur = primaryCurrency(col)
          const v = cur ? col.total.byCurrency[cur] : null
          const all = v ? v.confirmed + v.draft : 0
          const pct = v && all > 0 ? Math.round((v.confirmed / all) * 100) : 0
          return (
            <li key={k} className="text-callout">
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="font-semibold">{col.label}</span>
                <b className={`tabular-nums ${v ? '' : 'font-semibold text-muted'}`}>
                  {v && cur ? `${formatMoney(v.confirmed, cur)} | návrh ${formatMoney(v.draft, cur)}` : 'nic'}
                </b>
              </div>
              <div
                role="img"
                aria-label={`${col.label}: ${pct} % potvrzeno${cur ? ` (${cur})` : ''}`}
                className={`bar thin ${KIND_STYLE[k].bar}`}
              >
                <i style={{ width: `${pct}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// --- Filtr druhů pro tabulku záznamů ------------------------------------------

export function KindFilter({ current, hrefFor }: { current: FinancialKind | null; hrefFor: (k: FinancialKind | null) => string }) {
  const item = (k: FinancialKind | null, label: string) => (
    <Link key={k ?? 'all'} href={hrefFor(k)} aria-current={current === k ? 'page' : undefined} className="seg-item">
      {label}
    </Link>
  )
  return (
    <nav aria-label="Druh záznamů" className="seg">
      {item(null, 'Vše')}
      {FINANCIAL_KINDS.map((k) => item(k, FINANCIAL_KIND_LABEL[k]))}
    </nav>
  )
}

// --- Výzva: přijaté milníky bez podkladu k fakturaci -------------------------

export function MilestonePrompt({ milestones }: { milestones: UninvoicedMilestone[] }) {
  if (milestones.length === 0) {
    return (
      <section className="tile tile-mint flex items-center gap-3.5 !p-5" aria-labelledby="fin-ms-h">
        <span className="chk done" aria-hidden="true">✓</span>
        <div>
          <h2 id="fin-ms-h" className="m-0 text-headline">Všechny přijaté milníky mají podklad</h2>
          <p className="m-0 mt-1 text-callout text-muted">Žádný přijatý milník nečeká na fakturaci.</p>
        </div>
      </section>
    )
  }
  const first = milestones[0]
  const href = `/cockpit/clients/${first.account_id}/engagements/${first.engagement_id}/edit`
  // Klidná karta (bílá se žlutým proužkem): sytou barvu má jen faktura po splatnosti.
  return (
    <section className="tile tile-sun flex flex-col gap-2.5 !p-5" aria-labelledby="fin-ms-h">
      <h2 id="fin-ms-h" className="m-0 text-title2">Přijaté milníky bez fakturačního podkladu</h2>
      <div className="big-num text-[34px]">
        {milestones.length}
        <small className="ml-1.5 text-base font-bold">
          {milestones.length === 1 ? 'milník' : milestones.length < 5 ? 'milníky' : 'milníků'}
        </small>
      </div>
      <p className="m-0 text-callout">
        Klient je přijal, ale zatím z nich nejde vystavit faktura. Podklad se zakládá u milníku v dodávce.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-callout">
        {milestones.slice(0, 4).map((m) => (
          <li key={m.id} className="flex min-w-0 items-baseline gap-2">
            <Link href={`/cockpit/clients/${m.account_id}/engagements/${m.engagement_id}/edit`} className="font-bold underline">
              {m.account_name ?? `Firma #${m.account_id}`}
            </Link>
            <span className="min-w-0 truncate">· {m.title}</span>
          </li>
        ))}
      </ul>
      {milestones.length > 4 && <p className="m-0 text-footnote">A dalších {milestones.length - 4}.</p>}
      <Link href={href} className={buttonClass('secondary', 'md', 'mt-2 self-start')}>
        Vytvořit fakturační podklad
      </Link>
    </section>
  )
}

// --- Faktury po splatnosti (jediná karta se sytou barvou) --------------------

/**
 * Nezaplacené potvrzené faktury po splatnosti: součet po měnách (měny se
 * nesčítají), počet, nejdelší prodlení a odkaz na filtr tabulky. Sytá barva
 * jen když nějaké jsou; jinak klidná bílá karta (i když se splatnost teprve
 * připravuje nebo se nenačetla – pak to karta řekne, ne mlčí).
 */
export function OverdueInvoicesCard({ result, href }: { result: OverdueResult; href: string }) {
  if (result.state === 'missing_migration' || result.state === 'error') {
    return (
      <section className="tile tile-sun flex items-center gap-3.5 !p-5" aria-labelledby="fin-due-h">
        <div>
          <h2 id="fin-due-h" className="m-0 text-headline">Faktury po splatnosti</h2>
          <p className="m-0 mt-1 text-callout text-muted">
            {result.state === 'missing_migration'
              ? <FeaturePending variant="inline" migration="0090" title="Hlídání splatnosti se připravuje. Zatím se po splatnosti nehlídá." />
              : 'Splatnost faktur se nepodařilo načíst. Zkus to prosím za chvíli.'}
          </p>
        </div>
      </section>
    )
  }
  const rows = result.rows
  if (rows.length === 0) {
    return (
      <section className="tile tile-mint flex items-center gap-3.5 !p-5" aria-labelledby="fin-due-h">
        <span className="chk done" aria-hidden="true">✓</span>
        <div>
          <h2 id="fin-due-h" className="m-0 text-headline">Nic není po splatnosti</h2>
          <p className="m-0 mt-1 text-callout text-muted">
            Žádná potvrzená faktura nečeká na platbu déle, než měla. Hlídají se jen faktury s vyplněnou splatností.
          </p>
        </div>
      </section>
    )
  }
  const totals = totalOverdue(rows)
  const oldest = Math.max(...rows.map((r) => r.daysLate))
  const amounts = CURRENCIES.flatMap((c) => {
    const v = totals.byCurrency[c]
    return v && v.confirmed > 0 ? [{ c, amount: v.confirmed }] : []
  })
  return (
    <section className="tile tile-peach tile-solid flex flex-col gap-3 !p-5 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="fin-due-h">
      <div className="flex min-w-0 flex-col gap-2">
        <h2 id="fin-due-h" className="m-0 text-title2">Po splatnosti a nezaplaceno</h2>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          {amounts.map(({ c, amount }) => {
            const big = splitMoney(amount, c)
            return (
              <div key={c} className="big-num whitespace-nowrap text-[34px]">
                <span aria-hidden="true">{big.value}<small className="ml-1 text-base font-bold">{big.unit}</small></span>
                <span className="sr-only">{formatMoney(amount, c)}</span>
              </div>
            )
          })}
        </div>
        <p className="m-0 text-callout">
          {plural(rows.length, 'faktura', 'faktury', 'faktur')} po splatnosti, nejdéle o {plural(oldest, 'den', 'dny', 'dní')}. K faktuře zatím není potvrzený záznam Přijato se stejným číslem dokladu.
        </p>
      </div>
      <Link href={href} className={buttonClass('secondary', 'md', 'self-start sm:self-center')}>
        Zobrazit faktury
      </Link>
    </section>
  )
}
