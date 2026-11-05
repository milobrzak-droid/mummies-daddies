// Stav plánovaných úloh (job_run, migrace 0040) — denní kontrola.
//
// Co se hlídá: úloha, jejíž poslední dokončený běh selhal (a od té doby
// neuspěla), a běh, který visí jako 'running' déle, než mu dovoluje TTL
// zámku (locked_until v minulosti — funkci zabil limit a výsledek se
// nezapsal). Vidět je to na dvou místech, žádná nová externí služba:
//   - Nastavení → dlaždice „Stav úloh" (čte přihlášený člověk, RLS 0040),
//   - „Stav zdrojů" v přehledu e-mailem (domain/crm/digest.ts); problém
//     z posledních ALERT_HOURS spustí i ranní souhrn.
// Denní kontrolu jako takovou pouští cron follow-ups a přehled e-mailem
// (runJobHealthCheck): visící běhy nejdřív uzavře RPC close_stale_job_runs
// (0100), pak se stav přečte. Bez 0100 se jen čte.
//
// Čistá část (assessJobHealth, jobHealthStatus) je bez I/O kvůli testům.

import type { SupabaseClient } from '@supabase/supabase-js'
import { formatDate } from '@/lib/format'
import { logError, logWarn } from '@/lib/log'

export type JobRunRow = {
  id: number
  job_name: string
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  started_at: string
  finished_at: string | null
  locked_until: string | null
  error: string | null
}

export type JobProblem = {
  job: string
  label: string
  kind: 'failed' | 'stuck'
  /** Kdy běh začal (ISO). */
  at: string
  /** Krátká chyba (jen u failed), oříznutá na ERROR_SHOWN znaků. */
  error: string | null
}

export type JobHealth = {
  /** Okno kontroly ve dnech. */
  windowDays: number
  problems: JobProblem[]
  /** Selhání za okno celkem (i ta, po kterých úloha znovu uspěla). */
  failuresInWindow: number
  /** Kolik různých úloh v okně běželo. */
  jobsSeen: number
  /** Problém novější než ALERT_HOURS (spouští ranní souhrn). */
  recentProblem: boolean
}

export const JOB_HEALTH_WINDOW_DAYS = 7
/** Denní cron + rezerva: problém starší než tohle už ranní souhrn znovu nespouští. */
export const JOB_HEALTH_ALERT_HOURS = 26
const ERROR_SHOWN = 160

export const JOB_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'outlook-mail-sync': 'Sync pošty',
  'outlook-mail-webhook': 'Pošta z webhooku',
  'weekly-digest': 'Přehled e-mailem',
  'ares-enrich': 'Doplňování IČO z ARES',
  'idoklad-sync': 'Sync iDokladu',
  'follow-up-watch': 'Hlídač follow-upů',
  'approval-expiry': 'Vypršení schválení',
  'calendar-sync': 'Kontrola schůzek v kalendáři',
  'sharepoint-doc-sync': 'Kontrola dokumentů v SharePointu',
})

export function jobLabel(job: string): string {
  return JOB_LABELS[job] ?? job
}

const shortErr = (e: string | null) => (e && e.length > ERROR_SHOWN ? `${e.slice(0, ERROR_SHOWN - 1)}…` : e)

/** Čistá funkce: z řádků job_run (libovolné pořadí) stav úloh. */
export function assessJobHealth(rows: readonly JobRunRow[], now: Date, windowDays = JOB_HEALTH_WINDOW_DAYS): JobHealth {
  const nowMs = now.getTime()
  const from = nowMs - windowDays * 86_400_000
  const inWindow = rows
    .filter((r) => r.status !== 'skipped' && Date.parse(r.started_at) >= from)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id)

  const problems: JobProblem[] = []
  const seen = new Set<string>()
  const resolved = new Set<string>()
  for (const r of inWindow) {
    seen.add(r.job_name)
    if (r.status === 'running') {
      const until = r.locked_until ? Date.parse(r.locked_until) : NaN
      if (Number.isFinite(until) && until < nowMs) {
        problems.push({ job: r.job_name, label: jobLabel(r.job_name), kind: 'stuck', at: r.started_at, error: null })
      }
      continue
    }
    // Nejnovější dokončený běh rozhoduje: selhal = problém, uspěl = vyřešeno.
    if (resolved.has(r.job_name)) continue
    resolved.add(r.job_name)
    if (r.status === 'failed') {
      problems.push({ job: r.job_name, label: jobLabel(r.job_name), kind: 'failed', at: r.started_at, error: shortErr(r.error) })
    }
  }
  const alertFrom = nowMs - JOB_HEALTH_ALERT_HOURS * 3_600_000
  return {
    windowDays,
    problems,
    failuresInWindow: inWindow.filter((r) => r.status === 'failed').length,
    jobsSeen: seen.size,
    recentProblem: problems.some((p) => Date.parse(p.at) >= alertFrom),
  }
}

