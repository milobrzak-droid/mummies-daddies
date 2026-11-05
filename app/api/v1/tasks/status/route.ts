import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { updateTaskStatusForApi } from '@/domain/crm/apiTasks'

// Změna stavu úkolu (todo, in_progress, blocked, done) — jen úkoly vlastníka
// klíče. Pravidla drží domain/crm/apiTasks.ts.

export async function POST(req: Request) {
  const auth = await requireApiKey(req, { write: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })

    const result = await updateTaskStatusForApi(parsedBody.value, auth.createdBy)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result.data)
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
