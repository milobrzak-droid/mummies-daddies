// Webhooky Microsoft Graph pro poštu — orchestrace se vstříknutými
// závislostmi (Graph, DB, zámek, sync). Čistá logika je v
// domain/crm/mailWebhook.ts, napojení na Supabase v
// domain/crm/mailSyncService.ts; tady se nic nepřipojuje samo, takže se vše
// testuje bez sítě a bez databáze (test/mail-webhook*.test.ts).
//
// Dvě cesty:
//
// 1) Údržba předplatných (maintainMailSubscriptions) — denní cron
//    /api/cron/outlook-mail a lifecycle notifikace. Pro každou složku
//    rozhodne decideSubscriptionAction; obnova = PATCH, založení = POST.
//    404 při obnově → založit znovu. 409 při založení (Graph má předplatné,
//    o kterém nevíme) → najít ho v GET /subscriptions, smazat a jednou
//    zkusit znovu. 429/503 → počkat Retry-After, jen když se to vejde do
//    rozpočtu (decideThrottle z mailSync.ts), jinak chyba do řádku a zítra
//    znovu. 403 → chybí Mail.Read (znovu připojit Outlook). Výsledek i chyba
//    se zapíšou do graph_subscription, ať je stav vidět v Cockpitu.
//
// 2) Zpracování notifikace (processNotificationWork) — až PO odpovědi 202
//    (after() v route). Nejdřív se u předplatných zapíše
//    last_notification_at, pak pod zámkem runJob 'outlook-mail-webhook'
//    běží delta sync dotčených složek (bez purge, s omezeným rozpočtem).
//    Graph posílá notifikaci na každou zprávu, takže jich může přijít
//    několik naráz — zámek je seřadí. Aby se žádná neztratila, platí
//    „špinavý příznak": držitel zámku po každém kole zkontroluje, jestli
//    mezitím nepřišla novější notifikace (last_notification_at se během
//    kola posunul), a když ano, jede znovu. Kdo zámek nedostal, chvíli počká
//    a zkusí to znovu (okno mezi poslední kontrolou a uvolněním zámku).
//    Denní cron má vlastní zámek — souběh s ním je bezpečný (insert
//    ignoruje duplicity, last_inbound_at je monotónní, kurzor = platný
//    delta odkaz od kteréhokoli z nich).

import type { CreateSubscriptionRequest, GraphSubscription, SubscriptionCallResult } from '@/connectors/graph'
import { sameSubscriptionResource, subscriptionExpiration } from '@/connectors/graph'
import { decideThrottle, MISSING_SCOPE_ERROR, type FolderKey, type MailSyncStats } from '@/domain/crm/mailSync'
import {
  decideSubscriptionAction,
  MAIL_WEBHOOK_FOLDERS,
  webhookClientState,
  webhookClientStateHash,
  webhookConnectorKey,
  webhookResource,
  type NotificationWork,
  type SubscriptionAction,
  type SubscriptionRow,
} from '@/domain/crm/mailWebhook'

/** graph_subscription neexistuje (migrace 0066 neaplikovaná). */
export class MissingSubscriptionTableError extends Error {
  constructor() {
    super('Chybí migrace 0066 (graph_subscription) — webhook pošty zatím nejde použít.')
    this.name = 'MissingSubscriptionTableError'
  }
}

export interface SubscriptionGraph {
  create(req: CreateSubscriptionRequest): Promise<SubscriptionCallResult<GraphSubscription>>
  renew(subscriptionId: string, expirationDateTime: string): Promise<SubscriptionCallResult<GraphSubscription>>
  remove(subscriptionId: string): Promise<SubscriptionCallResult<null>>
  list(): Promise<SubscriptionCallResult<GraphSubscription[]>>
}

export interface SubscriptionStore {
  /** Všechny řádky; MissingSubscriptionTableError, když tabulka chybí. */
  loadAll(): Promise<SubscriptionRow[]>
  /** Platné předplatné složky; vynuluje last_error, last_notification_at nechá. */
  saveActive(row: {
    connector_key: string
    subscription_id: string
    resource: string
    expires_at: string
    client_state_hash: string
  }): Promise<void>
  /**
   * Chyba u složky. clear = předplatné už neexistuje (id, expirace a otisk
   * se vynulují); jinak zůstávají a chyba je jen poznámka.
   */
  markError(connectorKey: string, resource: string, error: string, clear: boolean): Promise<void>
  /** Smaže řádek složky (webhook vypnutý, předplatné smazané). */
  remove(connectorKey: string): Promise<void>
  /** last_notification_at = at pro tyhle id předplatného. Nevyhazuje. */
  touchNotifications(subscriptionIds: string[], at: string): Promise<void>
  /** Nejnovější last_notification_at přes složky, nebo null. Nevyhazuje. */
  latestNotificationAt(connectorKeys: string[]): Promise<string | null>
}

