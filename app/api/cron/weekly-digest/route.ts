// GET /api/cron/weekly-digest — přehled e-mailem přes Microsoft Graph.
// Cron běží DENNĚ (vercel.json "0 5 * * *"): pondělí a pátek = přehled týdne
// (vždy) s provozním přehledem firmy (domain/crm/opsReport.ts: obchody,
// dodávky podle milníků, čeká na nás / na klienta, Ke schválení, riziko
// termínů a kapacity, neověřené položky, Stav zdrojů), ostatní dny = krátký
// ranní souhrn, jen když je co hlásit (follow-up po termínu, blokovaný
// obchod, zastaralý / rozbitý zdroj). Logika je v
// domain/crm/digestDelivery.ts; tady je jen napojení na Graph a Supabase.
//
// ZATÍM VYPNUTO. Bez DIGEST_SEND_ENABLED === 'true' route vrací 404 a nedělá
// vůbec nic.
//
// Odesílatel (DIGEST_SEND_MODE, rozhodnutí vlastníka 28. 9. 2026):
//  - delegated (výchozí): z Viktorovy schránky přes jeho delegovaný token
//    (calendar_token_*_for_service z migrace 0041, POST /me/sendMail).
//    Token musí mít Mail.Send — Viktor jednou znovu připojí Outlook v
//    Nastavení. Obnovený token se musí uložit, jinak se neposílá nic.
//  - app (volitelně): servisní schránka cockpit@ s app-only tokenem
//    (Entra registrace + Exchange RBAC, postup v hlavičce digestDelivery.ts).
//
// Autorizace: `Authorization: Bearer ${CRON_SECRET}` (tak ho posílá Vercel
// cron), porovnání v konstantním čase.
//
// Idempotence: běh drží zámek runJob 'weekly-digest' (migrace 0040), takže
// dvě souběžná doručení cronu se nepřekryjí. „Jednou denně" drží trvalý
// marker digest_send_log (migrace 0053): INSERT … ON CONFLICT DO NOTHING
// PŘED odesláním — když řádek pro (pražský den, druh) už byl, nic se
// nepošle; při selhání odeslání se marker smaže a další běh to zkusí znovu.
// Bez migrace 0040 (RPC chybí) se neposílá nic a route vrací 503; bez 0053
// běh selže s chybou „chybí migrace 0053" (fail closed); bez 0041 (jen
// delegated) selže s chybou „chybí migrace 0041".
//
// Příjemci: jen @mummiesdaddies.com (config) a jen členové týmu s obchodní rolí
// (team_member, při odeslání). Loguje se jen počet vyřazených, nikdy adresy.
//
// Tajemství (access/refresh token, MS_APP_CLIENT_SECRET, CRON_SECRET) se
// nikdy nelogují ani nevrací; chyby z konektoru nesou jen HTTP status + kód.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError, logWarn } from '@/lib/log'
import { getAppOnlyToken, refreshAccessToken, sendMailAsMe, sendMailAsUser } from '@/connectors/graph'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { runJob, type JobDbAdapter } from '@/worker'
import {
  DIGEST_JOB_NAME,
  GRAPH_SEND_CONNECTOR,
  deliverDigest,
  explainDelegatedSendResult,
  getDelegatedSendToken,
  isCronAuthorized,
  filterTeamRecipientsAsService,
  loadDigestAsService,
  readDigestDeliveryConfig,
  type DigestDeliveryConfig,
  type DigestDeliveryDeps,
} from '@/domain/crm/digestDelivery'
import type { StoredToken } from '@/domain/crm/mailSync'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

const JOB_TTL_SECONDS = 300

// PostgREST: funkce/tabulka ve schema cache není (PGRST202/PGRST205),
// Postgres: undefined_function / undefined_table.
const MISSING_CODES = new Set(['PGRST202', 'PGRST205', '42883', '42P01'])

class JobRunMissingError extends Error {}

const SEND_LOG_TABLE = 'digest_send_log'

function sendLogError(op: string, error: { code?: unknown; message: string }): Error {
  if (MISSING_CODES.has(String(error.code))) {
    return new Error('Chybí migrace 0053 (digest_send_log) — přehled se neposlal, bez markeru nejde zaručit jedno odeslání denně.')
  }
  return new Error(`${SEND_LOG_TABLE} ${op}: ${error.message}`)
}

type Admin = ReturnType<typeof createAdminClient>
type Transport = Pick<DigestDeliveryDeps, 'getToken' | 'sendMail'>

// Chyba tokenového RPC do connector_state / job_run: jen jméno funkce a kód,
// nikdy text odpovědi (zbytečné riziko, že ponese data). Plná chyba jde jen
// do serverového logu.
function tokenRpcError(fn: string, error: { code?: unknown; message: string }): Error {
  logError(`cron.weeklyDigest.${fn}`, error)
  if (MISSING_CODES.has(String(error.code))) {
    return new Error(`Chybí migrace 0041 (${fn}) — přehled se neposlal.`)
  }
  const code = typeof error.code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(error.code) ? error.code : 'neznámý'
  return new Error(`${fn} selhalo (kód ${code}) — přehled se neposlal.`)
}

