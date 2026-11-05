import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { createContactForApi } from '@/domain/crm/apiContacts'

// Založení kontaktní osoby u klienta (id nebo bezpečně podle názvu) nebo
// partnera. Kontakty jsou osobní údaje: jen obchodní role (jako get_contacts).
// Pravidla drží domain/crm/apiContacts.ts.

export async function POST(req: Request) {
  const auth = await requireApiKey(req, { write: true, sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })

    const result = await createContactForApi(parsedBody.value, auth.createdBy, auth.canSeeSales)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.data, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
