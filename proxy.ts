import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { previewGate } from '@/lib/previewGate'

// Next.js 16 renamed the `middleware` file convention to `proxy`. Same behavior:
// runs on every matched request to refresh the Supabase session and gate auth.
export async function proxy(request: NextRequest) {
  // Uzavřený náhled: heslo na celou aplikaci, jen když je PREVIEW_BASIC_AUTH nastavená.
  const gate = previewGate(request)
  if (gate) return gate
  return await updateSession(request)
}

// Brána se nevztahuje na statické soubory: Next interní (_next/static, _next/image),
// favicon, písma (fonts/), fotky, výřezy a logo veřejného webu (web/photos/, web/cutouts/, web/brand/) a soubory z public/ přímo v kořeni (logo, symbol…),
// které se poznají podle přípony obrázku. Bez toho `/logo.svg` přesměroval
// nepřihlášeného na /login a na přihlašovací stránce bylo rozbité logo.
//
// Výjimka je záměrně úzká: jen JEDNA cesta bez lomítka končící příponou
// (`[^/]+\.přípona$`). Stránka ani API cesta (`/api/x.svg`, `/cockpit/clients/a.png`)
// tak z brány nevypadne. Nový podadresář v public/ nebo jiná přípona sem musí
// přidat člověk — test/proxy-matcher.test.ts projde celé public/ a selže.
// Matcher musí být doslovný řetězec (Next ho čte staticky při buildu, žádné
// proměnné ani interpolace).
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|fonts/|web/(?:photos|cutouts|brand)/|[^/]+\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)'],
}
