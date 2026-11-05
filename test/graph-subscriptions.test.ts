// @vitest-environment node
// connectors/graph/subscriptions.ts — transport předplatných Graphu
// a rozbor příchozích notifikací. Falešný fetch, nic nejde na síť.
import { describe, expect, it } from 'vitest'
import {
  clientStateHash,
  clientStateMatches,
  createSubscription,
  deleteSubscription,
  deriveClientState,
  GRAPH_SUBSCRIPTIONS_URL,
  listSubscriptions,
  mailFolderSubscriptionResource,
  MAX_NOTIFICATIONS_PER_BATCH,
  OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES,
  parseNotificationCollection,
  renewSubscription,
  sameSubscriptionResource,
  subscriptionExpiration,
  type SubscriptionFetch,
} from '@/connectors/graph'

const TOKEN = 'eyJ.access-token.sig'
const SUB_ID = '7f105c7d-2dc5-4530-97cd-4e7ae6534c07'
const NOW = Date.parse('2026-09-28T10:00:00Z')

type Call = { url: string; init: RequestInit }

function fakeFetch(respond: (call: Call) => Response): { fetch: SubscriptionFetch; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init }
      calls.push(call)
      return respond(call)
    },
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const subscriptionBody = (o: Record<string, unknown> = {}) => ({
  id: SUB_ID,
  resource: "me/mailFolders('inbox')/messages",
  expirationDateTime: '2026-10-05T09:00:00Z',
  clientState: 'nikdy-se-nevraci-do-vysledku',
  ...o,
})

const createReq = {
  resource: "me/mailFolders('inbox')/messages",
  notificationUrl: 'https://cockpit.example.cz/api/ms/notifications',
  lifecycleNotificationUrl: 'https://cockpit.example.cz/api/ms/notifications',
  expirationDateTime: '2026-10-05T09:00:00.000Z',
  clientState: 'abc',
}

describe('zdroj a expirace', () => {
  it('zdroj pro složku bez base URL', () => {
    expect(mailFolderSubscriptionResource('inbox')).toBe("me/mailFolders('inbox')/messages")
    expect(mailFolderSubscriptionResource('sentitems')).toBe("me/mailFolders('sentitems')/messages")
  })

  it('porovnání zdroje ignoruje velikost písmen a úvodní lomítko', () => {
    expect(sameSubscriptionResource("/Me/MailFolders('Inbox')/Messages", "me/mailFolders('inbox')/messages")).toBe(true)
    expect(sameSubscriptionResource("me/mailFolders('sentitems')/messages", "me/mailFolders('inbox')/messages")).toBe(false)
  })

  it('výchozí expirace je pod maximem 10 080 minut (Microsoft Learn)', () => {
    const exp = Date.parse(subscriptionExpiration(NOW))
    expect(exp - NOW).toBeLessThan(OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES * 60_000)
    expect(exp - NOW).toBeGreaterThan(6 * 24 * 3_600_000)
  })

  it('expirace se ořízne do rozsahu 45 min až maximum', () => {
    expect(Date.parse(subscriptionExpiration(NOW, 1)) - NOW).toBe(45 * 60_000)
    expect(Date.parse(subscriptionExpiration(NOW, 99_999)) - NOW).toBe(OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES * 60_000)
  })
})

describe('clientState', () => {
  it('HMAC je deterministický, base64url, pod limitem 128 znaků', () => {
    const a = deriveClientState('s3cret', 'label/inbox')
    expect(a).toBe(deriveClientState('s3cret', 'label/inbox'))
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toContain('s3cret')
  })

  it('jiné tajemství nebo štítek → jiná hodnota', () => {
    const a = deriveClientState('s3cret', 'label/inbox')
    expect(deriveClientState('jine', 'label/inbox')).not.toBe(a)
    expect(deriveClientState('s3cret', 'label/sent')).not.toBe(a)
  })

  it('bez tajemství nic neodvodí', () => {
    expect(() => deriveClientState('', 'label')).toThrow()
  })

  it('otisk je SHA-256 hex a neobsahuje hodnotu', () => {
    const cs = deriveClientState('s3cret', 'label/inbox')
    const h = clientStateHash(cs)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain(cs)
  })

  it('porovnání: shoda, neshoda, jiný typ, prázdné, příliš dlouhé', () => {
    const cs = deriveClientState('s3cret', 'label/inbox')
    expect(clientStateMatches(cs, cs)).toBe(true)
    expect(clientStateMatches(`${cs}x`, cs)).toBe(false)
    expect(clientStateMatches(null, cs)).toBe(false)
    expect(clientStateMatches(123, cs)).toBe(false)
    expect(clientStateMatches('', cs)).toBe(false)
    expect(clientStateMatches('a'.repeat(129), 'a'.repeat(129))).toBe(false)
  })
})

