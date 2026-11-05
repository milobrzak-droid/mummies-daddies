// Příjem formulářů veřejného webu (balík P6): poptávka cateringu a objednávka
// cheesecaků. Route handlery /api/web/** jen přečtou tělo a IP a zavolají
// tyto funkce; všechno ostatní (vypínač, limit, honeypot, Turnstile,
// validace, zápis přes RPC) je tady a dá se testovat bez sítě.
//
// Pořadí kontrol je od nejlevnější: vypínač → tvar obálky → limit na IP →
// honeypot a časová past → Turnstile → validace dat → RPC.
//
// VÝCHOZÍ VYPNUTO: bez WEB_INTAKE_ENABLED=true formuláře nic nepřijmou
// (503) — příjem osobních údajů z webu se zapíná až po podpisu smlouvy
// o zpracování a zveřejnění informačního textu.
//
// Do logu jde jen kód chyby (nikdy jméno, e-mail, telefon, text ani IP).
import { z } from 'zod'
import { COMPANY } from '@/config'
import { webInquiryPayload, WEB_INQUIRY_SUBMIT_RPC } from '@/core/webInquiry'
import { SHOP_ORDER_SUBMIT_RPC } from '@/core/cheesecakeOrder'
import type { SubmitInquiryResult, SubmitOrderResult } from '@/lib/web/api'
import { segmentOf } from '@/lib/web/options'
import { estimateFromGuide } from '@/lib/web/priceGuide'
import { logWarn } from '@/lib/log'
import { createRateLimiter, type RateLimiter } from '@/lib/rateLimit'
import { checkFormInquiry, predictOutcome, toAgentInquiry, webInquiryRpcPayload } from './inquiry'
import { checkFormOrder, orderRpcPayload, toShopOrder } from './order'
import { companyPriceGuide } from './priceGuide'

/** Strop těla požadavku formuláře (formulář má jednotky kB). */
export const WEB_FORM_MAX_BYTES = 32 * 1024

/** Nejkratší rozumná doba vyplnění (ms); rychlejší odeslání = robot. */
export const MIN_FILL_MS = 1500

export function webIntakeEnabled(env: Record<string, string | undefined>): boolean {
  return env.WEB_INTAKE_ENABLED === 'true'
}

/**
 * Slib „nabídka do pár minut" na potvrzovací stránce. Smí se ukázat, až
 * agent opravdu sám posílá standardní nabídky (L4) — do té doby web uvádí
 * reálnou lhůtu (varianta „ceka-na-cenik"). Výchozí vypnuto.
 */
export function instantOfferClaimEnabled(env: Record<string, string | undefined>): boolean {
  // Stejný přepínač jako texty webu (lib/web/claims.ts), aby potvrzení
  // nikdy neslíbilo něco jiného než zbytek stránky.
  return env.NEXT_PUBLIC_WEB_INSTANT_OFFER_CLAIM === 'true'
}

/** Obálka požadavku z lib/web/api.ts (data formuláře + technické údaje). */
export const webFormEnvelopeSchema = z.object({
  /** Klíč idempotence (uuid z prohlížeče; dvojí klik = jeden záznam). */
  clientToken: z.string().uuid(),
  /** Token Turnstile z prohlížeče. */
  turnstileToken: z.string().max(2048).nullable(),
  /** Honeypot: skryté pole formuláře. Člověk ho nevyplní. */
  hp: z.string().max(500).default(''),
  /** Jak dlouho byl formulář otevřený (ms). */
  elapsedMs: z.number().int().min(0).max(7 * 86_400_000).nullable().default(null),
  data: z.unknown(),
})

type RpcError = { code?: string; message?: string } | null
export type WebIntakeDeps = {
  env: Record<string, string | undefined>
  /** Volání RPC servisním klíčem (createAdminClient().rpc). */
  rpc: (fn: string, args: { p: Record<string, unknown> }) => PromiseLike<{ data: unknown; error: RpcError }>
  /** Ověření Turnstile (lib/turnstile.ts#verifyTurnstileToken). */
  verifyTurnstile: (token: string | null, ip: string) => Promise<boolean>
  /** Dnešní den v pásmu firmy (YYYY-MM-DD). */
  today: string
  now: Date
  limiter: RateLimiter
  /** Časová past (ms); výchozí MIN_FILL_MS. Testy průvodce ji nastaví na 0. */
  minFillMs?: number
}

export type WebIntakeResponse<T> = { status: number; body: T; headers?: Record<string, string> }

type Failure = { ok: false; reason: 'network' | 'server'; message: string }
const fail = (status: number, message: string, headers?: Record<string, string>): WebIntakeResponse<Failure> =>
  ({ status, body: { ok: false, reason: 'server', message }, headers })

/** Limity na IP adresu v paměti instance (na každý formulář zvlášť). */
export const inquiryLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 })
export const orderLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 })

/** Společné brány obou formulářů. null = pokračovat; jinak hotová odpověď. */
async function gate(
  deps: WebIntakeDeps,
  raw: unknown,
  ip: string,
  scope: string,
): Promise<{ stop: WebIntakeResponse<Failure> } | { stop: null; envelope: z.infer<typeof webFormEnvelopeSchema>; bot: boolean }> {
  if (!webIntakeEnabled(deps.env)) return { stop: fail(503, 'disabled') }
  const env = webFormEnvelopeSchema.safeParse(raw)
  if (!env.success) return { stop: fail(400, 'invalid_request') }
  if (!deps.limiter.check(ip, deps.now.getTime())) return { stop: fail(429, 'rate_limited', { 'Retry-After': '600' }) }
  // Honeypot / časová past: robotovi se tváříme, že je hotovo (nic se nezapíše).
  const bot = env.data.hp.trim() !== '' || (env.data.elapsedMs !== null && env.data.elapsedMs < (deps.minFillMs ?? MIN_FILL_MS))
  if (bot) {
    logWarn(`web.${scope}`, 'honeypot', {})
    return { stop: null, envelope: env.data, bot: true }
  }
  if (!(await deps.verifyTurnstile(env.data.turnstileToken, ip))) {
    logWarn(`web.${scope}`, 'turnstile_failed', {})
    return { stop: fail(403, 'captcha') }
  }
  return { stop: null, envelope: env.data, bot: false }
}

