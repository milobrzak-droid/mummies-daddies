// GET /api/cron/web-retention — denní retence údajů z webu (GDPR, balík P6).
//
// Volá RPC web_intake_retention (migrace 0106) servisním klíčem: smaže starý
// spam a anonymizuje vyřízené poptávky a předané objednávky po uplynutí lhůt.
// Bez WEB_RETENTION_ENABLED === 'true' vrací 404 a nic nedělá.
// Autorizace: `Authorization: Bearer ${CRON_SECRET}` (Vercel cron),
// porovnání v konstantním čase. Odpověď i log nesou jen počty a kódy.
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logWarn } from '@/lib/log'
import { isCronAuthorized, runWebRetention, webRetentionEnabled } from '@/domain/web/retention'

export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!webRetentionEnabled(process.env)) return new NextResponse(null, { status: 404 })
  if (!isCronAuthorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const admin = createAdminClient()
  const res = await runWebRetention((fn) => admin.rpc(fn))
  if (!res.ok) {
    logWarn('cron.webRetention', 'rpc_failed', { code: res.code })
    return NextResponse.json({ error: 'rpc_failed', code: res.code }, { status: 500 })
  }
  return NextResponse.json(res.counts)
}
