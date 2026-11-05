import Link from 'next/link'
import { MILESTONE_STATUS_LABEL, type MilestoneStatus } from '@/domain/delivery/milestone'
import { WorkChk, type WorkStatusTone } from '@/components/WorkUi'

// Časová osa milníků dodávky (Gantt). Jen skutečná data: milník má založení
// (created_at), termín (due_on) a případně přijetí (accepted_at). Pruh jde od
// založení do termínu (přijatý milník do přijetí), kosočtverec značí termín.
// Bez termínu se pruh táhne do dneška. Nic se nedomýšlí.

export type GanttMilestone = {
  id: number
  title: string
  status: MilestoneStatus
  due_on: string | null
  accepted_at: string | null
  created_at: string
}

export type GanttRow = {
  id: number
  title: string
  status: MilestoneStatus
  done: boolean
  /** Pořadí dnů od začátku osy. */
  startDay: number
  endDay: number
  dueDay: number | null
  dueOn: string | null
}

export type GanttTick = { pct: number; label: string }

export type GanttModel = {
  rows: GanttRow[]
  ticks: GanttTick[]
  totalDays: number
  /** Poloha dnešní čáry v %, nebo null když dnes leží mimo osu. */
  todayPct: number | null
  rangeLabel: string
}

const DAY = 86_400_000
const dayNo = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY)
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10)
// Pondělí = 1. Den 0 (1. 1. 1970) byl čtvrtek.
const weekdayMon0 = (n: number) => (((n + 3) % 7) + 7) % 7
const short = (iso: string) => `${+iso.slice(8, 10)}. ${+iso.slice(5, 7)}.`
const MONTHS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro']

export const isDoneStatus = (s: string) => s === 'prijato' || s === 'uzavreno'

export function buildGantt(
  milestones: GanttMilestone[],
  opts: { startedOn: string | null; dueOn: string | null; today: string },
): GanttModel | null {
  if (milestones.length === 0) return null
  const today = dayNo(opts.today)
  const raw = milestones.map((m) => {
    const start = dayNo(m.created_at.slice(0, 10))
    const due = m.due_on ? dayNo(m.due_on) : null
    const acc = m.accepted_at ? dayNo(m.accepted_at.slice(0, 10)) : null
    const done = isDoneStatus(m.status)
    let end = done ? (acc ?? due ?? start) : (due ?? Math.max(today, start))
    if (end < start) end = start
    return { m, start: Math.min(start, end), end, due, done }
  })
  const points = [
    ...raw.flatMap((r) => [r.start, r.end, ...(r.due !== null ? [r.due] : [])]),
    ...(opts.startedOn ? [dayNo(opts.startedOn)] : []),
    ...(opts.dueOn ? [dayNo(opts.dueOn)] : []),
  ]
  let lo = Math.min(...points)
  let hi = Math.max(...points)
  // dnešek na osu patří, když není daleko za koncem (dodávka běží)
  if (today >= lo && today <= hi + 14) hi = Math.max(hi, today)
  lo -= weekdayMon0(lo) // zpět na pondělí
  hi += 7 - weekdayMon0(hi) // dopředu na příští pondělí
  if (hi - lo < 6 * 7) hi = lo + 6 * 7
  const total = hi - lo
  const pct = (d: number) => ((d - lo) / total) * 100

  const ticks: GanttTick[] = []
  if (total <= 14 * 7) {
    for (let d = lo; d < hi; d += 7) ticks.push({ pct: pct(d), label: short(isoOf(d)) })
  } else {
    let d = lo
    while (d < hi) {
      const iso = isoOf(d)
      if (iso.slice(8, 10) === '01' || d === lo) {
        const y = iso.slice(2, 4)
        ticks.push({ pct: pct(d), label: iso.slice(5, 7) === '01' || d === lo ? `${MONTHS[+iso.slice(5, 7) - 1]} ${y}` : MONTHS[+iso.slice(5, 7) - 1] })
      }
      d += 1
    }
    // první značka (začátek osy) by splývala s příštím měsícem
    if (ticks.length > 1 && ticks[1].pct - ticks[0].pct < 8) ticks.shift()
  }
  const rows: GanttRow[] = raw.map((r) => ({
    id: r.m.id,
    title: r.m.title,
    status: r.m.status,
    done: r.done,
    startDay: r.start - lo,
    endDay: r.end - lo,
    dueDay: r.due === null ? null : r.due - lo,
    dueOn: r.m.due_on,
  }))
  const todayPct = today >= lo && today <= hi ? pct(today) : null
  return { rows, ticks, totalDays: total, todayPct, rangeLabel: `${short(isoOf(lo))} – ${short(isoOf(hi))}` }
}

const BAR: Record<MilestoneStatus, { bg: string; ring?: string; tone: WorkStatusTone }> = {
  pripraveno: { bg: 'rgba(90,100,114,.30)', tone: 'idle' },
  v_praci: { bg: 'color-mix(in srgb, var(--d-blue) 45%, transparent)', tone: 'info' },
  ceka_na_vstup: { bg: 'color-mix(in srgb, var(--brand-yellow) 70%, transparent)', tone: 'wait' },
  ceka_na_schvaleni: { bg: 'var(--p-sun)', ring: 'var(--d-yellow)', tone: 'wait' },
  prijato: { bg: 'var(--d-green)', tone: 'done' },
  uzavreno: { bg: 'var(--d-green)', tone: 'done' },
}

const STRIPES = 'repeating-linear-gradient(90deg,rgba(255,255,255,.3) 0 2px,transparent 2px 5px)'

export function ganttSummary(model: GanttModel): string {
  const done = model.rows.filter((r) => r.done).length
  return `Časová osa milníků: ${model.rows.length} ${model.rows.length === 1 ? 'milník' : model.rows.length < 5 ? 'milníky' : 'milníků'}, ${done} přijato.`
}

