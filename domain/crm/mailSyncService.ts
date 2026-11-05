// Napojení syncu pošty a webhooků na Supabase (service role) a Graph.
//
// Sdílí ho denní cron (app/api/cron/outlook-mail) a webhook
// (app/api/ms/notifications): adaptér MailSyncDb nad mail_event /
// connector_state, token Viktorovy schránky přes service RPC z 0041, tabulka
// graph_subscription (0066) a Graph klient předplatných. Logika sama je
// v domain/crm/mailSync.ts, mailWebhook.ts a mailWebhookRun.ts; tady jen
// dráty. Zámek runJob (worker/) sem nepatří — domain na worker nesmí,
// route ho předá jako runLocked.
//
// Chybějící migrace (42P01 / PGRST205 tabulka, 42703 / PGRST204 sloupec)
// není pád: graph_subscription → MissingSubscriptionTableError u údržby,
// tiché no-op u záznamu notifikace a „chybí migrace 0066" ve Stavu zdrojů.

import { createAdminClient } from '@/lib/supabase/admin'
import { logError, logWarn } from '@/lib/log'
import {
  createSubscription,
  deleteSubscription,
  fetchMailDeltaPage,
  listSubscriptions,
  refreshAccessToken,
  renewSubscription,
  type SubscriptionFetch,
} from '@/connectors/graph'
import {
  getConnectorState,
  recordConnectorError,
  recordConnectorSuccess,
  type ConnectorState,
} from '@/core/connectorState'
import { recordEvidence as recordEvidenceRow } from '@/core/evidence'
import { COMPANY } from '@/config'
import { autoIntakeEnabledFromEnv, type IntakeCandidate } from '@/domain/crm/autoIntake'
import { runAutoIntakeLive } from '@/domain/crm/autoIntakeService'
import {
  MAIL_CONTENT_CONNECTOR,
  mailContentAiEnabledFromEnv,
  mailContentEnabledFromEnv,
  mailContentFolderName,
} from '@/domain/crm/mailContent'
import type { MailContentSource } from '@/domain/crm/mailContentStatus'
import { describeMailOfferStatus } from '@/domain/crm/mailOffer'
import {
  FOLDERS,
  mailSyncInitialDaysFromEnv,
  resolveAccessToken,
  runMailSync,
  type FolderKey,
  type MailSyncDb,
  type StoredToken,
  type TokenDeps,
} from '@/domain/crm/mailSync'
import {
  assessMailWebhook,
  disabledMailWebhookHealth,
  mailWebhookEnabledFromEnv,
  webhookConnectorKey,
  webhookResource,
  type MailWebhookHealth,
  type NotificationUrlResult,
  type SubscriptionRow,
} from '@/domain/crm/mailWebhook'
import {
  maintainMailSubscriptions,
  MissingSubscriptionTableError,
  WEBHOOK_MAX_PAGES,
  type MaintainStats,
  type NotificationWorkDeps,
  type SubscriptionGraph,
  type SubscriptionStore,
} from '@/domain/crm/mailWebhookRun'

type Admin = ReturnType<typeof createAdminClient>
type DbError = { code?: string | null; message: string } | null

const SUBSCRIPTION_TABLE = 'graph_subscription'
const SUBSCRIPTION_COLUMNS =
  'connector_key, subscription_id, resource, expires_at, client_state_hash, created_at, updated_at, last_notification_at, last_error'

/** Tabulka / sloupec neexistuje — migrace ještě neběžela. */
export function isMissingSchema(error: DbError): boolean {
  const code = error?.code ?? ''
  return code === '42P01' || code === 'PGRST205' || code === '42703' || code === 'PGRST204'
}

// ---------------------------------------------------------------------------
// Sync (dřív přímo v app/api/cron/outlook-mail/route.ts)

