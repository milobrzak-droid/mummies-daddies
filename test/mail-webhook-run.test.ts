// @vitest-environment node
// domain/crm/mailWebhookRun.ts — údržba předplatných (obnova, založení,
// 404/409/429/403) a zpracování notifikace (zámek, špinavý příznak).
// Falešný Graph a falešná tabulka graph_subscription, žádná síť ani DB.
import { describe, expect, it } from 'vitest'
import {
  OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES,
  type CreateSubscriptionRequest,
  type GraphSubscription,
  type SubscriptionCallResult,
} from '@/connectors/graph'
import { MISSING_SCOPE_ERROR, type FolderKey, type MailSyncStats } from '@/domain/crm/mailSync'
import {
  webhookClientState,
  webhookClientStateHash,
  webhookResource,
  type NotificationWork,
  type SubscriptionRow,
} from '@/domain/crm/mailWebhook'
import {
  maintainMailSubscriptions,
  MissingSubscriptionTableError,
  processNotificationWork,
  retireMailSubscriptions,
  type LockedRun,
  type NotificationWorkDeps,
  type SubscriptionGraph,
  type SubscriptionStore,
} from '@/domain/crm/mailWebhookRun'

const SECRET = 'cron-secret-123'
const URL_ = 'https://cockpit.example.cz/api/ms/notifications'
const T0 = Date.parse('2026-09-28T04:00:00Z')
const HOUR = 3_600_000

// --- hodiny

function clock(start = T0) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
    advance: (ms: number) => { t += ms },
  }
}

// --- falešná tabulka graph_subscription

function fakeStore(initial: SubscriptionRow[] = [], opts: { missing?: boolean } = {}) {
  const rows = new Map(initial.map((r) => [r.connector_key, { ...r }]))
  const log: string[] = []
  const store: SubscriptionStore = {
    async loadAll() {
      if (opts.missing) throw new MissingSubscriptionTableError()
      return [...rows.values()].map((r) => ({ ...r }))
    },
    async saveActive(r) {
      log.push(`save ${r.connector_key} ${r.subscription_id}`)
      const prev = rows.get(r.connector_key)
      rows.set(r.connector_key, {
        created_at: prev?.created_at ?? new Date(T0).toISOString(),
        last_notification_at: prev?.last_notification_at ?? null,
        ...r,
        updated_at: new Date(T0).toISOString(),
        last_error: null,
      })
    },
    async markError(key, resource, error, clear) {
      log.push(`error ${key} ${clear ? 'clear' : 'keep'} ${error}`)
      const prev = rows.get(key)
      rows.set(key, {
        connector_key: key,
        resource,
        subscription_id: clear ? null : prev?.subscription_id ?? null,
        expires_at: clear ? null : prev?.expires_at ?? null,
        client_state_hash: clear ? null : prev?.client_state_hash ?? null,
        created_at: prev?.created_at ?? new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
        last_notification_at: prev?.last_notification_at ?? null,
        last_error: error,
      })
    },
    async remove(key) { log.push(`remove ${key}`); rows.delete(key) },
    async touchNotifications(ids, at) {
      log.push(`touch ${ids.join(',')}`)
      for (const r of rows.values()) if (r.subscription_id && ids.includes(r.subscription_id)) r.last_notification_at = at
    },
    async latestNotificationAt(keys) {
      let latest: string | null = null
      for (const k of keys) {
        const v = rows.get(k)?.last_notification_at ?? null
        if (v && (!latest || Date.parse(v) > Date.parse(latest))) latest = v
      }
      return latest
    },
  }
  return { store, rows, log }
}

// --- falešný Graph

type Script = {
  create?: SubscriptionCallResult<GraphSubscription>[]
  renew?: SubscriptionCallResult<GraphSubscription>[]
  remove?: SubscriptionCallResult<null>[]
  list?: SubscriptionCallResult<GraphSubscription[]>[]
}

