// Veřejné kalendáře a novinky akcí (RSS 2.0, Atom, iCalendar) pro outbound
// agenta (P7). Jen VEŘEJNÉ URL zadané v konfiguraci firmy — žádné
// přihlášení, cookies ani scrapování HTML. Bez OUTBOUND_FEEDS_ENABLED ===
// 'true' se nic nestahuje. Obsah je nedůvěryhodný: jen se zkrátí a předá
// jako ověřená fakta „co zdroj uvádí" (název, termín, místo, odkaz).
import type { OutboundFeedSource } from '@/core/outbound/config'
import { cleanText, matchKeywords, type SignalCandidate } from '@/core/outbound/signal'

export function feedsEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.OUTBOUND_FEEDS_ENABLED === 'true'
}

export const FEED_TIMEOUT_MS = 8_000
export const FEED_MAX_BYTES = 2_000_000

export class FeedUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'FeedUnavailableError' }
}

/** Povolená URL zdroje: https/http, bez přihlašovacích údajů v adrese. */
export function isAllowedSourceUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
  } catch {
    return false
  }
}

/** Stáhne text zdroje (timeout, limit velikosti, žádné cookies). Sdílí i konektor inzerátů. */
export async function fetchPublicText(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = FEED_TIMEOUT_MS): Promise<string> {
  if (!isAllowedSourceUrl(url)) throw new FeedUnavailableError('nepovolená adresa zdroje')
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, text/calendar, application/json, application/xml;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
    })
  } catch {
    throw new FeedUnavailableError('zdroj neodpověděl')
  }
  if (!res.ok) throw new FeedUnavailableError(`zdroj vrátil HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > FEED_MAX_BYTES) throw new FeedUnavailableError('zdroj je příliš velký')
  return text
}

export interface FeedItem {
  id: string
  title: string
  link: string | null
  date: string | null
  location: string | null
  description: string | null
  organizer: string | null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return m ? cleanText(decodeXml(m[1]), 1000) : null
}

function atomLink(block: string): string | null {
  const m = /<link\b[^>]*href="([^"]+)"/i.exec(block)
  return m ? m[1] : null
}

/** YYYY-MM-DD z RFC 822 / ISO data; null když nejde přečíst. */
export function toDay(raw: string | null): string | null {
  if (!raw) return null
  const ical = /^(\d{4})(\d{2})(\d{2})/.exec(raw)
  if (ical) return `${ical[1]}-${ical[2]}-${ical[3]}`
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

const httpOrNull = (u: string | null) => (u && /^https?:\/\//.test(u) ? u.slice(0, 1000) : null)

/** RSS 2.0 i Atom. */
export function parseRss(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0])
  return blocks.flatMap((b) => {
    const title = tag(b, 'title')
    if (!title) return []
    const link = httpOrNull(tag(b, 'link') ?? atomLink(b))
    const id = tag(b, 'guid') ?? tag(b, 'id') ?? link ?? title
    return [{
      id: id.slice(0, 250),
      title,
      link,
      date: toDay(tag(b, 'pubDate') ?? tag(b, 'updated') ?? tag(b, 'published')),
      location: tag(b, 'location'),
      description: tag(b, 'description') ?? tag(b, 'summary'),
      organizer: tag(b, 'author') ?? tag(b, 'dc:creator'),
    }]
  })
}

function unescapeIcal(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1')
}

/** iCalendar (RFC 5545): VEVENT → položka; řádky se před čtením rozbalí. */
export function parseIcal(text: string): FeedItem[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const events = [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => m[1])
  return events.flatMap((e) => {
    const prop = (name: string) => {
      const m = new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, 'mi').exec(e)
      return m ? cleanText(unescapeIcal(m[1]), 1000) : null
    }
    const title = prop('SUMMARY')
    const uid = prop('UID')
    if (!title) return []
    const organizer = /^ORGANIZER(?:;[^:\r\n]*?CN=("?)([^";:]+)\1)?[^:\r\n]*:/mi.exec(e)
    return [{
      id: (uid ?? `${title}:${prop('DTSTART') ?? ''}`).slice(0, 250),
      title,
      link: httpOrNull(prop('URL')),
      date: toDay(prop('DTSTART')),
      location: prop('LOCATION'),
      description: prop('DESCRIPTION'),
      organizer: organizer?.[2] ? cleanText(organizer[2], 200) : null,
    }]
  })
}

/** Položky zdroje → signály (jen ty s klíčovým slovem v názvu nebo popisu). */
export function feedItemsToSignals(source: Pick<OutboundFeedSource, 'key' | 'label'>, items: readonly FeedItem[], keywords: readonly string[]): SignalCandidate[] {
  return items.flatMap((it) => {
    const hits = matchKeywords(`${it.title} ${it.description ?? ''}`, keywords)
    if (!hits.length) return []
    const facts = [
      { key: 'akce', value: cleanText(it.title, 300)!, sourceUrl: it.link },
      ...(it.date ? [{ key: 'datum', value: it.date, sourceUrl: it.link }] : []),
      ...(it.location ? [{ key: 'misto', value: cleanText(it.location, 300)!, sourceUrl: it.link }] : []),
      ...(it.organizer ? [{ key: 'poradatel', value: cleanText(it.organizer, 200)!, sourceUrl: it.link }] : []),
      { key: 'zdroj', value: source.label.slice(0, 300), sourceUrl: it.link },
    ]
    return [{
      source: 'feed' as const,
      kind: 'event' as const,
      externalRef: `${source.key}:${it.id}`.slice(0, 300),
      title: cleanText(it.title, 300)!,
      url: it.link,
      signalDate: it.date,
      company: { ico: null, name: it.organizer ? cleanText(it.organizer, 200) : null },
      facts,
    }]
  })
}

/** Stáhne a převede jeden zdroj. Chyba jednoho zdroje nezastaví ostatní (řeší volající). */
export async function fetchFeedSignals(
  source: OutboundFeedSource, keywords: readonly string[], fetchImpl: typeof fetch = fetch,
): Promise<SignalCandidate[]> {
  const text = await fetchPublicText(source.url, fetchImpl)
  const items = source.format === 'ical' ? parseIcal(text) : parseRss(text)
  return feedItemsToSignals(source, items, keywords)
}
