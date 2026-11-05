// runJob — obal plánované úlohy: zámek proti překryvu, záznam výsledku.
//
// Vercel cron doručuje best-effort (vypadne, přijde dvakrát, překryje se).
// Proto každý běh nejdřív požádá DB o zámek s TTL (try_acquire_job_lock,
// migrace 0040). Když ho nedostane, úloha se neprovede a výsledek je
// 'skipped'. Když úloha spadne, zapíše se 'failed' s krátkou chybou a výjimka
// se NEPROPAGUJE dál — cron handler má vždy odpovědět a stav je v job_run.
//
// DB je vstříknutý adaptér, takže logika je čistě testovatelná bez Supabase.

export type JobStats = Record<string, unknown>

export interface JobDbAdapter {
  /** Vrátí id běhu, nebo null, když zámek drží jiný běh. */
  tryAcquireJobLock(jobName: string, ttlSeconds: number): Promise<number | null>
  finishJobRun(
    runId: number,
    status: 'succeeded' | 'failed',
    stats: JobStats,
    error: string | null,
  ): Promise<void>
}

export type JobResult =
  | { status: 'skipped' }
  | { status: 'succeeded'; runId: number; stats: JobStats }
  | { status: 'failed'; runId: number; error: string }

/** Stejný limit jako CHECK v 0040 — žádné stack trace do DB. */
export const MAX_ERROR_LENGTH = 500

export function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.length > MAX_ERROR_LENGTH ? msg.slice(0, MAX_ERROR_LENGTH) : msg
}

export type RunJobOptions = {
  /**
   * Tvrdá pojistka: když tělo do té doby neskončí, běh se zapíše jako
   * 'failed' s chybou `timeoutError` a runJob se vrátí (tělo se nečeká).
   * Smysl: Vercel funkci po maxDuration zabije bez `finally` a job_run by
   * zůstal 'running' až do vypršení TTL. Tělo má mít vlastní (měkký) deadline
   * dřív; tohle je jen záchranná síť, nastavuje se kousek pod maxDuration.
   */
  timeoutMs?: number
  timeoutError?: string
}

export const JOB_TIMEOUT_ERROR = 'Běh nestihl časový limit; nedokončená část proběhne při dalším běhu.'

class JobTimeoutError extends Error {}

/**
 * Uzavření běhu nesmí selhat potichu: když finish_job_run neprojde (výpadek
 * DB, statistiky, které se nedají uložit), zkusí se ještě jednou s prázdnými
 * statistikami. Výjimka z adaptéru se nikdy nepropaguje — cron musí
 * odpovědět; zbytek pohlídá TTL zámku a denní kontrola úloh (jobHealth).
 */
async function finishSafely(
  db: JobDbAdapter,
  runId: number,
  status: 'succeeded' | 'failed',
  stats: JobStats,
  error: string | null,
): Promise<void> {
  try {
    await db.finishJobRun(runId, status, stats, error)
    return
  } catch {
    // druhý pokus níž
  }
  try {
    await db.finishJobRun(runId, status, { finishRetried: true }, error)
  } catch {
    // Nechat být: zámek vyprší s TTL a kontrola úloh běh ukáže jako visící.
  }
}

export async function runJob(
  db: JobDbAdapter,
  name: string,
  ttlSeconds: number,
  fn: () => Promise<JobStats | void>,
  opts: RunJobOptions = {},
): Promise<JobResult> {
  const runId = await db.tryAcquireJobLock(name, ttlSeconds)
  if (runId === null) return { status: 'skipped' }

  let timer: ReturnType<typeof setTimeout> | undefined
  let stats: JobStats
  try {
    const body = fn()
    if (opts.timeoutMs !== undefined) {
      // Pozdní výjimka těla po vypršení pojistky nesmí být „unhandled".
      body.catch(() => undefined)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobTimeoutError(opts.timeoutError ?? JOB_TIMEOUT_ERROR)), opts.timeoutMs)
      })
      stats = (await Promise.race([body, timeout])) ?? {}
    } else {
      stats = (await body) ?? {}
    }
  } catch (err) {
    const error = shortError(err)
    await finishSafely(db, runId, 'failed', {}, error)
    return { status: 'failed', runId, error }
  } finally {
    if (timer) clearTimeout(timer)
  }
  await finishSafely(db, runId, 'succeeded', stats, null)
  return { status: 'succeeded', runId, stats }
}
