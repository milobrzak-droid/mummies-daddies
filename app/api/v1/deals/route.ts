import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { listDealsPageForApi, parseDealListParams } from '@/domain/crm/queries/apiV1'

// Stránkování vždy: ?limit=1..500 (výchozí 100) &offset=N. Bez parametrů
// přijde první stránka + next_offset (dřív „vše", což tiše končilo na 1000).
// Filtry: ?search= (část názvu obchodu), ?account_id=, ?only_open=true|false.
export async function GET(req: Request) {
  // Obchody a částky jen pro obchodní role (0058) — API jde přes admin
  // klienta mimo RLS, proto se role vlastníka klíče hlídá v requireApiKey.
  const auth = await requireApiKey(req, { sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const params = parseDealListParams(new URL(req.url).searchParams)
  if (!params.ok) return NextResponse.json({ error: 'invalid_pagination', detail: params.error }, { status: 400 })

  try {
    const page = await listDealsPageForApi(params.value)
    return NextResponse.json({ deals: page.items, next_offset: page.next_offset, total: page.total ?? null })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
