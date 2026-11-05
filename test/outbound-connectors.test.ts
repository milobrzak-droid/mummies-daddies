// Konektory zdrojů signálů outbound agenta (P7): veřejné zakázky (otevřená
// data ISVZ), RSS/Atom/iCal akcí a veřejné inzeráty. Jen mock fetch, žádná síť.
import { describe, expect, test, vi } from 'vitest'
import { COMPANY } from '@/config'
import type { OutboundAgentConfig } from '@/core/outbound/config'
import { parseSignalCandidate } from '@/core/outbound/signal'
import { feedItemsToSignals, feedsEnabledFromEnv, fetchFeedSignals, fetchPublicText, FeedUnavailableError, isAllowedSourceUrl, parseIcal, parseRss } from '@/connectors/feeds'
import { fetchJobSignals, jobsEnabledFromEnv, jobsToSignals, parseJobsJson, parseJobsRss } from '@/connectors/jobs'
import { fetchTenderSignals, normalizeTender, parseTenders, tendersToSignals, vvzEnabledFromEnv } from '@/connectors/vvz'
import { liveOutboundSources, outboundAgentEnabledFromEnv, outboundAutosendEnabledFromEnv } from '@/domain/outbound/sources'

const CFG = COMPANY.capabilities.outboundAgent as OutboundAgentConfig
const okText = (body: string) => vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Konference HR Praha 2027</title><link>https://akce.example/hr</link><guid>hr-2027</guid>
<pubDate>Tue, 10 Nov 2026 08:00:00 GMT</pubDate><description><![CDATA[Velká <b>konference</b> &amp; networking]]></description><author>Komora Ukázka</author></item>
<item><title>Koncert v parku</title><link>https://akce.example/koncert</link></item>
</channel></rss>`
const ATOM = `<feed><entry><title>Veletrh inovací</title><link href="https://akce.example/veletrh"/><id>urn:1</id><updated>2026-12-01T10:00:00Z</updated></entry></feed>`
const ICS = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-1@ukazka\r\nSUMMARY:Firemní akce\\, teambuilding\r\nDTSTART:20270115T170000Z\r\nLOCATION:Praha 7\r\nORGANIZER;CN=Delta Coworking:mailto:info@delta.example\r\nURL:https://akce.example/tb\r\nDESCRIPTION:Dlouhý popis\r\n  pokračuje\r\nEND:VEVENT\r\nEND:VCALENDAR`

describe('feeds (RSS/Atom/iCal)', () => {
  test('RSS: položky, CDATA a entity, datum', () => {
    const items = parseRss(RSS)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'hr-2027', title: 'Konference HR Praha 2027', link: 'https://akce.example/hr', date: '2026-11-10', organizer: 'Komora Ukázka' })
    expect(items[0].description).toBe('Velká konference & networking')
  })

  test('Atom a iCal (rozbalené řádky, escapování, organizátor)', () => {
    expect(parseRss(ATOM)[0]).toMatchObject({ title: 'Veletrh inovací', link: 'https://akce.example/veletrh', date: '2026-12-01' })
    const ev = parseIcal(ICS)[0]
    expect(ev).toMatchObject({ id: 'evt-1@ukazka', title: 'Firemní akce, teambuilding', date: '2027-01-15', location: 'Praha 7', organizer: 'Delta Coworking', link: 'https://akce.example/tb' })
    expect(ev.description).toBe('Dlouhý popis pokračuje')
  })

  test('jen položky s klíčovým slovem → platné signály s fakty', async () => {
    const s = feedItemsToSignals({ key: 'komora', label: 'Komora' }, parseRss(RSS), CFG.sources.feedKeywords)
    expect(s.map((x) => x.externalRef)).toEqual(['komora:hr-2027'])
    expect(s[0].facts.map((f) => f.key)).toEqual(['akce', 'datum', 'poradatel', 'zdroj'])
    expect(parseSignalCandidate(s[0])).not.toBeNull()
    const ical = await fetchFeedSignals({ key: 'k', label: 'K', url: 'https://akce.example/cal.ics', format: 'ical' }, CFG.sources.feedKeywords, okText(ICS))
    expect(ical).toHaveLength(1)
    expect(ical[0].company.name).toBe('Delta Coworking')
  })

  test('jen veřejné URL bez přihlašovacích údajů; HTTP chyba je dočasná', async () => {
    expect(isAllowedSourceUrl('https://user:heslo@akce.example/x')).toBe(false)
    expect(isAllowedSourceUrl('file:///etc/passwd')).toBe(false)
    await expect(fetchPublicText('ftp://x', okText(''))).rejects.toBeInstanceOf(FeedUnavailableError)
    const f = vi.fn(async () => new Response('x', { status: 503 })) as unknown as typeof fetch
    await expect(fetchPublicText('https://akce.example/x', f)).rejects.toThrow(/503/)
    const init = (okText(RSS) as unknown as ReturnType<typeof vi.fn>)
    await fetchPublicText('https://akce.example/x', init as unknown as typeof fetch)
    expect(init.mock.calls[0][1]).toMatchObject({ credentials: 'omit', cache: 'no-store' })
  })
})

