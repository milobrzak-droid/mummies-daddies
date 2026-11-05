import Link from 'next/link'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { COMPANY } from '@/config'
import { formatDate } from '@/lib/format'
import type { MeetingIntakeStats } from '@/domain/crm/queries/meetingIntake'
import { Card } from '@/components/ui/Card'

// Nastavení → „Zápisy schůzek z Wispr Flow": kolik zápisů z diktátu přišlo
// (posledních 30 dní), kdy naposledy a kolik jich čeká na ruční přiřazení.
// Stejná čísla jsou ve „Stavu zdrojů" v přehledu (domain/crm/digest.ts).
// Wispr Flow nemá API, takže „zastaralé" tu nic neznamená — zápis odesílá
// člověk; jen ukazujeme, kdy to naposledy udělal.
// Data načítá stránka (getMeetingIntakeStats), komponenta jen vykresluje.
// `stats` null = příjem zápisů zatím není nasazený (chybí migrace 0078).

const timeFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, hour: '2-digit', minute: '2-digit' })

function dateTime(iso: string | null): string {
  if (!iso) return 'nikdy'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${formatDate(iso)} ${timeFmt.format(d)}`
}

export function MeetingSourcesCard({ stats }: { stats: MeetingIntakeStats | null }) {
  return (
    <Card title="Zápisy schůzek z Wispr Flow">
      <div className="space-y-3">
      {!stats ? (
        <p className="m-0 text-body text-muted">
          <FeaturePending
            variant="inline"
            migration="0078 a 0079"
            title="Příjem zápisů se připravuje. Wispr Flow nemá veřejné API, zápis se posílá z diktátu (návod: docs/PROVOZ.md)."
          />
        </p>
      ) : (
        <>
          <ul className="m-0 list-none space-y-1 p-0 text-callout text-muted tabular-nums">
            <li>Poslední zápis: {dateTime(stats.lastReceivedAt)}</li>
            <li>Přijato za posledních 30 dní: {stats.received30d}</li>
            <li className={stats.unmatched > 0 ? 'text-ink' : undefined}>
              Čeká na přiřazení: {stats.unmatched}
              {stats.unmatched > 0 && (
                <> — <Link href="/cockpit/schuzky/nesparovane" className="font-semibold underline">otevřít frontu</Link></>
              )}
            </li>
          </ul>
          <p className="m-0 text-footnote text-muted">
            Wispr Flow nemá API: zápis odesílá člověk (zkratka, curl), Cockpit ho spáruje na klienta.
            Návod v docs/PROVOZ.md.
          </p>
        </>
      )}
      </div>
    </Card>
  )
}
