// Provozní zdraví a alarm do 15 minut (docs/PROVOZ.md, „Monitoring a alarm“).
//
// Doteď se problémy dozvídal člověk až z ranního přehledu (okno 26 h,
// domain/crm/jobHealth.ts). Pro agenta, který odpovídá zákazníkům, je to
// pozdě: neplatný OAuth token Gmailu, vyčerpaný kredit Anthropic nebo
// visící úloha musí správce vědět do 15 minut. Tenhle modul z dat, která už
// v DB jsou, sestaví seznam SIGNÁLŮ:
//   - job_failed   poslední dokončený běh úlohy selhal (job_run, 0040),
//   - job_stuck    běh visí jako 'running' po vypršení zámku,
//   - job_silent   sledovaná úloha (agent, outbox) neběžela déle než limit,
//   - gmail_oauth  chyba úlohy ukazuje na neplatný / odvolaný token Google,
//   - model_credit chyba úlohy ukazuje na vyčerpaný kredit / limit Anthropic,
//   - queue_stuck  fronta (web_inquiry, inquiry_agent_run, agent_outbox) má
//                  položky, které se nehnuly déle než limit.
// Používá ho /api/health (veřejně jen souhrn) a /api/cron/ops-alarm
// (oznámení správci přes ALERT_WEBHOOK_URL, s potlačením opakování).
//
// Signál nese jen kód, název úlohy / tabulky a čas — nikdy text e-mailu,
// jméno, adresu ani chybovou hlášku (ta může obsahovat cokoli z odpovědi
// API). Chybový text se jen KLASIFIKUJE regulárními výrazy níže.
//
// Tabulky front zakládají paralelní balíky (P2 0103, P3 0104, P6 0102);
// dokud chybí, kontrola fronty se tiše přeskočí.
//
// Konvence pro úlohy agenta a pošty (P2, P3): při selhání tokenu Google
// zapsat do job_run.error kód 'gmail_oauth', při vyčerpaném kreditu modelu
// 'model_credit' (bez dalších údajů). Klasifikace níže pozná i surové
// hlášky Google/Anthropic, ale kód je spolehlivější.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assessJobHealth, jobLabel, type JobRunRow } from '@/domain/crm/jobHealth'

export type OpsSignalCode = 'job_failed' | 'job_stuck' | 'job_silent' | 'gmail_oauth' | 'model_credit' | 'queue_stuck'

export type OpsSignal = {
  code: OpsSignalCode
  /** Název úlohy (job_name) nebo fronty (tabulka:stav). */
  subject: string
  /** Od kdy (ISO), je-li známo. */
  since: string | null
}

export type QueueProbe = {
  /** tabulka:stav, např. 'web_inquiry:new'. */
  subject: string
  table: string
  status: string
  /** Sloupec s časem, od kterého se počítá stáří položky. */
  timeColumn: string
  /** Položka starší než tolik minut = fronta stojí. */
  maxAgeMinutes: number
}

export type OpsHealth = {
  status: 'ok' | 'degraded'
  signals: OpsSignal[]
  /** Otisk aktivních signálů (pro potlačení opakovaných oznámení). */
  fingerprint: string
}

// Fronty, které se hlídají. Limity jsou volené tak, aby alarm přišel do 15–30
// minut od zaseknutí, ale aby běžný backoff (P2: pending s odkladem po
// výpadku modelu) alarm nespouštěl hned: ten se hlásí až po hodině.
export const QUEUE_PROBES: readonly QueueProbe[] = Object.freeze([
  { subject: 'web_inquiry:new', table: 'web_inquiry', status: 'new', timeColumn: 'received_at', maxAgeMinutes: 20 },
  { subject: 'web_inquiry:processing', table: 'web_inquiry', status: 'processing', timeColumn: 'updated_at', maxAgeMinutes: 15 },
  { subject: 'inquiry_agent_run:pending', table: 'inquiry_agent_run', status: 'pending', timeColumn: 'received_at', maxAgeMinutes: 60 },
  { subject: 'inquiry_agent_run:processing', table: 'inquiry_agent_run', status: 'processing', timeColumn: 'received_at', maxAgeMinutes: 30 },
  { subject: 'agent_outbox:claimed', table: 'agent_outbox', status: 'claimed', timeColumn: 'updated_at', maxAgeMinutes: 15 },
])