const rpcCode = (error: RpcError): string => {
  const m = /\b([A-Z]{2}\d{3})\b/.exec(error?.message ?? '')
  return m ? m[1] : error?.code ?? 'unknown'
}

// --- Poptávka ---------------------------------------------------------------

export async function handleInquirySubmit(deps: WebIntakeDeps, raw: unknown, ip: string): Promise<WebIntakeResponse<SubmitInquiryResult>> {
  const g = await gate(deps, raw, ip, 'inquiry')
  if (g.stop) return g.stop
  const receivedAt = deps.now.toISOString()
  if (g.bot) return { status: 200, body: { ok: true, inquiryId: '0', outcome: 'ceka-na-cenik', estimate: null, receivedAt } }

  const checked = checkFormInquiry(g.envelope.data, deps.today)
  if (!checked.ok) {
    if ('invalid' in checked) return fail(400, 'invalid_request')
    return { status: 422, body: { ok: false, reason: 'validation', fieldErrors: checked.fieldErrors } }
  }
  // Segment určuje druh zákazníka (prohlížeči se nevěří ani v odvozeném poli).
  const form = { ...checked.form, segment: segmentOf(checked.form.customerKind) }
  const mapped = toAgentInquiry(form, g.envelope.clientToken)
  if (!mapped.ok) return { status: 422, body: { ok: false, reason: 'validation', fieldErrors: mapped.fieldErrors } }

  const payload = webInquiryRpcPayload(mapped.mapped, webInquiryPayload(mapped.mapped.inquiry))
  const { data, error } = await deps.rpc(WEB_INQUIRY_SUBMIT_RPC, { p: payload })
  if (error) {
    const code = rpcCode(error)
    logWarn('web.inquiry', 'rpc_failed', { code })
    if (code === 'WI001') return fail(429, 'rate_limited')
    return fail(502, 'unavailable')
  }
  const id = (data as { web_inquiry_id?: unknown } | null)?.web_inquiry_id
  if (typeof id !== 'number' && typeof id !== 'string') return fail(502, 'unavailable')

  const outcome = predictOutcome(form, mapped.mapped, deps.today, { instantOfferEnabled: instantOfferClaimEnabled(deps.env) })
  const estimate = outcome === 'konzultace'
    ? null
    : estimateFromGuide(companyPriceGuide(deps.today), { eventType: form.eventType, guests: form.guests, customerKind: form.customerKind })
  return { status: 200, body: { ok: true, inquiryId: String(id), outcome, estimate, receivedAt } }
}

// --- Objednávka cheesecaků --------------------------------------------------

export async function handleOrderSubmit(deps: WebIntakeDeps, raw: unknown, ip: string): Promise<WebIntakeResponse<SubmitOrderResult>> {
  const g = await gate(deps, raw, ip, 'order')
  if (g.stop) return g.stop
  if (g.bot) {
    return {
      status: 200,
      body: { ok: true, orderNumber: '0', subtotal: 0, delivery: 0, total: 0, bakeDate: deps.today, payment: { method: 'karta', redirectUrl: null } },
    }
  }
  const checked = checkFormOrder(g.envelope.data, deps.today, COMPANY.shop)
  if (!checked.ok) {
    if ('invalid' in checked) return fail(400, 'invalid_request')
    return { status: 422, body: { ok: false, reason: 'validation', fieldErrors: checked.fieldErrors } }
  }
  const mapped = toShopOrder(checked.form, g.envelope.clientToken, deps.today, COMPANY.shop)
  if (!mapped.ok) return { status: 422, body: { ok: false, reason: 'validation', fieldErrors: mapped.fieldErrors } }

  const { data, error } = await deps.rpc(SHOP_ORDER_SUBMIT_RPC, { p: orderRpcPayload(mapped.mapped, checked.form) })
  if (error) {
    const code = rpcCode(error)
    logWarn('web.order', 'rpc_failed', { code })
    if (code === 'SO001') return fail(429, 'rate_limited')
    return fail(502, 'unavailable')
  }
  const id = (data as { shop_order_id?: unknown } | null)?.shop_order_id
  if (typeof id !== 'number' && typeof id !== 'string') return fail(502, 'unavailable')

  const orderNumber = String(id)
  const { pricing, order } = mapped.mapped
  const subtotal = pricing.totalCzk - pricing.deliveryCzk
  return {
    status: 200,
    body: {
      ok: true,
      orderNumber,
      subtotal,
      delivery: pricing.deliveryCzk,
      total: pricing.totalCzk,
      bakeDate: order.fulfilmentDate,
      // Platební brána ani číslo účtu zatím nejsou (doplní klient): kartou
      // bez přesměrování, převodem s variabilním symbolem = číslo objednávky.
      payment: checked.form.payment === 'karta'
        ? { method: 'karta', redirectUrl: null }
        : { method: 'prevod', account: null, variableSymbol: orderNumber, amount: pricing.totalCzk },
    },
  }
}
