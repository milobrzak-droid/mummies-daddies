import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { createActivity } from '@/domain/crm/apiWrite'
import { listActivitiesPageForApi, parseActivityListParams } from '@/domain/crm/queries/apiV1'

// Zápis aktivity (hovor, e-mail, schůzka, poznámka) z externího nástroje.
// Validaci i vlastní insert řeší domain/crm/apiWrite.ts — tady jen ověříme klíč,
// bezpečně rozparsujeme tělo a přeložíme výsledek na HTTP kód.

export async function POST(req: Request) {
  const auth = await requireApiKey(req, { write: true, sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    // Rozbité JSON nesmí spadnout jako 500 — volající má dostat jasnou 400;
    // příliš velké tělo 413 (čte se po částech, až po ověření klíče).
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })
    const body = parsedBody.value

    const result = await createActivity(body, auth.createdBy, auth.canSeeSales)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    // paired_planned: zápis doplnil naplánovanou schůzku téhož dne (id je její).
    // Stav 201 zůstává kvůli zpětné kompatibilitě volajících.
    return NextResponse.json({
      id: result.data.id,
      evidence_id: result.data.evidence_id,
      ...(result.data.paired_planned ? { paired_planned: true } : {}),
    }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}

// Čtení záznamů z jednání, nejnovější první: ?limit=1..200 (výchozí 50)
// &offset=N &account_id= &deal_id= &since=YYYY-MM-DD. sales_activity je
// v DB jen pro obchodní role (0020), API jde mimo RLS → hlídá requireApiKey.
export async function GET(req: Request) {
  const auth = await requireApiKey(req, { sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const params = parseActivityListParams(new URL(req.url).searchParams)
  if (!params.ok) return NextResponse.json({ error: 'invalid_pagination', detail: params.error }, { status: 400 })

  try {
    const page = await listActivitiesPageForApi(params.value)
    return NextResponse.json({ activities: page.items, next_offset: page.next_offset, total: page.total ?? null })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
