// GET /api/cron/ops-alarm — provozní alarm do 15 minut (docs/PROVOZ.md).
//
// Každých 5 minut (vercel.json) přečte stav úloh a front
// (domain/ops/opsHealth.ts) a při novém nebo trvajícím problému pošle
// oznámení na ALERT_WEBHOOK_URL (domain/ops/opsAlarm.ts) — odtud e-mail / SMS
// správci. Hlídá neplatný OAuth token Gmailu, vyčerpaný kredit Anthropic,
// selhané a visící úlohy a stojící fronty.
//
// Bez OPS_ALARM_ENABLED === 'true' vrací 404 a nic nedělá. Autorizace:
// `Authorization: Bearer ${CRON_SECRET}` v konstantním čase (isCronAuthorized).
//
// Do job_run se zapisuje JEN běh, který něco oznámil (stats: fingerprint,
// notified, kind, počet signálů) — slouží k potlačení opakování; běh bez
// oznámení nic nezapisuje, ať tabulka neroste o 288 řádků denně.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError, logWarn } from '@/lib/log'
import { isCronAuthorized } from '@/domain/crm/digestDelivery'
import { loadOpsHealth } from '@/domain/ops/opsHealth'
import {
  OPS_ALARM_JOB,
  alarmWebhookUrl,
  decideAlarm,
  loadLastNotice,
  postAlarm,
  repeatMinutesFromEnv,
} from '@/domain/ops/opsAlarm'

export const maxDuration = 60

export async function GET(request: Request) {
  if (process.env.OPS_ALARM_ENABLED !== 'true') {
    return new NextResponse(null, { status: 404 })
  }
  if (!isCronAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const url = alarmWebhookUrl(process.env)
  if (!url) {
    logWarn('cron.opsAlarm', 'ALERT_WEBHOOK_URL chybí nebo není https — alarm nemá kam odejít')
    return NextResponse.json({ error: 'no_webhook' }, { status: 500 })
  }

  const now = new Date()
  const admin = createAdminClient()
  let health
  try {
    health = await loadOpsHealth(admin, now, process.env)
  } catch (e) {
    // Nedostupnou databázi hlásí externí uptime monitor přes /api/health;
    // tady se bez stavu nedá potlačit opakování, takže se jen loguje.
    logError('cron.opsAlarm.load', e)
    return NextResponse.json({ status: 'db_unreachable' }, { status: 503 })
  }

  const last = await loadLastNotice(admin)
  const decision = decideAlarm(health, last, now, repeatMinutesFromEnv(process.env))
  if (!decision.send) {
    return NextResponse.json({ status: health.status, signals: health.signals.length, notified: false })
  }

  const ok = await postAlarm(url, health.signals, process.env.APP_URL ?? null)
  if (!ok) {
    logError('cron.opsAlarm.post', new Error('webhook alarmu neodpověděl 2xx'))
    return NextResponse.json({ status: health.status, signals: health.signals.length, notified: false }, { status: 502 })
  }
  const { error } = await admin.from('job_run').insert({
    job_name: OPS_ALARM_JOB,
    status: 'succeeded',
    finished_at: now.toISOString(),
    stats: { notified: true, kind: decision.kind, fingerprint: health.fingerprint, signals: health.signals.length },
  })
  if (error) logError('cron.opsAlarm.record', error)
  return NextResponse.json({ status: health.status, signals: health.signals.length, notified: true, kind: decision.kind })
}
