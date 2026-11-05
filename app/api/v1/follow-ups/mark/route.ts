import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { readJsonBody } from '@/lib/httpBody'
import { markNudged } from '@/domain/crm/queries/followUps'

const schema = z.object({
  marks: z.array(z.object({
    deal_id: z.number().int(),
    level: z.enum(['owner', 'manager']),
  })).min(1),
})

// Zaznamená, že upozornění bylo odesláno — volat až po doručení.
export async function POST(req: Request) {
  // Obchody a částky jen pro obchodní role (0058) — API jde přes admin
  // klienta mimo RLS, proto se role vlastníka klíče hlídá v requireApiKey.
  const auth = await requireApiKey(req, { write: true, sales: true })
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const parsedBody = await readJsonBody(req)
  if (!parsedBody.ok) return NextResponse.json({ error: parsedBody.error }, { status: parsedBody.status })
  const body = parsedBody.value
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 })
  try {
    const marked = await markNudged(parsed.data.marks)
    return NextResponse.json({ marked })
  } catch {
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
