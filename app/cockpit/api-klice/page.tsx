import { isCurrentUserAdmin } from '@/lib/queries/team'
import { listApiKeys } from '@/lib/queries/apiKeys'
import { PageHeader } from '@/components/PageHeader'
import { ApiKeyForm } from '@/components/ApiKeyForm'
import { ApiKeyActions } from '@/components/ApiKeyActions'
import { SettingsTabs } from '@/components/ui/SettingsTabs'
import { SettingsTile } from '@/components/ui/SettingsParts'
import { CARD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { buttonClass } from '@/components/ui/Button'
import { formatDate } from '@/lib/format'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadOAuthOverview } from '@/lib/oauthOverview'
import { OAuthConnectionsCard } from '@/components/OAuthConnectionsCard'

const SCOPE_LABELS: Record<string, string> = {
  full: 'čtení i zápis',
  read: 'jen čtení',
  intake: 'jen zápisy schůzek',
}

export default async function ApiKeysPage() {
  const admin = await isCurrentUserAdmin()
  if (!admin) {
    return (
      <>
        <PageHeader title="API klíče" eyebrow="Napojení externích nástrojů" />
        <div className={CARD}>
          <EmptyState title="Nemáš oprávnění zobrazit API klíče." action={{ href: '/cockpit/nastaveni', label: 'Otevřít Nastavení' }}>
            Klíče pro napojení nástrojů spravují jen správci.
          </EmptyState>
        </div>
      </>
    )
  }

  // Připojení Claude: servisní klient (oauth_refresh_token a api_key čte jen
  // service role) — stránka je jen pro admina, gate je výše.
  const [keys, oauth] = await Promise.all([
    listApiKeys(),
    loadOAuthOverview(createAdminClient()).catch(() => null),
  ])
  const active = keys.filter((k) => !k.revoked_at)
  const revoked = keys.length - active.length
  const usedTimes = active.map((k) => k.last_used_at).filter((d): d is string => !!d).sort()
  const lastUsed = usedTimes.length > 0 ? usedTimes[usedTimes.length - 1] : null

  return (
    <>
      <PageHeader
        title="API klíče"
        eyebrow="Napojení externích nástrojů"
        subtitle="Pro čtení dat z Cockpitu přes /api/v1 — Claude Code, budoucí Notion sync. Klíč „jen zápisy schůzek“ je pro odesílání diktátu z Wispr Flow (návod: docs/PROVOZ.md)."
      >
        <a href="#novy-klic" className={buttonClass('primary')}>Vytvořit klíč</a>
      </PageHeader>

      <SettingsTabs isAdmin />

      <div className="mb-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SettingsTile color="mint" label="Platných klíčů" value={active.length} />
        <SettingsTile color="pink" label="Zrušených" value={revoked} />
        <SettingsTile color="sky" label="Naposledy použit" value={<span className="text-[26px] tabular-nums">{lastUsed ? formatDate(lastUsed) : 'nikdy'}</span>} />
      </div>

      <section aria-label="API klíče" className="mb-5">
        {keys.length === 0 ? (
          <div className={CARD}>
            <EmptyState title="Zatím žádný klíč." action={{ href: '#novy-klic', label: 'Vytvořit klíč' }}>
              Klíč vytvoříš formulářem níže. Zobrazí se jen jednou.
            </EmptyState>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {keys.map((k) => (
              <li
                key={k.id}
                className={`${CARD} flex flex-wrap items-center gap-x-5 gap-y-3 p-4 sm:px-6${k.revoked_at ? ' text-muted' : ''}`}
              >
                <div className="min-w-[180px] flex-1">
                  <h2 className="m-0 font-heading text-title2 font-bold">{k.name}</h2>
                  <code className="mt-1 inline-block rounded-full bg-[color:var(--c-soft)] px-3 py-0.5 font-mono text-callout">{k.key_prefix}••••</code>
                </div>
                <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-1 text-callout tabular-nums">
                  <div>
                    <dt className="eyebrow">Rozsah</dt>
                    <dd className="m-0 mt-0.5">{SCOPE_LABELS[k.scope ?? 'full'] ?? k.scope}</dd>
                  </div>
                  <div>
                    <dt className="eyebrow">Vytvořen</dt>
                    <dd className="m-0 mt-0.5">{formatDate(k.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="eyebrow">Naposledy použit</dt>
                    <dd className="m-0 mt-0.5">{k.last_used_at ? formatDate(k.last_used_at) : 'nikdy'}</dd>
                  </div>
                </dl>
                {k.revoked_at && <span className="st fail">Zrušen</span>}
                <ApiKeyActions id={k.id} revoked={!!k.revoked_at} name={k.name} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <OAuthConnectionsCard overview={oauth} />

      <Card id="novy-klic" className="scroll-mt-6" title="Vytvořit nový klíč" sub="Pojmenuj klíč podle nástroje, který ho bude používat. Tak ho později snadno zrušíš.">
        <ApiKeyForm />
      </Card>
    </>
  )
}
