// Oznámení provozního alarmu správci (cron /api/cron/ops-alarm, každých 5 min).
//
// Kanál: ALERT_WEBHOOK_URL — POST JSON { text, signals } na libovolný
// příjemce, který umí poslat e-mail nebo SMS správci (např. Make/Zapier
// scénář → SMS brána a e-mail, Slack/Teams incoming webhook, ntfy).
// Záměrně NE přes Gmail aplikace: alarm musí dojít i tehdy, když je
// problémem právě Gmail. Výpadek celé aplikace nebo databáze hlídá navíc
// externí uptime monitor na /api/health (docs/PROVOZ.md).
//
// Potlačení opakování: stav posledního oznámení je ve statistikách běhu
// úlohy 'ops-alarm' v job_run (fingerprint, notified). Oznamuje se, když
// se změní sada problémů, když trvá déle než OPS_ALARM_REPEAT_MINUTES
// (výchozí 180) od posledního oznámení, a jednou, když se všechno vyřeší.
//
// Odesílá se jen s OPS_ALARM_ENABLED=true (jinak route vrací 404) a jen na
// https adresu. Tělo nese jen kódy signálů a názvy úloh / front.

import type { SupabaseClient } from '@supabase/supabase-js'
import { renderAlarmText, type OpsHealth, type OpsSignal } from './opsHealth'

export const OPS_ALARM_JOB = 'ops-alarm'
export const DEFAULT_REPEAT_MINUTES = 180
const WEBHOOK_TIMEOUT_MS = 10_000

export type LastNotice = { fingerprint: string; at: string } | null

export type AlarmDecision = { send: false } | { send: true; kind: 'alarm' | 'resolved' }

export function repeatMinutesFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.OPS_ALARM_REPEAT_MINUTES)
  return Number.isInteger(n) && n >= 15 && n <= 1440 ? n : DEFAULT_REPEAT_MINUTES
}

/** Čistá funkce: má se teď oznamovat? */
export function decideAlarm(health: OpsHealth, last: LastNotice, now: Date, repeatMinutes: number): AlarmDecision {
  const lastFp = last?.fingerprint ?? ''
  if (health.signals.length === 0) {
    return lastFp ? { send: true, kind: 'resolved' } : { send: false }
  }
  if (health.fingerprint !== lastFp) return { send: true, kind: 'alarm' }
  const age = last ? now.getTime() - Date.parse(last.at) : Infinity
  return age >= repeatMinutes * 60_000 ? { send: true, kind: 'alarm' } : { send: false }
}

type Db = Pick<SupabaseClient, 'from'>

/** Poslední běh ops-alarm, který něco oznámil (nebo oznámil vyřešení). */
export async function loadLastNotice(db: Db): Promise<LastNotice> {
  const { data, error } = await db
    .from('job_run')
    .select('started_at, stats')
    .eq('job_name', OPS_ALARM_JOB)
    .eq('status', 'succeeded')
    .eq('stats->>notified', 'true')
    .order('started_at', { ascending: false })
    .limit(1)
  if (error || !data?.length) return null
  const row = data[0] as { started_at: string; stats: { fingerprint?: unknown } | null }
  return { fingerprint: typeof row.stats?.fingerprint === 'string' ? row.stats.fingerprint : '', at: row.started_at }
}

export function alarmWebhookUrl(env: Record<string, string | undefined>): string | null {
  const raw = env.ALERT_WEBHOOK_URL?.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** Odeslání na webhook. Vrací true při 2xx. Výjimku nepouští (cron musí odpovědět). */
export async function postAlarm(
  url: string,
  signals: readonly OpsSignal[],
  appUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const body = {
    text: renderAlarmText(signals, appUrl),
    signals: signals.map((s) => ({ code: s.code, subject: s.subject, since: s.since })),
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}
