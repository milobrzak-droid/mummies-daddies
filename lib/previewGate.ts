import { NextResponse, type NextRequest } from 'next/server'

// Heslo na celou aplikaci pro uzavřený náhled (HTTP Basic Auth prohlížeče).
// Zapne se jen proměnnou PREVIEW_BASIC_AUTH ve tvaru „uživatel:heslo";
// bez ní se nic nemění. Hodí se tam, kde hosting nemá vlastní ochranu heslem
// (např. Vercel Hobby). Do ostrého provozu se nenastavuje — web má být veřejný
// a Cockpit chrání vlastní přihlášení s dvoufázovým ověřením.
//
// Plánované úlohy (/api/cron/*) mají vlastní CRON_SECRET; brána je nepouští
// bez hesla také, takže v náhledu crony neběží, což je záměr.

const REALM = 'Mummies and Daddies – náhled'

function timingSafeEqual(a: string, b: string): boolean {
  // Porovnání v konstantním čase (Edge runtime nemá node:crypto).
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

function decodeBasic(header: string | null): string | null {
  if (!header) return null
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header.trim())
  if (!m) return null
  try {
    // atob vrací binární řetězec; credentials v hlavičce jsou UTF-8.
    const bin = atob(m[1])
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** Platná hodnota PREVIEW_BASIC_AUTH, nebo null (brána vypnutá). */
export function previewCredentials(raw: string | undefined = process.env.PREVIEW_BASIC_AUTH): string | null {
  const v = raw?.trim()
  if (!v) return null
  const i = v.indexOf(':')
  // Neplatný tvar = brána zavřená pro všechny, ne potichu otevřená.
  if (i < 1 || i === v.length - 1) return '\u0000invalid'
  return v
}

/** Vrátí odpověď 401, když je brána zapnutá a požadavek nemá správné heslo; jinak null. */
export function previewGate(request: NextRequest, raw?: string): NextResponse | null {
  const expected = previewCredentials(raw ?? process.env.PREVIEW_BASIC_AUTH)
  if (!expected) return null
  const got = decodeBasic(request.headers.get('authorization'))
  if (got !== null && timingSafeEqual(got, expected)) return null
  return new NextResponse('Přístup jen s heslem.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
