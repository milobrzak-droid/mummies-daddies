// Živé závislosti příjmu formulářů webu (servisní klíč Supabase, Turnstile,
// pražský den). Odděleno od domain/web/intake.ts, aby testy nesahaly na síť.
import { pragueToday } from '@/lib/pragueDate'
import { createAdminClient } from '@/lib/supabase/admin'
import type { verifyTurnstileToken } from '@/lib/turnstile'
import type { RateLimiter } from '@/lib/rateLimit'
import type { WebIntakeDeps } from './intake'

/**
 * `verifyTurnstile` předává route (lib/turnstile.ts#verifyTurnstileToken),
 * aby ověření bylo vidět přímo v routě (test/route-auth-guard.test.ts).
 */
export function liveWebIntakeDeps(
  limiter: RateLimiter,
  verifyTurnstile: typeof verifyTurnstileToken,
  env: Record<string, string | undefined> = process.env,
): WebIntakeDeps {
  const now = new Date()
  return {
    env,
    // Klient se založí až při volání RPC: vypnutý příjem ani odmítnutý
    // požadavek na databázi nesahají.
    rpc: (fn, args) => createAdminClient().rpc(fn, args),
    verifyTurnstile: async (token, ip) => (await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip)).ok,
    today: pragueToday(now),
    now,
    limiter,
  }
}