/**
 * Sledované úlohy a nejdelší povolené ticho (minuty). Platí jen pro úlohu,
 * která za posledních 24 h aspoň jednou běžela — vypnutá úloha (přepínač
 * *_ENABLED, route vrací 404 a job_run nezapisuje) alarm nespouští.
 * Názvy úloh dodávají balíky P2/P3; přepsat jde přes OPS_EXPECTED_JOBS
 * ("inquiry-agent:20,agent-outbox:20").
 */
export const DEFAULT_EXPECTED_JOBS: Readonly<Record<string, number>> = Object.freeze({
  'inquiry-agent': 20,
  'agent-outbox': 20,
})

export function expectedJobsFromEnv(env: Record<string, string | undefined>): Record<string, number> {
  const raw = env.OPS_EXPECTED_JOBS?.trim()
  if (!raw) return { ...DEFAULT_EXPECTED_JOBS }
  const out: Record<string, number> = {}
  for (const part of raw.split(',')) {
    const m = part.trim().match(/^([a-z0-9][a-z0-9-]{0,99}):(\d{1,4})$/)
    if (m && Number(m[2]) >= 5) out[m[1]] = Number(m[2])
  }
  return out
}

// Klasifikace chybového textu úlohy. Hláška se nikam dál nepouští.
const GMAIL_OAUTH_RE = /\bgmail_oauth\b|invalid_grant|unauthorized_client|invalid_client|token (?:has been )?(?:expired|revoked)|insufficient(?:Permissions| authentication scopes)/i
const MODEL_CREDIT_RE = /\bmodel_credit\b|credit balance is too low|insufficient[_ ]credit|billing|spend(?:ing)? limit|usage limit/i

export function classifyJobError(error: string | null): 'gmail_oauth' | 'model_credit' | null {
  if (!error) return null
  if (MODEL_CREDIT_RE.test(error)) return 'model_credit'
  if (GMAIL_OAUTH_RE.test(error)) return 'gmail_oauth'
  return null
}

const SILENCE_SEEN_HOURS = 24

/** Čistá funkce: z běhů úloh a stavu front seznam signálů. */
export function assessOps(input: {
  jobRows: readonly JobRunRow[]
  stuckQueues: readonly { subject: string; since: string | null }[]
  now: Date
  expectedJobs?: Readonly<Record<string, number>>
}): OpsHealth {
  const { jobRows, stuckQueues, now } = input
  const expected = input.expectedJobs ?? DEFAULT_EXPECTED_JOBS
  const nowMs = now.getTime()
  const signals: OpsSignal[] = []

  const health = assessJobHealth(jobRows, now)
  for (const p of health.problems) {
    if (p.kind === 'stuck') {
      signals.push({ code: 'job_stuck', subject: p.job, since: p.at })
      continue
    }
    // Plný text chyby (assessJobHealth ho zkracuje) — jen pro klasifikaci.
    const row = jobRows.find((r) => r.job_name === p.job && r.started_at === p.at && r.status === 'failed')
    const cls = classifyJobError(row?.error ?? p.error)
    signals.push({ code: cls ?? 'job_failed', subject: p.job, since: p.at })
  }

  const seenFrom = nowMs - SILENCE_SEEN_HOURS * 3_600_000
  for (const [job, maxMinutes] of Object.entries(expected)) {
    const runs = jobRows.filter((r) => r.job_name === job && r.status !== 'skipped')
    const latest = runs.reduce<number>((m, r) => Math.max(m, Date.parse(r.started_at)), -Infinity)
    if (!Number.isFinite(latest) || latest < seenFrom) continue
    if (nowMs - latest > maxMinutes * 60_000) {
      signals.push({ code: 'job_silent', subject: job, since: new Date(latest).toISOString() })
    }
  }

  for (const q of stuckQueues) signals.push({ code: 'queue_stuck', subject: q.subject, since: q.since })

  signals.sort((a, b) => a.code.localeCompare(b.code) || a.subject.localeCompare(b.subject))
  return { status: signals.length ? 'degraded' : 'ok', signals, fingerprint: fingerprintSignals(signals) }
}