describe('jobs (veřejné inzeráty)', () => {
  test('JSON výpis různých tvarů → pozice s firmou', () => {
    const jobs = parseJobsJson(JSON.stringify({ items: [
      { id: 1, title: 'Office manažerka', employer: { name: 'Beta Konzult a.s.' }, url: 'https://prace.example/1', publishedAt: '2026-11-01', city: 'Praha' },
      { id: 2, title: 'Skladník', company: 'Gama' },
      { id: 3, title: 'Event koordinátor' },
    ] }))
    expect(jobs).toHaveLength(3)
    const s = jobsToSignals({ key: 'p', label: 'Portál' }, jobs, CFG.sources.jobKeywords)
    // Bez firmy (id 3) a mimo pozice (id 2) se signál nedělá; jména náborářů se nikdy neberou.
    expect(s.map((x) => x.externalRef)).toEqual(['p:1'])
    expect(s[0]).toMatchObject({ kind: 'job_posting', company: { ico: null, name: 'Beta Konzult a.s.' } })
    expect(parseJobsJson('není json')).toEqual([])
  })

  test('RSS portálu: firma z autora nebo za pomlčkou', async () => {
    const xml = '<rss><item><title>Office manager – Delta Coworking s.r.o.</title><link>https://prace.example/9</link><guid>9</guid></item></rss>'
    expect(parseJobsRss(xml)[0]).toMatchObject({ title: 'Office manager', company: 'Delta Coworking s.r.o.' })
    const s = await fetchJobSignals({ key: 'p', label: 'P', url: 'https://prace.example/rss', format: 'rss' }, CFG.sources.jobKeywords, okText(xml))
    expect(s).toHaveLength(1)
  })
})

describe('vvz (veřejné zakázky z otevřených dat)', () => {
  const data = { zakazky: [
    { idZakazky: 'Z2026-001', nazev: 'Zajištění občerstvení pro konferenci', zadavatel: { nazev: 'Úřad Ukázka', ico: '64581' }, cpv: ['55520000-1'], lhutaNabidek: '2026-12-01T10:00:00+01:00', url: 'https://vvz.example/Z2026-001' },
    { id: 'Z2026-002', title: 'Oprava střechy', buyer: { name: 'Obec', identifier: '00012345' }, cpvKody: [{ kod: '45261000' }] },
    { id: 'Z2026-003', nazev: 'Stravovací služby', hlavniCpv: '55321000' },
    { bez: 'id' },
  ] }

  test('obranné parsování českých i anglických polí', () => {
    const t = parseTenders(JSON.stringify(data))
    expect(t).toHaveLength(3)
    expect(t[0]).toMatchObject({ id: 'Z2026-001', buyerIco: '00064581', cpv: ['55520000'], deadline: '2026-12-01' })
    expect(t[1]).toMatchObject({ buyerName: 'Obec', buyerIco: '00012345', cpv: ['45261000'] })
    expect(normalizeTender(null)).toBeNull()
    expect(parseTenders('[')).toEqual([])
  })

  test('relevantní podle CPV nebo klíčového slova', async () => {
    const s = tendersToSignals(parseTenders(JSON.stringify(data)), CFG.sources.vvz)
    expect(s.map((x) => x.externalRef)).toEqual(['Z2026-001', 'Z2026-003'])
    expect(s[0]).toMatchObject({ source: 'vvz', kind: 'public_tender', company: { ico: '00064581', name: 'Úřad Ukázka' } })
    expect(s.every((x) => parseSignalCandidate(x) !== null)).toBe(true)
    expect(await fetchTenderSignals('https://vvz.example/export.json', CFG.sources.vvz, okText(JSON.stringify(data)))).toHaveLength(2)
  })
})

describe('přepínače (výchozí vypnuto)', () => {
  test('bez env nic nejede', () => {
    expect(outboundAgentEnabledFromEnv({})).toBe(false)
    expect(outboundAutosendEnabledFromEnv({ OUTBOUND_AUTOSEND_ENABLED: 'true' })).toBe(false)
    expect(outboundAutosendEnabledFromEnv({ OUTBOUND_AGENT_ENABLED: 'true', OUTBOUND_AUTOSEND_ENABLED: 'true' })).toBe(true)
    expect(feedsEnabledFromEnv({})).toBe(false)
    expect(jobsEnabledFromEnv({})).toBe(false)
    expect(vvzEnabledFromEnv({ VVZ_ENABLED: 'true' })).toBe(false)
  })

  test('liveOutboundSources: vypnuté zdroje nevolají síť; chyba zdroje = kód', async () => {
    const f = vi.fn() as unknown as typeof fetch
    const off = await liveOutboundSources({}, CFG, f).collect()
    expect(off).toEqual({ signals: [], errors: [] })
    expect(f).not.toHaveBeenCalled()
    expect(liveOutboundSources({}, CFG, f).ares).toBeNull()
    const bad = vi.fn(async () => new Response('x', { status: 500 })) as unknown as typeof fetch
    const on = await liveOutboundSources({ VVZ_ENABLED: 'true', VVZ_OPEN_DATA_URL: 'https://vvz.example/x.json' }, CFG, bad).collect()
    expect(on.errors).toEqual([{ source: 'vvz', code: 'FeedUnavailableError' }])
  })
})
