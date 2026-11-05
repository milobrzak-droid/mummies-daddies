// POST /api/web/objednavka — objednávka cheesecaků z košíku webu.
//
// Veřejné API webu (lib/routes.ts#PUBLIC_WEB_API_PREFIX): proxy ho pouští bez
// session, ochranu dělá route sama — vypínač WEB_INTAKE_ENABLED (výchozí
// vypnuto → 503), limit na IP, honeypot, ověření Cloudflare Turnstile
// (TURNSTILE_SECRET_KEY, bez klíče se nic nepřijme), validace zod, cena
// z ceníku firmy (priceShopOrder) a RPC shop_order_submit (servisní klíč).
// Objednávku pak obsluha vidí v Cockpitu (/cockpit/objednavky).
import { clientIp } from '@/lib/oauth'
import { readJsonBody } from '@/lib/httpBody'
import { verifyTurnstileToken } from '@/lib/turnstile'
import { handleOrderSubmit, orderLimiter, WEB_FORM_MAX_BYTES } from '@/domain/web/intake'
import { liveWebIntakeDeps } from '@/domain/web/intakeLive'

export async function POST(req: Request) {
  const body = await readJsonBody(req, WEB_FORM_MAX_BYTES)
  if (!body.ok) return Response.json({ ok: false, reason: 'server', message: body.error }, { status: body.status })
  const res = await handleOrderSubmit(liveWebIntakeDeps(orderLimiter, verifyTurnstileToken), body.value, clientIp(req))
  return Response.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } })
}