function fakeGraph(script: Script = {}) {
  const calls: string[] = []
  const created: CreateSubscriptionRequest[] = []
  let n = 0
  const take = <T>(q: T[] | undefined, fallback: () => T): T => (q && q.length > 0 ? q.shift()! : fallback())
  const graph: SubscriptionGraph = {
    async create(req) {
      calls.push(`create ${req.resource}`)
      created.push(req)
      return take(script.create, () => ({ kind: 'ok', value: { id: `new-${++n}`, resource: req.resource, expirationDateTime: req.expirationDateTime } }))
    },
    async renew(id, exp) {
      calls.push(`renew ${id}`)
      return take(script.renew, () => ({ kind: 'ok', value: { id, resource: 'x', expirationDateTime: exp } }))
    },
    async remove(id) {
      calls.push(`remove ${id}`)
      return take(script.remove, () => ({ kind: 'ok', value: null }))
    },
    async list() {
      calls.push('list')
      return take(script.list, () => ({ kind: 'ok', value: [] }))
    },
  }
  return { graph, calls, created }
}

const row = (key: FolderKey, o: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  connector_key: key === 'inbox' ? 'outlook:inbox' : 'outlook:sent',
  subscription_id: `${key}-sub`,
  resource: webhookResource(key),
  expires_at: new Date(T0 + 5 * 24 * HOUR).toISOString(),
  client_state_hash: webhookClientStateHash(SECRET, key),
  created_at: new Date(T0 - 2 * 24 * HOUR).toISOString(),
  updated_at: new Date(T0 - 2 * 24 * HOUR).toISOString(),
  last_notification_at: null,
  last_error: null,
  ...o,
})

const opts = { secret: SECRET, notificationUrl: URL_, budgetMs: 20_000 }

