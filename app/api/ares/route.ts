import { NextRequest, NextResponse } from 'next/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { aresByIco, aresSearchByName } from '@/connectors/ares'

// GET /api/ares?ico=25352628   → jeden subjekt
// GET /api/ares?q=Servis+Climax → kandidáti podle jména
export async function GET(req: NextRequest) {
  // Interní role s ověřeným 2FA (AAL2), ne jen platná session: proxy je první
  // vrstva, brána v handleru druhá (jako u Server Actions).
  const user = await tryRequireUser({ aal2: true })
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const ico = req.nextUrl.searchParams.get('ico')
  const q = req.nextUrl.searchParams.get('q')
  try {
    if (ico) {
      const company = await aresByIco(ico)
      return NextResponse.json({ company })
    }
    if (q && q.trim().length >= 2) {
      const candidates = await aresSearchByName(q.trim())
      return NextResponse.json({ candidates })
    }
    return NextResponse.json({ error: 'missing ico or q' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'ares_unavailable' }, { status: 502 })
  }
}
