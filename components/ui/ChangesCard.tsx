import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  changesSummary, changesTotal, latestChanges, type ChangeItem, type ChangeKind, type ChangeSection, type ChangeTone,
} from '@/domain/crm/changes'
import {
  ArrowRightIcon, BellIcon, CheckIcon, ClockIcon, MailIcon, TodayCount, TodayNote,
} from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Karta „Co se změnilo": shrnutí po druzích (dlaždice s počty; plná barva
// jen u nenulových) a nejnovější položky seskupené podle druhu, u každé
// odkaz na záznam a označení důkazu. Čistě prezentační (server komponenta).
// Data i text okna dodává stránka.

const ICON_PROPS = { 'aria-hidden': true, focusable: false, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function MoneyIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5c.5-1 1.4-1.5 2.5-1.5 1.5 0 2.5.8 2.5 2s-1 1.7-2.5 2-2.5.8-2.5 2 1 2 2.5 2c1.1 0 2-.5 2.5-1.5M12 6.5V8m0 8v1.5" /></svg>
}
function StageIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><path d="M4 7h7M4 12h11M4 17h15M15 5l4 2-4 2" /></svg>
}

function HandoverIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><path d="M4 9h12l-3-3M20 15H8l3 3" /></svg>
}

function DeliveryIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><path d="M3 8h18v12H3zM8 8V5h8v3M3 13h18" /></svg>
}

function InboxIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><path d="M4 14h4l1.5 3h5L16 14h4M5.5 14 7.5 6h9l2 8v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
}

function DocumentIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" /></svg>
}

function CalendarIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M8 3v4M16 3v4M10 15l4 0M12 13v4" /></svg>
}

const KIND_ICON: Record<ChangeKind, ReactNode> = {
  intake: <InboxIcon />, email: <MailIcon />, stage: <StageIcon />, meeting: <CalendarIcon />, delivery: <DeliveryIcon />, decision: <CheckIcon size={18} />, work: <BellIcon size={18} />, handover: <HandoverIcon />, milestone: <ClockIcon />, document: <DocumentIcon />, money: <MoneyIcon />,
}

// Třídy jsou napsané celé (Tailwind je hledá ve zdrojácích components/).
const TONE_BG: Record<ChangeTone, string> = {
  sky: 'bg-[color:var(--p-sky)]', peach: 'bg-[color:var(--p-peach)]', mint: 'bg-[color:var(--p-mint)]',
  lav: 'bg-[color:var(--p-lav)]', sun: 'bg-[color:var(--p-sun)]', pink: 'bg-[color:var(--p-pink)]',
}

// Dlaždice shrnutí: nenulový počet je klávesa v plné barvě značky (klik ji
// zmáčkne a otevře, kde se změna stala). Nula je klidná plochá dlaždice
// v nesyté (pastelové) barvě bez hrany – nic se nedá zmáčknout, nic neruší.
const KEY_CLASS: Record<ChangeTone, string> = {
  sky: 'keycap-blue', lav: 'keycap-violet', mint: 'keycap-turquoise', sun: 'keycap-yellow', peach: 'keycap-red', pink: 'keycap-white',
}
// Kam klávesa vede: seznam, kde je daný druh změny vidět (dodávky, milníky
// a dokumenty → Dodávky; e-maily → klienti seřazení podle poslední aktivity).
export const KIND_HREF: Record<ChangeKind, string> = {
  intake: '/cockpit/pipeline', email: '/cockpit/clients?sort=aktivita', stage: '/cockpit/pipeline', meeting: '/cockpit/schuzky', delivery: '/cockpit/dodavky', decision: '/cockpit/rozhodnuti', work: '/cockpit/tasks', handover: '/cockpit/tasks?view=mine', milestone: '/cockpit/dodavky', document: '/cockpit/dodavky', money: '/cockpit/finance',
}

function SummaryTile({ section }: { section: ChangeSection }) {
  if (section.total > 0) {
    return (
      <Link
        href={KIND_HREF[section.kind]}
        className={`keycap ${KEY_CLASS[section.tone]} min-h-[96px] flex-col justify-between p-4`}
        aria-label={`${section.label}: ${section.total}`}
      >
        <span className="eyebrow !text-[color:#17202E]">{section.label}</span>
        <span className="big-num mt-2 block text-[30px] text-[color:#17202E]">{section.total}</span>
      </Link>
    )
  }
  return (
    <div className={`flex min-h-[96px] flex-col justify-between rounded-card p-4 ${TONE_BG[section.tone]}`}>
      <span className="eyebrow">{section.label}</span>
      <span className="big-num mt-2 block text-[30px] text-[color:var(--c-slate)]">0</span>
    </div>
  )
}

function ChangeRow({ item }: { item: ChangeItem }) {
  return (
    <li>
      <Link href={item.href} className="-mx-2 flex min-h-[44px] items-start gap-3 rounded-btn px-2 py-2 text-ink no-underline transition-colors duration-fast hover:bg-[color:var(--c-soft)] hover:text-ink">
        <span className="min-w-0 flex-1">
          <b className="block text-headline leading-tight">{item.title}</b>
          <span className="mt-0.5 block text-callout text-muted">{item.detail}</span>
          <span className="mt-0.5 block text-footnote text-muted">Důkaz: {item.proof}</span>
        </span>
        <span aria-hidden="true" className="mt-1 shrink-0 text-muted"><ArrowRightIcon size={15} /></span>
      </Link>
    </li>
  )
}

