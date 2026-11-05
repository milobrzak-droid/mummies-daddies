// connectors/graph/calendar.ts — stav jedné události kalendáře proti
// podvrženým odpovědím Microsoft Graphu (žádná síť).
import { describe, expect, test, vi } from 'vitest'
import {
  CALENDAR_EVENT_PREFER,
  calendarEventUrl,
  fetchCalendarEvent,
  graphUtcToIso,
} from '@/connectors/graph'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function fakeFetch(res: Response | (() => Promise<Response>)) {
  return vi.fn(async () => (typeof res === 'function' ? res() : res.clone()))
}

const EVENT_ID = 'AAMkAGI2TG93AAA=/x+y'

describe('graphUtcToIso', () => {
  test('UTC s desetimilionty sekundy → ISO se Z', () => {
    expect(graphUtcToIso({ dateTime: '2026-10-02T12:00:00.0000000', timeZone: 'UTC' })).toBe('2026-10-02T12:00:00.000Z')
    expect(graphUtcToIso({ dateTime: '2026-10-02T12:30', timeZone: 'Etc/UTC' })).toBe('2026-10-02T12:30:00.000Z')
  })

  test('jiné pásmo nebo nesmysl → null (čas, kterému nerozumíme, schůzku nesmí posunout)', () => {
    expect(graphUtcToIso({ dateTime: '2026-10-02T14:00:00.0000000', timeZone: 'Central Europe Standard Time' })).toBeNull()
    expect(graphUtcToIso({ dateTime: 'zítra', timeZone: 'UTC' })).toBeNull()
    expect(graphUtcToIso({ dateTime: '2026-10-02T12:00:00Z', timeZone: 'UTC' })).toBeNull()
    expect(graphUtcToIso(null)).toBeNull()
    expect(graphUtcToIso({ timeZone: 'UTC' })).toBeNull()
  })
})

describe('fetchCalendarEvent', () => {
  test('pošle GET na /me/events/{id} s $select jen na čas a stav, časy v UTC', async () => {
    const f = fakeFetch(json(200, {
      id: EVENT_ID,
      start: { dateTime: '2026-10-03T12:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-03T13:00:00.0000000', timeZone: 'UTC' },
      isCancelled: false,
      lastModifiedDateTime: '2026-09-29T07:00:00Z',
      subject: 'Tohle Cockpit nečte',
    }))
    const r = await fetchCalendarEvent('tok', EVENT_ID, f)
    expect(r).toEqual({
      kind: 'event',
      event: {
        id: EVENT_ID,
        start: '2026-10-03T12:00:00.000Z',
        end: '2026-10-03T13:00:00.000Z',
        isCancelled: false,
        lastModified: '2026-09-29T07:00:00Z',
      },
    })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(calendarEventUrl(EVENT_ID))
    expect(url).toBe(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(EVENT_ID)}?$select=id,start,end,isCancelled,lastModifiedDateTime`)
    expect(url).not.toMatch(/subject|body|attendees/)
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({ Authorization: 'Bearer tok', Prefer: CALENDAR_EVENT_PREFER })
  })

  test('zrušená schůzka (pohled pozvaného) → isCancelled', async () => {
    const r = await fetchCalendarEvent('tok', 'ev', fakeFetch(json(200, {
      id: 'ev', start: { dateTime: '2026-10-03T12:00:00.0000000', timeZone: 'UTC' }, isCancelled: true,
    })))
    expect(r).toMatchObject({ kind: 'event', event: { isCancelled: true, end: null } })
  })

  test('404 → not_found (organizátor událost zrušil nebo smazal)', async () => {
    const r = await fetchCalendarEvent('tok', 'ev', fakeFetch(json(404, { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } })))
    expect(r).toEqual({ kind: 'not_found' })
  })

  test('jiná 404 (schránka bez licence, bez kódu) → chyba, ne zrušení', async () => {
    expect(await fetchCalendarEvent('tok', 'ev', fakeFetch(json(404, { error: { code: 'MailboxNotEnabledForRESTAPI' } }))))
      .toEqual({ kind: 'error', status: 404, message: 'Graph 404 MailboxNotEnabledForRESTAPI' })
    expect(await fetchCalendarEvent('tok', 'ev', fakeFetch(json(404, {})))).toMatchObject({ kind: 'error', status: 404 })
  })

  test('401 → unauthorized, 403 → forbidden s kódem', async () => {
    expect(await fetchCalendarEvent('tok', 'ev', fakeFetch(json(401, { error: { code: 'InvalidAuthenticationToken' } }))))
      .toEqual({ kind: 'unauthorized' })
    expect(await fetchCalendarEvent('tok', 'ev', fakeFetch(json(403, { error: { code: 'ErrorAccessDenied' } }))))
      .toEqual({ kind: 'forbidden', code: 'ErrorAccessDenied' })
  })

  test('429 / 503 → throttled s Retry-After', async () => {
    expect(await fetchCalendarEvent('tok', 'ev', fakeFetch(json(429, {}, { 'Retry-After': '7' }))))
      .toEqual({ kind: 'throttled', retryAfterSeconds: 7 })
    expect(await fetchCalendarEvent('tok', 'ev', fakeFetch(json(503, {}))))
      .toEqual({ kind: 'throttled', retryAfterSeconds: 10 })
  })

  test('jiná chyba → jen stav a kód, žádný text z Graphu', async () => {
    const r = await fetchCalendarEvent('tok', 'ev', fakeFetch(json(500, { error: { code: 'generalException', message: 'Jan Novák …' } })))
    expect(r).toEqual({ kind: 'error', status: 500, message: 'Graph 500 generalException' })
  })

  test('událost v cizím pásmu nebo bez začátku → chyba, ne posun', async () => {
    const r = await fetchCalendarEvent('tok', 'ev', fakeFetch(json(200, {
      id: 'ev', start: { dateTime: '2026-10-03T14:00:00.0000000', timeZone: 'Central Europe Standard Time' },
    })))
    expect(r).toMatchObject({ kind: 'error' })
  })

  test('výpadek sítě a neplatné id → chyba bez volání', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect(await fetchCalendarEvent('tok', 'ev', boom)).toEqual({ kind: 'error', status: 0, message: 'ECONNRESET' })
    const f = fakeFetch(json(200, {}))
    expect(await fetchCalendarEvent('tok', '', f)).toMatchObject({ kind: 'error', status: 0 })
    expect(await fetchCalendarEvent('tok', 'x'.repeat(513), f)).toMatchObject({ kind: 'error', status: 0 })
    expect(f).not.toHaveBeenCalled()
  })
})
