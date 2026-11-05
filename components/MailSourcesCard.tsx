import { COMPANY } from '@/config'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { describeFolderStatus } from '@/domain/crm/mailFolderStatus'
import { describeMailContentStatus } from '@/domain/crm/mailContentStatus'
import { formatDate } from '@/lib/format'
import type { MailSourcesStatus } from '@/domain/crm/mailSyncService'
import type { ConnectorState } from '@/core/connectorState'
import { Card } from '@/components/ui/Card'
import { SyncTasksButton } from '@/components/SyncTasksButton'
import type { ActionResult } from '@/lib/actionResult'
import { parseCursor } from '@/domain/crm/mailSync'

// Nastavení → „Pošta z Outlooku": stav syncu metadat (denní cron) a webhooku
// (okamžité notifikace, kapitola 8). Stejná pravidla jako „Stav zdrojů"
// v přehledu (domain/crm/digest.ts): sync je zastaralý po 36 h, webhook je
// rozbitý, když chybí / vypršelo předplatné nebo jeho obnova skončila chybou.
// Data načítá stránka (loadMailSourcesStatus), komponenta jen vykresluje.

const MAIL_STALE_AFTER_HOURS = 36

const timeFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, hour: '2-digit', minute: '2-digit' })

function dateTime(iso: string | null): string {
  if (!iso) return 'nikdy'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${formatDate(iso)} ${timeFmt.format(d)}`
}

// První načtení historie ještě běží, když některá složka stránkuje nebo se dosud nedotáhla.
function initialLoadPending(states: (ConnectorState | null)[]): boolean {
  return states.some((s) => s === null || s.last_success_at === null || parseCursor(s.cursor)?.phase === 'paging')
}

export function MailSourcesCard({
  status,
  syncNowAction,
}: {
  status: MailSourcesStatus
  /** Ruční běh syncu (jen správce a obchodní role — rozhoduje stránka i akce). Bez něj se tlačítko nezobrazí. */
  syncNowAction?: () => Promise<ActionResult & { note?: string }>
}) {
  const { syncEnabled, inbox, sent, webhook, content, initialDays } = status
  const contentStatus = content ? describeMailContentStatus(content, syncEnabled) : null
  const folders = [
    { label: 'Doručená', state: inbox },
    { label: 'Odeslaná', state: sent },
  ]

  return (
    <Card title="Pošta z Outlooku (synchronizace)">
      <div className="space-y-3">
      {!syncEnabled ? (
        <p className="m-0 text-body text-muted">
          Synchronizace pošty je vypnutá (OUTLOOK_MAIL_SYNC_ENABLED). Cockpit z pošty čte běžně jen metadata — kdo a kdy psal (obsah jen ze složky „Cockpit“, když je zapnutý).
          {content?.enabled ? ' Pošta s obsahem (složka „' + content.folderName + '“) je zapnutá, ale běží jen s touto synchronizací.' : ''}
        </p>
      ) : (
        <>
          <ul className="list-none p-0 m-0 space-y-2">
            {folders.map(({ label, state }) => {
              const st = describeFolderStatus(state, MAIL_STALE_AFTER_HOURS)
              const bad = st.tone !== 'ok'
              return (
                <li key={label} className={`flex items-start gap-2.5 rounded-btn bg-[color:var(--c-soft)] px-4 py-3 text-callout ${st.tone === 'error' ? 'text-neg' : st.tone === 'ok' ? 'text-[color:#39414D]' : 'text-warn'}`}>
                  <span aria-hidden="true" className={`mt-1 h-2 w-2 shrink-0 rounded-full ${st.tone === 'error' ? 'bg-[color:var(--d-red)]' : bad ? 'bg-[color:var(--d-amber)]' : 'bg-[color:var(--d-green)]'}`} />
                  <span>
                    {label}: poslední synchronizace {dateTime(st.lastSuccessAt)}
                    {st.message ? ` — ${st.message}` : ''}
                    {bad ? ` (poslední pokus: ${dateTime(st.lastAttemptAt)})` : ''}
                  </span>
                </li>
              )
            })}
          </ul>

          {initialDays !== undefined && (
            <p className="m-0 text-footnote text-muted">
              {initialDays > 0
                ? `První načtení bere jen poštu z posledních ${initialDays} dní (MAIL_SYNC_INITIAL_DAYS); starší se nenačítá.`
                : 'První načtení bere celou historii pošty (MAIL_SYNC_INITIAL_DAYS = 0).'}
            </p>
          )}

          {syncNowAction && (
            <div className="space-y-1">
              <SyncTasksButton
                action={syncNowAction}
                label={initialLoadPending([inbox, sent]) ? 'Dotáhnout další část' : 'Synchronizovat poštu teď'}
              />
              <p className="m-0 text-footnote text-muted">
                Spustí jeden běh hned, nemusíš čekat na denní synchronizaci. Trvá do minuty.
              </p>
            </div>
          )}

          {content && contentStatus && (
            <>
              <h3 className="m-0 pt-2 text-headline">Pošta s obsahem (složka „{content.folderName}“)</h3>
              <p
                className={`m-0 rounded-btn bg-[color:var(--c-soft)] px-4 py-3 text-callout ${contentStatus.tone === 'error' ? 'text-neg' : contentStatus.tone === 'warn' ? 'text-warn' : 'text-[color:#39414D]'}`}
                role={contentStatus.tone === 'error' ? 'alert' : undefined}
              >
                {contentStatus.message}
                {contentStatus.lastSuccessAt ? ` Poslední běh: ${dateTime(contentStatus.lastSuccessAt)}.` : ''}
              </p>
              {contentStatus.ai && <p className="m-0 text-footnote text-muted">{contentStatus.ai}</p>}
              {contentStatus.offer && <p className="m-0 text-footnote text-muted">{contentStatus.offer}</p>}
            </>
          )}

          <h3 className="m-0 pt-2 text-headline">Okamžité notifikace (webhook)</h3>
          {!webhook.enabled ? (
            <p className="m-0 text-footnote text-muted">
              Vypnuto (OUTLOOK_MAIL_WEBHOOK_ENABLED) — nové e-maily se do Cockpitu dostanou až při denní synchronizaci.
            </p>
          ) : webhook.migrationMissing ? (
            <p role="alert" className="m-0 text-callout text-neg"><FeaturePending variant="inline" migration="0066" title="Nefunguje: okamžité notifikace se teprve připravují." /></p>
          ) : (
            <>
              <p className="m-0 text-footnote text-muted">
                Poslední notifikace: {dateTime(webhook.lastNotificationAt)}
                {webhook.expiresAt ? ` · předplatné platí do ${dateTime(webhook.expiresAt)}` : ''}
              </p>
              {webhook.problems.length > 0 && (
                <ul role="alert" className="list-none p-0 m-0 space-y-1">
                  {webhook.problems.map((p) => (
                    <li key={p} className="rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-2.5 text-callout text-neg">{p}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
      </div>
    </Card>
  )
}
