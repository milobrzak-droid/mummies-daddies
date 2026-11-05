// Napojení veřejného webu na systém (balík P6): příjem poptávky a objednávky
// cheesecaků (domain/web/intake.ts), route handlery /api/web/**, ověření
// Turnstile, limit, honeypot, cena ze serveru a soulad ceníku webu s ceníkem
// firmy. Bez sítě: Supabase RPC je mock, fetch Turnstile je mock.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { COMPANY } from '@/config'
import { webInquirySchema } from '@/core/webInquiry'
import {
  handleInquirySubmit, handleOrderSubmit, MIN_FILL_MS, webIntakeEnabled, type WebIntakeDeps,
} from '@/domain/web/intake'
import { SLUG_PRODUCT } from '@/domain/web/order'
import { buildPriceGuide, isIllustrativeMap, rangeForEventType } from '@/domain/web/priceGuide'
import { createRateLimiter } from '@/lib/rateLimit'
import { TURNSTILE_VERIFY_URL, verifyTurnstileToken } from '@/lib/turnstile'
import type { CheesecakeOrder, WebInquiry } from '@/lib/web/api'
import { CHEESECAKES, DELIVERY_METHODS, ORDER_LEAD_DAYS } from '@/lib/web/options'
import { estimateFromGuide, FALLBACK_GUIDE } from '@/lib/web/priceGuide'

const TODAY = '2026-11-05'
const PII = ['Jana Nováková', 'jana@firma-alfa.example', '+420 737 000 000', 'Zámek 1, Praha', 'Pro Janu']

type Call = { fn: string; p: Record<string, unknown> }

function makeDeps(over: Partial<WebIntakeDeps> = {}) {
  const calls: Call[] = []
  const deps: WebIntakeDeps = {
    env: { WEB_INTAKE_ENABLED: 'true' },
    rpc: async (fn, { p }) => {
      calls.push({ fn, p })
      return { data: fn === 'shop_order_submit' ? { shop_order_id: 42, duplicate: false } : { web_inquiry_id: 7, duplicate: false }, error: null }
    },
    verifyTurnstile: vi.fn(async () => true),
    today: TODAY,
    now: new Date('2026-11-05T10:00:00Z'),
    limiter: createRateLimiter({ limit: 100, windowMs: 60_000 }),
    ...over,
  }
  return { deps, calls }
}

const inquiry = (patch: Partial<WebInquiry> = {}): WebInquiry => ({
  eventType: 'coffee-break', customerKind: 'firma', segment: 'b2b',
  company: { name: 'Firma Alfa s.r.o.', ico: '12345678' },
  eventDate: '2026-12-10', timeFrom: '09:00', timeTo: '11:30',
  venue: { address: 'Zámek 1, Praha', needsVenue: false, venueSlug: null },
  guests: 40, serviceFormat: null, budgetPerPerson: null, diets: [], dietNote: null, serviceLevel: null,
  drinks: [], extras: [], note: null,
  contact: { name: 'Jana Nováková', email: 'Jana@Firma-Alfa.example', phone: '+420 737 000 000' },
  consent: true,
  source: { channel: 'formular', page: '/catering/coffee-break', ref: null },
  ...patch,
})

const order = (patch: Partial<CheesecakeOrder> = {}): CheesecakeOrder => ({
  items: [
    { slug: 'daddy-vanilkovy', quantity: 2, inscription: 'Pro Janu' },
    { slug: 'mini-cheesecaky-10-ks', quantity: 1, miniFlavors: Array(10).fill('jahoda') },
  ],
  fulfillment: { method: 'praha-30', address: 'Zámek 1, Praha', date: '2026-11-12', note: null },
  customer: { name: 'Jana Nováková', email: 'jana@firma-alfa.example', phone: '+420 737 000 000' },
  company: null, payment: 'prevod', note: null, consent: true,
  ...patch,
})

const envelope = (data: unknown, over: Record<string, unknown> = {}) => ({
  clientToken: '0b6f0b8e-7a39-4d6e-9d55-3f1f3f7f3a11', turnstileToken: 'tok', hp: '', elapsedMs: 20_000, data, ...over,
})