/** Jedna věta pro „Stav zdrojů" (přehled) + jestli má spustit ranní souhrn. */
export function jobHealthStatus(h: JobHealth): { line: string; alert: boolean } {
  if (h.problems.length === 0) {
    const tail = h.failuresInWindow > 0 ? ` (za ${h.windowDays} dní ${h.failuresInWindow}× selhání, poslední běhy v pořádku)` : ''
    return { line: `Plánované úlohy: v pořádku${tail}`, alert: false }
  }
  const parts = h.problems.map((p) => p.kind === 'stuck'
    ? `${p.label} visí od ${formatDate(p.at)}`
    : `${p.label} selhal ${formatDate(p.at)}${p.error ? ` (${p.error})` : ''}`)
  return { line: `Plánované úlohy: ${parts.join('; ')} — detail v Nastavení`, alert: h.recentProblem }
}

// ---------------------------------------------------------------------------
// Čtení a denní kontrola

type Db = Pick<SupabaseClient, 'from'>
const MISSING = new Set(['42P01', 'PGRST205', '42883', 'PGRST202'])
const COLUMNS = 'id, job_name, status, started_at, finished_at, locked_until, error'
const MAX_ROWS = 1000

/** Stav úloh za okno. null = job_run nejde přečíst (chybí 0040 / RLS / výpadek). */
export async function loadJobHealth(db: Db, now: Date = new Date()): Promise<JobHealth | null> {
  const from = new Date(now.getTime() - JOB_HEALTH_WINDOW_DAYS * 86_400_000).toISOString()
  const { data, error } = await db
    .from('job_run')
    .select(COLUMNS)
    .gte('started_at', from)
    .neq('status', 'skipped')
    .order('started_at', { ascending: false })
    .limit(MAX_ROWS)
  if (error) {
    if (!MISSING.has(String((error as { code?: unknown }).code))) logError('jobHealth.load', error)
    return null
  }
  return assessJobHealth((data ?? []) as JobRunRow[], now)
}

/**
 * Denní kontrola (servisní klient): visící běhy s vypršelým zámkem uzavře
 * (close_stale_job_runs, 0100) a vrátí stav. Bez 0100 jen čte. Nikdy nevyhodí.
 */
export async function runJobHealthCheck(
  db: Db & Pick<SupabaseClient, 'rpc'>,
  now: Date = new Date(),
): Promise<{ closed: number | null; health: JobHealth | null }> {
  let closed: number | null = null
  try {
    const { data, error } = await db.rpc('close_stale_job_runs', { p_grace_seconds: 300 })
    if (error) {
      if (!MISSING.has(String((error as { code?: unknown }).code))) logError('jobHealth.close', error)
    } else {
      closed = typeof data === 'number' ? data : Number(data) || 0
    }
  } catch (e) {
    logError('jobHealth.close', e)
  }
  let health: JobHealth | null = null
  try {
    health = await loadJobHealth(db, now)
  } catch (e) {
    logError('jobHealth.load', e)
  }
  if (health && health.problems.length > 0) {
    // Jen názvy úloh a druh problému (žádné texty chyb) — pro logy Vercelu.
    logWarn('jobHealth', 'plánované úlohy mají problém', {
      problems: health.problems.map((p) => `${p.job}:${p.kind}`).join(','),
    })
  }
  return { closed, health }
}
