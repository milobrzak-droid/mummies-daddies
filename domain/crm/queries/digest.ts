import { getLastSkillMeetingNoteAt } from '@/domain/crm/queries/meetingNotes'
import { getMeetingIntakeStats } from '@/domain/crm/queries/meetingIntake'
import { createClient } from '@/lib/supabase/server'
import { buildDigest, outlookMailSyncEnabledFromEnv, type BlockedDeal, type Digest, type DigestFollowUp } from '@/domain/crm/digest'
import { getDueFollowUps } from '@/domain/crm/queries/followUps'
import { getOutreachQueue } from '@/domain/crm/queries/outreach'
import { getConnectorState } from '@/core/connectorState'
import { GRAPH_SEND_CONNECTOR } from '@/domain/crm/digestDelivery'
import type { DigestEmailSource } from '@/domain/crm/digestEmail'
import { loadMailWebhookHealth } from '@/domain/crm/mailSyncService'
import { loadJobHealth } from '@/domain/crm/jobHealth'
import { loadOAuthHealth } from '@/lib/oauthOverview'

// followUps a outreach mají už hotovou dotazovací funkci jinde (getDueFollowUps,
// getOutreachQueue) — stačí je zavolat. Blokované obchody takovou funkci
// nemají: existující místo, kde se `status_blocker` čte (dashboard přes
// getAllProjects), natahuje *všechny* sloupce každého dealu jen kvůli jedné
// vlajce. Pro digest stačí čtyři sloupce + jméno klienta, tak je to samostatný
// malý dotaz místo přitažení celého getAllProjects jen pro tenhle výpis.
export async function getBlockedDeals(): Promise<BlockedDeal[]> {
  const s = await createClient()
  const { data, error } = await s.from('deal')
    .select('id, account_id, title, status_blocker, account:account!deal_account_id_fkey(name)')
    .not('status_blocker', 'is', null)
    .order('title')
  if (error) throw new Error(`Načtení blokovaných obchodů selhalo: ${error.message}`)

  // PostgREST embed rozbíjí odvození typu (stejný důvod jako v
  // domain/crm/queries/followUps.ts), proto ruční tvar řádku.
  type Row = { id: number; account_id: number | null; title: string; status_blocker: string | null; account: { name?: string } | null }
  return ((data ?? []) as unknown as Row[])
    .filter((d): d is Row & { status_blocker: string } => d.status_blocker != null)
    .map((d) => ({
      id: d.id,
      account_id: d.account_id,
      title: d.title,
      account_name: d.account?.name ?? null,
      status_blocker: d.status_blocker,
    }))
}

// getDueFollowUps (domain/crm/queries/followUps.ts) account_id nenese; dotáhne
// se tady jedním dotazem podle deal_id, aby e-mail mohl odkazovat na detail
// obchodu pod klientem.
async function withAccountIds<T extends { deal_id: number }>(items: T[]): Promise<(T & { account_id: number | null })[]> {
  if (items.length === 0) return []
  const s = await createClient()
  const { data, error } = await s.from('deal').select('id, account_id')
    .in('id', Array.from(new Set(items.map((n) => n.deal_id))))
  if (error) throw new Error(`Načtení klientů k follow-upům selhalo: ${error.message}`)
  const byId = new Map(((data ?? []) as { id: number; account_id: number | null }[]).map((d) => [d.id, d.account_id]))
  return items.map((n) => ({ ...n, account_id: byId.get(n.deal_id) ?? null }))
}

export async function getDigestFollowUps(): Promise<DigestFollowUp[]> {
  return withAccountIds(await getDueFollowUps())
}

// Skládá DigestInput z reálných dat a rovnou zavolá už otestovanou čistou
// buildDigest — žádná další logika tu není, jen sběr zdrojů + časová
// značka "teď". Stav Outlooku (graph_calendar) se čte stejnou getConnectorState jako
// stránka Nastavení; zápisy schůzek (Wispr Flow přes skill) z posledního
// meeting záznamu se source 'api' (domain/crm/queries/meetingNotes.ts).
export async function getTodaysDigest(): Promise<Digest> {
  return (await getTodaysDigestWithSource()).digest
}

/**
 * Jako getTodaysDigest, ale i se zdrojovými seznamy (follow-upy, firmy
 * k oslovení, blokované obchody s id) — provozní přehled z nich skládá
 * položky s odkazy na záznam (stejný tvar jako loadDigestAsService pro cron).
 */
export async function getTodaysDigestWithSource(): Promise<{ digest: Digest; source: DigestEmailSource }> {
  const [followUps, outreach, blockedDeals, lastSkillNoteAt, graphCalendar, outlookMailInbox, outlookMailSent, graphSend, mailWebhook, intake, jobHealth, oauthHealth] =
    await Promise.all([
      getDigestFollowUps(),
      getOutreachQueue(),
      getBlockedDeals(),
      getLastSkillMeetingNoteAt(),
      getConnectorState('graph_calendar'),
      getConnectorState('outlook:inbox'),
      getConnectorState('outlook:sent'),
      getConnectorState(GRAPH_SEND_CONNECTOR),
      // Webhook pošty (graph_subscription, jen service role — jako connector_state).
      loadMailWebhookHealth(),
      // Příjem diktátu (0078): bez migrace null, chyba čtení řádek zdroje nerozbije.
      getMeetingIntakeStats().catch(() => null),
      // Stav plánovaných úloh (job_run čte tým s AAL2); chyba = řádek chybí.
      createClient().then((s) => loadJobHealth(s)).catch(() => null),
      // Konektor Claude (audit_event čte tým s AAL2); chyba = řádek chybí.
      createClient().then((s) => loadOAuthHealth(s)).catch(() => null),
    ])
  const digest = buildDigest({
    followUps,
    outreach,
    blockedDeals,
    connectorStates: { graphCalendar, outlookMailInbox, outlookMailSent, graphSend },
    lastMeetingNoteAt: latestOf(lastSkillNoteAt, intake?.lastReceivedAt ?? null),
    meetingIntake: intake ? { received30d: intake.received30d, unmatched: intake.unmatched } : null,
    outlookMailSyncEnabled: outlookMailSyncEnabledFromEnv(process.env),
    mailWebhook,
    jobHealth,
    oauthHealth,
    generatedAt: new Date(),
  })
  return { digest, source: { followUps, outreach, blockedDeals } }
}

/** Pozdější ze dvou časů (ISO); null, když nejsou žádné. */
export function latestOf(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}
