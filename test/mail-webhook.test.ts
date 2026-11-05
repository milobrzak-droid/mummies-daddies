// @vitest-environment node
// domain/crm/mailWebhook.ts — čistá logika webhooku pošty: přepínače,
// handshake, ověření clientState, rozhodnutí o obnově a stav pro „Stav zdrojů".
import { describe, expect, it } from 'vitest'
import { deriveClientState } from '@/connectors/graph'
import {
  assessMailWebhook,
  classifyNotificationRequest,
  decideSubscriptionAction,
  mailWebhookEnabledFromEnv,
  MAX_NOTIFICATION_BODY_BYTES,
  notificationResponse,
  notificationUrlFromEnv,
  REAUTH_MIN_INTERVAL_MS,
  webhookClientState,
  webhookClientStateHash,
  webhookResource,
  type NotificationRequestInput,
  type SubscriptionRow,
} from '@/domain/crm/mailWebhook'

const SECRET = 'cron-secret-123'
const SUB_IN = '11111111-2222-3333-4444-555555555555'
const SUB_OUT = '66666666-7777-8888-9999-000000000000'
const NOW = Date.parse('2026-09-28T10:00:00Z')
const HOUR = 3_600_000

const input = (o: Partial<NotificationRequestInput> = {}): NotificationRequestInput => ({
  enabled: true,
  secret: SECRET,
  memberConfigured: true,
  validationToken: null,
  body: null,
  ...o,
})

const batch = (...items: Record<string, unknown>[]) => JSON.stringify({ value: items })
const change = (sub: string, clientState: string | null, extra: Record<string, unknown> = {}) => ({
  subscriptionId: sub,
  clientState,
  changeType: 'created',
  resource: 'Users/x/Messages/y',
  resourceData: { id: 'AAMkAG=' },
  ...extra,
})

const row = (o: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  connector_key: 'outlook:inbox',
  subscription_id: SUB_IN,
  resource: webhookResource('inbox'),
  expires_at: new Date(NOW + 5 * 24 * HOUR).toISOString(),
  client_state_hash: webhookClientStateHash(SECRET, 'inbox'),
  created_at: new Date(NOW - 2 * 24 * HOUR).toISOString(),
  updated_at: new Date(NOW - 2 * 24 * HOUR).toISOString(),
  last_notification_at: null,
  last_error: null,
  ...o,
})

