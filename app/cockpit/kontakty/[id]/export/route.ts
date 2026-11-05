import { NextResponse } from 'next/server'
import { exportContactData } from '@/domain/crm/actions/gdprExport'

// GET /kontakty/:id/export → JSON export dle čl. 15 GDPR ke stažení.
// Route handler kryje action guard test jen nepřímo, proto se brána
// (přihlášení + AAL2 + admin) vynucuje uvnitř exportContactData, která
// vrací status 401/403 dřív, než sáhne na jakákoli data.
//
// GET s vedlejším účinkem (audit řádek contact.exported) je jinak
// vyvolatelná i cross-site (prostý odkaz/img/fetch z cizí stránky, cookie
// jde s requestem). Sec-Fetch-Site posílají všechny moderní prohlížeče u
// každého navigačního i fetch požadavku; když je přítomný a říká, že request
// nejde ze stejného originu (ani z "none" — přímé zadání URL/záložka), je to
// cross-site a odmítneme ho, než se sáhne na cokoli. Chybějící hlavička
// (starý/nestandardní klient) se propustí dál na standardní auth bránu.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const secFetchSite = req.headers.get('sec-fetch-site')
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return NextResponse.json({ error: 'Zakázáno.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const { id } = await params
  const contactId = /^\d+$/.test(id) ? Number(id) : NaN
  const result = await exportContactData(contactId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
  }
  return new NextResponse(JSON.stringify(result.document, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