export function createMailSyncDb(admin: Admin, logScope: string): MailSyncDb {
  return {
    async loadCursor(connector) {
      return (await getConnectorState(connector))?.cursor ?? null
    },
    async saveCursor(connector, cursor) {
      const { error } = await admin
        .from('connector_state')
        .upsert({ connector, cursor, updated_at: new Date().toISOString() }, { onConflict: 'connector' })
      // Neuložený kurzor = příští běh stránku zopakuje; duplicity zahodí DB.
      if (error) throw new Error(`connector_state: ${error.message}`)
    },
    recordSuccess: recordConnectorSuccess,
    recordError: recordConnectorError,
    async markAttempt(connector) {
      // Jen updated_at (= poslední pokus); kurzor, úspěch i chyby zůstanou.
      // Zakládá řádek, když ještě není — díky tomu složka, na kterou nepřišla
      // řada, není ve Stavu zdrojů úplně beze stopy. Nevyhazuje.
      const { error } = await admin
        .from('connector_state')
        .upsert({ connector, updated_at: new Date().toISOString() }, { onConflict: 'connector' })
      if (error) logError(`${logScope}.markAttempt`, error, { connector })
    },
    async loadMatchData() {
      const [contacts, aliases] = await Promise.all([
        admin.from('contact').select('id, email, account_id').not('email', 'is', null),
        admin.from('company_alias').select('alias_domain, account_id').not('alias_domain', 'is', null),
      ])
      if (contacts.error) throw new Error(`contact: ${contacts.error.message}`)
      if (aliases.error) throw new Error(`company_alias: ${aliases.error.message}`)
      return {
        contacts: (contacts.data ?? []) as { id: number; email: string; account_id: number | null }[],
        aliases: (aliases.data ?? []).map((a) => ({ domain: a.alias_domain as string, account_id: a.account_id as number })),
      }
    },
    async insertEvents(rows) {
      const { data, error } = await admin
        .from('mail_event')
        .upsert(rows, { onConflict: 'internet_message_id,direction', ignoreDuplicates: true })
        .select('id')
      if (error) throw new Error(`mail_event: ${error.message}`)
      return data?.length ?? 0
    },
    async applyToAccount(accountId, direction, occurredAt) {
      const { error } = await admin.rpc('apply_mail_event_to_account', {
        p_account_id: accountId,
        p_direction: direction,
        p_occurred_at: occurredAt,
      })
      if (error) throw new Error(`apply_mail_event_to_account: ${error.message}`)
    },
    async purgeUnmatchedEvents() {
      // Bez argumentu = výchozí '30 days' z 0041 (rozhodnutí vlastníka).
      const { data, error } = await admin.rpc('purge_unmatched_mail_events')
      if (error) {
        logError(`${logScope}.purge`, error)
        throw new Error(`purge_unmatched_mail_events: ${error.message}`)
      }
      return (data as number | null) ?? 0
    },
    async recordEvidence(refs) {
      // Best-effort a bez ohledu na velikost dávky nekritické: stránka má
      // nejvýš pár desítek zpráv (Prefer odata.maxpagesize=50), takže žádný
      // další limit nepřidáváme. recordEvidence sama nikdy nevyhazuje —
      // failure se jen zaloguje, ať se to nikde neprojeví jako chyba syncu.
      await Promise.all(
        refs.map(async (r) => {
          const res = await recordEvidenceRow(admin, {
            kind: 'email_message',
            sourceId: r.internetMessageId,
            webLink: r.webLink,
          })
          if (!res.ok) {
            const message = res.reason === 'invalid' ? res.issues.join('; ') : res.message
            logError(`${logScope}.evidence`, new Error(message))
          }
        }),
      )
    },
  }
}

/** Token schránky OUTLOOK_MAIL_SYNC_MEMBER_ID přes service RPC z 0041. */
export function createMailTokenDeps(admin: Admin, memberId: string, logScope: string): TokenDeps {
  return {
    async load() {
      const { data, error } = await admin.rpc('calendar_token_get_for_service', { p_member_id: memberId })
      if (error) throw new Error(`calendar_token_get_for_service: ${error.message}`)
      return ((data as StoredToken[] | null)?.[0] ?? null)
    },
    refresh: refreshAccessToken,
    async save(t) {
      const { error } = await admin.rpc('calendar_token_update_for_service', {
        p_member_id: memberId,
        p_access_token: t.access_token,
        p_refresh_token: t.refresh_token,
        p_expires_at: t.expires_at,
      })
      if (error) logError(`${logScope}.tokenSave`, error)
      return !error
    },
    now: Date.now,
  }
}

