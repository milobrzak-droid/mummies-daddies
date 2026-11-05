import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, TODAY_TABS } from '@/components/SectionTabs'
import { ChangesCard } from '@/components/ui/ChangesCard'
import { OpsEmailPreview, OpsKeys, OpsSectionCard, OpsSourcesCard } from '@/components/ui/OpsReport'
import { TodayNote } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { buttonClass } from '@/components/ui/Button'
import { ExportButtons } from '@/components/ExportButtons'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { listTeamMembers } from '@/lib/queries/team'
import { buildChangeSections, parseWeekChoice, weekWindow, type ChangeSection, type WeekChoice } from '@/domain/crm/changes'
import { czechDateLabel } from '@/domain/crm/digestDelivery'
import { previewAppUrl, renderOpsReportEmail } from '@/domain/crm/opsReportEmail'
import { loadChanges } from '@/domain/crm/queries/changes'
import { getTodaysDigestWithSource } from '@/domain/crm/queries/digest'
import { loadOpsReport } from '@/domain/crm/queries/opsReport'
import { clockTime, isoWeek } from '@/domain/crm/today'
import { logError } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'

export const dynamic = 'force-dynamic'

// Route "prehled-tydne" (ne "digest") — v Cockpitu je zbytek UI v češtině
// (viz /oslovovani, /schuzky). Druhá záložka obrazovky „Dnes" (TODAY_TABS),
// ne položka menu; jen pro obchodní role (vedení a obchodník).
//
// Obsah: PROVOZNÍ PŘEHLED firmy (domain/crm/opsReport.ts) za týden Po–Ne —
// obchody, dodávky podle milníků, co čeká na nás a na klienta, Ke schválení,
// riziko termínů a kapacity, neověřené položky a Stav zdrojů; každá položka
// vede na svůj záznam. Pod ním celý záznam změn za týden („Co se změnilo").
// Tentýž přehled chodí v pondělí a v pátek e-mailem; vedení tu vidí jeho
// náhled (?nahled=email), ať ho zkontroluje před prvním odesláním.

const WEEK_PILLS: { key: WeekChoice; label: string }[] = [
  { key: 'minuly', label: 'Minulý týden (Po–Ne)' },
  { key: 'tento', label: 'Tento týden' },
]

/** Karta „Co se změnilo" ukazuje z každého druhu nejvýš tolik položek (dřívější limit stránky). */
const CHANGES_PER_SECTION = 15

