import Link from 'next/link'
import { AreaChart } from '@/components/AreaChart'
import { formatCzkValue } from '@/components/Sparkline'
import { clockTime, monthShort, plural, sourcesNeedingAttention, sourcesWithProblem, type SourceRow } from '@/domain/crm/today'
import { buttonClass } from '@/components/ui/Button'
import { CARD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { TodayOverdueList, type CompleteTaskAction, type OverdueRow, type PostponeAction, type PostponeTaskAction } from '@/components/ui/TodayOverdueList'
import type { TodayMeeting } from '@/domain/crm/queries/todayMeetings'
import {
  ArrowRightIcon, BigMoney, CheckIcon, TodayBar, TodayCount,
  TodayNote, TodayRow, TodaySources, TodayStatus,
} from '@/components/ui/TodayParts'

// ── tři velká čísla ────────────────────────────────────────────────────────

// Tři klidná KPI vedle sebe: popisek, číslo, jedna věta. Pruh má jen
// „S pravděpodobností" (podíl z otevřené hodnoty), ostatní čísla ho nepotřebují.
export function TodayNumbers({
  open, weighted, won, monthLabel, openCount,
}: { open: number; weighted: number; won: number; monthLabel: string; openCount: number }) {
  const weightedPct = open > 0 ? Math.round((weighted / open) * 100) : 0
  const cell = 'min-w-0 p-5'
  const divider = 'border-t border-[color:var(--c-line-2)] sm:border-l sm:border-t-0'
  return (
    <section aria-label="Obchody v číslech" className={CARD}>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <div className={cell}>
          <div className="eyebrow">Otevřené obchody</div>
          <div className="mt-2"><BigMoney value={open} size={28} /></div>
          <p className="m-0 mt-2 text-footnote text-muted">
            {openCount} {plural(openCount, 'obchod', 'obchody', 'obchodů')} · součet hodnot
          </p>
        </div>
        <div className={`${cell} ${divider}`}>
          <div className="eyebrow">S pravděpodobností</div>
          <div className="mt-2"><BigMoney value={weighted} size={28} /></div>
          <div className="mt-3"><TodayBar pct={weightedPct} color="blue" label={`S pravděpodobností je to ${weightedPct} % z otevřené hodnoty`} /></div>
          <p className="m-0 mt-2 text-footnote text-muted">{weightedPct} % otevřené hodnoty podle šance na výhru</p>
        </div>
        <div className={`${cell} ${divider}`}>
          <div className="eyebrow">Vyhráno tento měsíc</div>
          <div className="mt-2"><BigMoney value={won} size={28} /></div>
          <p className="m-0 mt-2 text-footnote text-muted">{monthLabel}{won === 0 ? ' · zatím nic uzavřeno' : ''}</p>
        </div>
      </div>
    </section>
  )
}

// ── vyhráno po měsících (jen se skutečnými daty) ───────────────────────────

export function TodayWonChart({ months, values }: { months: string[]; values: number[] }) {
  const total = values.reduce((a, b) => a + b, 0)
  const hasData = total > 0 && months.length >= 2
  return (
    <Card title="Vyhráno po měsících" sub={hasData ? `posledních ${months.length} měsíců` : undefined} href="/cockpit/pipeline" hrefLabel="Otevřít obchody" className="h-full">
      {hasData ? (
        <>
          <div className="mb-2"><BigMoney value={total} size={28} /></div>
          <AreaChart
            labels={months.map(monthShort)}
            series={[{ name: 'Vyhráno', color: 'var(--d-turquoise)', values }]}
            label="Vyhráno po měsících"
            format={formatCzkValue}
            height={150}
          />
        </>
      ) : (
        <EmptyState compact title="Zatím není z čeho kreslit" action={{ href: '/cockpit/pipeline', label: 'Otevřít obchody' }}>
          Graf se objeví, jakmile bude vyhraný obchod aspoň v jednom z posledních měsíců.
        </EmptyState>
      )}
    </Card>
  )
}

// ── schůzky dnes ───────────────────────────────────────────────────────────

export function TodayMeetings({ meetings, outlookConnected }: { meetings: TodayMeeting[]; outlookConnected: boolean }) {
  const n = meetings.length
  return (
    <Card
      title="Schůzky dnes"
      sub={n === 0 ? 'Dnes nic v plánu' : `${n} ${plural(n, 'schůzka', 'schůzky', 'schůzek')}`}
      href="/cockpit/schuzky"
      hrefLabel="Otevřít schůzky"
    >
      {n === 0 ? (
        <EmptyState tone="calm" compact title="Dnes žádná schůzka">Volno na práci s obchody.</EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {meetings.map((m) => {
            const planned = m.outcome === 'planned'
            // Zrušená v Outlooku (kontrola kalendáře) zůstává v seznamu, ať je vidět, že odpadla.
            const cancelled = m.outcome === 'cancelled'
            const inner = (
              <>
                <span className="flex items-center justify-between font-mono text-footnote tracking-wide text-ink">
                  <span className={cancelled ? 'line-through' : undefined}>{clockTime(m.occurred_at)}</span>
                  <span className={cancelled ? 'text-neg' : 'text-muted'}>{cancelled ? 'zrušeno' : planned ? 'naplánováno' : 'zapsáno'}</span>
                </span>
                <b className="mt-1 block text-headline leading-snug">{m.subject ?? '(bez předmětu)'}</b>
                {m.account && <span className="mt-0.5 block text-footnote font-semibold text-muted">{m.account.name}</span>}
              </>
            )
            const cls = 'block rounded-tile border border-border px-3.5 py-3 text-ink no-underline transition-colors duration-fast'
            return (
              <li key={m.id}>
                {m.account ? <Link href={`/cockpit/clients/${m.account.id}`} className={`${cls} hover:bg-[color:var(--c-soft)] hover:text-ink`}>{inner}</Link> : <div className={cls}>{inner}</div>}
              </li>
            )
          })}
        </ul>
      )}
      {!outlookConnected && (
        <p className="m-0 mt-4 text-callout text-muted">
          Outlook zatím není napojený, kalendář se sem nenačítá.{' '}
          <Link href="/cockpit/nastaveni" className="font-semibold text-ink underline">Napojit Outlook</Link>
        </p>
      )}
    </Card>
  )
}

// ── ke schválení ───────────────────────────────────────────────────────────

export type ApprovalPreview = { id: string; title: string; sub: string; age: string }

export function TodayApprovals({
  items, total, available,
}: { items: ApprovalPreview[]; total: number; available: boolean }) {
  return (
    <Card
      title="Ke schválení"
      sub={!available || total === 0 ? 'Čeká na tvé rozhodnutí' : `${total} ${plural(total, 'věc čeká', 'věci čekají', 'věcí čeká')} na tvé rozhodnutí`}
      href="/cockpit/rozhodnuti"
      hrefLabel="Otevřít Ke schválení"
      badge={total > 0 ? <TodayCount n={total} /> : undefined}
    >
      {!available ? (
        <p role="alert" className="m-0 text-callout text-muted">Ke schválení se teď nepodařilo načíst. <Link href="/cockpit/rozhodnuti" className="font-semibold text-ink underline">Otevřít</Link></p>
      ) : total === 0 ? (
        <EmptyState tone="calm" compact title="Nic nečeká na tebe">Žádné schválení ani rozhodnutí.</EmptyState>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {items.map((a) => (
              <TodayRow
                key={a.id}
                href="/cockpit/rozhodnuti"
                icon={<CheckIcon size={18} />}
                tone="lav"
                title={a.title}
                sub={a.sub}
                trailing={<span className="whitespace-nowrap text-footnote font-semibold text-muted">{a.age}</span>}
              />
            ))}
          </ul>
          <Link href="/cockpit/rozhodnuti" className={buttonClass('secondary', 'sm', 'mt-3')}>
            {total > items.length ? `Rozhodnout všech ${total}` : 'Rozhodnout'} <ArrowRightIcon size={15} />
          </Link>
        </>
      )}
    </Card>
  )
}

// ── po termínu ─────────────────────────────────────────────────────────────

export type OverdueItem = OverdueRow

/**
 * Po termínu: nejvíc zpožděné nahoře. S akcemi jde další krok obchodu posunout
 * na zítra / příští týden, u úkolu posunout termín stejně nebo ho odškrtnout
 * přímo v řádku (toast se Zpět).
 */
export function TodayOverdue({
  items, targets, postpone, postponeTask, completeTask,
}: {
  items: OverdueItem[]
  targets?: { tomorrow: string; nextWeek: string }
  postpone?: PostponeAction
  postponeTask?: PostponeTaskAction
  completeTask?: CompleteTaskAction
}) {
  const shown = items.slice(0, 6)
  return (
    <Card
      title="Po termínu"
      sub={items.length === 0 ? undefined : 'Posuň termín, nebo to rovnou vyřeš'}
      href="/cockpit/pipeline"
      hrefLabel="Otevřít vše po termínu"
      badge={items.length > 0 ? <TodayCount n={items.length} tone="neg" /> : undefined}
    >
      {items.length === 0 ? (
        <EmptyState tone="calm" compact title="Nic není po termínu">Termíny kroků a úkolů držíš.</EmptyState>
      ) : (
        <>
          <TodayOverdueList items={shown} targets={targets} postpone={postpone} postponeTask={postponeTask} completeTask={completeTask} />
          {items.length > shown.length && (
            <Link href="/cockpit/pipeline" className="inline-flex min-h-[44px] items-center text-callout font-semibold text-muted no-underline">
              … a dalších {items.length - shown.length} po termínu →
            </Link>
          )}
        </>
      )}
    </Card>
  )
}

// ── vyžaduje pozornost (blokované obchody) ─────────────────────────────────

export type BlockedItem = { id: number; href: string; firm: string; title: string; blocker: string }

export function TodayBlocked({ items }: { items: BlockedItem[] }) {
  return (
    <Card title="Vyžaduje pozornost" sub="Blokované obchody" badge={items.length > 0 ? <TodayCount n={items.length} tone="neg" /> : undefined}>
      {items.length === 0 ? (
        <EmptyState tone="calm" compact title="Nic neblokuje obchody" />
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {items.slice(0, 4).map((b) => (
              <li key={b.id} className="rounded-tile border border-border">
                <Link href={b.href} className="flex min-h-[44px] items-start gap-3 p-3.5 text-ink no-underline transition-colors duration-fast hover:bg-[color:var(--c-soft)] hover:text-ink rounded-tile">
                  <span className="min-w-0 flex-1">
                    <b className="block text-headline leading-tight">{b.firm}</b>
                    <span className="block text-footnote text-muted">{b.title}</span>
                    <span className="mt-1.5 block text-callout text-neg">Blokuje: {b.blocker}</span>
                  </span>
                  <span aria-hidden="true" className="mt-1 shrink-0 text-muted"><ArrowRightIcon size={15} /></span>
                </Link>
              </li>
            ))}
          </ul>
          {items.length > 4 && (
            <Link href="/cockpit/pipeline" className="inline-flex min-h-[44px] items-center text-callout font-semibold text-muted no-underline">
              … a dalších {items.length - 4} blokovaných →
            </Link>
          )}
        </>
      )}
    </Card>
  )
}

// ── stav zdrojů dat (dole, sbalený) ────────────────────────────────────────

/**
 * Stav zdrojů dat: odkud Cockpit bere data. Je dole a sbalený – rozbalí se
 * sám jen při problému (chyba, zastaralá data, nefunkční upozornění na poštu).
 * Zdroj, který zatím nic nedodal, se jen zmíní a panel nerozbaluje.
 */
export function TodaySourcesPanel({
  rows, note,
}: { rows: SourceRow[]; note: { text: string; problem: boolean } | null }) {
  const problems = sourcesWithProblem(rows).length + (note?.problem ? 1 : 0)
  const problem = problems > 0
  const pending = sourcesNeedingAttention(rows) - sourcesWithProblem(rows).length
  const summary = problem
    ? `${problems} ${plural(problems, 'zdroj chce', 'zdroje chtějí', 'zdrojů chce')} pozornost`
    : pending > 0
      ? `Bez poruch · ${pending} ${plural(pending, 'zdroj zatím nemá', 'zdroje zatím nemají', 'zdrojů zatím nemá')} data`
      : 'Odkud Cockpit bere data: vše běží'
  return (
    <details open={problem} className={`${CARD} group`}>
      <summary className="flex min-h-[64px] cursor-pointer list-none items-center gap-3 rounded-card px-5 py-4 sm:px-6 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <h2 className="m-0 font-heading text-title2 font-bold">Stav zdrojů dat</h2>
          <span className="mt-0.5 block text-callout text-muted">{summary}</span>
        </span>
        <TodayStatus tone={problem ? 'fail' : 'done'}>{problem ? 'Pozor' : 'V pořádku'}</TodayStatus>
        <span aria-hidden="true" className="text-muted transition-transform duration-fast group-open:rotate-180">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </summary>
      <div className="border-t border-[color:var(--c-line-2)] px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
        <TodaySources rows={rows} />
        {note && <TodayNote problem={note.problem}>{note.text}</TodayNote>}
        <Link href="/cockpit/nastaveni" className={buttonClass('outline', 'sm', 'mt-4')}>Otevřít nastavení zdrojů</Link>
      </div>
    </details>
  )
}
