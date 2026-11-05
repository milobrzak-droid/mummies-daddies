import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { updateDealForApi } from '@/domain/crm/apiDeals'

// Úprava obchodu přes API: jen pole z whitelistu (částka, náklad, MD, fáze,
// důvod prohry, pilíř a fáze pilíře, očekávané uzavření, další krok a poznámka).
// Pravidla (přechody fází, kurz EUR, audit jménem vlastníka klíče) drží
// domain/crm/apiDeals.ts. Schválně POST jako ostatní zápisy API.

export async function POST(req: Request) {
  const auth = await requireApiKey(req, { write: true, sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })

    const result = await updateDealForApi(parsedBody.value, auth.createdBy, auth.canSeeSales)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.data)
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
