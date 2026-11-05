// Tělo úlohy „sync pošty z Outlooku" — sdílí ho denní cron
// (app/api/cron/outlook-mail/route.ts) a ruční „Dotáhnout další část"
// v Nastavení → Pošta (app/cockpit/nastaveni/actions.ts). Obojí běží pod stejným
// zámkem runJob(OUTLOOK_MAIL_JOB_NAME), takže se cron a ruční běh nepřekryjí.
//
// Režimy:
//   cron    — celý denní běh: údržba webhooku, pošta s obsahem (složka
//             „Cockpit"), metadatový sync, retence, auto-poptávky, mail→případ.
//   manual  — jen metadatový sync a to, co z nových zpráv vzniká (auto-poptávky,
//             mail→případ). Webhook a pošta s obsahem zůstávají na denním cronu:
//             ruční běh má celý rozpočet dát stránkám historie.
//
// Chování crona se refaktorem nezměnilo; jen se tělo přesunulo sem.

import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { COMPANY } from '@/config'
import { fetchMailDeltaPage } from '@/connectors/graph'
import { recordConnectorError } from '@/core/connectorState'
import { caseProposalSink } from '@/core/agents/caseProposal'
import { MAIL_TO_CASE_ID } from '@/core/agents/mailToCase'
import { runJob, shortError, type JobDbAdapter, type JobResult } from './jobRunner'
import { createDeadline, type Deadline } from './deadline'
import { DEFAULT_OPTIONS, FOLDERS, mailSyncInitialDaysFromEnv, resolveAccessToken } from '@/domain/crm/mailSync'
import { mailWebhookEnabledFromEnv, notificationUrlFromEnv } from '@/domain/crm/mailWebhook'
import { retireMailSubscriptions } from '@/domain/crm/mailWebhookRun'
import { runOutlookMailConnector, type OutlookMailRun } from '@/domain/crm/mailConnector'
import { runMailToCase, supabaseMailToCaseContext } from '@/domain/crm/mailToCase'
import { autoIntakeEnabledFromEnv } from '@/domain/crm/autoIntake'
import { runAresForNewAccounts, runAutoIntakeLive } from '@/domain/crm/autoIntakeService'
import { ARES_ENRICH_JOB_NAME, ARES_ENRICH_JOB_TTL_SECONDS } from '@/domain/crm/aresEnrich'
import { mailContentEnabledFromEnv } from '@/domain/crm/mailContent'
import { purgeMailContent, runMailContentIntakeLive } from '@/domain/crm/mailContentService'
import {
  createMailSyncDb,
  createMailTokenDeps,
  createSubscriptionGraph,
  createSubscriptionStore,
  maintainSubscriptionsSafely,
} from '@/domain/crm/mailSyncService'

export const OUTLOOK_MAIL_JOB_NAME = 'outlook-mail-sync'
export const OUTLOOK_MAIL_JOB_TTL_SECONDS = 120

// ---------------------------------------------------------------------------
// Časový plán jednoho běhu (cron i ruční „Dotáhnout další část").
//
// Všechny kroky sdílejí JEDEN deadline: OUTLOOK_MAIL_ROUTE_BUDGET_MS od začátku
// běhu. Každý krok dostane jen to, co zbývá, mínus rezervu pro kroky po něm.
// Co se nestihne, se odloží na další běh:
//   - webhook / pošta s obsahem → přeskočí se (`skipped: 'budget'`),
//   - metadatový sync → delta kurzor zůstane, další běh naváže,
//   - auto-poptávky a mail→případ → zbytek se jen spočítá (`deferred`),
//   - ARES pro nové klienty → zůstanou ve frontě denní dávky ARES.
// Pojistka nad tím: runJob s OUTLOOK_MAIL_HARD_TIMEOUT_MS zapíše job_run jako
// failed dřív, než Vercel funkci po maxDuration zabije (job_run tak nikdy
// nezůstane „running“). test/outlook-mail-budget.test.ts hlídá, že součty sedí.

/** maxDuration route /api/cron/outlook-mail a stránky Nastavení (ruční běh). */
export const OUTLOOK_MAIL_MAX_DURATION_S = 60
/** Společný deadline všech kroků. */
export const OUTLOOK_MAIL_ROUTE_BUDGET_MS = 55_000
/** Tvrdá pojistka runJob: po ní se běh zapíše jako failed (pod maxDuration). */
export const OUTLOOK_MAIL_HARD_TIMEOUT_MS = 57_000