describe('maintainMailSubscriptions', () => {
  it('bez řádků založí předplatné pro obě složky se správnými parametry', async () => {
    const c = clock(); const s = fakeStore(); const g = fakeGraph()
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, opts)
    expect(stats.folders.inbox?.outcome).toBe('created')
    expect(stats.folders.sent?.outcome).toBe('created')
    expect(g.created.map((r) => r.resource)).toEqual(["me/mailFolders('inbox')/messages", "me/mailFolders('sentitems')/messages"])
    for (const [i, key] of (['inbox', 'sent'] as FolderKey[]).entries()) {
      const req = g.created[i]
      expect(req.notificationUrl).toBe(URL_)
      expect(req.lifecycleNotificationUrl).toBe(URL_)
      expect(req.clientState).toBe(webhookClientState(SECRET, key))
      const lifetime = Date.parse(req.expirationDateTime) - T0
      expect(lifetime).toBeLessThan(OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES * 60_000)
      expect(lifetime).toBeGreaterThan(6 * 24 * HOUR)
      // Do DB jde jen otisk, ne clientState.
      const saved = s.rows.get(key === 'inbox' ? 'outlook:inbox' : 'outlook:sent')!
      expect(saved.client_state_hash).toBe(webhookClientStateHash(SECRET, key))
      expect(JSON.stringify(saved)).not.toContain(req.clientState)
    }
  })

  it('platná předplatná jen ponechá — žádné volání Graphu', async () => {
    const c = clock(); const s = fakeStore([row('inbox'), row('sent')]); const g = fakeGraph()
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, opts)
    expect(g.calls).toEqual([])
    expect(stats.folders.inbox?.outcome).toBe('kept')
  })

  it('vyprší do 36 h → PATCH a nová expirace v DB', async () => {
    const c = clock()
    const s = fakeStore([row('inbox', { expires_at: new Date(T0 + 20 * HOUR).toISOString() }), row('sent')])
    const g = fakeGraph()
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, opts)
    expect(g.calls).toEqual(['renew inbox-sub'])
    expect(stats.folders.inbox?.outcome).toBe('renewed')
    expect(Date.parse(s.rows.get('outlook:inbox')!.expires_at!)).toBeGreaterThan(T0 + 6 * 24 * HOUR)
  })

  it('obnova 404 (Microsoft ho už nemá) → založí nové', async () => {
    const c = clock()
    const s = fakeStore([row('inbox', { expires_at: new Date(T0 + HOUR).toISOString() })])
    const g = fakeGraph({ renew: [{ kind: 'not_found' }] })
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, { ...opts, folders: ['inbox'] })
    expect(g.calls).toEqual(['renew inbox-sub', "create me/mailFolders('inbox')/messages"])
    expect(stats.folders.inbox?.outcome).toBe('created')
    expect(s.rows.get('outlook:inbox')!.subscription_id).toBe('new-1')
  })

  it('jiné tajemství (otisk nesedí) → smazat staré a založit nové', async () => {
    const c = clock()
    const s = fakeStore([row('inbox', { client_state_hash: 'f'.repeat(64) })])
    const g = fakeGraph()
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, { ...opts, folders: ['inbox'] })
    expect(g.calls).toEqual(['remove inbox-sub', "create me/mailFolders('inbox')/messages"])
    expect(stats.folders.inbox?.outcome).toBe('recreated')
    expect(s.rows.get('outlook:inbox')!.client_state_hash).toBe(webhookClientStateHash(SECRET, 'inbox'))
  })

  it('409 → najde cizí předplatné na stejný zdroj, smaže ho a založí znovu', async () => {
    const c = clock(); const s = fakeStore()
    const g = fakeGraph({
      create: [{ kind: 'conflict' }],
      list: [{ kind: 'ok', value: [
        { id: 'orphan-1', resource: "/Me/MailFolders('Inbox')/Messages", expirationDateTime: '2026-10-01T00:00:00.000Z' },
        { id: 'other', resource: "me/mailFolders('sentitems')/messages", expirationDateTime: '2026-10-01T00:00:00.000Z' },
      ] }],
    })
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, { ...opts, folders: ['inbox'] })
    expect(g.calls).toEqual([
      "create me/mailFolders('inbox')/messages",
      'list',
      'remove orphan-1',
      "create me/mailFolders('inbox')/messages",
    ])
    expect(stats.folders.inbox?.outcome).toBe('created')
  })

  it('429 s krátkým Retry-After: počká a zkusí znovu', async () => {
    const c = clock(); const s = fakeStore()
    const g = fakeGraph({ create: [{ kind: 'throttled', retryAfterSeconds: 2 }] })
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, { ...opts, folders: ['inbox'] })
    expect(stats.folders.inbox?.outcome).toBe('created')
    expect(c.now() - T0).toBe(2000)
  })

  it('429 s dlouhým Retry-After: nečeká, zapíše chybu (vidět ve Stavu zdrojů)', async () => {
    const c = clock(); const s = fakeStore()
    const g = fakeGraph({ create: [{ kind: 'throttled', retryAfterSeconds: 600 }] })
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, { ...opts, folders: ['inbox'] })
    expect(stats.folders.inbox?.outcome).toBe('throttled')
    expect(c.now()).toBe(T0)
    expect(s.rows.get('outlook:inbox')).toMatchObject({ subscription_id: null, last_error: expect.stringContaining('throttling') })
  })

  it('403 → chybí Mail.Read, srozumitelná chyba u složky', async () => {
    const c = clock(); const s = fakeStore()
    const g = fakeGraph({ create: [{ kind: 'forbidden', code: 'ErrorAccessDenied' }, { kind: 'forbidden', code: 'ErrorAccessDenied' }] })
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, opts)
    expect(stats.folders.inbox?.outcome).toBe('missing_scope')
    expect(s.rows.get('outlook:inbox')!.last_error).toBe(MISSING_SCOPE_ERROR)
  })

  it('chyba obnovy nechá předplatné (id, expirace) a jen poznamená chybu', async () => {
    const c = clock()
    const s = fakeStore([row('inbox', { expires_at: new Date(T0 + HOUR).toISOString() })])
    const g = fakeGraph({ renew: [{ kind: 'error', status: 500, message: 'Graph 500 generalException' }] })
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, { ...opts, folders: ['inbox'] })
    expect(stats.folders.inbox?.outcome).toBe('error')
    expect(s.rows.get('outlook:inbox')).toMatchObject({ subscription_id: 'inbox-sub', last_error: 'Graph 500 generalException' })
  })

  it('chybí tabulka (migrace 0066) → nic nevolá, jen to nahlásí', async () => {
    const c = clock(); const s = fakeStore([], { missing: true }); const g = fakeGraph()
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, opts)
    expect(stats).toEqual({ migrationMissing: true, folders: {} })
    expect(g.calls).toEqual([])
  })

  it('bez rozpočtu na volání složku nezačne', async () => {
    const c = clock(); const s = fakeStore(); const g = fakeGraph()
    const stats = await maintainMailSubscriptions({ graph: g.graph, store: s.store, ...c }, { ...opts, budgetMs: 1000 })
    expect(stats.folders.inbox?.outcome).toBe('not_started')
    expect(g.calls).toEqual([])
  })
})