/** Skupina změn jednoho druhu: ikona a název druhu jednou, pod tím řádky. */
function ChangeGroup({ section, items, count, hidden = 0 }: { section: ChangeSection; items: ChangeItem[]; count: number; hidden?: number }) {
  return (
    <section aria-label={section.label}>
      <h3 className="m-0 flex items-center gap-2.5 font-body text-callout font-semibold text-ink">
        <span aria-hidden="true" className={`grid h-7 w-7 shrink-0 place-items-center rounded-xs text-ink ${TONE_BG[section.tone]}`}>{KIND_ICON[section.kind]}</span>
        {section.label}
        <span className="font-normal tabular-nums text-muted">{count}</span>
      </h3>
      <ul className="m-0 mt-1 flex list-none flex-col p-0 pl-[38px]">
        {items.map((item) => <ChangeRow key={item.key} item={item} />)}
      </ul>
      {hidden > 0 && <p className="m-0 mt-1 pl-[38px] text-footnote text-muted">A dalších {hidden} se sem nevešlo.</p>}
    </section>
  )
}

/** Nejnovější změny seskupené podle druhu; skupina s nejčerstvější změnou je první. */
function groupLatest(sections: readonly ChangeSection[], latest: ChangeItem[]): { section: ChangeSection; items: ChangeItem[] }[] {
  const groups: { section: ChangeSection; items: ChangeItem[] }[] = []
  for (const item of latest) {
    const section = sections.find((s) => s.kind === item.kind)
    if (!section) continue
    const g = groups.find((x) => x.section.kind === item.kind)
    if (g) g.items.push(item)
    else groups.push({ section, items: [item] })
  }
  return groups
}

export function ChangesCard({
  sections, windowLabel, note, unavailable = [], mode, emptyHint,
}: {
  sections: ChangeSection[]
  /** Věta o okně: „od tvé poslední návštěvy (dnes v 8:15)". */
  windowLabel: string
  /** Proč okno není „od poslední návštěvy", nebo null. */
  note?: string | null
  unavailable?: ChangeKind[]
  /** today = dlaždice + nejnovější položky seskupené; week = všechny sekce rozepsané. */
  mode: 'today' | 'week'
  emptyHint?: string
}) {
  const total = changesTotal(sections)
  const labelOf = (k: ChangeKind) => sections.find((s) => s.kind === k)?.label ?? k
  // Třídy jsou napsané celé (Tailwind je hledá ve zdrojácích).
  const n = sections.length
  const cols = n <= 3 ? 'xl:grid-cols-3' : n === 4 ? 'xl:grid-cols-4' : n <= 6 ? 'xl:grid-cols-6' : n === 7 ? 'xl:grid-cols-7' : n === 8 ? 'xl:grid-cols-8' : n === 9 ? 'xl:grid-cols-5 2xl:grid-cols-9' : n === 10 ? 'xl:grid-cols-5 2xl:grid-cols-10' : 'xl:grid-cols-6 2xl:grid-cols-11'
  const latest = latestChanges(sections, 6)
  const hiddenOnToday = Math.max(0, sections.reduce((n, s) => n + s.items.length + s.hidden, 0) - latest.length)

  return (
    <Card
      title="Co se změnilo"
      sub={`${changesSummary(total)} ${windowLabel}`}
      badge={total > 0 ? <TodayCount n={total} /> : undefined}
      href={mode === 'today' ? '/cockpit/prehled-tydne' : undefined}
      hrefLabel="Otevřít týdenní přehled"
    >
      <div className={`grid grid-cols-2 gap-4 pb-1 pr-1 sm:grid-cols-3 ${cols}`}>
        {sections.map((s) => <SummaryTile key={s.kind} section={s} />)}
      </div>

      {note && <p className="m-0 mt-3 text-callout text-muted">{note}</p>}

      {unavailable.length > 0 && (
        <TodayNote problem>
          Nepodařilo se načíst: {unavailable.map(labelOf).join(', ')}. Ostatní změny jsou vidět.
        </TodayNote>
      )}

      {total === 0 && unavailable.length === 0 && (
        <EmptyState
          tone="calm"
          compact
          className="mt-2"
          title={mode === 'today' ? 'Od poslední návštěvy se nic nezměnilo' : 'V tomhle týdnu se nic nezměnilo'}
        >
          {emptyHint ?? 'Nové e-maily, posuny obchodů, rozhodnutí, úkoly a milníky se ukážou tady, jakmile k nim dojde.'}
        </EmptyState>
      )}

      {total > 0 && mode === 'today' && (
        <>
          <h3 className="eyebrow m-0 mb-3 mt-6">Nejnovější</h3>
          <div className="flex flex-col gap-4">
            {groupLatest(sections, latest).map((g) => <ChangeGroup key={g.section.kind} section={g.section} items={g.items} count={g.section.total} />)}
          </div>
          {hiddenOnToday > 0 && (
            <p className="m-0 mt-2 text-callout">
              <Link href="/cockpit/prehled-tydne" className="inline-flex min-h-[44px] items-center font-semibold text-muted">
                A dalších {hiddenOnToday} v týdenním přehledu →
              </Link>
            </p>
          )}
        </>
      )}

      {total > 0 && mode === 'week' && (
        <div className="mt-6 flex flex-col gap-5">
          {sections.filter((s) => s.items.length > 0).map((s) => (
            <ChangeGroup key={s.kind} section={s} items={s.items} count={s.total} hidden={s.hidden} />
          ))}
        </div>
      )}
    </Card>
  )
}
