// Společný deadline jednoho běhu úlohy. Každý krok si z něj bere rozpočet
// („kolik zbývá do konce mínus co musí zbýt dalším krokům"), takže součet
// kroků nikdy nepřeleze limit funkce (Vercel maxDuration), ani když se
// některý krok protáhne — další kroky dostanou méně, nebo se odloží.

export type Deadline = {
  /** Absolutní čas konce (ms, stejné hodiny jako `now`). */
  readonly at: number
  /** Kolik ms zbývá do konce (může být záporné). */
  remaining(): number
  /**
   * Rozpočet kroku: nejvýš `max`, a jen tolik, aby po kroku zbylo
   * `reserveAfter` ms dalším krokům. Méně než `min` = 0 (krok se nemá spouštět).
   */
  budget(opts: { max?: number; min?: number; reserveAfter?: number }): number
  /** true, když už je čas skončit (zbývá méně než `reserve` ms). */
  passed(reserve?: number): boolean
}

export function createDeadline(totalMs: number, now: () => number = Date.now): Deadline {
  const at = now() + totalMs
  const remaining = () => at - now()
  return {
    at,
    remaining,
    budget({ max = Number.POSITIVE_INFINITY, min = 0, reserveAfter = 0 }) {
      const b = Math.min(max, remaining() - reserveAfter)
      return b >= min && b > 0 ? b : 0
    },
    passed(reserve = 0) {
      return remaining() <= reserve
    },
  }
}
