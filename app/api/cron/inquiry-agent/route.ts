// GET /api/cron/inquiry-agent — agent příchozích poptávek (P2).
//
// ZATÍM VYPNUTO. Bez INQUIRY_AGENT_ENABLED === 'true' route vrací 404 a nedělá
// vůbec nic. Zapnutí (docs/NASAZENI.md, balík P8):
//   1) Migrace 0102 (web_intake) a 0103 (inquiry_agent) aplikované.
//   2) Env: INQUIRY_AGENT_ENABLED=true, CRON_SECRET, klíč Supabase se service rolí,
//      ANTHROPIC_API_KEY (čtení e-mailu modelem; web model nepotřebuje).
//      Schránky: INQUIRY_AGENT_MAILBOXES (adresy oddělené čárkou),
//      GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET a GMAIL_REFRESH_TOKENS
//      (JSON {adresa: refresh token}) — interní OAuth aplikace v Google Cloud
//      projektu firmy, rozsah gmail.readonly. Bez nich se schránky přeskočí
//      a zpracují se jen webové poptávky.
//      Vzdálenost místa akce: GEO_ENABLED=true + MAPY_API_KEY (jinak se agent
//      sám neodpoví a pošle poptávku na posouzení).
//   3) Odpovědi zákazníkům posílá jen odchozí fronta (P3, /api/cron/agent-outbox);
//      tahle úloha nikdy nic neodesílá.
//
// Autorizace: `Authorization: Bearer ${CRON_SECRET}` (tak ho posílá Vercel
// cron), porovnání v konstantním čase.
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createJobDb } from '@/domain/crm/mailSyncService'
import { inquiryAgentEnabledFromEnv } from '@/domain/crm/inquiryMailbox'
import { createDeadline } from '@/worker/deadline'
import { INQUIRY_AGENT_BUDGET_MS, runInquiryAgentJob, runInquiryAgentJobBody } from '@/worker/inquiryAgent'

// Musí sedět s INQUIRY_AGENT_MAX_DURATION_S (worker/inquiryAgent.ts).
export const maxDuration = 300

const LOG_SCOPE = 'cron.inquiryAgent'

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const deadline = createDeadline(INQUIRY_AGENT_BUDGET_MS)
  if (!inquiryAgentEnabledFromEnv(process.env)) {
    return new NextResponse(null, { status: 404 })
  }
  const secret = process.env.CRON_SECRET
  if (!secret || !authorized(request.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const result = await runInquiryAgentJob(createJobDb(admin, LOG_SCOPE), () => runInquiryAgentJobBody(admin, deadline))
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 })
}