/** Údržba předplatných (2 složky; založení čeká i na validaci endpointu). */
export const WEBHOOK_BUDGET_MAX_MS = 15_000
/** Pošta s obsahem: nejvýš tohle; pod minimem se přeskočí (jedno volání Graphu potřebuje 15 s rezervy). */
export const CONTENT_BUDGET_MAX_MS = 18_000
export const CONTENT_BUDGET_MIN_MS = 16_000
/** Metadatový sync dostane vždy aspoň tolik (kroky před ním se mu přizpůsobí). */
export const MIN_SYNC_BUDGET_MS = 20_000
/** Rezerva po syncu: retence, auto-poptávky, mail→případ (ARES jen z přebytku). */
export const AFTER_SYNC_RESERVE_MS = 8_000
/** Mail→případ: rezerva, kterou mu nechají auto-poptávky a ARES. */
export const MAIL_TO_CASE_RESERVE_MS = 3_000
/** Poslední krok končí nejpozději tolik před deadlinem (zápis job_run, odpověď). */
export const FINISH_RESERVE_MS = 1_000
/** ARES pro nové klienty: nejvýš tolik, pod minimem se odloží na denní dávku. */
export const ARES_BUDGET_MAX_MS = 10_000
export const ARES_BUDGET_MIN_MS = 7_000
export const ARES_REQUEST_TIMEOUT_MS = 5_000

export type OutlookMailJobMode = 'cron' | 'manual'

export type OutlookMailJobOptions = {
  admin: ReturnType<typeof createAdminClient>
  jobDb: JobDbAdapter
  /** Člen, jehož schránka se synchronizuje (OUTLOOK_MAIL_SYNC_MEMBER_ID). */
  memberId: string
  /** CRON_SECRET; potřebuje jen údržba webhooku v režimu cron. */
  secret?: string
  mode: OutlookMailJobMode
  logScope: string
  /** Výsledek metadatového syncu pro volající (ruční běh z něj skládá větu). */
  onSyncStats?: (stats: OutlookMailRun['stats']) => void
  /** Deadline celého běhu; bez něj OUTLOOK_MAIL_ROUTE_BUDGET_MS od začátku těla. */
  deadline?: Deadline
}

