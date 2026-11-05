import { PageHeader } from '@/components/PageHeader'
import { SyncTasksButton } from '@/components/SyncTasksButton'
import { disconnectOutlook } from '@/domain/crm/actions/calendar'
import { runMailSyncNow, syncOutlookNow } from './actions'
import { getMyCalendarConnection } from '@/domain/crm/queries/calendar'
import { getConnectorState, isStale } from '@/core/connectorState'
import { formatDate } from '@/lib/format'
import { ChangePasswordForm } from '@/components/ChangePasswordForm'
import { missingGraphScopes } from '@/connectors/graph'
import { EditFullNameForm } from '@/components/EditFullNameForm'
import { updateMyDisplayName } from '@/lib/actions/security'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { MailSourcesCard } from '@/components/MailSourcesCard'
import { loadMailSourcesStatus } from '@/domain/crm/mailSyncService'
import { SettingsTabs } from '@/components/ui/SettingsTabs'
import { Card } from '@/components/ui/Card'
import { buttonClass } from '@/components/ui/Button'
import { MeetingSourcesCard } from '@/components/MeetingSourcesCard'
import { getMeetingIntakeStats } from '@/domain/crm/queries/meetingIntake'
import { memberSeesSales } from '@/lib/queries/currentMember'
import { canRunMailSyncNow } from '@/domain/crm/mailSyncProgress'
import { JobHealthCard } from '@/components/JobHealthCard'
import { loadJobHealth } from '@/domain/crm/jobHealth'
import { loadOAuthHealth } from '@/lib/oauthOverview'
import { createClient } from '@/lib/supabase/server'

// Tenhle konektor se používá pasivně — sync úkolů běží jen občas ručně
// a plánování schůzky není každodenní úkon. Proto okno 7 dní, ať
// se čerstvost nezačne hlásit jako stará jen proto, že týden nikdo úkol
// s termínem nezaložil ani neplánoval schůzku.
const STALE_AFTER_HOURS = 24 * 7

// „Dotáhnout další část" u pošty spouští jeden běh syncu (až 55 s) jako server
// akci z této stránky — ta dědí maxDuration stránky.
export const maxDuration = 60


