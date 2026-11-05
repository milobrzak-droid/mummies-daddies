import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { updateContactForApi } from '@/domain/crm/apiContacts'

// Úprava kontaktní osoby (bez mazání a bez přesunu k jiné firmě; nesouhlas
// s oslovením jde jen zapnout). Pravidla drží domain/crm/apiContacts.ts.

export async function POST(req: Request) {
  const auth = await requireApiKey(req, { write: true, sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })

    const result = await updateContactForApi(parsedBody.value, auth.createdBy, auth.canSeeSales)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.data)
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
