// Veřejné inzeráty na pozice office manager / event / HR pro outbound
// agenta (P7). Firma, která takovou pozici obsazuje, často řeší firemní
// akce — inzerát je signál, ne kontakt: z inzerátu se nikdy nebere jméno
// ani e-mail náboráře. Zdroj je VEŘEJNÁ URL z konfigurace (RSS/Atom nebo
// JSON výpis); žádné přihlášení ani scrapování HTML stránek portálu.
// Bez OUTBOUND_JOBS_ENABLED === 'true' se nic nestahuje.
import type { OutboundJobSource } from '@/core/outbound/config'
import { cleanText, matchKeywords, type SignalCandidate } from '@/core/outbound/signal'
import { fetchPublicText, parseRss, toDay } from '@/connectors/feeds'

export function jobsEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.OUTBOUND_JOBS_ENABLED === 'true'
}

export interface JobPosting {
  id: string
  title: string
  company: string | null
  link: string | null
  date: string | null
  location: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null)
const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = str((v as Record<string, unknown>).name)
      if (nested) return nested
    }
    const s = str(v)
    if (s && s.trim()) return s
  }
  return null
}

/** JSON výpis: pole, nebo {items|results|data|jobs: [...]}; pole se jmény podle běžných API. */
export function parseJobsJson(text: string): JobPosting[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  const list = Array.isArray(raw) ? raw
    : raw && typeof raw === 'object'
      ? (['items', 'results', 'data', 'jobs'].map((k) => (raw as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined) ?? []
      : []
  return list.flatMap((x) => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const title = cleanText(pick(o, ['title', 'name', 'position', 'positionName']), 300)
    if (!title) return []
    const link = pick(o, ['url', 'link', 'detailUrl'])
    return [{
      id: (pick(o, ['id', 'uuid', 'guid']) ?? link ?? title).slice(0, 250),
      title,
      company: cleanText(pick(o, ['company', 'employer', 'companyName', 'employerName']), 200),
      link: link && /^https?:\/\//.test(link) ? link.slice(0, 1000) : null,
      date: toDay(pick(o, ['date', 'published', 'publishedAt', 'created', 'createdAt'])),
      location: cleanText(pick(o, ['location', 'city', 'place', 'locality']), 200),
    }]
  })
}

/** RSS portálu: firma bývá v <author> nebo v názvu za pomlčkou („Office manager – Firma s.r.o."). */
export function parseJobsRss(xml: string): JobPosting[] {
  return parseRss(xml).map((it) => {
    const split = /^(.*?)\s+[–—-]\s+(.+)$/.exec(it.title)
    return {
      id: it.id,
      title: split ? split[1] : it.title,
      company: it.organizer ?? (split ? split[2] : null),
      link: it.link,
      date: it.date,
      location: it.location,
    }
  })
}

export function jobsToSignals(source: Pick<OutboundJobSource, 'key' | 'label'>, jobs: readonly JobPosting[], keywords: readonly string[]): SignalCandidate[] {
  return jobs.flatMap((j) => {
    const hits = matchKeywords(j.title, keywords)
    if (!hits.length || !j.company) return []
    return [{
      source: 'jobs' as const,
      kind: 'job_posting' as const,
      externalRef: `${source.key}:${j.id}`.slice(0, 300),
      title: `${j.company} hledá: ${j.title}`.slice(0, 300),
      url: j.link,
      signalDate: j.date,
      company: { ico: null, name: j.company },
      facts: [
        { key: 'pozice', value: j.title, sourceUrl: j.link },
        { key: 'firma', value: j.company, sourceUrl: j.link },
        ...(j.location ? [{ key: 'misto', value: j.location, sourceUrl: j.link }] : []),
        { key: 'zdroj', value: source.label.slice(0, 300), sourceUrl: j.link },
      ],
    }]
  })
}

export async function fetchJobSignals(
  source: OutboundJobSource, keywords: readonly string[], fetchImpl: typeof fetch = fetch,
): Promise<SignalCandidate[]> {
  const text = await fetchPublicText(source.url, fetchImpl)
  const jobs = source.format === 'json' ? parseJobsJson(text) : parseJobsRss(text)
  return jobsToSignals(source, jobs, keywords)
}
