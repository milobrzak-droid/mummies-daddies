import Link from 'next/link'
import { COMPANY } from '@/config'
import { formatDate } from '@/lib/format'
import { JOB_HEALTH_WINDOW_DAYS, type JobHealth } from '@/domain/crm/jobHealth'
import { Card } from '@/components/ui/Card'
import { oauthHealthStatus, type OAuthHealth } from '@/lib/oauthOverview'

// Nastavení → „Stav úloh": plánované úlohy (sync pošty, přehled e-mailem,
// ARES, hlídač follow-upů…), které naposledy selhaly nebo visí déle, než
// dovoluje zámek. Stejný stav je ve „Stavu zdrojů" v přehledu e-mailem.
// Data načítá stránka (loadJobHealth), komponenta jen vykresluje.
// `health` null = job_run nejde přečíst (chybí migrace 0040 nebo výpadek).
// `oauth` (jen pro adminy): konektor Claude za 24 h — zrušené připojení nebo
// opakované 401 u platného připojení (lib/oauthOverview.ts). Bez problému nic.

const timeFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, hour: '2-digit', minute: '2-digit' })

function dateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${formatDate(iso)} ${timeFmt.format(d)}`
}

export function JobHealthCard({ health, oauth }: { health: JobHealth | null; oauth?: OAuthHealth | null }) {
  const connector = oauthHealthStatus(oauth)
  const ok = !!health && health.problems.length === 0 && !connector
  return (
    <Card
      title="Stav úloh"
      sub={`Plánované úlohy za posledních ${JOB_HEALTH_WINDOW_DAYS} dní.`}
      badge={health ? <span className={ok ? 'st done' : 'st'}>{ok ? 'V pořádku' : 'Problém'}</span> : undefined}
    >
      {connector && (
        <p className="m-0 mb-3 text-callout">
          <span className="font-semibold text-ink">Konektor Claude</span>
          <span className="text-muted"> — {connector.line.replace(/^Konektor Claude za 24 h: /, 'za 24 h: ')} </span>
          <Link href="/cockpit/api-klice#pripojeni-claude" className="underline">Otevřít</Link>
        </p>
      )}
      {!health ? (
        <p className="m-0 text-body text-muted">Stav úloh se nepodařilo načíst.</p>
      ) : health.problems.length === 0 ? (
        <p className="m-0 text-callout text-muted">
          {health.jobsSeen === 0
            ? 'Za poslední týden neběžela žádná plánovaná úloha.'
            : `Všechny úlohy naposledy doběhly v pořádku${health.failuresInWindow > 0 ? ` (dřívější selhání: ${health.failuresInWindow}×)` : ''}.`}
        </p>
      ) : (
        <ul role="list" className="m-0 list-none space-y-2 p-0 text-callout">
          {health.problems.map((p) => (
            <li key={`${p.job}-${p.kind}-${p.at}`}>
              <span className="font-semibold text-ink">{p.label}</span>
              <span className="text-muted">
                {p.kind === 'stuck' ? ` — visí od ${dateTime(p.at)} (nedoběhl, zámek vypršel)` : ` — selhal ${dateTime(p.at)}`}
              </span>
              {p.error && <span className="block break-words text-footnote text-muted">{p.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