let logs: string[] = []
beforeEach(() => {
  logs = []
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('příjem poptávky z webu', () => {
  test('výchozí vypnuto: bez WEB_INTAKE_ENABLED nic nepřijme a na databázi nesáhne', async () => {
    expect(webIntakeEnabled({})).toBe(false)
    const { deps, calls } = makeDeps({ env: {} })
    const r = await handleInquirySubmit(deps, envelope(inquiry()), '203.0.113.1')
    expect(r.status).toBe(503)
    expect(calls).toEqual([])
    expect(deps.verifyTurnstile).not.toHaveBeenCalled()
  })

  test('platná poptávka → RPC web_inquiry_submit s payloadem kontraktu (P2)', async () => {
    const { deps, calls } = makeDeps()
    const r = await handleInquirySubmit(deps, envelope(inquiry()), '203.0.113.1')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, inquiryId: '7', outcome: 'ceka-na-cenik', estimate: { od: 300, do: 2000, binding: false, basis: 'obvykle-rozpeti' } })
    expect(calls).toHaveLength(1)
    const p = calls[0].p
    expect(calls[0].fn).toBe('web_inquiry_submit')
    expect(p).toMatchObject({
      client_token: '0b6f0b8e-7a39-4d6e-9d55-3f1f3f7f3a11', segment: 'b2b', event_type: 'coffee_break', guests: 40,
      email: 'jana@firma-alfa.example', company_name: 'Firma Alfa s.r.o.', ico: '12345678', marketing_consent: false,
      source_page: '/catering/coffee-break', consent_version: 'web-2026-11',
    })
    const inq = p.inquiry as Record<string, unknown>
    expect(inq).toMatchObject({ event_type: 'coffee_break', start_time: '09:00', duration_hours: 2.5, venue: 'Zámek 1, Praha', special_requests: null })
    // Pole akce bez kontaktu (kontakt má vlastní sloupce).
    expect(JSON.stringify(inq)).not.toContain('jana@firma-alfa.example')
    expect(JSON.stringify(inq)).not.toContain('Jana Nováková')
    // Payload projde schématem kontraktu i zpětně (P2 ho čte z tabulky).
    expect(webInquirySchema.safeParse({
      clientToken: p.client_token, segment: p.segment, eventType: p.event_type, eventDate: p.event_date, guests: p.guests,
      customer: { name: p.customer_name, email: p.email }, consent: { processing: true },
    }).success).toBe(true)
  })

  test('segment určuje druh zákazníka, ne pole z prohlížeče', async () => {
    const { deps, calls } = makeDeps()
    await handleInquirySubmit(deps, envelope(inquiry({ customerKind: 'soukrome', segment: 'b2b', eventType: 'oslava', company: null })), '203.0.113.1')
    expect(calls[0].p).toMatchObject({ segment: 'b2c', event_type: 'oslava' })
  })

  test('mimo mapu (svatba za firmu, diety, agentura) jde k člověku: „na míru" a zvláštní přání', async () => {
    const { deps, calls } = makeDeps()
    const r = await handleInquirySubmit(deps, envelope(inquiry({ customerKind: 'agentura', diets: ['bezlepkove'] })), '203.0.113.1')
    expect(r.body).toMatchObject({ ok: true, outcome: 'na-miru' })
    const special = String((calls[0].p.inquiry as Record<string, unknown>).special_requests)
    expect(special).toContain('agentura')
    expect(special).toContain('Bezlepkové')
  })

  test('konzultace: výsledek „konzultace" bez odhadu ceny', async () => {
    const { deps } = makeDeps()
    const r = await handleInquirySubmit(deps, envelope(inquiry({ eventType: 'konzultace', guests: 0 })), '203.0.113.1')
    expect(r.body).toMatchObject({ ok: true, outcome: 'konzultace', estimate: null })
  })

  test('slib rychlé nabídky jen se schválenou mapou a zapnutým přepínačem (do té doby reálná lhůta)', async () => {
    const { deps } = makeDeps({ env: { WEB_INTAKE_ENABLED: 'true', NEXT_PUBLIC_WEB_INSTANT_OFFER_CLAIM: 'true' } })
    // Mapa firmy je ilustrační → i se zapnutým přepínačem „čeká na ceník".
    expect(isIllustrativeMap(COMPANY.capabilities.standardOffer!.priceMap.version)).toBe(true)
    const r = await handleInquirySubmit(deps, envelope(inquiry()), '203.0.113.1')
    expect(r.body).toMatchObject({ ok: true, outcome: 'ceka-na-cenik' })
  })

  test('chyby validace vrací server ve tvaru formuláře (422), nic se nezapíše', async () => {
    const { deps, calls } = makeDeps()
    const r = await handleInquirySubmit(deps, envelope(inquiry({ consent: false, contact: { name: '', email: 'x@', phone: null } })), '203.0.113.1')
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ ok: false, reason: 'validation' })
    if (!r.body.ok && r.body.reason === 'validation') {
      expect(Object.keys(r.body.fieldErrors).sort()).toEqual(['consent', 'contact.email', 'contact.name'])
    }
    expect(calls).toEqual([])
  })

  test('neznámé hodnoty číselníků a cizí tvar = 400', async () => {
    const { deps, calls } = makeDeps()
    expect((await handleInquirySubmit(deps, envelope({ ...inquiry(), eventType: 'hack' }), '1')).status).toBe(400)
    expect((await handleInquirySubmit(deps, { data: inquiry() }, '1')).status).toBe(400)
    expect((await handleInquirySubmit(deps, envelope(inquiry(), { clientToken: 'x' }), '1')).status).toBe(400)
    expect(calls).toEqual([])
  })

  test('honeypot a příliš rychlé odeslání: robot dostane „hotovo", nic se nezapíše ani neověřuje', async () => {
    const { deps, calls } = makeDeps()
    const a = await handleInquirySubmit(deps, envelope(inquiry(), { hp: 'https://spam.example' }), '1')
    const b = await handleInquirySubmit(deps, envelope(inquiry(), { elapsedMs: MIN_FILL_MS - 1 }), '1')
    for (const r of [a, b]) expect(r).toMatchObject({ status: 200, body: { ok: true, inquiryId: '0' } })
    expect(calls).toEqual([])
    expect(deps.verifyTurnstile).not.toHaveBeenCalled()
  })

  test('Turnstile neprošel → 403, nic se nezapíše', async () => {
    const { deps, calls } = makeDeps({ verifyTurnstile: vi.fn(async () => false) })
    const r = await handleInquirySubmit(deps, envelope(inquiry()), '1')
    expect(r).toMatchObject({ status: 403, body: { ok: false, reason: 'server', message: 'captcha' } })
    expect(calls).toEqual([])
  })

  test('limit na IP: šestý požadavek z jedné adresy v okně = 429', async () => {
    const { deps } = makeDeps({ limiter: createRateLimiter({ limit: 5, windowMs: 600_000 }) })
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await handleInquirySubmit(deps, envelope(inquiry()), '198.51.100.9')).status)
    expect(codes).toEqual([200, 200, 200, 200, 200, 429])
    expect((await handleInquirySubmit(deps, envelope(inquiry()), '198.51.100.10')).status).toBe(200)
  })

  test('WI001 z databáze (limit na e-mail) = 429; jiná chyba = 502; do logu jen kód, žádné osobní údaje', async () => {
    const wi = makeDeps({ rpc: async () => ({ data: null, error: { code: 'P0001', message: 'WI001: příliš mnoho poptávek z jedné adresy' } }) })
    expect((await handleInquirySubmit(wi.deps, envelope(inquiry()), '1')).status).toBe(429)
    const other = makeDeps({ rpc: async () => ({ data: null, error: { code: '23514', message: 'new row violates check constraint, Failing row contains (Jana Nováková, jana@firma-alfa.example)' } }) })
    expect((await handleInquirySubmit(other.deps, envelope(inquiry()), '1')).status).toBe(502)
    const all = logs.join('\n')
    expect(all).toContain('WI001')
    for (const s of PII) expect(all).not.toContain(s)
  })
})

