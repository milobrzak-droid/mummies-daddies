// Falešné API webu pro testy formulářů: fetch na /api/web/** jde rovnou do
// serverových funkcí (domain/web/intake.ts) se Supabase mockem RPC. Žádná
// síť; Turnstile „projde", časová past je vypnutá (testy klikají rychle).
import { vi } from 'vitest'
import { handleInquirySubmit, handleOrderSubmit, type WebIntakeDeps } from '@/domain/web/intake'
import { createRateLimiter } from '@/lib/rateLimit'
import { isoDate } from '@/lib/web/format'

export type FakeRpcCall = { fn: string; p: Record<string, unknown> }

export function installWebApiFake(over: Partial<WebIntakeDeps> = {}) {
  const calls: FakeRpcCall[] = []
  const tokens = new Map<string, number>()
  let seq = 1000
  const deps = (): WebIntakeDeps => ({
    env: { WEB_INTAKE_ENABLED: 'true' },
    rpc: async (fn, { p }) => {
      calls.push({ fn, p })
      const token = String(p.client_token)
      const duplicate = tokens.has(token)
      if (!duplicate) tokens.set(token, ++seq)
      const id = tokens.get(token)!
      return { data: fn === 'shop_order_submit' ? { shop_order_id: id, duplicate } : { web_inquiry_id: id, duplicate }, error: null }
    },
    verifyTurnstile: async () => true,
    today: isoDate(),
    now: new Date(),
    limiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    minFillMs: 0,
    ...over,
  })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? 'null'))
    const handler = url === '/api/web/poptavka' ? handleInquirySubmit : url === '/api/web/objednavka' ? handleOrderSubmit : null
    if (!handler) return new Response('not found', { status: 404 })
    const res = await handler(deps(), body, '203.0.113.7')
    return Response.json(res.body, { status: res.status })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}
