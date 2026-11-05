import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { listAccountsPageForApi, parseAccountListParams } from '@/domain/crm/queries/apiV1'

// Stránkování vždy: ?limit=1..500 (výchozí 100) &offset=N. Bez parametrů
// přijde první stránka + next_offset (dřív „vše", což tiše končilo na 1000).
// Filtry: ?search= (část názvu nebo IČO), ?has_open_deal=true|false.
export async function GET(req: Request) {
  const auth = await requireApiKey(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const params = parseAccountListParams(new URL(req.url).searchParams)
  if (!params.ok) return NextResponse.json({ error: 'invalid_pagination', detail: params.error }, { status: 400 })

  try {
    const page = await listAccountsPageForApi(params.value)
    return NextResponse.json({ accounts: page.items, next_offset: page.next_offset, total: page.total ?? null })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