/** Otisk = kódy a předměty (bez času), aby se stejný stav neohlašoval znovu. */
export function fingerprintSignals(signals: readonly OpsSignal[]): string {
  if (signals.length === 0) return ''
  const key = signals.map((s) => `${s.code}:${s.subject}`).sort().join('|')
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

const CODE_TEXT: Record<OpsSignalCode, string> = {
  job_failed: 'úloha selhala',
  job_stuck: 'úloha visí (nedoběhla)',
  job_silent: 'úloha přestala běžet',
  gmail_oauth: 'neplatný nebo odvolaný přístup ke Gmailu — znovu autorizovat schránku',
  model_credit: 'vyčerpaný kredit nebo limit Anthropic — dobít / zvýšit limit',
  queue_stuck: 'fronta stojí',
}

/** Text oznámení správci (česky, bez osobních údajů). */
export function renderAlarmText(signals: readonly OpsSignal[], appUrl: string | null): string {
  if (signals.length === 0) {
    return 'Mummies and Daddies — provoz: všechny dříve hlášené problémy jsou vyřešené.'
  }
  const lines = signals.map((s) => {
    const name = s.subject.includes(':') ? s.subject : jobLabel(s.subject)
    return `• ${CODE_TEXT[s.code]}: ${name}${s.since ? ` (od ${s.since.slice(0, 16).replace('T', ' ')} UTC)` : ''}`
  })
  const tail = appUrl ? `\nDetail: ${appUrl.replace(/\/$/, '')}/cockpit/nastaveni · postup: docs/PROVOZ.md` : '\nPostup: docs/PROVOZ.md'
  return `Mummies and Daddies — provozní alarm (${signals.length}):\n${lines.join('\n')}${tail}`
}

// ---------------------------------------------------------------------------
// Čtení z DB (servisní klient)

type Db = Pick<SupabaseClient, 'from'>
const MISSING = new Set(['42P01', 'PGRST205', '42703', 'PGRST204'])
const JOB_COLUMNS = 'id, job_name, status, started_at, finished_at, locked_until, error'

export class OpsReadError extends Error {}

/** Běhy úloh za posledních 7 dní. Chyba čtení = DB nedostupná → výjimka. */
export async function loadJobRows(db: Db, now: Date): Promise<JobRunRow[]> {
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const { data, error } = await db
    .from('job_run')
    .select(JOB_COLUMNS)
    .gte('started_at', from)
    .order('started_at', { ascending: false })
    .limit(2000)
  if (error) throw new OpsReadError(`job_run: ${String((error as { code?: unknown }).code ?? 'chyba')}`)
  return (data ?? []) as JobRunRow[]
}

/** Fronty, kde nejstarší položka v daném stavu překročila limit. */
export async function loadStuckQueues(db: Db, now: Date, probes: readonly QueueProbe[] = QUEUE_PROBES) {
  const out: { subject: string; since: string | null }[] = []
  for (const p of probes) {
    const before = new Date(now.getTime() - p.maxAgeMinutes * 60_000).toISOString()
    const { data, error } = await db
      .from(p.table)
      .select(p.timeColumn)
      .eq('status', p.status)
      .lt(p.timeColumn, before)
      .order(p.timeColumn, { ascending: true })
      .limit(1)
    if (error) {
      // Tabulka (nebo sloupec) ještě neexistuje — balík, který ji zakládá, nedorazil.
      if (MISSING.has(String((error as { code?: unknown }).code))) continue
      throw new OpsReadError(`${p.table}: ${String((error as { code?: unknown }).code ?? 'chyba')}`)
    }
    const row = ((data ?? []) as unknown[])[0] as Record<string, unknown> | undefined
    if (row) out.push({ subject: p.subject, since: typeof row[p.timeColumn] === 'string' ? (row[p.timeColumn] as string) : null })
  }
  return out
}

export async function loadOpsHealth(db: Db, now: Date, env: Record<string, string | undefined>): Promise<OpsHealth> {
  const [jobRows, stuckQueues] = await Promise.all([loadJobRows(db, now), loadStuckQueues(db, now)])
  return assessOps({ jobRows, stuckQueues, now, expectedJobs: expectedJobsFromEnv(env) })
}
