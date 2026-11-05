// GET /api/cron/outlook-mail — sync metadat pošty jednoho člena do mail_event.
//
// ZATÍM VYPNUTO. Bez OUTLOOK_MAIL_SYNC_ENABLED === 'true' route vrací 404
// a nedělá vůbec nic. Postup zapnutí je v docs/PROVOZ.md, kapitola 3:
//   1) Migrace 0040 (job_run: try_acquire_job_lock / finish_job_run)
//      a 0041 (mail_event + calendar_token_*_for_service +
//      apply_mail_event_to_account + purge_unmatched_mail_events) aplikované.
//   2) Scope: rozhodnuto Mail.Read (28. 9. 2026, GRAPH_SCOPES v
//      connectors/graph/client.ts). Člen musí Outlook jednou znovu připojit;
//      starý token právo nemá → Graph 403 → sync zapíše chybu konektoru
//      „Chybí oprávnění Mail.Read…" a skončí (žádné opakování).
//      Ukládají se dál JEN metadata, nikdy předmět ani tělo.
//   3) Env: OUTLOOK_MAIL_SYNC_ENABLED=true, OUTLOOK_MAIL_SYNC_MEMBER_ID
//      (uuid člena — jen Viktorova schránka viktor@mummiesdaddies.com), CRON_SECRET,
//      MS_CLIENT_ID, MS_CLIENT_SECRET, klíč Supabase se service rolí.
//   4) Plán: vercel.json, denně 04:00 UTC (Hobby = nejvýš 1× denně,
//      spuštění kdykoli v rámci té hodiny).
//
// První načtení historie je omezené na posledních MAIL_SYNC_INITIAL_DAYS dní
// (výchozí 120, 0 = bez omezení; docs/PROVOZ.md). Ručně ho lze dotáhnout
// tlačítkem „Dotáhnout další část" v Nastavení → Pošta (stejné tělo, stejný
// zámek: worker/outlookMailSync.ts).
//
// Webhooky (kapitola 8, „do hodiny"): s OUTLOOK_MAIL_WEBHOOK_ENABLED=true
// běh nejdřív obnoví předplatná Graphu, která vyprší do 36 h, a založí
// chybějící (domain/crm/mailWebhookRun.ts maintainMailSubscriptions); pak
// teprve delta sync se zbytkem rozpočtu. Bez přepínače existující předplatná
// smaže (retireMailSubscriptions). Údržba webhooku sync nikdy neshodí —
// chyba se zapíše do graph_subscription a je vidět ve Stavu zdrojů.
// Postup zapnutí: docs/PROVOZ.md, kapitola 3c.
//
// Autorizace: `Authorization: Bearer ${CRON_SECRET}` (tak ho posílá Vercel
// cron), porovnání v konstantním čase. Veškerá logika je v
// domain/crm/mailSync.ts a mailWebhook*.ts; napojení na Supabase je
// v domain/crm/mailSyncService.ts, tady jen skládání.
//
// Kapitola 11: sync běží přes adaptér kontraktu konektorů
// (domain/crm/mailConnector.ts — stejný runMailSync, navíc normalizované
// události). S CAPABILITY_MAIL_TO_CASE_ENABLED === 'true' se po zápisu obou
// složek pustí schopnost „příchozí e-mail → doložený návrh pracovního
// případu" (domain/crm/mailToCase.ts) s konfigurací firmy z @/config.
// Vyžaduje migraci 0067 (case_proposal); bez ní schopnost skončí klidně
// („čeká na migraci 0067") a sync to neovlivní. Selhání schopnosti se jen
// zapíše do statistik běhu — sync je na ní nezávislý.
//
// Pošta s obsahem (docs/PROVOZ.md): s MAIL_CONTENT_INTAKE_ENABLED ===
// 'true' se před metadatovým syncem přečtou zprávy, které člověk vědomě
// přesunul do složky „Cockpit" (název MAIL_CONTENT_FOLDER), včetně těla. Z těla
// se uloží jen úryvek (≤ 300 znaků), z příloh jen názvy; výsledkem je návrh
// pracovního případu nebo fronta „Pošta k zařazení" (domain/crm/mailContentService.ts).
// Vyžaduje migraci 0091; bez ní běh skončí hláškou „čeká na migraci 0091".
// Statistiky jsou jen počty a kódy (`mailContent`). Retence obsahu
// (purge_mail_content_intake) běží při každém běhu, i s vypnutým přepínačem,
// ať se uložené úryvky smažou i po vypnutí funkce.
//
// Automatické založení poptávky (docs/PROVOZ.md): s
// CAPABILITY_AUTO_INTAKE_ENABLED === 'true' sync navíc sesbírá nespárované
// příchozí zprávy z firemních domén a domain/crm/autoIntakeService.ts u vysoké
// jistoty založí klienta, kontakt, obchod a úkol, u nižší navrhne případ
// (case_proposal). Vyžaduje migraci 0081; bez ní běh skončí hláškou „čeká na
// migraci 0081". Výsledek je v `autoIntake` (jen počty, žádná jména ani adresy).
// Když je zapnutý i ARES_ENRICH_ENABLED, novým klientům se hned zkusí doplnit
// IČO (pod zámkem úlohy ares-enrich); jinak je vezme denní dávka ARESu.

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { type JobDbAdapter } from '@/worker'
import { createDeadline } from '@/worker/deadline'
import { OUTLOOK_MAIL_ROUTE_BUDGET_MS, runOutlookMailJob, runOutlookMailJobBody } from '@/worker/outlookMailSync'
import { createJobDb } from '@/domain/crm/mailSyncService'

// Musí sedět s OUTLOOK_MAIL_MAX_DURATION_S (worker/outlookMailSync.ts); hlídá
// to test/outlook-mail-budget.test.ts. Všechny kroky sdílejí jeden deadline
// (55 s od začátku požadavku), pojistka runJob zapíše job_run do 57 s.
export const maxDuration = 60

const LOG_SCOPE = 'cron.outlookMail'

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  // Hash srovná délky, takže timingSafeEqual nevyzradí ani délku tajemství.
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const deadline = createDeadline(OUTLOOK_MAIL_ROUTE_BUDGET_MS)
  if (process.env.OUTLOOK_MAIL_SYNC_ENABLED !== 'true') {
    return new NextResponse(null, { status: 404 })
  }
  const secret = process.env.CRON_SECRET
  if (!authorized(request.headers.get('authorization'), secret) || !secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const memberId = process.env.OUTLOOK_MAIL_SYNC_MEMBER_ID
  if (!memberId) {
    return NextResponse.json({ error: 'OUTLOOK_MAIL_SYNC_MEMBER_ID chybí' }, { status: 500 })
  }

  const admin = createAdminClient()
  const jobDb: JobDbAdapter = createJobDb(admin, LOG_SCOPE)

  // Tělo úlohy je ve worker/outlookMailSync.ts (sdílí ho ruční běh z Nastavení).
  const result = await runOutlookMailJob(jobDb, () =>
    runOutlookMailJobBody({ admin, jobDb, memberId, secret, mode: 'cron', logScope: LOG_SCOPE, deadline }),
  )

  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 })
}
