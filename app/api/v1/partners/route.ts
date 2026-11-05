import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { listPartnersPageForApi, parsePagination } from '@/domain/crm/queries/apiV1'

// Volitelné stránkování: ?limit=1..500&offset=N. Bez limit = všichni partneři
// (načtení po stránkách, žádný tichý strop 1000 řádků).
export async function GET(req: Request) {
  const auth = await requireApiKey(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const pagination = parsePagination(new URL(req.url).searchParams)
  if (!pagination.ok) return NextResponse.json({ error: 'invalid_pagination', detail: pagination.error }, { status: 400 })

  try {
    const page = await listPartnersPageForApi(pagination.value)
    return NextResponse.json({ partners: page.items, next_offset: page.next_offset })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
