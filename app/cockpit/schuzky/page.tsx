import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, WORK_TABS } from '@/components/SectionTabs'
import { PlanMeetingForm } from '@/components/PlanMeetingForm'
import { CalendarCheckButton } from '@/components/CalendarCheckButton'
import { WorkStatus, type WorkStatusTone } from '@/components/WorkUi'
import { buttonClass } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getRecentMeetings } from '@/domain/crm/queries/meetingNotes'
import { getMeetingIntakeStats } from '@/domain/crm/queries/meetingIntake'
import { formatDate } from '@/lib/format'
import { pragueDayOf } from '@/lib/pragueDate'
import { checkMeetingsInOutlook } from './actions'

export const dynamic = 'force-dynamic'

function sourceLabel(source: string | null, outcome: string | null): string {
  if (outcome === 'planned') return 'naplánováno'
  // Zrušená v Outlooku (kontrola kalendáře) nebo zapsaná jako zrušená.
  if (outcome === 'cancelled') return 'zrušeno'
  if (source === 'api') return 'zápis přes skill'
  if (source === 'wispr_flow') return 'zápis z Wispr Flow'
  if (source === 'cockpit') return 'z Cockpitu'
  return source ?? 'ručně'
}

function statusTone(outcome: string | null): WorkStatusTone {
  if (outcome === 'planned') return 'info'
  if (outcome === 'cancelled') return 'fail'
  return 'done'
}

const MONTHS = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro']

export default async function MeetingsPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  // Klienta formulář hledá sám (AccountPicker → server akce), celý seznam
  // firem se sem už neposílá.
  const meetings = await getRecentMeetings(20)
  // Bez migrace 0078 (nebo při chybě) se odkaz na frontu prostě nezobrazí.
  const intake = await getMeetingIntakeStats().catch(() => null)
  const planned = meetings.filter((m) => m.outcome === 'planned').length
  const unmatched = intake?.unmatched ?? 0
  return (
    <>
      <PageHeader
        title="Schůzky"
        eyebrow="Práce"
        subtitle={
          meetings.length === 0
            ? 'Naplánuj schůzku rovnou z Cockpitu, zápisy proběhlých přijdou z Wispr Flow.'
            : `V přehledu ${meetings.length} ${meetings.length === 1 ? 'schůzka' : meetings.length < 5 ? 'schůzky' : 'schůzek'}, z toho ${planned} ${planned === 1 ? 'naplánovaná' : planned >= 2 && planned <= 4 ? 'naplánované' : 'naplánovaných'}. Zápisy přicházejí z Wispr Flow.`
        }
      >
        <a href="#planovat" className={buttonClass('primary')}>Naplánovat schůzku</a>
      </PageHeader>
      <SectionTabs tabs={WORK_TABS} label="Práce" />

      {unmatched > 0 && (
        <p role="status" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card bg-[color:var(--c-warn-soft)] px-5 py-3 text-body">
          <span className="st">Čeká na přiřazení</span>
          <Link href="/cockpit/schuzky/nesparovane" className="font-semibold underline underline-offset-2">
            Nespárované zápisy k přiřazení: {unmatched}
          </Link>
        </p>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Card title="Zápisy schůzek" sub="Nejnovější nahoře.">
          <div className="mb-4">
            {/* Posun a zrušení v Outlooku Cockpit kontroluje sám každé ráno; tlačítko hned. */}
            <CalendarCheckButton action={checkMeetingsInOutlook} />
          </div>
          {meetings.length === 0 ? (
            <EmptyState title="Zatím žádné schůzky" action={{ href: '#planovat', label: 'Naplánovat schůzku' }}>
              Naplánovanou schůzku i zápis z Wispr Flow uvidíš tady.
            </EmptyState>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {meetings.map((m) => {
                const valid = !Number.isNaN(new Date(m.occurred_at).getTime())
                const day = valid ? pragueDayOf(m.occurred_at) : ''
                return (
                  <li key={m.id} className="flex items-center gap-3.5 rounded-tile border border-border p-3 text-body">
                    <span className="grid h-[54px] w-[54px] shrink-0 place-items-center rounded-btn bg-[color:var(--c-soft)] text-center" aria-hidden="true">
                      <span className="leading-none">
                        <b className="block font-heading text-[20px] tabular-nums">{valid ? Number(day.slice(8, 10)) : '–'}</b>
                        <span className="eyebrow !text-[10px] !text-[color:#39414D]">{valid ? MONTHS[Number(day.slice(5, 7)) - 1] : ''}</span>
                      </span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-headline text-ink">{m.subject ?? '(bez předmětu)'}</div>
                      <div className="mt-0.5 text-callout">
                        <span className="sr-only">{formatDate(m.occurred_at)}. </span>
                        {m.account ? (
                          <Link href={`/cockpit/clients/${m.account.id}`} className="underline underline-offset-2">{m.account.name}</Link>
                        ) : (
                          <span className="text-muted">bez klienta</span>
                        )}
                      </div>
                    </div>
                    <WorkStatus tone={statusTone(m.outcome)}>{sourceLabel(m.source, m.outcome)}</WorkStatus>
                  </li>
                )
              })}
            </ul>
          )}
          <details className="group mt-5 border-t border-[color:var(--c-line-2)] pt-3">
            <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-1.5 rounded-btn text-callout font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
              Jak sem zápisy přicházejí
            </summary>
            <p className="m-0 mt-2 max-w-xl text-callout text-muted">
              Poznámky ze schůzek se nahrávají ve Wispr Flow. Ten nemá veřejné API, takže je do Cockpitu
              nepřenáší automat: zápis odešleš sám (zkratka, curl — návod v <code>docs/PROVOZ.md</code>),
              nebo ho zkontroluješ a uložíš přes Cowork skill „enter-meeting-notes“. Cockpit ho spáruje
              na klienta; co jistě spárovat nejde, čeká ve frontě. Zápis ke schůzce naplánované týž den
              ji doplní (nevznikne druhý řádek). Posun a zrušení v Outlooku Cockpit kontroluje sám každé ráno.
            </p>
          </details>
        </Card>

        <div id="planovat" className="scroll-mt-6">
          <Card title="Naplánovat schůzku" sub="Pozvánka s Teams odkazem odejde z tvého Outlooku.">
            <PlanMeetingForm />
          </Card>
        </div>
      </div>
    </>
  )
}
