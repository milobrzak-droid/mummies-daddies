import Link from 'next/link'
import type { DigestSection } from '@/domain/crm/digest'
import type { DigestEmail } from '@/domain/crm/digestEmail'
import type { OpsItem, OpsReport, OpsSection, OpsSectionKey, OpsTone } from '@/domain/crm/opsReport'
import { digestSourceTone, plural, SOURCE_TONE_LABEL } from '@/domain/crm/today'
import { ArrowRightIcon, TodayCount, TodayNote, TodayStatus } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Provozní přehled na záložce Týden: klávesy se souhrnem (klik skočí na
// sekci; nulová sekce je klidná dlaždice), karta na každou sekci s položkami
// (tečka tónu, odkaz na záznam + důkaz),
// klidné prázdné stavy, Stav zdrojů a náhled e-mailu pro vedení. Čistě
// prezentační (server komponenty); data dodává stránka.

// Třídy jsou napsané celé (Tailwind je hledá ve zdrojácích components/).
// Klávesy mají barvy značky; červená = riziko, žlutá = na tahu jsme my.
const KEY_CLASS: Record<OpsSectionKey, string> = {
  obchody: 'keycap keycap-violet',
  dodavky: 'keycap keycap-blue',
  'na-nas': 'keycap keycap-yellow',
  'na-klienta': 'keycap keycap-turquoise',
  'ke-schvaleni': 'keycap keycap-white',
  riziko: 'keycap keycap-red',
  neovereno: 'keycap keycap-white',
  'finance-rozdily': 'keycap keycap-yellow',
  agent: 'keycap keycap-turquoise',
}

/** Tón i slovem pro čtečky (barva sama nestačí). */
const TONE_WORD: Record<OpsTone, string> = { neg: 'Vyžaduje pozornost', warn: 'Pozor', ok: 'V pořádku', info: 'Pro informaci' }

/** Nenačtená sekce s nulou neukazuje „0" (nevíme to), ale pomlčku. */
function keyValue(s: OpsSection): string {
  return s.total === 0 && s.unavailable.length > 0 ? '—' : String(s.total)
}

// Nulová sekce je klidná plochá dlaždice v nesyté barvě (bez hrany, není
// odkazem – není kam skákat); plná barva a klávesa jen tam, kde číslo něco říká.
const CALM_BG: Record<OpsSectionKey, string> = {
  obchody: 'bg-[color:var(--p-lav)]',
  dodavky: 'bg-[color:var(--p-sky)]',
  'na-nas': 'bg-[color:var(--p-sun)]',
  'na-klienta': 'bg-[color:var(--p-mint)]',
  'ke-schvaleni': 'bg-[color:var(--c-soft)]',
  riziko: 'bg-[color:var(--p-peach)]',
  neovereno: 'bg-[color:var(--c-soft)]',
  'finance-rozdily': 'bg-[color:var(--p-sun)]',
  agent: 'bg-[color:var(--p-mint)]',
}

/** Klávesy se souhrnem: jedna na sekci, klik skočí na její kartu níž. */
export function OpsKeys({ report }: { report: OpsReport }) {
  const n = report.sections.length
  const cols = n >= 8 ? 'xl:grid-cols-4' : n === 7 ? 'xl:grid-cols-7' : 'xl:grid-cols-6'
  return (
    <ul className={`m-0 grid list-none grid-cols-2 gap-4 p-0 pb-1 pr-1 sm:grid-cols-4 ${cols}`}>
      {report.sections.map((s) => {
        const calm = s.total === 0 && s.unavailable.length === 0
        return (
          <li key={s.key} className="contents">
            {calm ? (
              <div className={`flex min-h-[96px] flex-col justify-between rounded-card p-4 ${CALM_BG[s.key]}`}>
                <span className="eyebrow">{s.short}</span>
                <span className="big-num mt-2 block text-[30px] text-[color:var(--c-slate)]">0</span>
              </div>
            ) : (
              <Link
                href={`#${s.key}`}
                aria-label={`${s.title}: ${s.total === 0 && s.unavailable.length > 0 ? 'nepodařilo se načíst' : s.total}`}
                className={`${KEY_CLASS[s.key]} min-h-[96px] flex-col justify-between p-4`}
              >
                <span className="eyebrow !text-[color:#17202E]">{s.short}</span>
                <span className="big-num mt-2 block text-[30px] text-[color:#17202E]">{keyValue(s)}</span>
              </Link>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const TONE_DOT: Record<OpsTone, string> = {
  neg: 'bg-[color:var(--d-red)]', warn: 'bg-[color:var(--d-amber)]', ok: 'bg-[color:var(--d-green)]', info: 'bg-[color:var(--d-blue)]',
}

function OpsRow({ item }: { item: OpsItem }) {
  return (
    <li>
      <Link href={item.href} className="-mx-2 flex min-h-[44px] items-start gap-3 rounded-btn px-2 py-2 text-ink no-underline transition-colors duration-fast hover:bg-[color:var(--c-soft)] hover:text-ink">
        <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[item.tone]}`} />
        <span className="min-w-0 flex-1">
          <b className="block text-headline leading-tight">{item.title}</b>
          <span className={`mt-0.5 block text-callout ${item.tone === 'neg' ? 'text-neg' : 'text-muted'}`}>
            <span className="sr-only">{TONE_WORD[item.tone]}: </span>{item.detail}
          </span>
          <span className="mt-0.5 block text-footnote text-muted">Důkaz: {item.proof}</span>
        </span>
        <span aria-hidden="true" className="mt-1 shrink-0 text-muted"><ArrowRightIcon size={15} /></span>
      </Link>
    </li>
  )
}

/** Kolik položek karta sekce ukáže; zbytek odkazem na celý seznam v Cockpitu. */
export const PAGE_ITEMS_PER_SECTION = 8

export function OpsSectionCard({ section, max = PAGE_ITEMS_PER_SECTION }: { section: OpsSection; max?: number }) {
  const shown = section.items.slice(0, max)
  const more = section.total - shown.length
  const hot = section.key === 'riziko' || section.items.some((i) => i.tone === 'neg')
  return (
    <Card
      id={section.key}
      title={section.title}
      sub={section.lead}
      className="scroll-mt-6"
      badge={section.total > 0 ? <TodayCount n={section.total} tone={hot ? 'neg' : 'neutral'} /> : undefined}
    >
      {section.unavailable.length > 0 && (
        <div className="mb-3">
          <TodayNote problem>Nepodařilo se načíst: {section.unavailable.join(', ')}. Sekce může být neúplná.</TodayNote>
        </div>
      )}
      {section.total === 0 ? (
        section.unavailable.length === 0 && <EmptyState tone="calm" compact title={section.calm} />
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {shown.map((item) => <OpsRow key={item.key} item={item} />)}
          </ul>
          {more > 0 && (
            <p className="m-0 mt-2 text-callout">
              <Link href={section.path} className="inline-flex min-h-[44px] items-center gap-1.5 font-semibold text-muted">
                Celý seznam v Cockpitu (ještě {more}) <ArrowRightIcon size={15} />
              </Link>
            </p>
          )}
        </>
      )}
    </Card>
  )
}

/** Stav zdrojů: odkud Cockpit bere data a jak čerstvá jsou (z týdenního přehledu). */
export function OpsSourcesCard({ sources, alerts }: { sources: DigestSection | null; alerts: number }) {
  if (!sources) {
    return (
      <Card id="zdroje" title="Stav zdrojů" sub="Odkud Cockpit bere data a jak jsou čerstvá.">
        <TodayNote problem>Stav zdrojů se nepodařilo načíst. Zkontroluj Nastavení.</TodayNote>
      </Card>
    )
  }
  return (
    <Card
      id="zdroje"
      title={sources.title}
      sub={alerts === 0 ? 'Odkud Cockpit bere data: vše běží' : `${alerts} ${plural(alerts, 'zdroj chce', 'zdroje chtějí', 'zdrojů chce')} pozornost`}
      href="/cockpit/nastaveni"
      hrefLabel="Otevřít nastavení zdrojů"
    >
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {sources.lines.map((line, i) => {
          const tone = digestSourceTone(line)
          return (
            <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-btn bg-[color:var(--c-soft)] px-4 py-3 text-body text-ink">
              <span className="min-w-0 flex-1">{line}</span>
              <TodayStatus tone={tone}>{SOURCE_TONE_LABEL[tone]}</TodayStatus>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/**
 * Náhled e-mailu (jen vedení): přesně to HTML, které by v pondělí nebo
 * v pátek odešlo, v izolovaném rámu (sandbox bez skriptů), a textová verze.
 * Zobrazení nic neodesílá.
 */
export function OpsEmailPreview({ email, sendEnabled }: { email: DigestEmail; sendEnabled: boolean }) {
  return (
    <Card id="nahled" title="Náhled e-mailu" sub="Takhle by přehled vypadal, kdyby odešel teď (data k této chvíli). Zobrazení náhledu nic neodesílá.">
      <dl className="m-0 grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="eyebrow pt-0.5">Předmět</dt>
        <dd className="m-0 font-semibold text-ink">{email.subject}</dd>
        <dt className="eyebrow pt-0.5">Od</dt>
        <dd className="m-0 text-ink">Z Viktorovy schránky přes jeho připojený Outlook (zůstane mu v Odeslané poště)</dd>
        <dt className="eyebrow pt-0.5">Komu</dt>
        <dd className="m-0 text-ink">Adresy z nastavení odesílání, jen firemní a jen členové vedení a obchodníci</dd>
        <dt className="eyebrow pt-0.5">Kdy</dt>
        <dd className="m-0 text-ink">V pondělí za minulý týden, v pátek za tento týden, ráno a nejvýš jednou za den</dd>
        <dt className="eyebrow pt-0.5">Odesílání</dt>
        <dd className="m-0"><TodayStatus tone={sendEnabled ? 'done' : 'info'}>{sendEnabled ? 'Zapnuté' : 'Vypnuté'}</TodayStatus></dd>
      </dl>
      <iframe
        title="Náhled e-mailu s přehledem týdne"
        sandbox=""
        srcDoc={email.html}
        className="mt-5 block h-[1400px] w-full rounded-tile border border-border bg-white"
      />
      <details className="mt-4 text-callout">
        <summary className="inline-flex min-h-[44px] cursor-pointer items-center font-semibold text-ink">Textová verze</summary>
        <pre className="m-0 mt-2 max-h-[600px] overflow-auto whitespace-pre-wrap rounded-btn bg-[color:var(--c-soft)] p-4 font-body text-[12.5px] leading-relaxed text-ink">{email.text}</pre>
      </details>
    </Card>
  )
}
