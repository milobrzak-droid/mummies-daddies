// Odpovědi route handlerů exportu: soubor ke stažení a chyby. Export obsahuje
// osobní a obchodní data, proto `no-store` na každé cestě (úspěch i chyba).

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const

/**
 * GET exportu má vedlejší účinek (záznam do auditu), takže ho cizí stránka
 * nesmí vyvolat odkazem nebo obrázkem s cookie uživatele. Sec-Fetch-Site
 * posílají moderní prohlížeče; „same-origin" a „none" (zadaná adresa,
 * záložka) projdou, chybějící hlavička jde dál na běžnou bránu přihlášení
 * (stejně jako GDPR export kontaktu).
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  return !!site && site !== 'same-origin' && site !== 'none'
}

export function exportError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE })
}

/** Název souboru do Content-Disposition: ASCII verze + UTF-8 (RFC 6266/5987). */
export function contentDisposition(filename: string): string {
  const ascii = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

export function fileResponse(bytes: Uint8Array, filename: string, contentType: string): Response {
  return new Response(bytes as BodyInit, {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(bytes.byteLength),
    },
  })
}
