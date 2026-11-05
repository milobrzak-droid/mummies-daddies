// POST /api/web/poptavka — nezávazná poptávka cateringu z formuláře webu.
//
// Veřejné API webu (lib/routes.ts#PUBLIC_WEB_API_PREFIX): proxy ho pouští bez
// session, ochranu dělá route sama — vypínač WEB_INTAKE_ENABLED (výchozí
// vypnuto → 503), limit na IP, honeypot, ověření Cloudflare Turnstile
// (TURNSTILE_SECRET_KEY, bez klíče se nic nepřijme), validace zod a pak RPC
// web_inquiry_submit (servisní klíč). Řádek web_inquiry ve stavu 'new'
// zpracuje agent poptávek (P2). Logika: domain/web/intake.ts.
import { clientIp } from '@/lib/oauth'
import { readJsonBody } from '@/lib/httpBody'
import { verifyTurnstileToken } from '@/lib/turnstile'
import { handleInquirySubmit, inquiryLimiter, WEB_FORM_MAX_BYTES } from '@/domain/web/intake'
import { liveWebIntakeDeps } from '@/domain/web/intakeLive'

export async function POST(req: Request) {
  const body = await readJsonBody(req, WEB_FORM_MAX_BYTES)
  if (!body.ok) return Response.json({ ok: false, reason: 'server', message: body.error }, { status: body.status })
  const res = await handleInquirySubmit(liveWebIntakeDeps(inquiryLimiter, verifyTurnstileToken), body.value, clientIp(req))
  return Response.json(res.body, { status: res.status, headers: { 'Cache-Control': 'no-store', ...res.headers } })
}