function capSections(sections: readonly ChangeSection[], n: number): ChangeSection[] {
  return sections.map((s) => ({ ...s, items: s.items.slice(0, n), hidden: s.hidden + Math.max(0, s.items.length - n) }))
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function PrehledTydnePage({
  searchParams,
}: {
  searchParams: Promise<{ tyden?: string | string[]; nahled?: string | string[] }>
}) {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')

  const sp = await searchParams
  const now = new Date()
  const today = pragueToday()
  const week = parseWeekChoice(sp.tyden, today)
  const range = weekWindow(today, week)
  const { user, member } = await getCurrentMember()
  // Náhled e-mailu jen pro vedení: stejný obsah, jaký dostanou příjemci.
  const leadership = member?.role === 'vedeni'
  const preview = leadership && first(sp.nahled) === 'email'

  // Pomocné zdroje: chyba se zaloguje a přehled to v dané sekci řekne.
  const empty = buildChangeSections([], { canSeeSales: true })
  const [changes, digest] = await Promise.all([
    listTeamMembers()
      .then((members) => loadChanges({ window: range, meId: user?.id ?? null, canSeeSales: true, members, perSection: 100 }))
      .catch((e) => {
        logError('weekChanges', e)
        return { sections: empty, unavailable: empty.map((s) => s.kind) }
      }),
    getTodaysDigestWithSource().catch((e) => {
      logError('weekDigest', e)
      return null
    }),
  ])
  const report = await loadOpsReport({ now, today, week, canSeeSales: true, digest, changes })
  const stamp = `${czechDateLabel(now)} ${clockTime(now.toISOString())}`
  const weekHref = (key: WeekChoice) => `/cockpit/prehled-tydne?tyden=${key}${preview ? '&nahled=email' : ''}`

  return (
    <>
      <PageHeader
        title="Přehled týdne"
        eyebrow={`Týden ${isoWeek(today)} · obchody, dodávky, rozhodnutí, rizika`}
        subtitle="Provozní přehled firmy na jednom místě: co se změnilo, co čeká a kde hrozí riziko. Každá položka vede na svůj záznam."
      >
        {/* Týdenní přehled pro vedení: pipeline podle fáze, leady, nabídky, výhry a prohry. */}
        <ExportButtons prehled="tydenni-prehled" label="Stáhnout týdenní přehled pro vedení" params={{ tyden: week }} />
        {leadership && (preview ? (
          <Link href={`/cockpit/prehled-tydne?tyden=${week}`} className={buttonClass('outline')}>
            Zpět na přehled
          </Link>
        ) : (
          <Link href={`/cockpit/prehled-tydne?tyden=${week}&nahled=email`} className={buttonClass('primary')}>
            Náhled e-mailu
          </Link>
        ))}
      </PageHeader>

      <SectionTabs tabs={TODAY_TABS} label="Dnes a týden" />

      {/* Pondělní přehled je za minulý týden Po–Ne, páteční za probíhající. */}
      <nav aria-label="Který týden" className="seg mb-4">
        {WEEK_PILLS.map((p) => (
          <Link key={p.key} href={weekHref(p.key)} className="seg-item" aria-current={p.key === week ? 'page' : undefined}>{p.label}</Link>
        ))}
      </nav>

      {preview ? (
        <OpsEmailPreview
          email={renderOpsReportEmail(report, { appUrl: previewAppUrl(process.env), generatedAtLabel: czechDateLabel(now) })}
          sendEnabled={process.env.DIGEST_SEND_ENABLED === 'true'}
        />
      ) : (
        <>
          <p className="m-0 mb-4 text-callout text-muted">
            Obchody a posuny milníků {range.label}; ostatní je stav k {stamp}.
          </p>

          {report.unavailable.length > 0 && (
            <div className="mb-4">
              <TodayNote problem>Nepodařilo se načíst: {report.unavailable.join(', ')}. Ostatní části přehledu jsou vidět.</TodayNote>
            </div>
          )}

          <section aria-labelledby="souhrn-nadpis" className="mb-6">
            <h2 id="souhrn-nadpis" className="sr-only">Souhrn přehledu</h2>
            <OpsKeys report={report} />
          </section>

          {report.isEmpty && report.unavailable.length === 0 && (
            <Card className="mb-4">
              <EmptyState tone="calm" compact title="Tento týden nic nečeká">
                Žádné riziko, nic ke schválení, nic nečeká na nás ani na klienta a obchody se nehnuly.
              </EmptyState>
            </Card>
          )}

          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
            {report.sections.map((s) => <OpsSectionCard key={s.key} section={s} />)}
            <OpsSourcesCard sources={report.sources} alerts={report.sourceAlerts} />
          </div>

          {/* Celý záznam změn za týden (i rozhodnutí, úkoly, pošta klientů, peníze). */}
          <div className="mt-6">
            <ChangesCard
              sections={capSections(changes.sections, CHANGES_PER_SECTION)}
              windowLabel={range.label}
              unavailable={changes.unavailable}
              mode="week"
            />
          </div>

          <p className="mt-8 text-footnote text-muted">
            Po zapnutí odesílání chodí tento přehled e-mailem z Viktorovy schránky v pondělí (za minulý týden) a v pátek
            (za tento týden); ostatní dny jen krátký ranní souhrn, a to jen když je co hlásit.
          </p>
        </>
      )}
    </>
  )
}