/** Tvar JobDbAdapter z worker/ (domain na worker importovat nesmí). */
export function createJobDb(admin: Admin, logScope: string) {
  return {
    async tryAcquireJobLock(jobName: string, ttlSeconds: number): Promise<number | null> {
      const { data, error } = await admin.rpc('try_acquire_job_lock', { job_name: jobName, ttl_seconds: ttlSeconds })
      if (error) throw new Error(`try_acquire_job_lock: ${error.message}`)
      return (data as number | null) ?? null
    },
    async finishJobRun(
      runId: number,
      status: 'succeeded' | 'failed',
      stats: Record<string, unknown>,
      error: string | null,
    ): Promise<void> {
      const { error: e } = await admin.rpc('finish_job_run', { run_id: runId, status, stats, error })
      if (e) logError(`${logScope}.finish`, e, { runId })
    },
  }
}

// ---------------------------------------------------------------------------
// graph_subscription (0066)

export function createSubscriptionStore(admin: Admin, logScope: string): SubscriptionStore {
  return {
    async loadAll() {
      const { data, error } = await admin.from(SUBSCRIPTION_TABLE).select(SUBSCRIPTION_COLUMNS)
      if (error) {
        if (isMissingSchema(error)) throw new MissingSubscriptionTableError()
        throw new Error(`${SUBSCRIPTION_TABLE}: ${error.message}`)
      }
      return (data ?? []) as SubscriptionRow[]
    },
    async saveActive(row) {
      const { error } = await admin.from(SUBSCRIPTION_TABLE).upsert(
        { ...row, last_error: null, updated_at: new Date().toISOString() },
        { onConflict: 'connector_key' },
      )
      // Předplatné u Microsoftu existuje, jen o něm DB neví: notifikace
      // projdou (clientState), cron ho zítra najde přes 409 → list → smazat.
      if (error) throw new Error(`${SUBSCRIPTION_TABLE}: ${error.message}`)
    },
    async markError(connectorKey, resource, message, clear) {
      const row: Record<string, unknown> = {
        connector_key: connectorKey,
        resource,
        last_error: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      }
      if (clear) Object.assign(row, { subscription_id: null, expires_at: null, client_state_hash: null })
      const { error } = await admin.from(SUBSCRIPTION_TABLE).upsert(row, { onConflict: 'connector_key' })
      if (error && !isMissingSchema(error)) logError(`${logScope}.subscriptionError`, error, { connectorKey })
    },
    async remove(connectorKey) {
      const { error } = await admin.from(SUBSCRIPTION_TABLE).delete().eq('connector_key', connectorKey)
      if (error && !isMissingSchema(error)) throw new Error(`${SUBSCRIPTION_TABLE}: ${error.message}`)
    },
    async touchNotifications(subscriptionIds, at) {
      if (subscriptionIds.length === 0) return
      const { error } = await admin.from(SUBSCRIPTION_TABLE)
        .update({ last_notification_at: at })
        .in('subscription_id', subscriptionIds)
      if (error && !isMissingSchema(error)) logError(`${logScope}.touch`, error)
    },
    async latestNotificationAt(connectorKeys) {
      if (connectorKeys.length === 0) return null
      const { data, error } = await admin.from(SUBSCRIPTION_TABLE)
        .select('last_notification_at')
        .in('connector_key', connectorKeys)
      if (error) {
        if (!isMissingSchema(error)) logError(`${logScope}.latest`, error)
        return null
      }
      let latest: string | null = null
      for (const r of (data ?? []) as { last_notification_at: string | null }[]) {
        if (r.last_notification_at && (!latest || Date.parse(r.last_notification_at) > Date.parse(latest))) {
          latest = r.last_notification_at
        }
      }
      return latest
    },
  }
}