describe('retireMailSubscriptions (webhook vypnutý)', () => {
  it('smaže předplatná u Microsoftu i v DB', async () => {
    const s = fakeStore([row('inbox'), row('sent', { subscription_id: null, expires_at: null, client_state_hash: null, last_error: 'x' })])
    const g = fakeGraph({ remove: [{ kind: 'not_found' }] })
    const r = await retireMailSubscriptions({ graph: g.graph, store: s.store })
    expect(r).toEqual({ removed: 2, failed: 0, migrationMissing: false })
    expect(g.calls).toEqual(['remove inbox-sub'])
    expect(s.rows.size).toBe(0)
  })

  it('bez tabulky nic nedělá', async () => {
    const g = fakeGraph()
    expect(await retireMailSubscriptions({ graph: g.graph, store: fakeStore([], { missing: true }).store }))
      .toEqual({ removed: 0, failed: 0, migrationMissing: true })
    expect(g.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------

const emptySyncStats = (): MailSyncStats => ({
  pages: 1,
  folders: {
    inbox: { outcome: 'caught_up', pages: 1, inserted: 1, matched: 1, skipped: {}, resyncs: 0 },
    sent: { outcome: 'not_started', pages: 0, inserted: 0, matched: 0, skipped: {}, resyncs: 0 },
  },
  missingScope: false,
  purged: null,
})

function workDeps(s: ReturnType<typeof fakeStore>, c: ReturnType<typeof clock>, o: {
  lock?: LockedRun['status'][]
  onSync?: (n: number) => void
} = {}) {
  const syncCalls: { folders: FolderKey[]; budgetMs: number }[] = []
  const maintainCalls: { folders: FolderKey[]; forceRenew: FolderKey[] }[] = []
  const lockQueue = [...(o.lock ?? [])]
  const deps: NotificationWorkDeps = {
    store: s.store,
    async maintain(folders, forceRenew) {
      maintainCalls.push({ folders, forceRenew })
      return { migrationMissing: false, folders: {} }
    },
    async sync(folders, budgetMs) {
      syncCalls.push({ folders, budgetMs })
      c.advance(2000)
      o.onSync?.(syncCalls.length)
      return emptySyncStats()
    },
    async runLocked(fn) {
      const status = lockQueue.length > 0 ? lockQueue.shift()! : 'succeeded'
      if (status === 'skipped') return { status }
      try { await fn(); return { status: 'succeeded' } } catch { return { status: 'failed' } }
    },
    now: c.now,
    sleep: c.sleep,
  }
  return { deps, syncCalls, maintainCalls }
}

const work = (o: Partial<NotificationWork> = {}): NotificationWork => ({
  subscriptionIds: ['inbox-sub'],
  syncFolders: ['inbox'],
  recreateFolders: [],
  renewFolders: [],
  ...o,
})

describe('processNotificationWork', () => {
  it('notifikace → zapíše last_notification_at a spustí delta sync jen té složky', async () => {
    const c = clock(); const s = fakeStore([row('inbox'), row('sent')])
    const w = workDeps(s, c)
    const r = await processNotificationWork(work(), w.deps)
    expect(r).toEqual({ status: 'succeeded', attempts: 1 })
    expect(w.syncCalls.map((x) => x.folders)).toEqual([['inbox']])
    expect(s.rows.get('outlook:inbox')!.last_notification_at).toBe(new Date(T0).toISOString())
    expect(s.rows.get('outlook:sent')!.last_notification_at).toBeNull()
    expect(w.maintainCalls).toEqual([])
  })

  it('zámek drží jiný běh → chvíli počká a zkusí znovu', async () => {
    const c = clock(); const s = fakeStore([row('inbox')])
    const w = workDeps(s, c, { lock: ['skipped', 'succeeded'] })
    const r = await processNotificationWork(work(), w.deps)
    expect(r).toEqual({ status: 'succeeded', attempts: 2 })
    expect(w.syncCalls).toHaveLength(1)
  })

  it('zámek pořád obsazený → po pokusech vzdá (držitel notifikaci převezme přes příznak)', async () => {
    const c = clock(); const s = fakeStore([row('inbox')])
    const w = workDeps(s, c, { lock: ['skipped', 'skipped', 'skipped', 'skipped'] })
    const r = await processNotificationWork(work(), w.deps)
    expect(r.status).toBe('skipped')
    expect(w.syncCalls).toHaveLength(0)
    // Příznak zůstal zapsaný — držitel zámku ho po svém kole uvidí.
    expect(s.rows.get('outlook:inbox')!.last_notification_at).not.toBeNull()
  })

  it('špinavý příznak: notifikace během kola → další kolo', async () => {
    const c = clock(); const s = fakeStore([row('inbox')])
    const w = workDeps(s, c, {
      onSync: (n) => {
        // Během prvního kola přijde další notifikace (jiný běh ji zapíše).
        if (n === 1) void s.store.touchNotifications(['inbox-sub'], new Date(c.now()).toISOString())
      },
    })
    await processNotificationWork(work(), w.deps)
    expect(w.syncCalls).toHaveLength(2)
  })

  it('subscriptionRemoved → chyba hned vidět, založení znovu a sync', async () => {
    const c = clock(); const s = fakeStore([row('sent')])
    const w = workDeps(s, c)
    await processNotificationWork(work({ subscriptionIds: ['sent-sub'], syncFolders: ['sent'], recreateFolders: ['sent'] }), w.deps)
    expect(s.log).toContain('error outlook:sent clear Microsoft předplatné zrušil (subscriptionRemoved) — zakládá se znovu')
    expect(s.rows.get('outlook:sent')!.subscription_id).toBeNull()
    expect(w.maintainCalls).toEqual([{ folders: ['sent'], forceRenew: [] }])
    expect(w.syncCalls.map((x) => x.folders)).toEqual([['sent']])
  })

  it('reauthorizationRequired → jen obnova, žádný sync', async () => {
    const c = clock(); const s = fakeStore([row('inbox')])
    const w = workDeps(s, c)
    await processNotificationWork(work({ syncFolders: [], renewFolders: ['inbox'] }), w.deps)
    expect(w.maintainCalls).toEqual([{ folders: ['inbox'], forceRenew: ['inbox'] }])
    expect(w.syncCalls).toEqual([])
  })

  it('sync dostane omezený rozpočet (vejde se do maxDuration route)', async () => {
    const c = clock(); const s = fakeStore([row('inbox')])
    const w = workDeps(s, c)
    await processNotificationWork(work(), w.deps)
    expect(w.syncCalls[0].budgetMs).toBeLessThanOrEqual(45_000)
  })

  it('nic k práci → nic nevolá', async () => {
    const c = clock(); const s = fakeStore()
    const w = workDeps(s, c)
    const r = await processNotificationWork(work({ subscriptionIds: [], syncFolders: [] }), w.deps)
    expect(r).toEqual({ status: 'nothing', attempts: 0 })
    expect(w.syncCalls).toEqual([])
  })
})
