import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { getSummaryForApi } from '@/domain/crm/queries/apiV1'

export async function GET(req: Request) {
  // Obchody a částky jen pro obchodní role (0058) — API jde přes admin
  // klienta mimo RLS, proto se role vlastníka klíče hlídá v requireApiKey.
  const auth = await requireApiKey(req, { sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const summary = await getSummaryForApi()
    return NextResponse.json(summary)
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
