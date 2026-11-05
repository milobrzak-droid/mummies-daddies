// Zdroje signálů outbound agenta (P7) podle přepínačů v env. Každý zdroj
// je konektor za vlastním *_ENABLED (výchozí vypnuto); chyba jednoho zdroje
// se zapíše kódem a ostatní běží dál.
import type { OutboundAgentConfig } from '@/core/outbound/config'
import type { QualifyContext } from '@/core/outbound/qualify'
import { aresLookupByIco, aresSearch, pickAresMatch, type AresCompany } from '@/connectors/ares'
import { feedsEnabledFromEnv, fetchFeedSignals } from '@/connectors/feeds'
import { fetchJobSignals, jobsEnabledFromEnv } from '@/connectors/jobs'
import { fetchTenderSignals, vvzEnabledFromEnv } from '@/connectors/vvz'
import type { OutboundSources } from './run'

type Env = Record<string, string | undefined>

export function outboundAgentEnabledFromEnv(env: Env): boolean {
  return env.OUTBOUND_AGENT_ENABLED === 'true'
}

/** Samostatné odeslání (jen stávajícím zákazníkům a kontaktům se souhlasem). */
export function outboundAutosendEnabledFromEnv(env: Env): boolean {
  return env.OUTBOUND_AGENT_ENABLED === 'true' && env.OUTBOUND_AUTOSEND_ENABLED === 'true'
}

export function aresForOutboundEnabledFromEnv(env: Env): boolean {
  return env.OUTBOUND_ARES_ENABLED === 'true'
}

function toAresCtx(c: AresCompany): NonNullable<QualifyContext['ares']> {
  return { ico: c.ico, legalName: c.legalName, city: c.city, region: c.region, nace: c.nace, legalFormCode: c.legalFormCode ?? null }
}

/** ARES: podle IČO, jinak podle jména jen při jednoznačné shodě (pickAresMatch). */
export async function liveAresLookup(ico: string | null, name: string | null): Promise<QualifyContext['ares']> {
  if (ico) {
    const c = await aresLookupByIco(ico)
    return c ? toAresCtx(c) : null
  }
  if (!name) return null
  const r = await aresSearch(name, { count: 20 })
  const pick = pickAresMatch(name, r.candidates, r.total)
  return pick ? toAresCtx(pick.company) : null
}

export function liveOutboundSources(env: Env, config: OutboundAgentConfig, fetchImpl: typeof fetch = fetch): OutboundSources {
  return {
    ares: aresForOutboundEnabledFromEnv(env) ? liveAresLookup : null,
    async collect() {
      const signals: unknown[] = []
      const errors: { source: string; code: string }[] = []
      const run = async (source: string, f: () => Promise<unknown[]>) => {
        try { signals.push(...(await f())) } catch (e) { errors.push({ source, code: e instanceof Error ? e.name : 'error' }) }
      }
      if (vvzEnabledFromEnv(env)) {
        await run('vvz', () => fetchTenderSignals(env.VVZ_OPEN_DATA_URL!, config.sources.vvz, fetchImpl))
      }
      if (feedsEnabledFromEnv(env)) {
        for (const f of config.sources.feeds) await run(`feed:${f.key}`, () => fetchFeedSignals(f, config.sources.feedKeywords, fetchImpl))
      }
      if (jobsEnabledFromEnv(env)) {
        for (const j of config.sources.jobs) await run(`jobs:${j.key}`, () => fetchJobSignals(j, config.sources.jobKeywords, fetchImpl))
      }
      return { signals, errors }
    },
  }
}
