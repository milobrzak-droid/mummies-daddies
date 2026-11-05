import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { setNextStep } from '@/domain/crm/apiWrite'

// Rychlá změna dalšího kroku a termínu. Částky, fáze a další pole obchodu
// mění /api/v1/deals/update (whitelist v domain/crm/apiDeals.ts).
//
// Schválně POST, ne PATCH: všechny zápisové cesty API jsou stejné, aby se
// daly volat z jednoduchého skriptu bez přemýšlení nad metodou.

export async function POST(req: Request) {
  // Obchody a částky jen pro obchodní role (0058) — API jde přes admin
  // klienta mimo RLS, proto se role vlastníka klíče hlídá v requireApiKey.
  const auth = await requireApiKey(req, { write: true, sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    // Rozbité JSON nesmí spadnout jako 500 — volající má dostat jasnou 400;
    // příliš velké tělo 413 (čte se po částech, až po ověření klíče).
    const parsedBody = await readJsonBody(req)
    if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })
    const body = parsedBody.value

    const result = await setNextStep(body, auth.createdBy)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    return NextResponse.json({ id: result.data.id })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