describe('objednávka cheesecaků z košíku', () => {
  test('cena ze serveru (ceník firmy + pásmo doručení), RPC shop_order_submit s doplňky webu', async () => {
    const { deps, calls } = makeDeps()
    const r = await handleOrderSubmit(deps, envelope(order()), '1')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      ok: true, orderNumber: '42', subtotal: 2 * 790 + 575, delivery: 550, total: 2 * 790 + 575 + 550, bakeDate: '2026-11-12',
      payment: { method: 'prevod', account: null, variableSymbol: '42', amount: 2705 },
    })
    const p = calls[0].p
    expect(calls[0].fn).toBe('shop_order_submit')
    expect(p).toMatchObject({
      fulfilment: 'delivery', delivery_zone: 'praha-30', delivery_address: 'Zámek 1, Praha', delivery_czk: 550, total_czk: 2705,
      payment_method: 'prevod', dedication: 'Pro Janu', source_page: '/kosik', consent_version: 'web-2026-11', marketing_consent: false,
    })
    expect(p.items).toEqual([
      { product_key: 'daddy_vanilka', label: 'Daddy vanilkový', quantity: 2, unit_price_czk: 790, total_czk: 1580, inscription: 'Pro Janu' },
      { product_key: 'mini_mix', label: 'Mini cheesecaky mix', quantity: 1, unit_price_czk: 575, total_czk: 575, mini_flavors: Array(10).fill('jahoda') },
    ])
  })

  test('osobní vyzvednutí bez dopravy; kartou bez platební brány', async () => {
    const { deps, calls } = makeDeps()
    const r = await handleOrderSubmit(deps, envelope(order({ fulfillment: { method: 'vyzvednuti', address: null, date: '2026-11-12', note: 'Vyzvednu odpoledne' }, payment: 'karta' })), '1')
    expect(r.body).toMatchObject({ ok: true, delivery: 0, total: 2155, payment: { method: 'karta', redirectUrl: null } })
    expect(calls[0].p).toMatchObject({ fulfilment: 'pickup', delivery_zone: null, delivery_address: null, note: 'Vyzvednu odpoledne' })
  })

  test('pravidla ceníku firmy u pole: předstih, sezóna, množství', async () => {
    const { deps, calls } = makeDeps()
    const soon = await handleOrderSubmit(deps, envelope(order({ fulfillment: { method: 'vyzvednuti', address: null, date: '2026-11-06', note: null } })), '1')
    expect(soon.status).toBe(422)
    if (!soon.body.ok && soon.body.reason === 'validation') expect(soon.body.fieldErrors['fulfillment.date']).toContain('nestihneme')
    const far = await handleOrderSubmit(deps, envelope(order({ fulfillment: { method: 'vyzvednuti', address: null, date: '2027-03-01', note: null } })), '1')
    if (!far.body.ok && far.body.reason === 'validation') expect(far.body.fieldErrors['fulfillment.date']).toContain('60 dní')
    const many = await handleOrderSubmit(deps, envelope(order({ items: [{ slug: 'daddy-vanilkovy', quantity: 11 }] })), '1')
    if (!many.body.ok && many.body.reason === 'validation') expect(many.body.fieldErrors['items.0']).toContain('nejvýš 10')
    const xmas = await handleOrderSubmit(deps, { ...envelope(order({ items: [{ slug: 'mummy-vanilkovo-pomerancovy-vanocni', quantity: 1 }], fulfillment: { method: 'vyzvednuti', address: null, date: '2026-11-12', note: null } })) }, '1')
    expect(xmas.status).toBe(200)
    expect(calls).toHaveLength(1)
  })

  test('součty z prohlížeče se ignorují (cizí pole = 400, ne „levnější" objednávka)', async () => {
    const { deps } = makeDeps()
    const r = await handleOrderSubmit(deps, envelope({ ...order(), total: 1 }), '1')
    // Neznámá pole zod zahodí; cena je vždy z ceníku.
    expect(r.body).toMatchObject({ ok: true, total: 2705 })
  })

  test('SO001 (limit na e-mail) = 429; vypnuto = 503; Turnstile = 403', async () => {
    const so = makeDeps({ rpc: async () => ({ data: null, error: { message: 'SO001: příliš mnoho objednávek z jedné adresy' } }) })
    expect((await handleOrderSubmit(so.deps, envelope(order()), '1')).status).toBe(429)
    expect((await handleOrderSubmit(makeDeps({ env: {} }).deps, envelope(order()), '1')).status).toBe(503)
    expect((await handleOrderSubmit(makeDeps({ verifyTurnstile: async () => false }).deps, envelope(order()), '1')).status).toBe(403)
    for (const s of PII) expect(logs.join('\n')).not.toContain(s)
  })
})

