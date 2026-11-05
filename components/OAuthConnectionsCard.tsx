import { COMPANY } from '@/config'
import { formatDate } from '@/lib/format'
import type { OAuthConnection, OAuthOverview } from '@/lib/oauthOverview'
import { oauthHealthStatus } from '@/lib/oauthOverview'
import { Card } from '@/components/ui/Card'

// /api-klice → „Připojení Claude": každé připojení konektoru Cockpit
// (rodina OAuth tokenů) se stavem a důvodem a posledních 20 problémů
// (odmítnutí na token endpointu, 401 na /api/mcp, zrušení připojení).
// Data načítá stránka (loadOAuthOverview, jen admin), komponenta vykresluje.
// `overview` null = přehled se nepodařilo načíst.

const timeFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, hour: '2-digit', minute: '2-digit' })

function dateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${formatDate(iso)} ${timeFmt.format(d)}`
}

const STATUS: Record<OAuthConnection['status'], { label: string; cls: string }> = {
  active: { label: 'Aktivní', cls: 'st done' },
  expired: { label: 'Prošlé', cls: 'st idle' },
  revoked: { label: 'Zrušené', cls: 'st fail' },
}

export function OAuthConnectionsCard({ overview }: { overview: OAuthOverview | null }) {
  const alert = oauthHealthStatus(overview?.health)
  return (
    <Card
      id="pripojeni-claude"
      className="mb-5 scroll-mt-6"
      title="Připojení Claude"
      sub="Konektor Cockpit v Claude (OAuth). Proč se připojení odpojilo, vidíš u něj a v posledních problémech."
      badge={overview ? <span className={alert ? 'st fail' : 'st done'}>{alert ? 'Problém za 24 h' : 'V pořádku'}</span> : undefined}
    >
      {!overview ? (
        <p className="m-0 text-body text-muted">Přehled připojení se nepodařilo načíst.</p>
      ) : (
        <>
          {alert && <p className="m-0 mb-4 text-callout">{alert.line}</p>}
          {!overview.available ? (
            <p className="m-0 text-callout text-muted">Připojení nejde vypsat: v databázi chybí tabulka obnovovacích tokenů (migrace 0083).</p>
          ) : overview.connections.length === 0 ? (
            <p className="m-0 text-callout text-muted">Žádné připojení za posledních 30 dní.</p>
          ) : (
            <ul role="list" className="m-0 flex list-none flex-col gap-3 p-0">
              {overview.connections.map((c) => (
                <li key={c.familyId} className={`rounded-tile border border-border p-3 sm:px-4${c.status === 'active' ? '' : ' text-muted'}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-semibold text-ink">{c.clientName ?? 'Klient bez názvu'}</span>
                    <code className="font-mono text-footnote text-muted">{c.clientId.slice(-6)} · {c.familyId.slice(-6)}</code>
                    <span className={STATUS[c.status].cls}>{STATUS[c.status].label}</span>
                  </div>
                  <dl className="m-0 mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-callout tabular-nums sm:grid-cols-4">
                    <div><dt className="eyebrow">Schválil</dt><dd className="m-0 mt-0.5">{c.approverName ?? '—'}</dd></div>
                    <div><dt className="eyebrow">Rozsah</dt><dd className="m-0 mt-0.5">{c.scope === 'full' ? 'čtení i zápis' : 'jen čtení'}</dd></div>
                    <div><dt className="eyebrow">Naposledy použito</dt><dd className="m-0 mt-0.5">{c.lastUsedAt ? dateTime(c.lastUsedAt) : 'nikdy'}</dd></div>
                    <div><dt className="eyebrow">Platí do</dt><dd className="m-0 mt-0.5">{formatDate(c.validUntil)}</dd></div>
                  </dl>
                  {c.reason && (
                    <p className="m-0 mt-2 text-footnote">
                      {c.status === 'revoked' ? 'Zrušeno' : 'Prošlo'} {dateTime(c.changedAt)}: {c.reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3 className="m-0 mt-5 font-heading text-headline font-bold">Posledních {overview.problems.length || 20} problémů</h3>
          {overview.problems.length === 0 ? (
            <p className="m-0 mt-2 text-callout text-muted">Zatím žádné odmítnutí ani odpojení.</p>
          ) : (
            <ul role="list" className="m-0 mt-2 list-none space-y-2 p-0 text-callout">
              {overview.problems.map((p) => (
                <li key={p.id}>
                  <span className="tabular-nums text-muted">{dateTime(p.at)}</span>
                  {' · '}
                  <span className="font-semibold text-ink">{p.clientName ?? 'neznámý klient'}</span>
                  {p.connection && <code className="ml-1 font-mono text-footnote text-muted">{p.connection}</code>}
                  {' · '}
                  <span className="text-muted">{p.source}</span>
                  <span className="block break-words">
                    {p.revoked && <span className="st fail mr-2">zrušeno</span>}
                    {p.reason}
                    {p.repeats > 0 && <span className="text-muted"> (+{p.repeats}× během minuty)</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  )
}