/** Delegovaně: token člena přes service-only RPC z 0041, odeslání přes /me/sendMail. */
function delegatedTransport(admin: Admin, memberId: string): Transport {
  return {
    getToken: () => getDelegatedSendToken({
      async load() {
        const { data, error } = await admin.rpc('calendar_token_get_for_service', { p_member_id: memberId })
        if (error) throw tokenRpcError('calendar_token_get_for_service', error)
        return ((data as StoredToken[] | null)?.[0] ?? null)
      },
      refresh: refreshAccessToken,
      async save(t) {
        const { error } = await admin.rpc('calendar_token_update_for_service', {
          p_member_id: memberId,
          p_access_token: t.access_token,
          p_refresh_token: t.refresh_token,
          p_expires_at: t.expires_at,
        })
        if (error) {
          tokenRpcError('calendar_token_update_for_service', error)
          return false
        }
        return true
      },
      now: Date.now,
    }),
    sendMail: async (token, mail) => explainDelegatedSendResult(await sendMailAsMe(token, mail)),
  }
}

function transportFor(admin: Admin, config: DigestDeliveryConfig): Transport {
  if (config.mode === 'delegated') return delegatedTransport(admin, config.senderMemberId)
  return {
    getToken: () => getAppOnlyToken(config.credentials),
    sendMail: (token, mail) => sendMailAsUser(token, config.sender, mail),
  }
}

export async function GET(request: Request) {
  if (process.env.DIGEST_SEND_ENABLED !== 'true') {
    return new NextResponse(null, { status: 404 })
  }
  if (!isCronAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const cfg = readDigestDeliveryConfig(process.env)
  if (!cfg.ok) {
    logError('cron.weeklyDigest.config', 'neplatná konfigurace', { errors: cfg.errors })
    return NextResponse.json({ error: 'config', details: cfg.errors }, { status: 500 })
  }
  const config = cfg.config

  const admin = createAdminClient()

  const jobDb: JobDbAdapter = {
    async tryAcquireJobLock(jobName, ttlSeconds) {
      const { data, error } = await admin.rpc('try_acquire_job_lock', { job_name: jobName, ttl_seconds: ttlSeconds })
      if (error) {
        if (MISSING_CODES.has(String(error.code))) throw new JobRunMissingError('try_acquire_job_lock chybí')
        throw new Error(`try_acquire_job_lock: ${error.message}`)
      }
      return (data as number | null) ?? null
    },
    async finishJobRun(runId, status, stats, error) {
      const { error: e } = await admin.rpc('finish_job_run', { run_id: runId, status, stats, error })
      if (e) logError('cron.weeklyDigest.finish', e, { runId })
    },
  }

  let result
  try {
    result = await runJob(jobDb, DIGEST_JOB_NAME, JOB_TTL_SECONDS, async () => {
      const stats = await deliverDigest(config, {
        now: () => new Date(),
        async claimSendMarker(day, kind) {
          // Atomicky: vloží se jen, když (den, druh) ještě není; vrácený řádek
          // = zabral tenhle běh. Chyba = fail closed (neposílat).
          const { data, error } = await admin.from(SEND_LOG_TABLE)
            .upsert({ prague_day: day, kind, sent_at: new Date().toISOString() }, { onConflict: 'prague_day,kind', ignoreDuplicates: true })
            .select('prague_day')
          if (error) throw sendLogError('insert', error)
          return (data ?? []).length > 0
        },
        async releaseSendMarker(day, kind) {
          const { error } = await admin.from(SEND_LOG_TABLE).delete().eq('prague_day', day).eq('kind', kind)
          if (error) {
            const e = sendLogError('delete', error)
            logError('cron.weeklyDigest.releaseMarker', e)
            throw e
          }
        },
        filterTeamRecipients: filterTeamRecipientsAsService,
        loadDigest: loadDigestAsService,
        ...transportFor(admin, config),
        recordSuccess: () => recordConnectorSuccess(GRAPH_SEND_CONNECTOR, null),
        recordError: (message) => recordConnectorError(GRAPH_SEND_CONNECTOR, message),
      })
      if (stats.dropped_recipients) {
        // Jen počet — adresy do logu nepatří.
        logWarn('cron.weeklyDigest.recipients', 'příjemci mimo team_member vyřazeni', { dropped: stats.dropped_recipients })
      }
      return stats as unknown as Record<string, unknown>
    })
  } catch (err) {
    if (err instanceof JobRunMissingError) {
      logError('cron.weeklyDigest.lock', err)
      return NextResponse.json(
        { status: 'skipped', error: 'Chybí migrace 0040 (try_acquire_job_lock) — přehled se neposlal, bez zámku nejde zaručit jedno odeslání denně.' },
        { status: 503 },
      )
    }
    logError('cron.weeklyDigest.lock', err)
    return NextResponse.json({ status: 'skipped', error: 'Zámek úlohy nejde získat — přehled se neposlal.' }, { status: 503 })
  }

  if (result.status === 'failed') logError('cron.weeklyDigest', result.error, { runId: result.runId })
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 })
}
