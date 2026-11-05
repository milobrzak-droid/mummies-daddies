// Signály ze stávající databáze klientů (P7): výročí poslední akce a
// sezóna (vánoční večírky, letní party …). Čistá funkce: klienty načte
// domain/outbound, tady se jen rozhodne, komu a kdy signál vznikne.
// Firma s rozjednaným obchodem signál nedostane (řeší ho pipeline).
import type { OutboundAgentConfig } from './config'
import type { SignalCandidate } from './signal'

export interface CrmAccountSnapshot {
  accountId: number
  name: string
  ico: string | null
  /** Den poslední realizované / vyhrané akce (YYYY-MM-DD), null = nikdy. */
  lastEventDate: string | null
  /** Název poslední akce (deal.title) — ověřený fakt z CRM. */
  lastEventTitle: string | null
  hasOpenDeal: boolean
}

const mmdd = (day: string) => day.slice(5)

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function inSeason(today: string, from: string, to: string): boolean {
  const t = mmdd(today)
  return from <= to ? t >= from && t <= to : t >= from || t <= to
}

/** České datum „11. 12. 2025" z YYYY-MM-DD. */
export function czDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${d}. ${m}. ${y}`
}

export function crmSignals(accounts: readonly CrmAccountSnapshot[], today: string, config: OutboundAgentConfig): SignalCandidate[] {
  const out: SignalCandidate[] = []
  const year = today.slice(0, 4)
  const { anniversaryLeadDays, seasons } = config.sources.crm

  for (const a of accounts) {
    if (a.hasOpenDeal || !a.lastEventDate) continue
    const company = { ico: a.ico, name: a.name }
    const base = [
      { key: 'firma', value: a.name, sourceUrl: null },
      { key: 'posledni_akce_datum', value: czDate(a.lastEventDate), sourceUrl: null },
      ...(a.lastEventTitle ? [{ key: 'posledni_akce', value: a.lastEventTitle, sourceUrl: null }] : []),
    ]

    // Výročí: okno [výročí − leadDays, výročí), jen pro akce starší než rok.
    const anniversary = `${year}${a.lastEventDate.slice(4)}`
    const lastYear = Number(a.lastEventDate.slice(0, 4))
    if (lastYear < Number(year) && today >= addDays(anniversary, -anniversaryLeadDays) && today < anniversary) {
      out.push({
        source: 'crm', kind: 'crm_anniversary', externalRef: `anniv:${a.accountId}:${year}`,
        title: `Blíží se rok od poslední akce: ${a.name}`.slice(0, 300), url: null, signalDate: anniversary,
        company, facts: base, accountId: a.accountId,
      })
    }

    for (const s of seasons) {
      if (!inSeason(today, s.promptFrom, s.promptTo)) continue
      out.push({
        source: 'crm', kind: 'crm_season', externalRef: `season:${s.key}:${a.accountId}:${year}`,
        title: `${s.label}: ${a.name}`.slice(0, 300), url: null, signalDate: null,
        company, facts: [...base, { key: 'sezona', value: s.label, sourceUrl: null }], accountId: a.accountId,
      })
    }
  }
  return out
}

/** Šablona pro signál z CRM (výročí / sezóna); null = pro signál šablona není. */
export function templateKeyForSignal(
  s: Pick<SignalCandidate, 'kind' | 'externalRef'>,
  config: OutboundAgentConfig,
): string | null {
  if (s.kind === 'crm_anniversary') return config.sources.crm.anniversaryTemplate
  if (s.kind === 'crm_season') {
    const key = s.externalRef.split(':')[1]
    return config.sources.crm.seasons.find((x) => x.key === key)?.template ?? null
  }
  return null
}