/** Tělo úlohy: vrací statistiky pro job_run.stats. Výjimka = běh 'failed'. */
export async function runOutlookMailJobBody(o: OutlookMailJobOptions): Promise<Record<string, unknown>> {
  const { admin, jobDb, memberId, mode, logScope } = o
  const deadline = o.deadline ?? createDeadline(OUTLOOK_MAIL_ROUTE_BUDGET_MS)
  /** Co se kvůli deadlinu odložilo na další běh (jen názvy kroků). */
  const deferred: string[] = []
  let accessToken: string
  try {
    accessToken = await resolveAccessToken(createMailTokenDeps(admin, memberId, logScope))
  } catch (e) {
    // Bez tokenu se sync nepustí. Chybu zapíšeme i do stavu konektorů, ať
    // je v Nastavení vidět (ne jen v job_run), a běh skončí jako failed.
    // Další pokus je až zítra (denní cron), takže se nic necyklí.
    const msg = e instanceof Error ? e.message : String(e)
    for (const f of Object.values(FOLDERS)) await recordConnectorError(f.connector, msg)
    throw e
  }

  // Webhook před syncem: obnova předplatného je levná a když by ji sync
  // vyčerpáním rozpočtu přeskočil, notifikace by do týdne utichly.
  let webhook: Record<string, unknown> | undefined
  if (mode === 'cron') {
    const store = createSubscriptionStore(admin, logScope)
    const graph = createSubscriptionGraph(accessToken)
    if (mailWebhookEnabledFromEnv(process.env)) {
      const budgetMs = deadline.budget({ max: WEBHOOK_BUDGET_MAX_MS, reserveAfter: MIN_SYNC_BUDGET_MS + AFTER_SYNC_RESERVE_MS })
      if (budgetMs === 0) {
        webhook = { skipped: 'budget' }
        deferred.push('webhook')
      } else {
        webhook = await maintainSubscriptionsSafely({
          store,
          graph,
          secret: o.secret ?? '',
          notificationUrl: notificationUrlFromEnv(process.env),
          budgetMs,
          logScope,
        })
      }
    } else {
      try {
        webhook = { disabled: true, ...(await retireMailSubscriptions({ graph, store })) }
      } catch (e) {
        logError(`${logScope}.webhookRetire`, e)
        webhook = { disabled: true, error: e instanceof Error ? e.message : String(e) }
      }
    }
  }

  // Pošta s obsahem (jen vybraná složka) před metadatovým syncem: je malá a
  // člověk na její výsledek čeká; sync dostane vždy aspoň MIN_SYNC_BUDGET_MS.
  let mailContent: Record<string, unknown> | undefined
  if (mode === 'cron' && mailContentEnabledFromEnv(process.env)) {
    const budgetMs = deadline.budget({
      max: CONTENT_BUDGET_MAX_MS,
      min: CONTENT_BUDGET_MIN_MS,
      reserveAfter: MIN_SYNC_BUDGET_MS + AFTER_SYNC_RESERVE_MS,
    })
    if (budgetMs === 0) {
      mailContent = { skipped: 'budget' }
      deferred.push('mailContent')
    } else {
      try {
        mailContent = { ...(await runMailContentIntakeLive({ accessToken, ownerId: memberId, budgetMs })) }
      } catch (e) {
        // Nad syncem, ne uvnitř něj: selhání se jen zapíše do statistik a logu.
        logError('cron.outlookMail.mailContent', e instanceof Error ? e.name : 'chyba')
        mailContent = { error: shortError(e) }
      }
    }
  }

  const autoIntakeOn = autoIntakeEnabledFromEnv(process.env) && !!COMPANY.capabilities.autoIntake
  // Sync dostane zbytek do deadlinu mínus rezervu na kroky po něm. Když zbyde
  // méně než na jedno volání Graphu, runMailSync složky nezačne (kurzor
  // zůstává, další běh naváže) — to je odložení, ne chyba.
  const syncBudgetMs = Math.max(0, Math.min(DEFAULT_OPTIONS.budgetMs, deadline.remaining() - AFTER_SYNC_RESERVE_MS))
  const { stats, results, intake } = await runOutlookMailConnector(
    {
      fetchPage: (url) => fetchMailDeltaPage(accessToken, url),
      db: createMailSyncDb(admin, logScope),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: Date.now,
    },
    {
      budgetMs: syncBudgetMs,
      collectIntake: autoIntakeOn,
      initialDays: mailSyncInitialDaysFromEnv(process.env),
      // Ruční běh je kvůli historii, ne kvůli retenci: purge dělá denní cron.
      ...(mode === 'manual' ? { purge: false } : {}),
    },
  )
  o.onSyncStats?.(stats)
  const out: Record<string, unknown> = { ...(stats as unknown as Record<string, unknown>) }
  if (webhook) out.webhook = webhook
  if (mode === 'manual') out.manual = true
  if (mailContent) out.mailContent = mailContent
  if (mode === 'cron') {
    // Retence uložených úryvků a předmětů (0091); bez migrace null a nic se nezapíše.
    // Jedno RPC; když už není čas, počká na zítřek (retence je ve dnech).
    if (deadline.passed(MAIL_TO_CASE_RESERVE_MS + FINISH_RESERVE_MS)) {
      deferred.push('mailContentPurge')
    } else {
      try {
        const purged = await purgeMailContent(admin)
        if (purged) out.mailContentPurge = purged
      } catch (e) {
        logError('cron.outlookMail.mailContentPurge', e instanceof Error ? e.name : 'chyba')
      }
    }
  }
  if (autoIntakeOn) {
    // Nad syncem, ne uvnitř něj: selhání se jen zapíše do statistik.
    try {
      const result = await runAutoIntakeLive({
        candidates: intake,
        ownerId: memberId,
        shouldStop: () => deadline.passed(MAIL_TO_CASE_RESERVE_MS + FINISH_RESERVE_MS),
      })
      out.autoIntake = result
      if (result.deferred) deferred.push('autoIntake')
      if (result.createdAccountIds.length > 0 && process.env.ARES_ENRICH_ENABLED === 'true') {
        const budgetMs = deadline.budget({
          max: ARES_BUDGET_MAX_MS,
          min: ARES_BUDGET_MIN_MS,
          reserveAfter: MAIL_TO_CASE_RESERVE_MS + FINISH_RESERVE_MS,
        })
        if (budgetMs === 0) {
          // Klienti bez IČO zůstávají ve frontě denní dávky ARES (cron ares-enrich).
          out.autoIntakeAres = { skipped: 'budget', deferred: result.createdAccountIds.length }
          deferred.push('autoIntakeAres')
        } else {
          out.autoIntakeAres = await runJob(jobDb, ARES_ENRICH_JOB_NAME, ARES_ENRICH_JOB_TTL_SECONDS, async () => ({
            ...(await runAresForNewAccounts(result.createdAccountIds, { budgetMs, requestTimeoutMs: ARES_REQUEST_TIMEOUT_MS })),
          }))
        }
      }
    } catch (e) {
      logError('cron.outlookMail.autoIntake', e)
      out.autoIntake = { capability: 'auto_intake', error: shortError(e) }
    }
  }
  if (process.env.CAPABILITY_MAIL_TO_CASE_ENABLED === 'true') {
    try {
      const result = await runMailToCase({
        tenant: COMPANY,
        events: [...results.inbox.events, ...results.sent.events],
        context: supabaseMailToCaseContext(admin),
        sink: caseProposalSink(admin, { createdBy: `system:${MAIL_TO_CASE_ID}` }),
        now: new Date(),
        shouldStop: () => deadline.passed(FINISH_RESERVE_MS),
      })
      out.capability = result
      if ('deferred' in result && result.deferred) deferred.push('mailToCase')
    } catch (e) {
      // Schopnost nad syncem nesmí shodit sync: jen do statistik a logu.
      logError('cron.outlookMail.capability', e)
      out.capability = { capability: MAIL_TO_CASE_ID, error: shortError(e) }
    }
  }
  if (deferred.length > 0) out.deferred = deferred
  return out
}

/** Spuštění těla pod zámkem s tvrdou pojistkou (cron i ruční běh). */
export function runOutlookMailJob(
  jobDb: JobDbAdapter,
  body: () => Promise<Record<string, unknown>>,
): Promise<JobResult> {
  return runJob(jobDb, OUTLOOK_MAIL_JOB_NAME, OUTLOOK_MAIL_JOB_TTL_SECONDS, body, {
    timeoutMs: OUTLOOK_MAIL_HARD_TIMEOUT_MS,
  })
}
