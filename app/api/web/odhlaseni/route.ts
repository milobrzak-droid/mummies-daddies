// /api/web/odhlaseni — odhlášení z obchodních sdělení outbound agenta (P7).
//
// Veřejná routa webu BEZ Turnstile: odkaz přichází z e-mailu a odhlášení
// musí jít jedním kliknutím i z poštovního klienta (RFC 8058 One-Click
// POST), kde žádná výzva Turnstile být nemůže. Brána je podepsaný token
// (HMAC, OUTBOUND_UNSUBSCRIBE_SECRET) — bez platného tokenu se nic nestane.
// Token nese jen otisk adresy a id oslovení; e-mail v URL ani v logu není.
//
//   GET  ?t=… → stránka s tlačítkem „Odhlásit" (prefetch odkazů nic nezmění)
//   POST ?t=… → zapíše odhlášení (RPC outbound_unsubscribe, idempotentní)
//
// Odhlášení funguje i při vypnutém agentovi (lidé, kterým už e-mail přišel,
// se musí umět odhlásit vždy); bez tajemství routa vrací 404.
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { verifyUnsubscribeToken } from '@/core/outbound/unsubscribe'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`
    + '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#222}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #222;background:#222;color:#fff;cursor:pointer}</style>'
    + `</head><body><h1>${title}</h1>${body}</body></html>`
  return new Response(html, { status, headers: HEADERS })
}

function tokenFrom(request: Request): string | null {
  return new URL(request.url).searchParams.get('t')
}

export async function GET(request: Request) {
  const secret = process.env.OUTBOUND_UNSUBSCRIBE_SECRET
  if (!secret) return new NextResponse(null, { status: 404 })
  const token = tokenFrom(request)
  if (!verifyUnsubscribeToken(token, secret)) {
    return page('Odkaz není platný', '<p>Odkaz pro odhlášení je neplatný nebo poškozený. Napište nám prosím odpovědí na e-mail a odhlásíme vás ručně.</p>', 400)
  }
  // Token je base64url + tečka — bezpečný do atributu bez dalšího escapování.
  return page('Odhlášení z nabídek',
    '<p>Kliknutím níže vás odhlásíme z obchodních sdělení Mummies and Daddies. Už vám nebudeme posílat nabídky e-mailem.</p>'
    + `<form method="post" action="?t=${encodeURIComponent(token!)}"><button type="submit">Odhlásit</button></form>`)
}

export async function POST(request: Request) {
  const secret = process.env.OUTBOUND_UNSUBSCRIBE_SECRET
  if (!secret) return new NextResponse(null, { status: 404 })
  const claim = verifyUnsubscribeToken(tokenFrom(request), secret)
  if (!claim) return page('Odkaz není platný', '<p>Odkaz pro odhlášení je neplatný nebo poškozený.</p>', 400)
  const { error } = await createAdminClient().rpc('outbound_unsubscribe', {
    p: { email_hash: claim.emailHash, outreach_id: claim.outreachId, source: 'unsubscribe_link' },
  })
  if (error) {
    logError('web.odhlaseni', { code: error.code })
    return page('Odhlášení se nepodařilo', '<p>Zkuste to prosím za chvíli znovu, nebo nám odpovězte na e-mail a odhlásíme vás ručně.</p>', 503)
  }
  return page('Odhlášeno', '<p>Hotovo — z obchodních sdělení jste odhlášeni. Pokud jste u nás zákazníkem, objednávky a domluvené akce se tím nemění.</p>')
}
