import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { listApprovalsPageForApi, parseApprovalListParams } from '@/domain/crm/queries/apiV1'

// Čekající žádosti o schválení — jen čtení. Rozhoduje se v Cockpitu, API ani
// konektor schvalovat nesmí. Žádosti o odeslání nabídky jen obchodní role.
// ?limit=1..200 (výchozí 50) &offset=N.

export async function GET(req: Request) {
  const auth = await requireApiKey(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const params = parseApprovalListParams(new URL(req.url).searchParams)
  if (!params.ok) return NextResponse.json({ error: 'invalid_pagination', detail: params.error }, { status: 400 })

  try {
    const page = await listApprovalsPageForApi({ ...params.value, canSeeSales: auth.canSeeSales })
    return NextResponse.json({
      approvals: page.items, next_offset: page.next_offset, total: page.total ?? null,
      ...(page.unavailable ? { unavailable: true } : {}),
    })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