export default async function SettingsPage({
  searchParams,
}: { searchParams: Promise<{ connected?: string; err?: string }> }) {
  const { connected: justConnected, err } = await searchParams
  const [{ connected, email, grantedScopes }, connectorState, { member }, mailSources, jobHealth] = await Promise.all([
    getMyCalendarConnection(),
    getConnectorState('graph_calendar'),
    getCurrentMember(),
    loadMailSourcesStatus(),
    // Stav plánovaných úloh (job_run čte tým s AAL2); chyba = dlaždice řekne „nepodařilo načíst".
    createClient().then((s) => loadJobHealth(s)).catch(() => null),
  ])
  // Zápisy schůzek jsou obchodní data (RLS 0078) — karta jen obchodním rolím.
  const seesSales = memberSeesSales(member)
  const meetingIntake = seesSales ? await getMeetingIntakeStats().catch(() => null) : null
  // null = udělená práva neznáme (připojeno před migrací 0060).
  const missingScopes = connected ? missingGraphScopes(grantedScopes) : null
  // Záložky Tým / API klíče jsou jen pro adminy; stránky samy si oprávnění hlídají.
  const isAdmin = !!member?.is_admin
  // Konektor Claude (diagnostika v audit_event) — jen adminům, jako /api-klice.
  const oauthHealth = isAdmin ? await createClient().then((s) => loadOAuthHealth(s)).catch(() => null) : null

  return (
    <>
      <PageHeader title="Nastavení" eyebrow="Integrace" subtitle="Tvůj profil, heslo a napojení na Outlook." />

      <SettingsTabs isAdmin={isAdmin} />

      {justConnected === '1' && (
        <p role="status" className="mb-4 rounded-tile bg-[color:var(--c-pos-soft)] px-4 py-3 text-body font-semibold text-pos">Outlook byl úspěšně připojen.</p>
      )}
      {err && <p role="alert" className="mb-4 rounded-tile bg-[color:var(--c-neg-soft)] px-4 py-3 text-body font-semibold text-neg">{errorMessage(err)}</p>}

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <Card title="Profil" sub="Jméno, které se ti zobrazuje v aplikaci.">
            <EditFullNameForm action={updateMyDisplayName} initialFullName={member?.full_name ?? ''} />
          </Card>

          <Card title="Heslo" sub="Nastav si vlastní heslo pro přihlašování.">
            <ChangePasswordForm />
          </Card>
        </div>

        <div className="space-y-5">
          <Card
            title="Microsoft Outlook (kalendář, pošta)"
            badge={connected ? <span className="st done">Připojeno</span> : <span className="st">Nepřipojeno</span>}
          >
            <div className="space-y-3">
              {connected ? (
                <>
                  <p className="m-0 text-body text-muted">
                    Připojeno jako <span className="font-semibold text-ink">{email ?? '—'}</span>
                  </p>
                  <p className={`m-0 text-footnote ${isStale(connectorState, STALE_AFTER_HOURS) ? 'text-ink' : 'text-muted'}`}>
                    Naposledy použito: {connectorState?.last_success_at ? formatDate(connectorState.last_success_at) : 'nikdy'}
                  </p>
                  {missingScopes && missingScopes.length > 0 && (
                    <p role="alert" className="m-0 rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-2.5 text-callout text-neg">
                      Chybí oprávnění: {missingScopes.join(' / ')} — klikni Znovu připojit.
                    </p>
                  )}
                  {missingScopes === null && (
                    <p className="m-0 text-footnote text-muted">
                      Udělená oprávnění nejsou známá. Pokud jsi Outlook připojil před 28. 9. 2026, klikni
                      Znovu připojit — Cockpit teď potřebuje i čtení a odesílání pošty (Mail.Read, Mail.Send).
                    </p>
                  )}
                  <div className="flex flex-wrap items-start gap-3">
                    {/* Úkoly do kalendáře; obchodním rolím i kontrola naplánovaných
                        schůzek podle Outlooku (posun, zrušení) — viz ./actions.ts. */}
                    <SyncTasksButton
                      action={async () => { 'use server'; return syncOutlookNow() }}
                      label={seesSales ? 'Synchronizovat úkoly a schůzky' : 'Synchronizovat úkoly'}
                    />
                    {/* Nový souhlas se všemi GRAPH_SCOPES (prompt=consent); řádek
                        s tokenem callback přepíše, odpojovat předem netřeba. */}
                    <a href="/api/ms/connect?reconnect=1" className={buttonClass('outline')}>
                      Znovu připojit (rozšířit oprávnění)
                    </a>
                    <form action={disconnectOutlook}>
                      <button type="submit" className={buttonClass('quiet')}>
                        Odpojit
                      </button>
                    </form>
                  </div>
                </>
              ) : (
                <>
                  <p className="m-0 text-body text-muted">
                    Propoj svůj Outlook kalendář a termíny úkolů se ti automaticky promítnou do kalendáře.
                    Microsoft se zeptá i na přístup k poště. Cockpit ji běžně čte jen jako metadata (kdo a kdy
                    psal, nikdy předmět ani text). Výjimkou je složka „Cockpit“: zprávy, které tam sám přesuneš,
                    přečte včetně textu, aby z nich navrhl krok. Z pošty také posílá e-mailový přehled.
                  </p>
                  <a href="/api/ms/connect" className={buttonClass('primary')}>
                    Připojit Outlook
                  </a>
                </>
              )}
            </div>
          </Card>

          <MailSourcesCard
            status={mailSources}
            syncNowAction={canRunMailSyncNow(member, seesSales) ? async () => { 'use server'; return runMailSyncNow() } : undefined}
          />
          {seesSales && <MeetingSourcesCard stats={meetingIntake} />}
          <JobHealthCard health={jobHealth} oauth={oauthHealth} />
        </div>
      </div>
    </>
  )
}

function errorMessage(code: string): string {
  switch (code) {
    case 'notconfigured':
      return 'Integrace s Outlookem zatím není nastavená (chybí MS_CLIENT_ID / MS_CLIENT_SECRET).'
    case 'oauth':
      return 'Připojení k Outlooku se nepodařilo. Zkus to prosím znovu.'
    default:
      return 'Nastala chyba.'
  }
}