describe('přepínače a konfigurace', () => {
  it('webhook jen s oběma přepínači na true', () => {
    expect(mailWebhookEnabledFromEnv({})).toBe(false)
    expect(mailWebhookEnabledFromEnv({ OUTLOOK_MAIL_WEBHOOK_ENABLED: 'true' })).toBe(false)
    expect(mailWebhookEnabledFromEnv({ OUTLOOK_MAIL_SYNC_ENABLED: 'true' })).toBe(false)
    expect(mailWebhookEnabledFromEnv({ OUTLOOK_MAIL_SYNC_ENABLED: 'true', OUTLOOK_MAIL_WEBHOOK_ENABLED: 'yes' })).toBe(false)
    expect(mailWebhookEnabledFromEnv({ OUTLOOK_MAIL_SYNC_ENABLED: 'true', OUTLOOK_MAIL_WEBHOOK_ENABLED: 'true' })).toBe(true)
  })

  it('notificationUrl z APP_URL; bez https nic', () => {
    expect(notificationUrlFromEnv({ APP_URL: 'https://cockpit.example.cz/' })).toEqual({ ok: true, url: 'https://cockpit.example.cz/api/ms/notifications' })
    expect(notificationUrlFromEnv({}).ok).toBe(false)
    expect(notificationUrlFromEnv({ APP_URL: 'http://cockpit.example.cz' }).ok).toBe(false)
    expect(notificationUrlFromEnv({ APP_URL: 'nesmysl' }).ok).toBe(false)
  })

  it('clientState je HMAC z CRON_SECRET, každá složka jiný', () => {
    expect(webhookClientState(SECRET, 'inbox')).toBe(deriveClientState(SECRET, 'cockpit/graph-mail-webhook/v1/inbox'))
    expect(webhookClientState(SECRET, 'inbox')).not.toBe(webhookClientState(SECRET, 'sent'))
    expect(webhookClientStateHash(SECRET, 'inbox')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('handshake (validationToken)', () => {
  it('vrátí token jako text/plain 200', async () => {
    const d = classifyNotificationRequest(input({ validationToken: 'Validation: Testing client application reachability for subscription Request-Id: 1' }))
    expect(d).toEqual({ kind: 'validation', token: 'Validation: Testing client application reachability for subscription Request-Id: 1' })
    const res = notificationResponse(d)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('Validation: Testing client application reachability for subscription Request-Id: 1')
  })

  it('handshake nepotřebuje tělo ani člena (Graph validuje při vytváření)', () => {
    expect(classifyNotificationRequest(input({ validationToken: 'abc', memberConfigured: false })).kind).toBe('validation')
  })

  it('prázdný nebo přehnaně dlouhý token → 400', () => {
    expect(notificationResponse(classifyNotificationRequest(input({ validationToken: '' }))).status).toBe(400)
    expect(notificationResponse(classifyNotificationRequest(input({ validationToken: 'x'.repeat(5000) }))).status).toBe(400)
  })

  it('vypnutý webhook: 404 i pro handshake', () => {
    const d = classifyNotificationRequest(input({ enabled: false, validationToken: 'abc' }))
    expect(d).toEqual({ kind: 'disabled' })
    expect(notificationResponse(d).status).toBe(404)
  })
})

describe('notifikace — ověření clientState', () => {
  const inboxCs = webhookClientState(SECRET, 'inbox')
  const sentCs = webhookClientState(SECRET, 'sent')

  it('platná notifikace z Doručené → 202, sync jen inbox', () => {
    const d = classifyNotificationRequest(input({ body: batch(change(SUB_IN, inboxCs)) }))
    expect(d).toEqual({
      kind: 'accepted',
      accepted: 1,
      invalid: 0,
      ignored: 0,
      work: { subscriptionIds: [SUB_IN], syncFolders: ['inbox'], recreateFolders: [], renewFolders: [] },
    })
    expect(notificationResponse(d).status).toBe(202)
  })

  it('složku určuje clientState, ne tvrzení v těle', () => {
    // resource v těle tvrdí Doručenou, clientState patří Odeslané → sync sent.
    const d = classifyNotificationRequest(input({ body: batch(change(SUB_OUT, sentCs, { resource: "me/mailFolders('inbox')/messages" })) }))
    expect(d.kind === 'accepted' && d.work.syncFolders).toEqual(['sent'])
  })

  it('špatný clientState → 401, nic se nespustí', () => {
    const d = classifyNotificationRequest(input({ body: batch(change(SUB_IN, 'podvrh'), change(SUB_IN, null)) }))
    expect(d).toEqual({ kind: 'unauthorized', invalid: 2 })
    expect(notificationResponse(d).status).toBe(401)
  })

  it('clientState od jiného tajemství (rotace CRON_SECRET) neprojde', () => {
    const old = deriveClientState('stare-tajemstvi', 'cockpit/graph-mail-webhook/v1/inbox')
    expect(classifyNotificationRequest(input({ body: batch(change(SUB_IN, old)) })).kind).toBe('unauthorized')
  })

  it('smíšená dávka: platné se zpracují, neplatné ignorují a počítají', () => {
    const d = classifyNotificationRequest(input({
      body: batch(change(SUB_IN, 'podvrh'), change(SUB_OUT, sentCs), change(SUB_IN, inboxCs), change(SUB_IN, inboxCs)),
    }))
    expect(d.kind).toBe('accepted')
    if (d.kind !== 'accepted') return
    expect(d.invalid).toBe(1)
    expect(d.accepted).toBe(3)
    expect(d.work.syncFolders).toEqual(['sent', 'inbox'])
    expect(d.work.subscriptionIds).toEqual([SUB_OUT, SUB_IN])
  })

  it('lifecycle: missed → sync, subscriptionRemoved → znovu založit + sync, reauthorizationRequired → obnovit', () => {
    const d = classifyNotificationRequest(input({
      body: batch(
        { subscriptionId: SUB_IN, clientState: inboxCs, lifecycleEvent: 'missed' },
        { subscriptionId: SUB_OUT, clientState: sentCs, lifecycleEvent: 'subscriptionRemoved' },
        { subscriptionId: SUB_IN, clientState: inboxCs, lifecycleEvent: 'reauthorizationRequired' },
        { subscriptionId: SUB_IN, clientState: inboxCs, lifecycleEvent: 'somethingNew' },
      ),
    }))
    expect(d.kind).toBe('accepted')
    if (d.kind !== 'accepted') return
    expect(d.work).toEqual({ subscriptionIds: [SUB_IN, SUB_OUT], syncFolders: ['inbox', 'sent'], recreateFolders: ['sent'], renewFolders: ['inbox'] })
    expect(d.ignored).toBe(1)
  })

  it('neplatný JSON / ne kolekce → 400; bez CRON_SECRET nebo člena → 503; velké tělo → 413', () => {
    expect(notificationResponse(classifyNotificationRequest(input({ body: '{nope' }))).status).toBe(400)
    expect(notificationResponse(classifyNotificationRequest(input({ body: '{"x":1}' }))).status).toBe(400)
    expect(notificationResponse(classifyNotificationRequest(input({ body: null }))).status).toBe(400)
    expect(notificationResponse(classifyNotificationRequest(input({ secret: undefined, body: batch() }))).status).toBe(503)
    expect(notificationResponse(classifyNotificationRequest(input({ memberConfigured: false, body: batch() }))).status).toBe(503)
    expect(notificationResponse(classifyNotificationRequest(input({ body: 'x'.repeat(MAX_NOTIFICATION_BODY_BYTES + 1) }))).status).toBe(413)
  })

  it('prázdná dávka = nic ověřeného → 401', () => {
    expect(classifyNotificationRequest(input({ body: batch() })).kind).toBe('unauthorized')
  })
})

describe('decideSubscriptionAction', () => {
  const opts = { now: NOW, expectedResource: webhookResource('inbox'), expectedHash: webhookClientStateHash(SECRET, 'inbox') }

  it('chybí řádek nebo id → create', () => {
    expect(decideSubscriptionAction(null, opts)).toBe('create')
    expect(decideSubscriptionAction(row({ subscription_id: null, expires_at: null, client_state_hash: null, last_error: 'x' }), opts)).toBe('create')
  })

  it('vypršelé → create (Graph ho už smazal)', () => {
    expect(decideSubscriptionAction(row({ expires_at: new Date(NOW - 1000).toISOString() }), opts)).toBe('create')
  })

  it('platné s rezervou → keep', () => {
    expect(decideSubscriptionAction(row(), opts)).toBe('keep')
  })

  it('vyprší do 36 h → renew; za 37 h → keep', () => {
    expect(decideSubscriptionAction(row({ expires_at: new Date(NOW + 35 * HOUR).toISOString() }), opts)).toBe('renew')
    expect(decideSubscriptionAction(row({ expires_at: new Date(NOW + 36 * HOUR).toISOString() }), opts)).toBe('renew')
    expect(decideSubscriptionAction(row({ expires_at: new Date(NOW + 37 * HOUR).toISOString() }), opts)).toBe('keep')
  })

  it('jiné tajemství (otisk nesedí), jiný zdroj nebo chyba → recreate', () => {
    expect(decideSubscriptionAction(row({ client_state_hash: 'a'.repeat(64) }), opts)).toBe('recreate')
    expect(decideSubscriptionAction(row({ resource: webhookResource('sent') }), opts)).toBe('recreate')
    expect(decideSubscriptionAction(row({ last_error: 'Graph 500' }), opts)).toBe('recreate')
  })

  it('reautorizace: obnovit, ale ne častěji než po 10 minutách', () => {
    expect(decideSubscriptionAction(row(), { ...opts, forceRenew: true })).toBe('renew')
    const fresh = row({ updated_at: new Date(NOW - REAUTH_MIN_INTERVAL_MS + 1000).toISOString() })
    expect(decideSubscriptionAction(fresh, { ...opts, forceRenew: true })).toBe('keep')
  })
})

describe('assessMailWebhook (Stav zdrojů)', () => {
  const sentRow = (o: Partial<SubscriptionRow> = {}) => row({
    connector_key: 'outlook:sent',
    subscription_id: SUB_OUT,
    resource: webhookResource('sent'),
    client_state_hash: webhookClientStateHash(SECRET, 'sent'),
    ...o,
  })

  it('vypnutý webhook není rozbitý a DB nepotřebuje', () => {
    expect(assessMailWebhook(null, { enabled: false, now: NOW })).toMatchObject({ enabled: false, broken: false })
  })

  it('chybějící tabulka = rozbité (chybí migrace)', () => {
    expect(assessMailWebhook(null, { enabled: true, now: NOW })).toMatchObject({ migrationMissing: true, broken: true })
  })

  it('obě složky v pořádku: poslední notifikace a nejbližší expirace', () => {
    const h = assessMailWebhook([
      row({ last_notification_at: '2026-09-28T09:00:00.000Z', expires_at: '2026-10-03T00:00:00.000Z' }),
      sentRow({ last_notification_at: '2026-09-28T09:30:00.000Z', expires_at: '2026-10-02T00:00:00.000Z' }),
    ], { enabled: true, now: NOW })
    expect(h).toEqual({
      enabled: true,
      migrationMissing: false,
      lastNotificationAt: '2026-09-28T09:30:00.000Z',
      expiresAt: '2026-10-02T00:00:00.000Z',
      problems: [],
      broken: false,
    })
  })

  it('chybějící, vypršelé a chybové předplatné se hlásí po složkách', () => {
    expect(assessMailWebhook([row()], { enabled: true, now: NOW }).problems).toEqual(['Odeslaná pošta: předplatné chybí'])
    const expired = assessMailWebhook([row({ expires_at: new Date(NOW - 1).toISOString() }), sentRow()], { enabled: true, now: NOW })
    expect(expired).toMatchObject({ broken: true, problems: ['Doručená pošta: předplatné vypršelo'] })
    const errored = assessMailWebhook([row(), sentRow({ subscription_id: null, expires_at: null, client_state_hash: null, last_error: 'Chybí oprávnění Mail.Read' })], { enabled: true, now: NOW })
    expect(errored.problems).toEqual(['Odeslaná pošta: předplatné chybí (Chybí oprávnění Mail.Read)'])
    const noted = assessMailWebhook([row({ last_error: 'Graph 500' }), sentRow()], { enabled: true, now: NOW })
    expect(noted.problems).toEqual(['Doručená pošta: Graph 500'])
  })

  it('ticho bez notifikací samo o sobě rozbité není', () => {
    expect(assessMailWebhook([row(), sentRow()], { enabled: true, now: NOW }).broken).toBe(false)
  })
})
