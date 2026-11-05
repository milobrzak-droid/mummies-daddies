// GET /api/health — stav aplikace pro externí uptime monitor (docs/PROVOZ.md).
//
// Záměrně veřejné (monitor nemá session ani klíč) a proto bez citlivých dat:
// veřejná odpověď je jen { status, checkedAt }. Seznam signálů (kódy a názvy
// úloh / front, nikdy data) vrátí jen s hlavičkou
// `Authorization: Bearer ${HEALTH_TOKEN}` (porovnání v konstantním čase).
//
//   status 'ok'        databáze odpovídá, žádný provozní problém     → 200
//   status 'degraded'  databáze odpovídá, ale je aktivní signál      → 200, s ?strict=1 → 503
//   status 'down'      databáze neodpovídá / chybí konfigurace       → 503
//
// Monitor (Better Stack, UptimeRobot…) hlídá /api/health?strict=1 každé
// 1–5 minut a při 503 pošle e-mail / SMS správci. Nezávisí na Vercel Cronu
// ani na ALERT_WEBHOOK_URL, takže pokryje i výpadek celé aplikace.
// GET handlery se v Next.js 16 necachují (route.md: výchozí dynamické).

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { isCronAuthorized } from '@/domain/crm/digestDelivery'
import { loadOpsHealth } from '@/domain/ops/opsHealth'

const NO_STORE = { 'cache-control': 'no-store' }

export async function GET(request: Request) {
  const checkedAt = new Date()
  const strict = new URL(request.url).searchParams.get('strict') === '1'
  const detailed = isCronAuthorized(request.headers.get('authorization'), process.env.HEALTH_TOKEN)

  let health
  try {
    health = await loadOpsHealth(createAdminClient(), checkedAt, process.env)
  } catch (e) {
    logError('api.health', e)
    return NextResponse.json({ status: 'down', checkedAt: checkedAt.toISOString() }, { status: 503, headers: NO_STORE })
  }
  const body: Record<string, unknown> = { status: health.status, checkedAt: checkedAt.toISOString() }
  if (detailed) body.signals = health.signals
  const status = strict && health.status !== 'ok' ? 503 : 200
  return NextResponse.json(body, { status, headers: NO_STORE })
}
