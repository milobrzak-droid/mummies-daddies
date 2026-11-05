import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

// Next.js 16 renamed the `middleware` file convention to `proxy`. Same behavior:
// runs on every matched request to refresh the Supabase session and gate auth.
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

// Brána se nevztahuje na statické soubory: Next interní (_next/static, _next/image),
// favicon, písma (fonts/), fotky veřejného webu (web/photos/, balík P6) a soubory z public/ přímo v kořeni (logo, symbol…),
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
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|fonts/|web/photos/|[^/]+\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)'],
}
