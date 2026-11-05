// Veřejné zakázky na catering a občerstvení (P7) z OTEVŘENÝCH DAT
// (Portál ISVZ — isvz.nipez.cz/opendata: Registr veřejných zakázek s údaji
// z Věstníku veřejných zakázek, NEN a dalších elektronických nástrojů,
// JSON od února 2024). Přesnou adresu exportu zadává provoz v env
// VVZ_OPEN_DATA_URL (OVĚŘIT: struktura i adresa se mohou měnit — parser je
// proto obranný a bere jen pole, která zná). Bez VVZ_ENABLED === 'true' se
// nic nestahuje. Zadavatel je veřejný subjekt s IČO: oslovení = podání
// nabídky do zakázky (člověk), nikdy e-mail.
import { cleanText, matchKeywords, normalizeIco, type SignalCandidate } from '@/core/outbound/signal'
import { fetchPublicText, toDay } from '@/connectors/feeds'

export function vvzEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.VVZ_ENABLED === 'true' && !!env.VVZ_OPEN_DATA_URL
}

export interface PublicTender {
  id: string
  title: string
  buyerName: string | null
  buyerIco: string | null
  cpv: string[]
  deadline: string | null
  url: string | null
  description: string | null
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null)
const first = (o: Obj, keys: string[]): unknown => keys.map((k) => o[k]).find((v) => v != null && v !== '')

function cpvCodes(o: Obj): string[] {
  const raw = first(o, ['cpv', 'cpvKody', 'kodyCpv', 'hlavniCpv', 'cpvCodes', 'mainCpv'])
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : []
  return list.flatMap((x) => {
    const code = s(x) ?? s(obj(x)?.kod) ?? s(obj(x)?.code)
    const m = code ? /(\d{8})/.exec(code.replace(/-/g, '')) : null
    return m ? [m[1]] : []
  })
}

/** Obranný převod jednoho záznamu (české i anglické názvy polí). */
export function normalizeTender(raw: unknown): PublicTender | null {
  const o = obj(raw)
  if (!o) return null
  const id = s(first(o, ['id', 'idZakazky', 'evidencniCislo', 'systemoveCislo', 'noticeId']))
  const title = cleanText(s(first(o, ['nazev', 'nazevZakazky', 'title', 'name'])), 300)
  if (!id || !title) return null
  const buyer = obj(first(o, ['zadavatel', 'buyer', 'contractingAuthority'])) ?? {}
  const url = s(first(o, ['url', 'odkaz', 'link', 'detailUrl']))
  return {
    id: id.slice(0, 200),
    title,
    buyerName: cleanText(s(first(buyer, ['nazev', 'name', 'obchodniJmeno'])) ?? s(o.zadavatelNazev), 200),
    buyerIco: normalizeIco(s(first(buyer, ['ico', 'IC', 'ic', 'identifier'])) ?? s(o.zadavatelIco)),
    cpv: cpvCodes(o),
    deadline: toDay(s(first(o, ['lhutaNabidek', 'lhutaProPodaniNabidek', 'deadline', 'tenderDeadline']))),
    url: url && /^https?:\/\//.test(url) ? url.slice(0, 1000) : null,
    description: cleanText(s(first(o, ['popis', 'predmet', 'description'])), 1000),
  }
}

export function parseTenders(text: string): PublicTender[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  const list = Array.isArray(raw) ? raw
    : (['zakazky', 'verejneZakazky', 'items', 'data', 'results'].map((k) => obj(raw)?.[k]).find(Array.isArray) as unknown[] | undefined) ?? []
  return list.map(normalizeTender).filter((t): t is PublicTender => t !== null)
}

/** Zakázka je relevantní podle CPV (prefix) nebo klíčového slova v názvu/popisu. */
export function tendersToSignals(tenders: readonly PublicTender[], opts: { keywords: readonly string[]; cpvPrefixes: readonly string[] }): SignalCandidate[] {
  return tenders.flatMap((t) => {
    const cpvHit = t.cpv.some((c) => opts.cpvPrefixes.some((p) => c.startsWith(p)))
    const kwHit = matchKeywords(`${t.title} ${t.description ?? ''}`, opts.keywords).length > 0
    if (!cpvHit && !kwHit) return []
    return [{
      source: 'vvz' as const,
      kind: 'public_tender' as const,
      externalRef: t.id,
      title: t.title,
      url: t.url,
      signalDate: t.deadline,
      company: { ico: t.buyerIco, name: t.buyerName },
      facts: [
        { key: 'zakazka', value: t.title, sourceUrl: t.url },
        ...(t.buyerName ? [{ key: 'zadavatel', value: t.buyerName, sourceUrl: t.url }] : []),
        ...(t.deadline ? [{ key: 'lhuta', value: t.deadline, sourceUrl: t.url }] : []),
        ...(t.cpv.length ? [{ key: 'cpv', value: t.cpv.slice(0, 5).join(', '), sourceUrl: t.url }] : []),
      ],
    }]
  })
}

export async function fetchTenderSignals(
  url: string, opts: { keywords: readonly string[]; cpvPrefixes: readonly string[] }, fetchImpl: typeof fetch = fetch,
): Promise<SignalCandidate[]> {
  return tendersToSignals(parseTenders(await fetchPublicText(url, fetchImpl, 15_000)), opts)
}
