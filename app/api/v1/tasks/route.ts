import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { createTask } from '@/domain/crm/apiWrite'
import { listTasksPageForApi, parseTaskListParams } from '@/domain/crm/queries/apiV1'

// Založení úkolu přes API — typicky to, co vypadlo ze schůzky a má se
// někomu objevit v seznamu. Pravidla drží domain/crm/apiWrite.ts, tenhle handler
// jen ověří klíč a namapuje výsledek zápisu na HTTP odpověď.

export async function POST(req: Request) {
  const auth = await requireApiKey(req, { write: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    // Rozbité JSON nesmí spadnout jako 500 — volající má dostat jasnou 400;
    // příliš velké tělo 413 (čte se po částech, až po ověření klíče).
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })
    const body = parsedBody.value

    const result = await createTask(body, auth.createdBy, auth.canSeeSales)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    return NextResponse.json({ id: result.data.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}

// Čtení úkolů: ?only_mine=true|false (výchozí true = řešitel je vlastník
// klíče) &only_open=true|false (výchozí true = bez hotových) &limit=1..200
// &offset=N. Vazbu na obchod (deal_id) vidí jen obchodní role.
export async function GET(req: Request) {
  const auth = await requireApiKey(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const params = parseTaskListParams(new URL(req.url).searchParams)
  if (!params.ok) return NextResponse.json({ error: 'invalid_pagination', detail: params.error }, { status: 400 })

  try {
    const page = await listTasksPageForApi({ ...params.value, meId: auth.createdBy, canSeeSales: auth.canSeeSales })
    return NextResponse.json({ tasks: page.items, next_offset: page.next_offset, total: page.total ?? null })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
