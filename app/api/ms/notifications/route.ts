// POST /api/ms/notifications — webhook Microsoft Graph pro poštu (Doručená
// a Odeslaná pošta jednoho člena, OUTLOOK_MAIL_SYNC_MEMBER_ID).
//
// ZATÍM VYPNUTO. Bez OUTLOOK_MAIL_SYNC_ENABLED=true a zároveň
// OUTLOOK_MAIL_WEBHOOK_ENABLED=true vrací 404 a nedělá nic (ani validaci).
// Postup zapnutí: docs/PROVOZ.md, kapitola 3c.
//
// Veřejná cesta bez session (lib/supabase/middleware.ts ji pouští jako
// jedinou pod /api/ms). Autentizace je clientState: HMAC z CRON_SECRET,
// ověřený v konstantním čase u KAŽDÉ notifikace
// (domain/crm/mailWebhook.ts classifyNotificationRequest). Když neprojde
// žádná, odpověď je 401 a nic se nespustí.
//
// Časování podle Microsoftu: validace (?validationToken=) do 10 s jako
// text/plain; notifikace potvrdit 2xx do 3 s. Proto se tady jen ověří
// a zařadí (202) a delta sync dotčené složky běží až po odpovědi přes
// after() (domain/crm/mailWebhookRun.ts processNotificationWork), s vlastním
// rozpočtem pod maxDuration. Do odpovědi se nesahá na DB ani na Graph.
//
// Z těla notifikace se nevěří ničemu kromě id předplatného (zápis
// last_notification_at) — data do mail_event jdou vždy z Graph delta dotazu.

import { after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError, logWarn } from '@/lib/log'
import { runJob } from '@/worker'
import {
  classifyNotificationRequest,
  mailWebhookEnabledFromEnv,
  MAX_NOTIFICATION_BODY_BYTES,
  notificationResponse,
  notificationUrlFromEnv,
  type NotificationWork,
} from '@/domain/crm/mailWebhook'
import {
  processNotificationWork,
  WEBHOOK_JOB_NAME,
  WEBHOOK_JOB_TTL_SECONDS,
} from '@/domain/crm/mailWebhookRun'
import { createJobDb, createNotificationWorkDeps } from '@/domain/crm/mailSyncService'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const LOG_SCOPE = 'ms.notifications'

/** Tělo nejvýš `max` bajtů; delší (i bez Content-Length) → null. */
async function readBoundedText(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength }
  return new TextDecoder().decode(buf)
}

function schedule(work: NotificationWork, secret: string, memberId: string): void {
  after(async () => {
    try {
      const admin = createAdminClient()
      const jobDb = createJobDb(admin, LOG_SCOPE)
      const deps = createNotificationWorkDeps({
        admin,
        memberId,
        secret,
        notificationUrl: notificationUrlFromEnv(process.env),
        runLocked: (fn) => runJob(jobDb, WEBHOOK_JOB_NAME, WEBHOOK_JOB_TTL_SECONDS, fn),
        logScope: LOG_SCOPE,
      })
      const r = await processNotificationWork(work, deps)
      if (r.status === 'failed') logWarn(LOG_SCOPE, 'zpracování notifikace selhalo (viz job_run)', { attempts: r.attempts })
      if (r.status === 'skipped') logWarn(LOG_SCOPE, 'zámek drží jiný běh — notifikaci převezme on', { attempts: r.attempts })
    } catch (e) {
      logError(LOG_SCOPE, e)
    }
  })
}

export async function POST(request: Request) {
  const enabled = mailWebhookEnabledFromEnv(process.env)
  if (!enabled) return notificationResponse({ kind: 'disabled' })

  const validationToken = new URL(request.url).searchParams.get('validationToken')
  const secret = process.env.CRON_SECRET
  const memberId = process.env.OUTLOOK_MAIL_SYNC_MEMBER_ID

  let body: string | null = null
  if (validationToken === null) {
    body = await readBoundedText(request, MAX_NOTIFICATION_BODY_BYTES)
    if (body === null) return notificationResponse({ kind: 'too_large' })
  }

  const decision = classifyNotificationRequest({
    enabled,
    secret,
    memberConfigured: !!memberId,
    validationToken,
    body,
  })

  switch (decision.kind) {
    case 'accepted':
      if (decision.invalid > 0) logWarn(LOG_SCOPE, 'notifikace s neplatným clientState ignorovány', { invalid: decision.invalid })
      schedule(decision.work, secret!, memberId!)
      break
    case 'unauthorized':
      logWarn(LOG_SCOPE, 'žádná notifikace neprošla ověřením clientState', { invalid: decision.invalid })
      break
    case 'misconfigured':
      logError(LOG_SCOPE, decision.reason)
      break
    default:
      break
  }
  return notificationResponse(decision)
}