export type MaintainOptions = {
  /** CRON_SECRET — z něj clientState. */
  secret: string
  /** https://…/api/ms/notifications (i jako lifecycleNotificationUrl). */
  notificationUrl: string
  folders?: readonly FolderKey[]
  /** reauthorizationRequired: tyhle složky obnovit, i když expirace ještě nehoří. */
  forceRenew?: readonly FolderKey[]
  budgetMs: number
  maxThrottleAttempts?: number
  maxWaitMs?: number
}

export type MaintainDeps = {
  graph: SubscriptionGraph
  store: SubscriptionStore
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export type FolderMaintenanceOutcome =
  | 'kept'
  | 'renewed'
  | 'created'
  | 'recreated'
  | 'throttled'
  | 'missing_scope'
  | 'error'
  | 'not_started'

export type FolderMaintenance = {
  action: SubscriptionAction | null
  outcome: FolderMaintenanceOutcome
  expiresAt?: string
  error?: string
}

export type MaintainStats = {
  migrationMissing: boolean
  folders: Partial<Record<FolderKey, FolderMaintenance>>
}

const DEFAULT_MAX_THROTTLE_ATTEMPTS = 2
const DEFAULT_MAX_WAIT_MS = 10_000
/** Rezerva na jedno volání Graphu (vytvoření čeká i na validaci endpointu). */
const CALL_RESERVE_MS = 10_000

function shortMessage(r: SubscriptionCallResult<unknown>): string {
  switch (r.kind) {
    case 'throttled': return 'Graph omezuje požadavky (throttling) — zkusí se při dalším běhu'
    case 'not_found': return 'předplatné nenalezeno'
    case 'conflict': return 'Graph hlásí existující předplatné (409)'
    case 'forbidden': return MISSING_SCOPE_ERROR
    case 'error': return r.message
    case 'ok': return ''
  }
}

/** Volání s čekáním na Retry-After, pokud se vejde do rozpočtu. */
async function withThrottle<T>(
  deps: MaintainDeps,
  remaining: () => number,
  opts: { maxAttempts: number; maxWaitMs: number },
  call: () => Promise<SubscriptionCallResult<T>>,
): Promise<SubscriptionCallResult<T>> {
  let attempt = 0
  while (true) {
    const r = await call()
    if (r.kind !== 'throttled') return r
    const d = decideThrottle({
      retryAfterSeconds: r.retryAfterSeconds,
      attempt,
      maxAttempts: opts.maxAttempts,
      remainingMs: remaining(),
      maxWaitMs: opts.maxWaitMs,
    })
    if (d.action === 'stop') return r
    attempt++
    await deps.sleep(d.waitMs)
  }
}

export async function maintainMailSubscriptions(deps: MaintainDeps, opts: MaintainOptions): Promise<MaintainStats> {
  const start = deps.now()
  const remaining = () => opts.budgetMs - (deps.now() - start)
  const throttle = {
    maxAttempts: opts.maxThrottleAttempts ?? DEFAULT_MAX_THROTTLE_ATTEMPTS,
    maxWaitMs: opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  }
  const stats: MaintainStats = { migrationMissing: false, folders: {} }

  let rows: SubscriptionRow[]
  try {
    rows = await deps.store.loadAll()
  } catch (e) {
    if (e instanceof MissingSubscriptionTableError) {
      stats.migrationMissing = true
      return stats
    }
    throw e
  }

  for (const key of opts.folders ?? MAIL_WEBHOOK_FOLDERS) {
    const connectorKey = webhookConnectorKey(key)
    const resource = webhookResource(key)
    const clientState = webhookClientState(opts.secret, key)
    const hash = webhookClientStateHash(opts.secret, key)
    const row = rows.find((r) => r.connector_key === connectorKey) ?? null

    if (remaining() < CALL_RESERVE_MS) {
      stats.folders[key] = { action: null, outcome: 'not_started' }
      continue
    }

    const action = decideSubscriptionAction(row, {
      now: deps.now(),
      expectedResource: resource,
      expectedHash: hash,
      forceRenew: opts.forceRenew?.includes(key) ?? false,
    })
    const fs: FolderMaintenance = { action, outcome: 'kept', ...(row?.expires_at ? { expiresAt: row.expires_at } : {}) }
    stats.folders[key] = fs
    if (action === 'keep') continue

    const fail = async (r: SubscriptionCallResult<unknown>, clear: boolean) => {
      fs.outcome = r.kind === 'forbidden' ? 'missing_scope' : r.kind === 'throttled' ? 'throttled' : 'error'
      fs.error = shortMessage(r)
      if (clear) delete fs.expiresAt
      await deps.store.markError(connectorKey, resource, fs.error, clear)
    }

    // --- obnova
    if (action === 'renew' && row?.subscription_id) {
      const r = await withThrottle(deps, remaining, throttle, () =>
        deps.graph.renew(row.subscription_id!, subscriptionExpiration(deps.now())))
      if (r.kind === 'ok') {
        await deps.store.saveActive({
          connector_key: connectorKey,
          subscription_id: r.value.id,
          resource,
          expires_at: r.value.expirationDateTime,
          client_state_hash: hash,
        })
        fs.outcome = 'renewed'
        fs.expiresAt = r.value.expirationDateTime
        continue
      }
      if (r.kind !== 'not_found') {
        await fail(r, false)
        continue
      }
      // 404: předplatné u Microsoftu už není → založit nové (níže).
    }

    // --- smazání starého (recreate)
    if (action === 'recreate' && row?.subscription_id) {
      const r = await withThrottle(deps, remaining, throttle, () => deps.graph.remove(row.subscription_id!))
      if (r.kind !== 'ok' && r.kind !== 'not_found') {
        // Bez smazání by nové založení skončilo 409; zkusí se zítra.
        await fail(r, false)
        continue
      }
    }

    // --- založení
    const request: CreateSubscriptionRequest = {
      resource,
      notificationUrl: opts.notificationUrl,
      lifecycleNotificationUrl: opts.notificationUrl,
      expirationDateTime: subscriptionExpiration(deps.now()),
      clientState,
    }
    let created = await withThrottle(deps, remaining, throttle, () => deps.graph.create(request))
    if (created.kind === 'conflict') {
      // Graph drží předplatné na stejný zdroj, o kterém nevíme (ztracený
      // řádek, jiné tajemství). Najít, smazat, jednou znovu.
      const listed = await withThrottle(deps, remaining, throttle, () => deps.graph.list())
      if (listed.kind !== 'ok') {
        await fail(listed, true)
        continue
      }
      for (const s of listed.value.filter((s) => sameSubscriptionResource(s.resource, resource))) {
        await withThrottle(deps, remaining, throttle, () => deps.graph.remove(s.id))
      }
      created = await withThrottle(deps, remaining, throttle, () =>
        deps.graph.create({ ...request, expirationDateTime: subscriptionExpiration(deps.now()) }))
    }
    if (created.kind !== 'ok') {
      await fail(created, true)
      continue
    }
    await deps.store.saveActive({
      connector_key: connectorKey,
      subscription_id: created.value.id,
      resource,
      expires_at: created.value.expirationDateTime,
      client_state_hash: hash,
    })
    fs.outcome = action === 'recreate' ? 'recreated' : 'created'
    fs.expiresAt = created.value.expirationDateTime
  }
  return stats
}

/**
 * Webhook vypnutý (OUTLOOK_MAIL_WEBHOOK_ENABLED ≠ 'true'), sync běží: smazat
 * předplatná u Microsoftu i v DB, ať Graph přestane volat endpoint, který
 * vrací 404. Chybějící tabulka = nic k úklidu.
 */
export async function retireMailSubscriptions(
  deps: Pick<MaintainDeps, 'graph' | 'store'>,
): Promise<{ removed: number; failed: number; migrationMissing: boolean }> {
  let rows: SubscriptionRow[]
  try {
    rows = await deps.store.loadAll()
  } catch (e) {
    if (e instanceof MissingSubscriptionTableError) return { removed: 0, failed: 0, migrationMissing: true }
    throw e
  }
  let removed = 0
  let failed = 0
  for (const row of rows) {
    if (!MAIL_WEBHOOK_FOLDERS.some((k) => webhookConnectorKey(k) === row.connector_key)) continue
    if (row.subscription_id) {
      const r = await deps.graph.remove(row.subscription_id)
      if (r.kind !== 'ok' && r.kind !== 'not_found') {
        failed++
        await deps.store.markError(row.connector_key, row.resource, `webhook vypnutý, smazání předplatného selhalo: ${shortMessage(r)}`, false)
        continue
      }
    }
    await deps.store.remove(row.connector_key)
    removed++
  }
  return { removed, failed, migrationMissing: false }
}

// ---------------------------------------------------------------------------
// Zpracování ověřené notifikace (po odpovědi 202)

export const WEBHOOK_JOB_NAME = 'outlook-mail-webhook'
/** Delší než nejdelší běh (rozpočet níže) — spadlý běh zámek sám uvolní. */
export const WEBHOOK_JOB_TTL_SECONDS = 75
/** Celý běh po odpovědi se musí vejít do maxDuration route (60 s). */
export const WEBHOOK_BUDGET_MS = 45_000
export const WEBHOOK_MAX_PAGES = 10
const MAX_SYNC_ROUNDS = 3
const MIN_ROUND_MS = 10_000
const LOCK_RETRIES = 2
const LOCK_RETRY_WAIT_MS = 4_000
/** Kolik rozpočtu smí spolknout údržba předplatného z lifecycle notifikace. */
const LIFECYCLE_MAINTAIN_BUDGET_MS = 20_000

export type LockedRun = { status: 'skipped' } | { status: 'succeeded' | 'failed' }

export type NotificationWorkDeps = {
  store: Pick<SubscriptionStore, 'touchNotifications' | 'latestNotificationAt' | 'markError'>
  /** Údržba předplatných (subscriptionRemoved / reauthorizationRequired). */
  maintain(folders: FolderKey[], forceRenew: FolderKey[], budgetMs: number): Promise<MaintainStats>
  /**
   * Delta sync složek s rozpočtem (runMailSync, purge: false). S automatickým
   * zakládáním poptávek (docs/PROVOZ.md) přibude `autoIntake`
   * — jen počty, žádná jména ani adresy.
   */
  sync(folders: FolderKey[], budgetMs: number): Promise<MailSyncStats & { autoIntake?: unknown }>
  /** runJob pod zámkem WEBHOOK_JOB_NAME; výjimku z fn zapíše jako failed. */
  runLocked(fn: () => Promise<Record<string, unknown>>): Promise<LockedRun>
  now(): number
  sleep(ms: number): Promise<void>
}

export type NotificationWorkResult = {
  status: 'succeeded' | 'failed' | 'skipped' | 'nothing'
  attempts: number
}

export async function processNotificationWork(
  work: NotificationWork,
  deps: NotificationWorkDeps,
): Promise<NotificationWorkResult> {
  const start = deps.now()
  const remaining = () => WEBHOOK_BUDGET_MS - (deps.now() - start)

  // 1) Záznam „přišla notifikace" — i pro špinavý příznak (viz hlavička).
  if (work.subscriptionIds.length > 0) {
    await deps.store.touchNotifications(work.subscriptionIds, new Date(deps.now()).toISOString())
  }
  // subscriptionRemoved: u Microsoftu už předplatné není — hned to zapsat,
  // ať je to vidět, i kdyby nové založení níže selhalo.
  for (const key of work.recreateFolders) {
    await deps.store.markError(
      webhookConnectorKey(key),
      webhookResource(key),
      'Microsoft předplatné zrušil (subscriptionRemoved) — zakládá se znovu',
      true,
    )
  }

  const maintainFolders = [...new Set([...work.recreateFolders, ...work.renewFolders])]
  if (maintainFolders.length === 0 && work.syncFolders.length === 0) return { status: 'nothing', attempts: 0 }
  const connectorKeys = work.syncFolders.map(webhookConnectorKey)

  const body = async (): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {}
    if (maintainFolders.length > 0) {
      out.maintenance = await deps.maintain(maintainFolders, [...work.renewFolders], Math.min(LIFECYCLE_MAINTAIN_BUDGET_MS, remaining()))
    }
    const rounds: { folders: Record<string, unknown>; missingScope: boolean; autoIntake?: unknown }[] = []
    // Příznak porovnává hodnoty v DB před a po kole (ne s hodinami tohoto
    // procesu), takže mu nevadí drobný rozdíl hodin mezi instancemi.
    let before = work.syncFolders.length > 0 ? await deps.store.latestNotificationAt(connectorKeys) : null
    for (let round = 0; round < MAX_SYNC_ROUNDS && work.syncFolders.length > 0; round++) {
      if (remaining() < MIN_ROUND_MS) break
      const s = await deps.sync([...work.syncFolders], remaining())
      rounds.push({ folders: s.folders, missingScope: s.missingScope, ...(s.autoIntake !== undefined ? { autoIntake: s.autoIntake } : {}) })
      if (s.missingScope) break
      const after = await deps.store.latestNotificationAt(connectorKeys)
      // Během kola přišla novější notifikace (její běh zámek nedostal) → znovu.
      if (!after || (before && Date.parse(after) <= Date.parse(before))) break
      before = after
    }
    out.rounds = rounds
    return out
  }

  let attempts = 0
  while (true) {
    attempts++
    const r = await deps.runLocked(body)
    if (r.status !== 'skipped') return { status: r.status, attempts }
    if (attempts > LOCK_RETRIES || remaining() < LOCK_RETRY_WAIT_MS + MIN_ROUND_MS) return { status: 'skipped', attempts }
    await deps.sleep(LOCK_RETRY_WAIT_MS)
  }
}