describe('soulad ceníku webu s ceníkem firmy (cenu počítá server)', () => {
  test('každý cheesecake webu má produkt firmy se stejnou cenou', () => {
    for (const c of CHEESECAKES) {
      const p = COMPANY.shop.products.find((x) => x.key === SLUG_PRODUCT[c.slug])
      expect(p, c.slug).toBeDefined()
      expect(p!.priceCzk, c.slug).toBe(c.price)
    }
  })

  test('pásma doručení webu = pásma firmy, objednací lhůta = minLeadDays', () => {
    const zones = (COMPANY.shop.delivery.zones ?? []).map((z) => ({ value: z.key, price: z.priceCzk }))
    expect(DELIVERY_METHODS.filter((d) => d.value !== 'vyzvednuti').map((d) => ({ value: d.value, price: d.price }))).toEqual(zones)
    expect(ORDER_LEAD_DAYS).toBe(COMPANY.shop.minLeadDays)
  })
})

describe('orientační ceník (estimatePrice) z cenové mapy', () => {
  test('ilustrační mapa → jen obecné rozpětí 300–2 000 Kč, nikdy ceny balíčků', () => {
    const guide = buildPriceGuide(COMPANY.capabilities.standardOffer!.priceMap, TODAY)
    expect(guide).toEqual(FALLBACK_GUIDE)
    expect(estimateFromGuide(guide, { eventType: 'svatba', guests: 80 })).toEqual({
      od: 300, do: 2000, unit: 'osoba', total: { od: 24_000, do: 160_000 }, basis: 'obvykle-rozpeti', mapVersion: null, binding: false,
    })
    expect(estimateFromGuide(guide, { eventType: 'nevim' })).toBeNull()
  })

  test('schválená mapa → rozpětí podle typu akce ze stejného výpočtu jako nabídka agenta', () => {
    const map = { ...COMPANY.capabilities.standardOffer!.priceMap, version: 'schvalena-2027-01' }
    // Coffee break: 320 Kč/host bez obsluhy, DPH 12 % → 358,40 Kč → 350–360.
    expect(rangeForEventType(map, 'b2b', 'coffee_break', TODAY)).toEqual({ od: 350, do: 360 })
    const guide = buildPriceGuide(map, TODAY)
    expect(guide).toMatchObject({ basis: 'cateringova-mapa', mapVersion: 'schvalena-2027-01' })
    expect(guide.byEventType['coffee-break']).toEqual({ b2b: { od: 350, do: 360 } })
    // Typy, které mapa nezná (teambuilding), nemají rozpětí → obecné.
    expect(guide.byEventType.teambuilding).toBeUndefined()
    expect(estimateFromGuide(guide, { eventType: 'coffee-break', guests: 20, customerKind: 'firma' })).toMatchObject({
      od: 350, do: 360, total: { od: 7000, do: 7200 }, basis: 'cateringova-mapa', mapVersion: 'schvalena-2027-01',
    })
    expect(estimateFromGuide(guide, { eventType: 'teambuilding', customerKind: 'firma' })).toMatchObject({ od: 300, do: 2000, basis: 'obvykle-rozpeti' })
    expect(buildPriceGuide({ ...map, validUntil: '2026-01-01' }, TODAY)).toEqual(FALLBACK_GUIDE)
  })
})