describe('createSubscription', () => {
  it('POST /subscriptions s changeType created, lifecycle URL a clientState; 201 → ok', async () => {
    const f = fakeFetch(() => json(201, subscriptionBody()))
    const r = await createSubscription(TOKEN, createReq, f.fetch)
    expect(r).toEqual({
      kind: 'ok',
      value: { id: SUB_ID, resource: "me/mailFolders('inbox')/messages", expirationDateTime: '2026-10-05T09:00:00.000Z' },
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe(GRAPH_SUBSCRIPTIONS_URL)
    expect(f.calls[0].init.method).toBe('POST')
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    const body = JSON.parse(String(f.calls[0].init.body))
    expect(body).toEqual({
      changeType: 'created',
      notificationUrl: createReq.notificationUrl,
      lifecycleNotificationUrl: createReq.lifecycleNotificationUrl,
      resource: createReq.resource,
      expirationDateTime: createReq.expirationDateTime,
      clientState: 'abc',
    })
  })

  it('výsledek nenese clientState z odpovědi', async () => {
    const f = fakeFetch(() => json(201, subscriptionBody()))
    const r = await createSubscription(TOKEN, createReq, f.fetch)
    expect(JSON.stringify(r)).not.toContain('nikdy-se-nevraci')
  })

  it('409 → conflict, 403 → forbidden s kódem, 500 → error bez textu odpovědi', async () => {
    expect(await createSubscription(TOKEN, createReq, fakeFetch(() => json(409, { error: { code: 'Conflict' } })).fetch))
      .toEqual({ kind: 'conflict' })
    expect(await createSubscription(TOKEN, createReq, fakeFetch(() => json(403, { error: { code: 'ErrorAccessDenied', message: 'x' } })).fetch))
      .toEqual({ kind: 'forbidden', code: 'ErrorAccessDenied' })
    const r = await createSubscription(TOKEN, createReq, fakeFetch(() => json(500, { error: { code: 'generalException', message: 'viktor@mummiesdaddies.com tajné' } })).fetch)
    expect(r).toEqual({ kind: 'error', status: 500, message: 'Graph 500 generalException' })
  })

  it('429 s Retry-After → throttled s počtem sekund', async () => {
    const r = await createSubscription(TOKEN, createReq, fakeFetch(() => json(429, {}, { 'Retry-After': '7' })).fetch)
    expect(r).toEqual({ kind: 'throttled', retryAfterSeconds: 7 })
  })

  it('http notificationUrl se vůbec neodešle', async () => {
    const f = fakeFetch(() => json(201, subscriptionBody()))
    const r = await createSubscription(TOKEN, { ...createReq, notificationUrl: 'http://x.cz/api/ms/notifications' }, f.fetch)
    expect(r.kind).toBe('error')
    expect(f.calls).toHaveLength(0)
  })

  it('výpadek sítě → error bez tokenu ve zprávě', async () => {
    const r = await createSubscription(TOKEN, createReq, async () => { throw new TypeError(`fetch failed ${TOKEN}`) })
    expect(r.kind).toBe('error')
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })

  it('neplatná odpověď (id není GUID) → error', async () => {
    const r = await createSubscription(TOKEN, createReq, fakeFetch(() => json(201, subscriptionBody({ id: '../x' }))).fetch)
    expect(r.kind).toBe('error')
  })
})

describe('renew / delete / list', () => {
  it('renew = PATCH /subscriptions/{id} jen s expirationDateTime', async () => {
    const f = fakeFetch(() => json(200, subscriptionBody({ expirationDateTime: '2026-10-06T09:00:00Z' })))
    const r = await renewSubscription(TOKEN, SUB_ID, '2026-10-06T09:00:00.000Z', f.fetch)
    expect(r).toMatchObject({ kind: 'ok', value: { id: SUB_ID, expirationDateTime: '2026-10-06T09:00:00.000Z' } })
    expect(f.calls[0].url).toBe(`${GRAPH_SUBSCRIPTIONS_URL}/${SUB_ID}`)
    expect(f.calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ expirationDateTime: '2026-10-06T09:00:00.000Z' })
  })

  it('renew 404 → not_found; neplatné id se neodešle', async () => {
    expect(await renewSubscription(TOKEN, SUB_ID, 'x', fakeFetch(() => json(404, {})).fetch)).toEqual({ kind: 'not_found' })
    const f = fakeFetch(() => json(200, subscriptionBody()))
    expect((await renewSubscription(TOKEN, 'a/b', 'x', f.fetch)).kind).toBe('error')
    expect(f.calls).toHaveLength(0)
  })

  it('delete 204 → ok, 404 → not_found', async () => {
    const f = fakeFetch(() => new Response(null, { status: 204 }))
    expect(await deleteSubscription(TOKEN, SUB_ID, f.fetch)).toEqual({ kind: 'ok', value: null })
    expect(f.calls[0].init.method).toBe('DELETE')
    expect(await deleteSubscription(TOKEN, SUB_ID, fakeFetch(() => new Response(null, { status: 404 })).fetch)).toEqual({ kind: 'not_found' })
  })

  it('list vrátí platná předplatná, nesmysly zahodí', async () => {
    const f = fakeFetch(() => json(200, { value: [subscriptionBody(), { id: 'x y' }, null] }))
    const r = await listSubscriptions(TOKEN, f.fetch)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.value.map((s) => s.id)).toEqual([SUB_ID])
    expect(f.calls[0].init.method).toBe('GET')
  })
})

