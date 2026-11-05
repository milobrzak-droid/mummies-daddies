// Microsoft Graph — stav jedné události kalendáře (schůzky naplánované
// z Cockpitu, domain/crm/actions/planMeeting.ts).
//
// Jen transport: jeden GET /me/events/{id} a překlad odpovědi na
// jednoznačný výsledek (událost / smazaná / bez oprávnění / throttling /
// chyba). Co s výsledkem udělat (posun, zrušení, úkoly, milník) rozhoduje
// domain/crm/meetingCalendar.ts, běh a zápisy domain/crm/meetingCalendarSync.ts.
//
// Soukromí: $select je natvrdo jen čas a stav události. Předmět, tělo,
// účastníci ani místo se z Outlooku nečtou — Cockpit je má vlastní (zadal
// je člověk při plánování) a nepotřebuje je.
//
// Oprávnění: čtení vlastní události pokrývá Calendars.ReadWrite, které
// Cockpit žádá od začátku (GRAPH_SCOPES v ./client.ts). Nové oprávnění
// v Entra netřeba.

import { GRAPH_BASE, parseRetryAfter, type FetchLike } from './mail'

export const CALENDAR_EVENT_SELECT = ['id', 'start', 'end', 'isCancelled', 'lastModifiedDateTime'] as const

/** Časy v UTC — bez hlavičky by Graph vrátil pásmo, ve kterém událost vznikla. */
export const CALENDAR_EVENT_PREFER = 'outlook.timezone="UTC"'

/** Nejdelší id události, které má smysl posílat (Graph id mají ~150 znaků). */
const EVENT_ID_MAX = 512

export type CalendarEventState = {
  id: string
  /** Začátek události (ISO v UTC). */
  start: string
  /** Konec události (ISO v UTC), když ho Graph poslal čitelně. */
  end: string | null
  /** Zrušená schůzka (u pozvaného; organizátorovi Outlook zrušenou událost smaže). */
  isCancelled: boolean
  lastModified: string | null
}

export type CalendarEventResult =
  | { kind: 'event'; event: CalendarEventState }
  /** 404 — událost v kalendáři není (organizátor ji zrušil nebo smazal). */
  | { kind: 'not_found' }
  /** 401 — token neplatí (vypršel, byl odvolán). */
  | { kind: 'unauthorized' }
  /** 403 — token nemá právo na kalendář; pomůže jen nové připojení Outlooku. */
  | { kind: 'forbidden'; code: string | null }
  | { kind: 'throttled'; retryAfterSeconds: number }
  | { kind: 'error'; status: number; message: string }

export function calendarEventUrl(eventId: string): string {
  return `${GRAPH_BASE}/me/events/${encodeURIComponent(eventId)}?$select=${CALENDAR_EVENT_SELECT.join(',')}`
}

const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'Coordinated Universal Time'])

/**
 * Graph `dateTimeTimeZone` v UTC („2026-10-02T12:00:00.0000000") → ISO s „Z".
 * Jiné pásmo nebo nečitelná hodnota → null: čas, kterému nerozumíme, nesmí
 * schůzku posunout.
 */
export function graphUtcToIso(dt: { dateTime?: unknown; timeZone?: unknown } | null | undefined): string | null {
  if (!dt || typeof dt.dateTime !== 'string') return null
  if (typeof dt.timeZone !== 'string' || !UTC_ZONES.has(dt.timeZone)) return null
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/.exec(dt.dateTime)
  if (!m) return null
  const d = new Date(`${m[1]}Z`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Stav jedné události z kalendáře přihlášeného člena (token je jeho). */
export async function fetchCalendarEvent(
  accessToken: string,
  eventId: string,
  fetchImpl: FetchLike = fetch,
): Promise<CalendarEventResult> {
  if (!eventId || eventId.length > EVENT_ID_MAX) return { kind: 'error', status: 0, message: 'Neplatné id události' }
  let res: Response
  try {
    res = await fetchImpl(calendarEventUrl(eventId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: CALENDAR_EVENT_PREFER },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    return { kind: 'error', status: 0, message: e instanceof Error ? e.message : String(e) }
  }

  if (res.status === 429 || res.status === 503) {
    return { kind: 'throttled', retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')) }
  }

  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    json = null
  }

  if (!res.ok) {
    const err = (json?.error ?? null) as { code?: unknown } | null
    const code = typeof err?.code === 'string' ? err.code : null
    // Jen „položka neexistuje" znamená smazanou událost. Jiná 404 (schránka
    // bez licence MailboxNotEnabledForRESTAPI, ResourceNotFound …) je chyba —
    // na jejím základě se schůzka rušit nesmí.
    if (res.status === 404 && code === 'ErrorItemNotFound') return { kind: 'not_found' }
    if (res.status === 401) return { kind: 'unauthorized' }
    if (res.status === 403) return { kind: 'forbidden', code }
    // Zpráva z Graphu může nést detaily; do stavu jde jen kód.
    return { kind: 'error', status: res.status, message: `Graph ${res.status}${code ? ` ${code}` : ''}` }
  }

  const start = graphUtcToIso(json?.start as { dateTime?: unknown; timeZone?: unknown } | undefined)
  if (!start || typeof json?.id !== 'string') {
    return { kind: 'error', status: res.status, message: 'Graph vrátil událost bez čitelného začátku' }
  }
  return {
    kind: 'event',
    event: {
      id: json.id,
      start,
      end: graphUtcToIso(json.end as { dateTime?: unknown; timeZone?: unknown } | undefined),
      isCancelled: json.isCancelled === true,
      lastModified: typeof json.lastModifiedDateTime === 'string' ? json.lastModifiedDateTime : null,
    },
  }
}
