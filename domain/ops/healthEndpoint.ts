// Brzda veřejného /api/health: limit požadavků na IP adresu a krátká cache
// výsledku kontroly.
//
// Endpoint je veřejný (uptime monitor nemá session), takže bez brzdy by každý
// požadavek z internetu spustil dotazy do databáze (job_run + fronty). Proto:
//   - limit na IP adresu stejným mechanismem jako webové formuláře
//     (lib/rateLimit.ts, pevné okno v paměti instance) — nad limitem 429
//     a do databáze se nesahá,
//   - výsledek kontroly (i „down") se drží HEALTH_CACHE_MS v paměti instance;
//     souběžné požadavky během kontroly čekají na stejný dotaz.
// Monitor volá jednou za 1–5 minut, takže ho ani limit, ani cache neomezí;
// alarm (cron ops-alarm) cache nepoužívá a čte databázi vždy.
import { createRateLimiter } from '@/lib/rateLimit'
import type { OpsHealth } from './opsHealth'

/** Jak dlouho platí výsledek kontroly (ms). */
export const HEALTH_CACHE_MS = 30_000
/** Požadavků na IP adresu za minutu (monitor potřebuje 1). */
export const HEALTH_RATE_LIMIT = 30
export const HEALTH_RATE_WINDOW_MS = 60_000

export const healthLimiter = createRateLimiter({ limit: HEALTH_RATE_LIMIT, windowMs: HEALTH_RATE_WINDOW_MS })

export type HealthResult = { ok: true; health: OpsHealth; checkedAt: Date } | { ok: false; checkedAt: Date }

let cached: { result: HealthResult; until: number } | null = null
let inflight: Promise<HealthResult> | null = null

/**
 * Výsledek kontroly z cache, nebo nová kontrola (`load`). Výjimka z `load`
 * = { ok: false } (databáze neodpovídá) a cachuje se také, ať výpadek
 * databáze nezhorší zahlcení.
 */
export async function cachedHealth(load: (now: Date) => Promise<OpsHealth>, now: Date = new Date(), onError?: (e: unknown) => void): Promise<HealthResult> {
  const t = now.getTime()
  if (cached && cached.until > t) return cached.result
  if (inflight) return inflight
  inflight = (async (): Promise<HealthResult> => {
    try {
      return { ok: true, health: await load(now), checkedAt: now }
    } catch (e) {
      onError?.(e)
      return { ok: false, checkedAt: now }
    }
  })()
  try {
    const result = await inflight
    cached = { result, until: t + HEALTH_CACHE_MS }
    return result
  } finally {
    inflight = null
  }
}

/** Jen pro testy: zapomene cache a počítadla limitu. */
export function resetHealthEndpoint(): void {
  cached = null
  inflight = null
  healthLimiter.reset()
}