export function WorkGantt({ model, todayDay }: { model: GanttModel; todayDay: number }) {
  const ROW = 34
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <div className="min-w-[620px]" role="group" aria-label={ganttSummary(model)}>
        {/* záhlaví: týdny / měsíce */}
        <div className="flex">
          <div className="w-[210px] shrink-0 eyebrow pt-0.5">Milník</div>
          <div className="relative flex-1 h-7" aria-hidden="true">
            {model.ticks.map((t) => (
              <span key={t.pct} className="absolute top-0 text-[11px] text-muted pl-1.5 whitespace-nowrap" style={{ left: `${t.pct}%`, fontFamily: "'Fira Mono',ui-monospace,monospace" }}>
                {t.label}
              </span>
            ))}
          </div>
        </div>
        <div className="relative">
          {/* linky a dnešní čára pod řádky */}
          <div className="absolute inset-y-0 left-[210px] right-0 pointer-events-none" aria-hidden="true">
            {model.ticks.map((t) => (
              <i key={t.pct} className="absolute inset-y-0 w-px bg-[color:var(--c-line)]" style={{ left: `${t.pct}%` }} />
            ))}
            {model.todayPct !== null && (
              <>
                <i className="absolute w-0.5 rounded-full bg-[color:var(--t-red)]" style={{ left: `${model.todayPct}%`, top: 8, bottom: 0, marginLeft: -1 }} />
                <span
                  className="absolute grid place-items-center rounded-full bg-[color:var(--t-red)] text-white text-[11px] font-bold tabular-nums"
                  style={{ left: `${model.todayPct}%`, top: -3, width: 22, height: 22, marginLeft: -11 }}
                >
                  {todayDay}
                </span>
              </>
            )}
          </div>
          {model.rows.map((r) => {
            const b = BAR[r.status]
            const left = (r.startDay / model.totalDays) * 100
            const width = Math.max(((r.endDay - r.startDay) / model.totalDays) * 100, 1.2)
            return (
              <div key={r.id} className="relative flex items-center" style={{ height: ROW }}>
                <div className="w-[210px] shrink-0 pr-3 flex items-center gap-2 min-w-0">
                  <WorkChk done={r.done} label={r.done ? 'Přijato' : 'Zatím nepřijato'} />
                  <span className="text-[13px] font-semibold truncate" title={r.title}>{r.title}</span>
                </div>
                <div className="relative flex-1 h-full">
                  <div
                    aria-hidden="true"
                    className="absolute rounded-full"
                    style={{
                      left: `${left}%`, width: `${width}%`, top: 10, height: 14,
                      backgroundColor: b.bg, backgroundImage: r.done || r.status === 'v_praci' ? STRIPES : undefined,
                      boxShadow: b.ring ? `inset 0 0 0 1.5px ${b.ring}` : undefined,
                    }}
                  />
                  {r.dueDay !== null && (
                    <i
                      aria-hidden="true"
                      className="absolute block"
                      style={{
                        left: `${(r.dueDay / model.totalDays) * 100}%`, top: 9, width: 14, height: 14, marginLeft: -7,
                        transform: 'rotate(45deg)', borderRadius: 3, border: '2px solid #fff',
                        background: r.done ? 'var(--d-green)' : 'var(--c-navy)', boxShadow: '0 1px 2px rgba(20,25,34,.25)',
                      }}
                    />
                  )}
                </div>
                <span className="sr-only">
                  {MILESTONE_STATUS_LABEL[r.status]}{r.dueOn ? `, termín ${r.dueOn}` : ', bez termínu'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * Pod časovou osu: které nepřijaté milníky nemají termín (jejich pruh končí
 * dneškem, kosočtverec chybí) a odkaz přímo k výzvě „Doplnit termín".
 */
export function GanttMissingDue({ model, href }: { model: GanttModel; href: string }) {
  const rows = model.rows.filter((r) => !r.done && r.dueOn === null)
  if (rows.length === 0) return null
  return (
    <p className="m-0 mt-3 rounded-[12px] bg-[color:var(--c-warn-soft)] px-3.5 py-2.5 text-[13px] text-[color:var(--c-ink-2)]">
      <span className="font-semibold text-[color:var(--c-warn)]">Bez termínu: </span>
      {rows.map((r) => r.title).join(', ')}.{' '}
      <Link href={`${href}#milnik-${rows[0].id}`} className="font-semibold text-ink underline underline-offset-2">
        Doplnit termín
      </Link>
    </p>
  )
}

export function GanttLegend() {
  const sw = 'inline-block w-3 h-3 rounded-[4px] shrink-0'
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 text-[12.5px] font-semibold text-[color:var(--c-ink-2)]">
      <span className="inline-flex items-center gap-1.5"><i className={sw} style={{ background: 'var(--d-green)' }} />Přijato</span>
      <span className="inline-flex items-center gap-1.5"><i className={sw} style={{ background: 'color-mix(in srgb, var(--d-blue) 45%, transparent)' }} />V práci</span>
      <span className="inline-flex items-center gap-1.5"><i className={sw} style={{ background: 'var(--p-sun)', boxShadow: 'inset 0 0 0 1.5px var(--d-yellow)' }} />Čeká na schválení klientem</span>
      <span className="inline-flex items-center gap-1.5"><i className={sw} style={{ background: 'var(--c-navy)', transform: 'rotate(45deg) scale(.78)', borderRadius: 2 }} />Termín</span>
      <span className="inline-flex items-center gap-1.5"><i className="inline-block w-0.5 h-3.5 rounded-full" style={{ background: 'var(--t-red)' }} />Dnes</span>
    </div>
  )
}

