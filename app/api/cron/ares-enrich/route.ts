// GET /api/cron/ares-enrich — denní dávka doplňování IČO a sídla z ARESu
// a denní čtení faktur a úhrad z iDokladu.
//
// DVĚ NEZÁVISLÉ ÚLOHY v jednom existujícím denním cronu (nový cron se
// nepřidává, Vercel Hobby má omezený počet). Každá má vlastní přepínač
// a vlastní zámek; když jsou oba vypnuté, route vrací 404 a nedělá nic.
//  * ARES (ARES_ENRICH_ENABLED === 'true') — popsáno níže.
//  * iDoklad (IDOKLAD_SYNC_ENABLED === 'true', P2.3, migrace 0092, výchozí
//    vypnuto): čte vydané faktury a úhrady za posledních N dní a zapisuje
//    jen jednoznačné shody; rozdíly jdou do fronty na stránce Finance.
//    Nikdy nic nezapisuje do iDokladu. Postup: docs/PROVOZ.md. Zámek
//    runJob('idoklad-sync'); selhání jedné úlohy nezastaví druhou. Běží před
//    ARESem a jeho čas se ARESu odečte z rozpočtu (jedna funkce, maxDuration 60 s).
// Odpověď ARES je beze změny; s přepínačem iDokladu nese navíc klíč `idoklad`.
//
// ARES: ZATÍM VYPNUTO. Bez ARES_ENRICH_ENABLED === 'true' se nedělá nic. Zapnutí (docs/PROVOZ.md, tabulka proměnných):
//   1) Migrace 0040 (zámek úloh) a 0065 (account.ares_checked_at /
//      ares_status) aplikované.
//   2) Env: ARES_ENRICH_ENABLED=true, CRON_SECRET (sdílený s ostatními
//      crony), klíč Supabase se service rolí.
//   3) Plán: vercel.json, denně 04:00 UTC (Hobby = nejvýš 1× denně).
//
// Jedna dávka = nejvýš 40 klientů, 4 požadavky na ARES současně, nic nového
// nezačne po ~40 s (rozpočet 50 s, maxDuration 60). Přiřazuje JEN přesnou
// shodu jména a nikdy IČO, které už má jiný klient — viz
// domain/crm/aresEnrich.ts. Stejnou dávku může ručně pustit admin na
// /clients/doplnit-ico; zámek runJob('ares-enrich') brání překryvu.
//
// Autorizace: `Authorization: Bearer ${CRON_SECRET}` (tak ho posílá Vercel
// cron), porovnání v konstantním čase — stejně jako /api/cron/outlook-mail.

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { runJob, type JobDbAdapter, type JobResult } from '@/worker'
import { idokladSyncEnabledFromEnv } from '@/connectors/idoklad'
import { IDOKLAD_SYNC_JOB_NAME, IDOKLAD_SYNC_JOB_TTL_SECONDS } from '@/domain/finance/idoklad'
import { runIdokladLive } from '@/domain/finance/idokladLive'
import {
  ARES_ENRICH_DEFAULTS,
  ARES_ENRICH_JOB_NAME,
  ARES_ENRICH_JOB_TTL_SECONDS,
  ARES_ENRICH_SYSTEM_ACTOR,
  liveAresSource,
  runAresEnrichment,
  supabaseAresEnrichDb,
} from '@/domain/crm/aresEnrich'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  // Hash srovná délky, takže timingSafeEqual nevyzradí ani délku tajemství.
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const aresOn = process.env.ARES_ENRICH_ENABLED === 'true'
  const idokladOn = idokladSyncEnabledFromEnv(process.env)
  if (!aresOn && !idokladOn) {
    return new NextResponse(null, { status: 404 })
  }
  if (!authorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const jobDb: JobDbAdapter = {
    async tryAcquireJobLock(jobName, ttlSeconds) {
      const { data, error } = await admin.rpc('try_acquire_job_lock', { job_name: jobName, ttl_seconds: ttlSeconds })
      if (error) throw new Error(`try_acquire_job_lock: ${error.message}`)
      return (data as number | null) ?? null
    },
    async finishJobRun(runId, status, stats, error) {
      const { error: e } = await admin.rpc('finish_job_run', { run_id: runId, status, stats, error })
      if (e) logError('cron.aresEnrich.finish', e, { runId })
    },
  }

  const started = Date.now()

  // iDoklad jede PRVNÍ: je krátký (jednotky požadavků) a jeho čas se odečte
  // ARESu, aby oba dohromady vešly do maxDuration. runJob výjimku nepustí ven
  // (zapíše 'failed'); try/catch je pojistka pro chybu samotného zámku.
  let idoklad: JobResult | { status: 'error'; error: string } | undefined
  if (idokladOn) {
    try {
      idoklad = await runJob(jobDb, IDOKLAD_SYNC_JOB_NAME, IDOKLAD_SYNC_JOB_TTL_SECONDS, async () =>
        (await runIdokladLive(process.env)) as unknown as Record<string, unknown>)
    } catch (e) {
      logError('cron.idoklad', e)
      idoklad = { status: 'error', error: 'job_lock' }
    }
  }

  let ares: JobResult | { status: 'disabled' } = { status: 'disabled' }
  let lockError = false
  if (aresOn) {
    // Bez iDokladu dostane ARES celý rozpočet jako dřív; po iDokladu zbytek (nejméně 10 s).
    const options = idokladOn ? { budgetMs: Math.max(10_000, ARES_ENRICH_DEFAULTS.budgetMs - (Date.now() - started)) } : undefined
    try {
      ares = await runJob(jobDb, ARES_ENRICH_JOB_NAME, ARES_ENRICH_JOB_TTL_SECONDS, async () =>
        runAresEnrichment(supabaseAresEnrichDb(admin, ARES_ENRICH_SYSTEM_ACTOR), liveAresSource, options),
      )
    } catch (e) {
      // Sem se dostane jen selhání zámku (bez migrace 0040) — samotná dávka
      // chyby zapisuje do job_run přes runJob.
      logError('cron.aresEnrich', e)
      lockError = true
    }
  }

  if (!idokladOn) {
    // Chování před přidáním iDokladu beze změny.
    if (lockError) return NextResponse.json({ error: 'job_lock' }, { status: 503 })
    return NextResponse.json(ares, { status: ares.status === 'failed' ? 500 : 200 })
  }
  const failed = ares.status === 'failed' || idoklad?.status === 'failed' || idoklad?.status === 'error' || lockError
  return NextResponse.json({ ...(lockError ? { error: 'job_lock' } : ares), idoklad }, { status: failed ? 500 : 200 })
}
