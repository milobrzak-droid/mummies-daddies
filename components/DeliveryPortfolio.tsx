import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatDate } from '@/lib/format'
import { formatHoursValue } from '@/domain/delivery/capacity'
import {
  RISK_STATE_LABEL, daysText, shortDay,
  type PortfolioFilter, type PortfolioItem, type PortfolioScope, type PortfolioSummary, type RiskReason, type RiskState,
} from '@/domain/delivery/portfolio'
import type { StageSlice } from '@/domain/crm/today'
import { plural } from '@/domain/crm/today'
import { TodayBar, TodayStageRing } from '@/components/ui/TodayParts'
import { CARD, CARD_PAD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { WorkLogo, WorkStatus, type WorkStatusTone } from '@/components/WorkUi'

// Portfolio dodávek (/dodavky). Karta na každou běžící dodávku, klávesy se
// souhrnem, prstenec stavů a pruhy postupu. Čistě prezentační (server
// komponenty); data i řazení podle rizika dodává stránka.

/** Odkaz na portfolio s filtry (čisté adresy: výchozí hodnoty se vynechají). */
export function portfolioHref(opts: { scope?: PortfolioScope; filter?: PortfolioFilter | null } = {}): string {
  const p = new URLSearchParams()
  if (opts.scope === 'moje') p.set('kdo', 'moje')
  if (opts.filter) p.set('stav', opts.filter)
  const q = p.toString()
  return q ? `/cockpit/dodavky?${q}` : '/cockpit/dodavky'
}

// ── klávesy se souhrnem ────────────────────────────────────────────────────

type KeySpec = { key: string; label: string; n: number; cls: string; filter: PortfolioFilter | null }

/** Čtyři čísla ze zadání (+ „Bez pohybu" na stránce). Nenulová klávesa je odkaz na filtr
 *  v plné barvě; nula je klidná bílá dlaždice bez odkazu (docs/PROVOZ.md §5). */
export function PortfolioKeys({
  summary, scope = 'vse', active, withStale = false,
}: { summary: PortfolioSummary; scope?: PortfolioScope; /** undefined = bez zvýraznění (panel na Dnes) */ active?: PortfolioFilter | null; withStale?: boolean }) {
  // Třídy jsou napsané celé (Tailwind je hledá ve zdrojácích components/).
  const keys: KeySpec[] = [
    { key: 'active', label: 'Aktivní dodávky', n: summary.active, cls: 'keycap keycap-blue', filter: null },
    { key: 'late', label: 'Po termínu', n: summary.late, cls: 'keycap keycap-red', filter: 'po-terminu' },
    { key: 'waiting', label: 'Čekají na klienta', n: summary.waitingClient, cls: 'keycap keycap-yellow', filter: 'ceka-na-klienta' },
    { key: 'blocked', label: 'Blokované', n: summary.blocked, cls: 'keycap keycap-violet', filter: 'blokovane' },
  ]
  if (withStale) keys.push({ key: 'stale', label: 'Bez pohybu', n: summary.stale, cls: 'keycap keycap-white', filter: 'bez-pohybu' })
  return (
    <ul className={`m-0 grid list-none grid-cols-2 gap-5 p-0 pb-2 pr-2 ${withStale ? 'sm:grid-cols-3 xl:grid-cols-5' : 'sm:grid-cols-4'}`}>
      {keys.map((k) => (
        <li key={k.key} className="contents">
          {k.n === 0 ? (
            // Nula nic neříká: klidná bílá dlaždice bez hrany a bez odkazu.
            <div className="tile tile-pink flex min-h-[104px] flex-col justify-between p-4">
              <span className="eyebrow">{k.label}</span>
              <span className="big-num mt-2 block text-[34px] text-[color:var(--c-slate)]">0</span>
            </div>
          ) : (
            <Link
              href={portfolioHref({ scope, filter: k.filter })}
              aria-label={`${k.label}: ${k.n}`}
              aria-current={active !== undefined && active === k.filter ? 'page' : undefined}
              className={`${k.cls} min-h-[104px] flex-col justify-between p-4`}
            >
              <span className="eyebrow !text-[color:#17202E]">{k.label}</span>
              <span className="big-num mt-2 block text-[34px] text-[color:#17202E]">{k.n}</span>
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}

// ── prstenec stavů ─────────────────────────────────────────────────────────

const STATE_COLOR: Record<RiskState, string> = {
  late: 'var(--d-red)', blocked: 'var(--d-orange)', waiting: 'var(--d-blue)', stale: 'var(--d-amber)', ok: 'var(--d-green)',
}
const STATE_ORDER: RiskState[] = ['late', 'blocked', 'waiting', 'stale', 'ok']

export function stateSlices(summary: PortfolioSummary): StageSlice[] {
  return STATE_ORDER.map((k) => ({ key: k, label: RISK_STATE_LABEL[k], color: STATE_COLOR[k], count: summary.byState[k], value: 0 }))
}

export function PortfolioRingCard({ summary }: { summary: PortfolioSummary }) {
  return (
    <Card title="Stav dodávek" sub="Každá dodávka je započtená jednou, podle nejzávažnějšího stavu.">
      {summary.active === 0
        ? <EmptyState compact title="Zatím žádná aktivní dodávka">Až nějaká vznikne, ukáže se tady.</EmptyState>
        : <TodayStageRing slices={stateSlices(summary)} centerLabel="dodávek" subject="Stav aktivních dodávek" emptyText="žádná aktivní dodávka" />}
    </Card>
  )
}

export function PortfolioImpactCard({ summary }: { summary: PortfolioSummary }) {
  const n = summary.active
  const pct = (v: number) => (n === 0 ? 0 : Math.round((v / n) * 100))
  return (
    <Card title="Dopad a reference" sub="Z měření a souhlasů zapsaných u dodávek.">
      {n === 0 ? (
        <EmptyState compact title="Zatím žádná aktivní dodávka">Dopad a reference se počítají z aktivních dodávek.</EmptyState>
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <div className="flex items-baseline justify-between gap-3 text-body">
              <b>Dopad změřený před i po</b>
              <span className="tabular-nums text-muted">{summary.withImpact} z {n}</span>
            </div>
            <div className="mt-2"><TodayBar pct={pct(summary.withImpact)} color="green" label={`Dopad je změřený u ${summary.withImpact} z ${n} aktivních dodávek`} /></div>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-3 text-body">
              <b>Reference se souhlasem klienta</b>
              <span className="tabular-nums text-muted">{summary.withReference} z {n}</span>
            </div>
            <div className="mt-2"><TodayBar pct={pct(summary.withReference)} color="blue" label={`Doložený souhlas s referencí je u ${summary.withReference} z ${n} aktivních dodávek`} /></div>
          </div>
          <p className="m-0 text-callout text-muted">
            {summary.withImpact === 0
              ? 'Zatím žádná dodávka nemá změřený výchozí stav i výsledek. Měření se zapisuje v záložce Dopad u dodávky.'
              : 'Měření a souhlasy se zapisují u dodávky (záložky Dopad a Reference).'}
          </p>
        </div>
      )}
    </Card>
  )
}

// ── karta dodávky ──────────────────────────────────────────────────────────

const REASON_TONE: Record<RiskReason['key'], WorkStatusTone> = {
  late: 'fail', milestone_late: 'fail', blocked: 'fail', waiting: 'wait', stale: 'idle', no_owner: 'wait', overloaded: 'wait',
}

function Facet({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 text-[13.5px] leading-snug text-ink">{children}</div>
    </div>
  )
}

function dueText(item: NonNullable<PortfolioItem['nextMilestone']>): string {
  if (!item.dueOn || item.daysToDue === null) return 'bez termínu'
  const d = item.daysToDue
  const when = d < 0 ? `o ${daysText(-d)} po termínu` : d === 0 ? 'dnes' : `za ${daysText(d)}`
  return `do ${formatDate(item.dueOn)} (${when})`
}

function moveText(days: number | null, day: string | null): string {
  if (days === null || !day) return 'Bez záznamu o pohybu'
  const ago = days === 0 ? 'dnes' : days === 1 ? 'včera' : `před ${days} dny`
  return `${ago} (${shortDay(day)})`
}

export function PortfolioCard({ item }: { item: PortfolioItem }) {
  const p = item.progress
  const cap = item.capacity
  const capPct = cap ? (cap.capacity > 0 ? (cap.load / cap.capacity) * 100 : cap.load > 0 ? 100 : 0) : 0
  const capColor = cap?.overloaded ? 'red' : capPct >= 85 ? 'amber' : 'green'
  const acceptedPct = p.total > 0 ? Math.round((p.accepted / p.total) * 100) : 0
  const titleId = `dodavka-${item.id}`
  return (
    <article aria-labelledby={titleId} className={`${CARD} ${CARD_PAD} flex min-w-0 flex-col gap-4`}>
      <header className="flex items-start gap-3">
        <WorkLogo name={item.accountName} size={38} />
        <div className="min-w-0 flex-1">
          <Link href={`/cockpit/clients/${item.accountId}`} className="eyebrow inline-block max-w-full truncate no-underline hover:text-ink">{item.accountName}</Link>
          <h3 id={titleId} className="m-0 mt-0.5 font-heading text-title2 font-bold">
            <Link href={item.href} className="text-ink no-underline hover:text-ink hover:underline">{item.title}</Link>
          </h3>
          <p className="m-0 mt-1 text-xs text-muted">
            {item.kindLabel} · fáze {item.phaseLabel} · {item.dueOn ? `termín ${formatDate(item.dueOn)}` : 'bez termínu'}
          </p>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {item.reasons.length === 0
          ? <WorkStatus tone="done">V pořádku</WorkStatus>
          : item.reasons.map((r) => <WorkStatus key={r.key} tone={REASON_TONE[r.key]}>{r.text}</WorkStatus>)}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <section aria-label="Co je slíbeno" className="tile tile-lav">
          <div className="eyebrow !text-[color:#39414D]">Co je slíbeno</div>
          <p className="m-0 mt-1.5 text-[14px] leading-snug text-ink">{item.promised.text ?? 'Rozsah zatím není zapsaný.'}</p>
          <p className="m-0 mt-1.5 text-xs text-[color:#39414D]">{item.promised.caption}</p>
        </section>
        <section aria-label="Další milník" className="tile tile-sky">
          <div className="eyebrow !text-[color:#39414D]">Další milník</div>
          {item.nextMilestone ? (
            <>
              <b className="mt-1.5 block text-[14.5px] leading-snug">{item.nextMilestone.title}</b>
              <p className="m-0 mt-0.5 text-[13px] text-[color:#39414D]">{item.nextMilestone.statusLabel} · {dueText(item.nextMilestone)}</p>
            </>
          ) : (
            <p className="m-0 mt-1.5 text-[14px] leading-snug">
              {p.total === 0 ? 'Milníky zatím nejsou zapsané.' : 'Všechny milníky jsou přijaté.'}
            </p>
          )}
          {p.total > 0 && (
            <div className="mt-3">
              <TodayBar pct={acceptedPct} color="green" label={`Klient přijal ${p.accepted} z ${p.total} milníků`} />
              <p className="m-0 mt-1.5 text-xs text-[color:#39414D]">
                Klient přijal {p.accepted} z {p.total} {plural(p.total, 'milníku', 'milníků', 'milníků')}
                {p.lastAcceptedOn ? `, naposledy ${shortDay(p.lastAcceptedOn)}` : ''}
              </p>
            </div>
          )}
        </section>
      </div>

      <section aria-label="Co čeká" className="grid grid-cols-3 gap-3 rounded-tile border border-border p-3.5">
        <Facet label="Na nás"><b className="big-num text-[24px]">{item.waits.us}</b></Facet>
        <Facet label="Na klienta"><b className="big-num text-[24px]">{item.waits.client}</b></Facet>
        <Facet label="Na schválení"><b className="big-num text-[24px]">{item.waits.approval}</b></Facet>
        {item.waits.blockedTasks > 0 && (
          <p className="col-span-3 m-0 text-[13px] text-neg">
            Blokováno: {item.waits.blockedTasks} {plural(item.waits.blockedTasks, 'úkol', 'úkoly', 'úkolů')}
          </p>
        )}
      </section>

      <details className="group rounded-tile border border-border">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-tile px-3.5 text-callout font-semibold text-ink hover:bg-[color:var(--c-soft)] [&::-webkit-details-marker]:hidden">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
          Lidé, kapacita a dopad
          <span className="ml-auto truncate text-footnote font-normal text-muted">{item.ownerName ?? 'bez vlastníka'}</span>
        </summary>
        <div className="grid gap-4 px-3.5 pb-3.5 pt-1 md:grid-cols-2">
          <Facet label="Kdo za to odpovídá">
            <div>Vlastník: <b>{item.ownerName ?? 'není určený'}</b></div>
            <div>Zástupce: <b>{item.deputyName ?? 'není určený'}</b></div>
            <div className="mt-2">
              {item.ownerId === null ? (
                <span className="text-muted">Bez vlastníka nelze ukázat kapacitu.</span>
              ) : cap ? (
                <>
                  <TodayBar pct={capPct} color={capColor} label={`Zatížení vlastníka tento týden: ${formatHoursValue(cap.load)} z ${formatHoursValue(cap.capacity)} hodin${cap.overloaded ? ', přetíženo' : ''}`} />
                  <div className={`mt-1 text-xs ${cap.overloaded ? 'font-semibold text-neg' : 'text-muted'}`}>
                    Kapacita vlastníka tento týden: {formatHoursValue(cap.load)} z {formatHoursValue(cap.capacity)} h{cap.overloaded ? ' (přetíženo)' : ''}
                  </div>
                </>
              ) : (
                <span className="text-muted">Kapacitu vlastníka se nepodařilo zjistit.</span>
              )}
            </div>
          </Facet>
          <Facet label="Stáří informace a dopad">
            <div className={item.flags.stale ? 'font-semibold text-neg' : ''}>Poslední pohyb: {moveText(item.lastMove.days, item.lastMove.at)}</div>
            <div className="mt-1">
              {item.impact
                ? <>Dopad: <b>{item.impact.metric}</b> {item.impact.baseline.toLocaleString('cs-CZ')} → {item.impact.actual.toLocaleString('cs-CZ')}{item.impact.unit ? ` ${item.impact.unit}` : ''}, změna {item.impact.change}</>
                : <span className="text-muted">Dopad zatím není změřený.</span>}
            </div>
            {item.reference !== 'none' && (
              <div className="mt-1">Reference: {item.reference === 'consent' ? 'souhlas klienta je doložený' : 'čeká na souhlas klienta'}</div>
            )}
          </Facet>
        </div>
      </details>

      <section aria-label="Co musí udělat vedení" className={`tile ${item.leadership.length ? 'tile-sun' : 'tile-mint'}`}>
        <div className="eyebrow !text-[color:#39414D]">Co musí udělat vedení</div>
        {item.leadership.length === 0 ? (
          <p className="m-0 mt-1.5 text-[14px] font-semibold">Nic. Dodávka jde podle plánu.</p>
        ) : (
          <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0 text-[14px] leading-snug">
            {item.leadership.slice(0, 3).map((t) => <li key={t} className="flex gap-2"><span aria-hidden="true">•</span><span>{t}</span></li>)}
          </ul>
        )}
        {item.leadership.length > 3 && <p className="m-0 mt-1.5 text-xs text-[color:#39414D]">A dalších {item.leadership.length - 3} v detailu dodávky.</p>}
      </section>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] font-bold">
        <Link href={item.href} className="inline-flex min-h-[44px] items-center text-ink no-underline hover:underline">Otevřít dodávku</Link>
        <Link href={item.milestonesHref} className="inline-flex min-h-[44px] items-center text-ink no-underline hover:underline">Milníky</Link>
      </div>
    </article>
  )
}
