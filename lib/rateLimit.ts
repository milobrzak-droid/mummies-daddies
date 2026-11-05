// Jednoduchý limit požadavků v paměti instance (pevné okno na klíč).
//
// Na serverless (Vercel) má každá instance vlastní paměť, takže limit je jen
// brzda proti zahlcení z jedné adresy, ne přesné počítadlo. Tvrdé limity
// drží databáze (např. web_inquiry_submit: 5 poptávek z jedné e-mailové
// adresy za 24 hodin, migrace 0102). Klíč je IP adresa — do logu nejde.

export type RateLimiter = {
  /** true = požadavek smí projít; false = nad limitem v aktuálním okně. */
  check: (key: string, now?: number) => boolean
  reset: () => void
}

export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>()
  const maxKeys = opts.maxKeys ?? 10_000
  return {
    check(key, now = Date.now()) {
      if (hits.size > maxKeys) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
        // Pořád plno (útok z mnoha adres): radši zapomenout než růst bez konce.
        if (hits.size > maxKeys) hits.clear()
      }
      const hit = hits.get(key)
      if (!hit || hit.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + opts.windowMs })
        return true
      }
      hit.count += 1
      return hit.count <= opts.limit
    },
    reset() {
      hits.clear()
    },
  }
}