describe('parseNotificationCollection', () => {
  it('běžná change notifikace: id předplatného, clientState, id zprávy', () => {
    const parsed = parseNotificationCollection({
      value: [{
        subscriptionId: SUB_ID,
        clientState: 'cs',
        changeType: 'created',
        resource: 'Users/x/Messages/y',
        resourceData: { id: 'AAMkAG=', '@odata.type': '#Microsoft.Graph.Message' },
      }],
    })
    expect(parsed).toEqual({
      notifications: [{ subscriptionId: SUB_ID, clientState: 'cs', lifecycleEvent: null, resourceId: 'AAMkAG=' }],
      malformed: 0,
    })
  })

  it('lifecycle události; neznámá = unknown', () => {
    const parsed = parseNotificationCollection({
      value: [
        { subscriptionId: SUB_ID, clientState: 'cs', lifecycleEvent: 'missed' },
        { subscriptionId: SUB_ID, clientState: 'cs', lifecycleEvent: 'subscriptionRemoved' },
        { subscriptionId: SUB_ID, clientState: 'cs', lifecycleEvent: 'reauthorizationRequired' },
        { subscriptionId: SUB_ID, clientState: 'cs', lifecycleEvent: 'somethingNew' },
      ],
    })
    expect(parsed?.notifications.map((n) => n.lifecycleEvent)).toEqual(['missed', 'subscriptionRemoved', 'reauthorizationRequired', 'unknown'])
  })

  it('položky bez platného id předplatného se počítají jako vadné', () => {
    const parsed = parseNotificationCollection({ value: [{ clientState: 'cs' }, 'x', { subscriptionId: '<script>' }] })
    expect(parsed).toEqual({ notifications: [], malformed: 3 })
  })

  it('příliš dlouhý clientState = žádný clientState', () => {
    const parsed = parseNotificationCollection({ value: [{ subscriptionId: SUB_ID, clientState: 'a'.repeat(200) }] })
    expect(parsed?.notifications[0].clientState).toBeNull()
  })

  it('co není { value: [] } → null', () => {
    expect(parseNotificationCollection(null)).toBeNull()
    expect(parseNotificationCollection([])).toBeNull()
    expect(parseNotificationCollection({ value: 'x' })).toBeNull()
  })

  it('dávka nad limit se ořízne, přebytek je vadný', () => {
    const value = Array.from({ length: MAX_NOTIFICATIONS_PER_BATCH + 3 }, () => ({ subscriptionId: SUB_ID, clientState: 'cs' }))
    const parsed = parseNotificationCollection({ value })
    expect(parsed?.notifications).toHaveLength(MAX_NOTIFICATIONS_PER_BATCH)
    expect(parsed?.malformed).toBe(3)
  })
})
