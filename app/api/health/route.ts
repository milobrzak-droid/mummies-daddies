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
//
// Brzda proti zahlcení (domain/ops/healthEndpoint.ts): limit požadavků na IP
// adresu (stejný mechanismus jako webové formuláře, nad limitem 429 bez
// dotazu do DB; s HEALTH_TOKEN se limit neuplatní) a výsledek kontroly se
// 30 s drží v paměti instance — veřejné volání nespouští dotazy do databáze
// při každém požadavku. checkedAt = čas skutečné kontroly.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { clientIp } from '@/lib/oauth'
import { isCronAuthorized } from '@/domain/crm/digestDelivery'
import { cachedHealth, healthLimiter, HEALTH_RATE_WINDOW_MS } from '@/domain/ops/healthEndpoint'
import { loadOpsHealth } from '@/domain/ops/opsHealth'

const NO_STORE = { 'cache-control': 'no-store' }

export async function GET(request: Request) {
  const strict = new URL(request.url).searchParams.get('strict') === '1'
  const detailed = isCronAuthorized(request.headers.get('authorization'), process.env.HEALTH_TOKEN)
  if (!detailed && !healthLimiter.check(clientIp(request))) {
    return NextResponse.json(
      { status: 'rate_limited' },
      { status: 429, headers: { ...NO_STORE, 'retry-after': String(Math.ceil(HEALTH_RATE_WINDOW_MS / 1000)) } },
    )
  }

  const r = await cachedHealth((now) => loadOpsHealth(createAdminClient(), now, process.env), new Date(), (e) => logError('api.health', e))
  if (!r.ok) {
    return NextResponse.json({ status: 'down', checkedAt: r.checkedAt.toISOString() }, { status: 503, headers: NO_STORE })
  }
  const body: Record<string, unknown> = { status: r.health.status, checkedAt: r.checkedAt.toISOString() }
  if (detailed) body.signals = r.health.signals
  const status = strict && r.health.status !== 'ok' ? 503 : 200
  return NextResponse.json(body, { status, headers: NO_STORE })
}