describe('Turnstile (lib/turnstile.ts)', () => {
  test('bez tajného klíče nebo tokenu neprojde a nic neodešle', async () => {
    const f = vi.fn()
    expect(await verifyTurnstileToken(undefined, 'tok', '1.2.3.4', f)).toEqual({ ok: false, reason: 'no_secret' })
    expect(await verifyTurnstileToken('secret', null, '1.2.3.4', f)).toEqual({ ok: false, reason: 'no_token' })
    expect(f).not.toHaveBeenCalled()
  })

  test('siteverify: úspěch, odmítnutí, výpadek (zavřeno při chybě)', async () => {
    const ok = vi.fn(async () => Response.json({ success: true }))
    expect(await verifyTurnstileToken('secret', 'tok', '1.2.3.4', ok as unknown as typeof fetch)).toEqual({ ok: true })
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(TURNSTILE_VERIFY_URL)
    expect(String(init.body)).toContain('remoteip=1.2.3.4')
    const no = vi.fn(async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }))
    expect(await verifyTurnstileToken('secret', 'tok', null, no as unknown as typeof fetch)).toEqual({ ok: false, reason: 'rejected' })
    const down = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect(await verifyTurnstileToken('secret', 'tok', null, down as unknown as typeof fetch)).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('route handlery /api/web/**', () => {
  test('POST /api/web/poptavka: vypnuto → 503 bez Supabase; nevalidní JSON → 400', async () => {
    vi.resetModules()
    const admin = vi.fn()
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: admin }))
    vi.stubEnv('WEB_INTAKE_ENABLED', '')
    const { POST } = await import('@/app/api/web/poptavka/route')
    const res = await POST(new Request('http://localhost/api/web/poptavka', { method: 'POST', body: JSON.stringify(envelope(inquiry())) }))
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bad = await POST(new Request('http://localhost/api/web/poptavka', { method: 'POST', body: '{' }))
    expect(bad.status).toBe(400)
    expect(admin).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
    vi.doUnmock('@/lib/supabase/admin')
  })

  test('POST /api/web/objednavka: zapnuto, Turnstile přes siteverify (mock fetch), zápis přes servisní klíč', async () => {
    vi.resetModules()
    const rpc = vi.fn(async () => ({ data: { shop_order_id: 5, duplicate: false }, error: null }))
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc }) }))
    vi.stubEnv('WEB_INTAKE_ENABLED', 'true')
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'test-secret')
    const fetchMock = vi.fn(async () => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    const { POST } = await import('@/app/api/web/objednavka/route')
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: COMPANY.timeZone }).format(new Date())
    const [y, m, d] = today.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10)
    const res = await POST(new Request('http://localhost/api/web/objednavka', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.20' },
      body: JSON.stringify(envelope(order({ items: [{ slug: 'daddy-vanilkovy', quantity: 1 }], fulfillment: { method: 'vyzvednuti', address: null, date, note: null } }))),
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, orderNumber: '5', total: 790 })
    expect(fetchMock).toHaveBeenCalledWith(TURNSTILE_VERIFY_URL, expect.anything())
    expect(rpc).toHaveBeenCalledWith('shop_order_submit', expect.objectContaining({ p: expect.objectContaining({ total_czk: 790 }) }))
    vi.unstubAllEnvs()
    vi.doUnmock('@/lib/supabase/admin')
  })
})

describe('slib „nabídka do pár minut" (lib/web/claims.ts)', () => {
  test('výchozí vypnuto: texty webu uvádějí reálnou lhůtu', async () => {
    const { INSTANT_OFFER_CLAIM, withResponseClaim, REALISTIC_RESPONSE } = await import('@/lib/web/claims')
    const { allPages, microcopy } = await import('@/lib/web/content')
    const { TOP_BAR_TEXT } = await import('@/lib/web/navigation')
    expect(INSTANT_OFFER_CLAIM).toBe(false)
    expect(withResponseClaim('Chci nabídku do pár minut')).toBe(`Chci nabídku ${REALISTIC_RESPONSE}`)
    expect(withResponseClaim('Chci nabídku do pár minut', true)).toBe('Chci nabídku do pár minut')
    expect(JSON.stringify(allPages())).not.toContain('do pár minut')
    expect(TOP_BAR_TEXT).not.toContain('do pár minut')
    expect(microcopy('POTVRZENÍ — standard, text')).not.toContain('do pár minut')
  })
})
