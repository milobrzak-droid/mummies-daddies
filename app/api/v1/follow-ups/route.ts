import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { getDueFollowUps } from '@/domain/crm/queries/followUps'

// Obchody, u kterých uplynul termín dalšího kontaktu a nic se nestalo.
// Jen čte — označení „upozorněno" je zvlášť (POST na /mark), aby se
// nezahodilo připomenutí, které se ve skutečnosti nikomu nedoručilo.
export async function GET(req: Request) {
  // Obchody a částky jen pro obchodní role (0058) — API jde přes admin
  // klienta mimo RLS, proto se role vlastníka klíče hlídá v requireApiKey.
  const auth = await requireApiKey(req, { sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const nudges = await getDueFollowUps()
    return NextResponse.json({ count: nudges.length, follow_ups: nudges })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