export function createSubscriptionGraph(accessToken: string, fetchImpl?: SubscriptionFetch): SubscriptionGraph {
  return {
    create: (req) => createSubscription(accessToken, req, fetchImpl),
    renew: (id, exp) => renewSubscription(accessToken, id, exp, fetchImpl),
    remove: (id) => deleteSubscription(accessToken, id, fetchImpl),
    list: () => listSubscriptions(accessToken, fetchImpl),
  }
}

/**
 * Údržba předplatných s ošetřenou konfigurací: bez platné APP_URL se nic
 * nezakládá a chyba se zapíše k oběma složkám (je vidět ve Stavu zdrojů).
 * Nikdy nevyhazuje — sync pošty kvůli webhooku nesmí spadnout.
 */
export async function maintainSubscriptionsSafely(opts: {
  store: SubscriptionStore
  graph: SubscriptionGraph
  secret: string
  notificationUrl: NotificationUrlResult
  folders?: FolderKey[]
  forceRenew?: FolderKey[]
  budgetMs: number
  logScope: string
}): Promise<MaintainStats | { error: string }> {
  try {
    if (!opts.notificationUrl.ok) {
      for (const key of opts.folders ?? (['inbox', 'sent'] as FolderKey[])) {
        await opts.store.markError(webhookConnectorKey(key), webhookResource(key), opts.notificationUrl.error, false)
      }
      return { error: opts.notificationUrl.error }
    }
    const stats = await maintainMailSubscriptions(
      { graph: opts.graph, store: opts.store, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      {
        secret: opts.secret,
        notificationUrl: opts.notificationUrl.url,
        folders: opts.folders,
        forceRenew: opts.forceRenew,
        budgetMs: opts.budgetMs,
      },
    )
    if (stats.migrationMissing) logWarn(`${opts.logScope}.webhook`, 'chybí migrace 0066 (graph_subscription) — předplatné se nezakládá')
    return stats
  } catch (e) {
    logError(`${opts.logScope}.webhook`, e)
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// Zpracování notifikace (webhook route, po odpovědi)

export function createNotificationWorkDeps(opts: {
  admin: Admin
  memberId: string
  secret: string
  notificationUrl: NotificationUrlResult
  runLocked: NotificationWorkDeps['runLocked']
  logScope: string
}): NotificationWorkDeps {
  const { admin, memberId, logScope } = opts
  const store = createSubscriptionStore(admin, logScope)
  let tokenPromise: Promise<string> | null = null
  const token = () => (tokenPromise ??= resolveAccessToken(createMailTokenDeps(admin, memberId, logScope)))

  return {
    store,
    async maintain(folders, forceRenew, budgetMs) {
      let accessToken: string
      try {
        accessToken = await token()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        for (const key of folders) await store.markError(webhookConnectorKey(key), webhookResource(key), msg, false)
        return { migrationMissing: false, folders: {} }
      }
      const r = await maintainSubscriptionsSafely({
        store,
        graph: createSubscriptionGraph(accessToken),
        secret: opts.secret,
        notificationUrl: opts.notificationUrl,
        folders,
        forceRenew,
        budgetMs,
        logScope,
      })
      return 'error' in r ? { migrationMissing: false, folders: {} } : r
    },
    async sync(folders, budgetMs) {
      let accessToken: string
      try {
        accessToken = await token()
      } catch (e) {
        // Stejně jako cron: chyba tokenu do stavu konektorů (vidět v Nastavení).
        const msg = e instanceof Error ? e.message : String(e)
        for (const key of folders) await recordConnectorError(FOLDERS[key].connector, msg)
        throw e
      }
      // Automatické založení poptávky (docs/PROVOZ.md): sesbírat
      // nespárované příchozí zprávy a po syncu je předat pravidlům. Vypnuté =
      // sync se chová přesně jako dřív a adresy odesílatelů se nesbírají.
      const collect = autoIntakeEnabledFromEnv(process.env) && !!COMPANY.capabilities.autoIntake
      const intake: IntakeCandidate[] = []
      const stats = await runMailSync(
        {
          fetchPage: (url) => fetchMailDeltaPage(accessToken, url),
          db: createMailSyncDb(admin, logScope),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: Date.now,
          ...(collect ? { onPageStored: (page) => { if (page.intake) intake.push(...page.intake) } } : {}),
        },
        {
          folders,
          purge: false,
          budgetMs,
          maxPages: WEBHOOK_MAX_PAGES,
          collectIntake: collect,
          initialDays: mailSyncInitialDaysFromEnv(process.env),
        },
      )
      if (!collect || intake.length === 0) return stats
      try {
        return { ...stats, autoIntake: await runAutoIntakeLive({ candidates: intake, ownerId: memberId }) }
      } catch (e) {
        logError(`${logScope}.autoIntake`, e)
        return { ...stats, autoIntake: { capability: 'auto_intake', error: e instanceof Error ? e.name : 'chyba' } }
      }
    },
    runLocked: opts.runLocked,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

// ---------------------------------------------------------------------------
// Stav pro „Stav zdrojů" (přehled týdne, e-mail, Nastavení)

/**
 * Stav webhooku. Při vypnutém přepínači DB vůbec nečte. Chyba čtení se
 * nepropaguje — přehled i Nastavení se musí vykreslit; ohlásí se jako
 * problém (rozbitý zdroj), ne jako „vše v pořádku".
 */
export async function loadMailWebhookHealth(
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): Promise<MailWebhookHealth> {
  const enabled = mailWebhookEnabledFromEnv(env)
  if (!enabled) return disabledMailWebhookHealth()
  try {
    const admin = createAdminClient()
    const { data, error } = await admin.from(SUBSCRIPTION_TABLE).select(SUBSCRIPTION_COLUMNS)
    if (error) {
      if (isMissingSchema(error)) return assessMailWebhook(null, { enabled, now })
      throw new Error(error.message)
    }
    return assessMailWebhook((data ?? []) as SubscriptionRow[], { enabled, now })
  } catch (e) {
    logError('mailWebhook.health', e)
    return {
      ...assessMailWebhook([], { enabled, now }),
      problems: ['stav předplatného nejde načíst'],
      broken: true,
    }
  }
}

export type MailSourcesStatus = {
  syncEnabled: boolean
  inbox: ConnectorState | null
  sent: ConnectorState | null
  webhook: MailWebhookHealth
  /** Obsahový vstup pošty (složka „Cockpit"); chybí u starých fixtur. */
  content?: MailContentSource
  /** Okno prvního načtení v dnech (MAIL_SYNC_INITIAL_DAYS; 0 = bez omezení); chybí u starých fixtur. */
  initialDays?: number
}

/** Pro kartu v Nastavení: sync pošty (obě složky) + webhook + obsahový vstup. Nevyhazuje. */
export async function loadMailSourcesStatus(
  env: Record<string, string | undefined> = process.env,
): Promise<MailSourcesStatus> {
  const syncEnabled = env.OUTLOOK_MAIL_SYNC_ENABLED === 'true'
  const initialDays = mailSyncInitialDaysFromEnv(env)
  const contentBase: MailContentSource = {
    enabled: mailContentEnabledFromEnv(env),
    folderName: mailContentFolderName(env),
    aiEnabled: mailContentAiEnabledFromEnv(env),
    aiKeyMissing: !env.ANTHROPIC_API_KEY,
    offerNote: describeMailOfferStatus(env),
    state: null,
  }
  if (!syncEnabled) {
    return { syncEnabled, inbox: null, sent: null, webhook: disabledMailWebhookHealth(), content: contentBase, initialDays }
  }
  const [inbox, sent, webhook, contentState] = await Promise.all([
    getConnectorState(FOLDERS.inbox.connector),
    getConnectorState(FOLDERS.sent.connector),
    loadMailWebhookHealth(env),
    contentBase.enabled ? getConnectorState(MAIL_CONTENT_CONNECTOR) : Promise.resolve(null),
  ])
  return { syncEnabled, inbox, sent, webhook, content: { ...contentBase, state: contentState }, initialDays }
}
