// Integrační test CELÉHO toku poptávky nad skutečnými migracemi (PGlite) a
// skutečnými konektory, kterým odpovídá falešný Google / Anthropic / Mapy.cz
// (test/helpers/fakeGoogle.ts). Žádná živá síť: globální fetch je napodobenina
// a cokoli mimo ni test shodí.
//
//   (1) webová poptávka → rozhodnutí z mapy → zápis klienta, kontaktu, obchodu
//       a aktivity → odchozí fronta → ilustrační mapa = sám neodešle, žádost
//       ke schválení CSO → CSO schválí → odejde z Gmailu
//   (2) e-mailová poptávka v Gmailu → vytěžení (model) → totéž, odpověď
//       ve vlákně zákazníka
//   (3) nestandardní poptávka → eskalace na CSO (návrh případu v uzlu obchod)
//   (4) follow-up: obchod bez odpovědi dostane připomínku, obchod, kde
//       zákazník odpověděl v Gmailu, se zastaví
//   (5) export pipeline do xlsx a PDF obsahuje založené obchody
//
// Do logů nesmí jít jméno ani e-mail zákazníka (kontroluje se na konci).
import ExcelJS from 'exceljs'
import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFRef, decodePDFRawStream, PDFArray } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { PgSupabase, bootDatabase, type PgDb } from './helpers/pgliteSupabase'
import { FakeGoogle, gmailAuthResults } from './helpers/fakeGoogle'

const PGLITE_MODULE = '@electric-sql/pglite'
let PGliteCtor: (new () => PgDb) | null = null
try {
  PGliteCtor = ((await import(/* @vite-ignore */ PGLITE_MODULE)) as { PGlite: new () => PgDb }).PGlite
} catch {
  PGliteCtor = null
}

const CEO = 'c0000000-0000-4000-8000-000000000001'
const CSO = 'c0000000-0000-4000-8000-000000000002'
const MAILBOX = 'obchod@mummiesdaddies.com'

// Sdílený stav mocků (vi.mock se vyhodnotí před importy modulů aplikace).
const h = vi.hoisted(() => ({
  pg: null as unknown as import('./helpers/pgliteSupabase').PgSupabase,
  user: 'c0000000-0000-4000-8000-000000000002',
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: (opts: { headers?: Record<string, string> } = {}) => h.pg.client({ role: 'service_role', headers: opts.headers }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => h.pg.client({ role: 'authenticated', sub: h.user, aal: 'aal2' }),
}))
vi.mock('@/lib/auth/requireUser', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/requireUser')>()),
  tryRequireUser: async () => ({ id: h.user }),
  requireUser: async () => ({ id: h.user }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_cache: <T,>(f: T) => f }))

// Moduly aplikace až po mockách.
const { COMPANY } = await import('@/config')
const { handleInquirySubmit } = await import('@/domain/web/intake')
const { liveWebIntakeDeps } = await import('@/domain/web/intakeLive')
const { createRateLimiter } = await import('@/lib/rateLimit')
const { runInquiryAgentJobBody } = await import('@/worker/inquiryAgent')
const { runAgentOutboxLive } = await import('@/domain/crm/agentOutboxService')
const { createFollowUpCadenceDb } = await import('@/worker/followUpSend')
const { runFollowUpCadence } = await import('@/domain/crm/followUpCadenceService')
const { resetGmailTokenCache } = await import('@/connectors/gmail')
const { pragueToday, addDaysToPragueDay, pragueLocalToUtc } = await import('@/lib/pragueDate')
const { GET: exportGet } = await import('@/app/cockpit/export/[prehled]/route')

type Row = Record<string, unknown>

/** Středa nejméně za `days` dní (bez víkendového příplatku, uvnitř platnosti mapy). */
function weekdayIn(days: number): string {
  let d = addDaysToPragueDay(pragueToday(), days)
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 3) d = addDaysToPragueDay(d, 1)
  return d
}

const WEB_EVENT_DATE = weekdayIn(30)
const MAIL_EVENT_DATE = weekdayIn(40)

const ENV = {
  WEB_INTAKE_ENABLED: 'true',
  AGENT_OUTBOX_ENABLED: 'true',
  GMAIL_OAUTH_CLIENT_ID: 'test-client',
  GMAIL_OAUTH_CLIENT_SECRET: 'test-secret',
  GMAIL_REFRESH_TOKENS: JSON.stringify({ [MAILBOX]: `rt-${MAILBOX}` }),
  INQUIRY_AGENT_MAILBOXES: MAILBOX,
  ANTHROPIC_API_KEY: 'test-key',
  GEO_ENABLED: 'true',
  MAPY_API_KEY: 'test-mapy',
}

function webForm(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'coffee-break',
    customerKind: 'firma',
    segment: 'b2b',
    company: { name: 'Alfa Tech s.r.o.', ico: null },
    eventDate: WEB_EVENT_DATE,
    timeFrom: '09:00',
    timeTo: '11:00',
    venue: { address: 'Vinohradská 12, Praha 2', needsVenue: false, venueSlug: null },
    guests: 40,
    serviceFormat: null,
    budgetPerPerson: null,
    diets: [],
    dietNote: null,
    serviceLevel: null,
    drinks: ['kava-caj'],
    extras: [],
    note: null,
    contact: { name: 'Karel Webový', email: 'karel.webovy@alfa-tech.cz', phone: null },
    consent: true,
    source: { channel: 'formular', page: '/poptavka', ref: null },
    ...over,
  }
}

/** Odpověď modelu pro vytěžení e-mailu (structured output podle inquiryJsonSchema). */
function modelAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    is_catering_inquiry: true, segment: 'b2b', segment_evidence: 'firma v podpisu', event_type: 'obed', event_date: MAIL_EVENT_DATE,
    guests: 30, package: null, duration_hours: null, venue: 'Karlovo náměstí 5, Praha 2', extras: [], dietary: [],
    special_requests: null, customer_name: 'Eva Mailová', company_name: 'Beta Consulting a.s.', document_instructions: null,
    ...over,
  }
}

describe.skipIf(!PGliteCtor)('celý tok poptávky: web, Gmail, schválení CSO, follow-up, export (PGlite)', () => {
  let db: PgDb
  let pg: PgSupabase
  const google = new FakeGoogle()
  const logs: string[] = []
  const ids: Record<string, number> = {}

  const one = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  const all = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
  const admin = () => pg.client({ role: 'service_role' }) as never
  const asCso = () => pg.client({ role: 'authenticated', sub: CSO, aal: 'aal2' })

  async function submitWeb(form: Record<string, unknown>) {
    const deps = { ...liveWebIntakeDeps(createRateLimiter({ limit: 50, windowMs: 60_000 }), async () => ({ ok: true }) as never, process.env), minFillMs: 0 }
    return handleInquirySubmit(deps, { clientToken: crypto.randomUUID(), turnstileToken: 'ok', hp: '', elapsedMs: 30_000, data: form }, '192.0.2.10')
  }

  /** CSO schválí čekající žádost o odeslání nabídky (Ke schválení). */
  async function csoApprovesOffer(versionId: number) {
    const req = await one<{ id: number; node: string; status: string }>(
      `SELECT id, node, status FROM approval_request WHERE action_type = 'send_offer' AND target_id = $1 ORDER BY id DESC LIMIT 1`, [versionId])
    expect(req).toMatchObject({ node: 'obchod', status: 'pending' })
    const r = await asCso().rpc('decide_approval', { p_request_id: req!.id, p_approve: true, p_note: null })
    expect(r.error).toBeNull()
    expect(r.data).toBe('approved')
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v)
    vi.stubGlobal('fetch', google.fetch)
    for (const m of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
    }
    resetGmailTokenCache()

    db = await bootDatabase(PGliteCtor!)
    pg = new PgSupabase(db)
    h.pg = pg
    h.user = CSO
    for (const [id, email, name, role] of [[CEO, 'ceo@mummiesdaddies.com', 'Jana Ředitelová', 'vedeni'], [CSO, MAILBOX, 'Petr Obchodní', 'obchodnik']]) {
      await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data, invited_at) VALUES ($1, $2, $3, now())`, [id, email, JSON.stringify({ full_name: name })])
      await db.query(`UPDATE team_member SET role = $2::team_role, full_name = $3 WHERE id = $1`, [id, role, name])
    }
    // CSO vlastní uzel obchod: eskalace i schválení nabídek jdou k němu.
    await db.query(`INSERT INTO loop_node (node, owner_id) VALUES ('obchod', $1) ON CONFLICT (node) DO UPDATE SET owner_id = EXCLUDED.owner_id`, [CSO])
  }, 300_000)

  afterAll(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  test('(1) webová poptávka: formulář → fronta web_inquiry (jen přes RPC, bez modelu)', async () => {
    const res = await submitWeb(webForm())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, outcome: 'ceka-na-cenik' })
    ids.web = Number((res.body as { inquiryId: string }).inquiryId)
    expect(await one(`SELECT status, email, guests FROM web_inquiry WHERE id = $1`, [ids.web])).toEqual({ status: 'new', email: 'karel.webovy@alfa-tech.cz', guests: 40 })
  })

  test('(1) agent rozhodne z mapy a zapíše klienta, kontakt, obchod, aktivitu, koncept nabídky a frontu', async () => {
    const before = google.modelCalls
    const stats = await runInquiryAgentJobBody(admin())
    expect(stats.agent).toMatchObject({ web: 1, send_offer: 1, enqueued: 1, failed: 0, escalate: 0 })
    expect(google.modelCalls).toBe(before) // web jde bez modelu
    const w = await one<Row>(`SELECT status, decision_kind, account_id, contact_id, deal_id FROM web_inquiry WHERE id = $1`, [ids.web])
    expect(w).toMatchObject({ status: 'decided', decision_kind: 'send_offer' })
    ids.webDeal = Number(w!.deal_id)
    const deal = await one<Row>(`SELECT d.title, d.phase, d.stage::text AS stage, d.source, d.owner_id, a.name AS account, c.email, c.full_name
      FROM deal d JOIN account a ON a.id = d.account_id JOIN contact c ON c.id = d.primary_contact_id WHERE d.id = $1`, [ids.webDeal])
    expect(deal).toMatchObject({ phase: 'poptavka', stage: 'kvalifikace', source: 'web', owner_id: CSO, account: 'Alfa Tech s.r.o.', email: 'karel.webovy@alfa-tech.cz', full_name: 'Karel Webový' })
    expect(await one(`SELECT kind::text AS kind, source FROM sales_activity WHERE deal_id = $1`, [ids.webDeal])).toEqual({ kind: 'note', source: 'agent:inquiry' })
    const ver = await one<Row>(`SELECT id, status, amount_one_time::float8 AS amount FROM deal_scope_version WHERE deal_id = $1`, [ids.webDeal])
    expect(ver).toMatchObject({ status: 'draft' })
    ids.webVersion = Number(ver!.id)
    const ob = await one<Row>(`SELECT id, kind, status, mode, to_email, source_ref, price_map_version FROM agent_outbox WHERE deal_id = $1`, [ids.webDeal])
    expect(ob).toMatchObject({ kind: 'offer', status: 'queued', mode: 'to', to_email: 'karel.webovy@alfa-tech.cz', source_ref: `web:${ids.web}`, price_map_version: 'ilustracni-2026-11' })
    ids.webOutbox = Number(ob!.id)
    // Vzdálenost se počítala z adresy místa akce, ne ze jména ani e-mailu.
    expect(google.geocoded).toContain('Vinohradská 12, Praha 2')
    expect(google.geocoded.join(' ')).not.toMatch(/Karel|alfa-tech/)
  })

  test('(1) fronta: ilustrační mapa → sama neodešle, žádost ke schválení CSO', async () => {
    const r = await runAgentOutboxLive({ env: process.env })
    expect(r.status).toBe('ran')
    expect(r).toMatchObject({ sent: 0, approvalRequested: 1 })
    expect(google.sent).toHaveLength(0)
    expect(await one(`SELECT status, stop_reason FROM agent_outbox WHERE id = $1`, [ids.webOutbox])).toEqual({ status: 'blocked', stop_reason: 'approval_required' })
    expect(await one(`SELECT node, requested_by, status FROM approval_request WHERE action_type = 'send_offer' AND target_id = $1`, [ids.webVersion]))
      .toEqual({ node: 'obchod', requested_by: 'system:agent_outbox', status: 'pending' })
  })

  test('(1) CSO schválí → fronta odešle nabídku z Gmailu, verze odeslána, obchod ve fázi nabídka', async () => {
    await csoApprovesOffer(ids.webVersion)
    const r = await runAgentOutboxLive({ env: process.env })
    expect(r).toMatchObject({ status: 'ran', sent: 1, sentAutonomous: 0 })
    expect(google.sent).toHaveLength(1)
    const mail = google.sent[0]
    expect(mail.mailbox).toBe(MAILBOX)
    expect(mail.headers.to).toContain('karel.webovy@alfa-tech.cz')
    expect(mail.text).toContain('Kalkulace je nezávazná') // podmínky nabídky z fronty
    expect(await one(`SELECT status FROM agent_outbox WHERE id = $1`, [ids.webOutbox])).toEqual({ status: 'sent' })
    expect(await one(`SELECT status FROM deal_scope_version WHERE id = $1`, [ids.webVersion])).toEqual({ status: 'sent' })
    expect(await one(`SELECT phase FROM deal WHERE id = $1`, [ids.webDeal])).toEqual({ phase: 'nabidka' })
  })

  // -------------------------------------------------------------------------
  test('(2) e-mailová poptávka z Gmailu → vytěžení modelem → CRM zápis a fronta s odpovědí ve vlákně', async () => {
    google.model = () => modelAnswer()
    const msg = google.deliver(MAILBOX, {
      from: 'Eva Mailová <eva.mailova@beta-consulting.cz>',
      subject: 'Poptávka obědu pro 30 lidí',
      text: `Dobrý den,\nchtěli bychom obědový raut pro 30 kolegů ${MAIL_EVENT_DATE} na Karlově náměstí 5, Praha 2.\n\nEva Mailová\nBeta Consulting a.s.`,
      messageId: '<poptavka-beta-1@beta-consulting.cz>',
      headers: { 'Authentication-Results': gmailAuthResults('beta-consulting.cz') },
    })
    ids.mailThread = Number.NaN
    const stats = await runInquiryAgentJobBody(admin())
    expect(stats.mailbox).toMatchObject({ mailboxes: 1, enqueued: 1 })
    expect(stats.agent).toMatchObject({ claimed: 1, send_offer: 1, enqueued: 1, modelCalls: 1, failed: 0 })
    const run = await one<Row>(`SELECT id, status, deal_id, thread_id, graph_message_id FROM inquiry_agent_run WHERE internet_message_id = '<poptavka-beta-1@beta-consulting.cz>'`)
    expect(run).toMatchObject({ status: 'enqueued', thread_id: msg.threadId, graph_message_id: msg.id })
    ids.mailRun = Number(run!.id)
    ids.mailDeal = Number(run!.deal_id)
    const deal = await one<Row>(`SELECT d.source, d.phase, a.name AS account, c.email, (SELECT alias_domain FROM company_alias WHERE account_id = a.id) AS alias
      FROM deal d JOIN account a ON a.id = d.account_id JOIN contact c ON c.id = d.primary_contact_id WHERE d.id = $1`, [ids.mailDeal])
    expect(deal).toEqual({ source: 'email', phase: 'poptavka', account: 'Beta Consulting a.s.', email: 'eva.mailova@beta-consulting.cz', alias: 'beta-consulting.cz' })
    expect(await one(`SELECT kind::text AS kind, source, external_id FROM sales_activity WHERE deal_id = $1`, [ids.mailDeal]))
      .toEqual({ kind: 'email', source: 'agent:inquiry', external_id: '<poptavka-beta-1@beta-consulting.cz>' })
    const ob = await one<Row>(`SELECT id, kind, status, mode, in_reply_to_message_id, scope_version_id FROM agent_outbox WHERE deal_id = $1`, [ids.mailDeal])
    expect(ob).toMatchObject({ kind: 'offer', status: 'queued', mode: 'reply', in_reply_to_message_id: msg.id })
    ids.mailOutbox = Number(ob!.id)
    ids.mailVersion = Number(ob!.scope_version_id)
    // Datum akce z vytěžení zůstává u řádku fronty (follow-up z něj vyplní šablonu, 0108).
    expect(await one(`SELECT event_date::text AS d FROM inquiry_agent_run WHERE id = $1`, [ids.mailRun])).toEqual({ d: MAIL_EVENT_DATE })
  })

  test('(2) fronta: blokace ilustrační mapou → schválení CSO → odpověď ve vlákně zákazníka', async () => {
    const first = await runAgentOutboxLive({ env: process.env })
    expect(first).toMatchObject({ sent: 0, approvalRequested: 1 })
    await csoApprovesOffer(ids.mailVersion)
    const r = await runAgentOutboxLive({ env: process.env })
    expect(r).toMatchObject({ sent: 1 })
    const mail = google.sent.at(-1)!
    expect(mail.headers.to).toContain('eva.mailova@beta-consulting.cz')
    expect(mail.headers['in-reply-to']).toBe('<poptavka-beta-1@beta-consulting.cz>')
    const original = google.mailbox(MAILBOX).messages.find((m) => m.headers.some((x) => x.value === '<poptavka-beta-1@beta-consulting.cz>'))!
    expect(mail.threadId).toBe(original.threadId)
    expect(await one(`SELECT status, sent_thread_id FROM agent_outbox WHERE id = $1`, [ids.mailOutbox])).toEqual({ status: 'sent', sent_thread_id: original.threadId })
    expect(await one(`SELECT phase FROM deal WHERE id = $1`, [ids.mailDeal])).toEqual({ phase: 'nabidka' })
  })

  // -------------------------------------------------------------------------
  test('(3) nestandardní poptávka (přání mimo mapu) → eskalace na CSO, zákazníkovi nic neodejde', async () => {
    const res = await submitWeb(webForm({
      eventType: 'vecere', guests: 60, company: { name: 'Gama Events s.r.o.', ico: null },
      contact: { name: 'Hana Zvláštní', email: 'hana@gama-events.cz', phone: null },
      note: 'Chceme ohňostroj a živou kapelu, menu podle vlastního výběru.',
    }))
    expect(res.body).toMatchObject({ ok: true, outcome: 'na-miru' })
    const webId = Number((res.body as { inquiryId: string }).inquiryId)
    const stats = await runInquiryAgentJobBody(admin())
    expect(stats.agent).toMatchObject({ web: 1, escalate: 1, enqueued: 0 })
    const w = await one<Row>(`SELECT status, decision_kind, deal_id, account_id FROM web_inquiry WHERE id = $1`, [webId])
    expect(w).toMatchObject({ status: 'decided', decision_kind: 'escalate' })
    // Lead je v CRM i u eskalace; do fronty nic.
    expect(await one(`SELECT count(*)::int AS n FROM agent_outbox WHERE deal_id = $1`, [w!.deal_id])).toEqual({ n: 0 })
    const p = await one<Row>(`SELECT id, node, status, account_id, rationale FROM case_proposal WHERE source_key = $1`, [`web:${webId}`])
    expect(p).toMatchObject({ node: 'obchod', status: 'pending', account_id: Number(w!.account_id) })
    expect(String(p!.rationale)).toMatch(/potřebuje rozhodnutí člověka/)
    // Text návrhu ani audit nenesou jméno ani e-mail zákazníka.
    expect(JSON.stringify(p)).not.toMatch(/Hana|gama-events\.cz/)
    // CSO (vlastník uzlu obchod) návrh přijme → pracovní případ je jeho.
    const acc = await asCso().rpc('accept_case_proposal', { p_proposal_id: p!.id })
    expect(acc.error).toBeNull()
    expect(await one(`SELECT node, lead_owner_id FROM work_case WHERE id = $1`, [Number(acc.data)])).toEqual({ node: 'obchod', lead_owner_id: CSO })
  })

  // -------------------------------------------------------------------------
  test('(4) follow-up: bez odpovědi připomínka do fronty; po odpovědi zákazníka v Gmailu se zastaví', async () => {
    // Zákazník z e-mailu odpoví do vlákna nabídky (Gmail), poděkování bez nové poptávky.
    const offerMail = google.sent.at(-1)!
    google.model = () => modelAnswer({ is_catering_inquiry: false, segment: null, event_type: null, event_date: null, guests: null, venue: null, company_name: null })
    google.deliver(MAILBOX, {
      from: 'Eva Mailová <eva.mailova@beta-consulting.cz>',
      subject: 'Re: Poptávka obědu pro 30 lidí',
      text: 'Děkuji za nabídku, probereme ji interně a ozveme se.\n\nEva',
      messageId: '<odpoved-beta-1@beta-consulting.cz>',
      threadId: offerMail.threadId,
      headers: { 'In-Reply-To': offerMail.headers['message-id'], 'Authentication-Results': gmailAuthResults('beta-consulting.cz') },
    })
    const agent = await runInquiryAgentJobBody(admin())
    expect(agent.mailbox).toMatchObject({ enqueued: 1 })
    expect(agent.agent).toMatchObject({ claimed: 1, not_inquiry: 1 })

    // Za týden ve čtvrtek v 10:00 (okno odesílání): obě nabídky jsou po termínu první připomínky.
    const thursday = weekdayIn(7).replace(/.*/, (d) => addDaysToPragueDay(d, 1))
    const later = pragueLocalToUtc(`${thursday}T10:00`)
    const stats = await runFollowUpCadence(createFollowUpCadenceDb(admin()), later, {
      cfg: COMPANY.capabilities.followUpCadence,
      wonPhases: COMPANY.wonPhases,
      lostReasonKeys: (COMPANY.lostReasons ?? []).map((r) => r.key),
    })
    expect(stats).toMatchObject({ state: 'ok', failed: 0 })
    const attempts = await all<Row>(`SELECT deal_id, attempt, status, stop_reason FROM follow_up_attempt ORDER BY deal_id`)
    expect(attempts).toEqual([
      { deal_id: ids.webDeal, attempt: 1, status: 'enqueued', stop_reason: null },
      { deal_id: ids.mailDeal, attempt: 1, status: 'stopped', stop_reason: 'customer_replied' },
    ])
    expect(await one(`SELECT kind, status, to_email FROM agent_outbox WHERE source_ref = $1`, [`followup:${ids.webDeal}:1`]))
      .toMatchObject({ kind: 'follow_up', status: 'queued', to_email: 'karel.webovy@alfa-tech.cz' })
    expect(await one(`SELECT count(*)::int AS n FROM agent_outbox WHERE source_ref LIKE $1`, [`followup:${ids.mailDeal}:%`])).toEqual({ n: 0 })
    // Text připomínky má datum akce z webu; e-mailový obchod má datum akce z vytěžení.
    const [y, m, d] = WEB_EVENT_DATE.split('-').map(Number)
    expect(String((await one<Row>(`SELECT body FROM agent_outbox WHERE source_ref = $1`, [`followup:${ids.webDeal}:1`]))!.body)).toContain(`${d}. ${m}. ${y}`)
    const facts = await pg.client({ role: 'service_role' }).rpc('follow_up_facts', { p_deal_ids: [ids.mailDeal] })
    expect(facts.data).toEqual([expect.objectContaining({ deal_id: ids.mailDeal, event_date: MAIL_EVENT_DATE })])
  })

  // -------------------------------------------------------------------------
  test('(5) export pipeline do xlsx obsahuje založené obchody (RLS přihlášeného CSO)', async () => {
    h.user = CSO
    const res = await exportGet(new Request('https://cockpit.test/cockpit/export/pipeline?format=xlsx', { headers: { 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ prehled: 'pipeline' }) })
    expect(res.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never)
    const cells: string[] = []
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => { cells.push(String(c.value ?? '')) })))
    const text = cells.join('\n')
    expect(text).toContain('Alfa Tech s.r.o.')
    expect(text).toContain('Beta Consulting a.s.')
    expect(text).toContain('Gama Events s.r.o.')
    expect(text).toContain('Web (formulář poptávky)')
    expect(text).toContain('E-mail (agent poptávek)')
    // Audit exportu: kdo a co, bez obsahu.
    const ev = await one<Row>(`SELECT actor_id, after FROM audit_event WHERE action = 'export.downloaded' ORDER BY id DESC LIMIT 1`)
    expect(ev).toMatchObject({ actor_id: CSO })
    expect(JSON.stringify(ev!.after)).not.toMatch(/Alfa|Beta|Gama/)
  })

  test('(5) export pipeline do PDF obsahuje založené obchody', async () => {
    const res = await exportGet(new Request('https://cockpit.test/cockpit/export/pipeline?format=pdf', { headers: { 'sec-fetch-site': 'same-origin' } }), { params: Promise.resolve({ prehled: 'pipeline' }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/pdf')
    const text = await pdfText(new Uint8Array(await res.arrayBuffer()))
    expect(text).toContain('Alfa Tech s.r.o.')
    expect(text).toContain('Beta Consulting a.s.')
  })

  test('nic osobního v logech a žádný požadavek mimo napodobené služby', () => {
    const joined = logs.join('\n')
    for (const pii of ['Karel', 'karel.webovy', 'Eva Mailová', 'eva.mailova', 'Hana', 'hana@gama', 'Vinohradská', 'ohňostroj']) {
      expect(joined).not.toContain(pii)
    }
    expect(new Set(google.requests.map((r) => r.split(' ')[1].split('/')[0]))).toEqual(
      new Set(['oauth2.googleapis.com', 'gmail.googleapis.com', 'api.anthropic.com', 'api.mapy.cz']),
    )
  })
})

// --- PDF → text (ToUnicode mapy vložených písem) --------------------------------

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes)
  const out: string[] = []
  const decode = (s: PDFRawStream) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')
  for (const page of pdf.getPages()) {
    const fonts = new Map<string, Map<number, string>>()
    const res = page.node.Resources()
    const fontDict = res?.lookup(PDFName.of('Font'), PDFDict)
    for (const [name, ref] of fontDict?.entries() ?? []) {
      const font = pdf.context.lookup(ref as PDFRef, PDFDict)
      const tu = font.lookup(PDFName.of('ToUnicode'))
      const map = new Map<number, string>()
      if (tu instanceof PDFRawStream) {
        const cmap = decode(tu)
        for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
          for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]))
        }
        for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
          for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
            const start = parseInt(m[1], 16)
            const base = parseInt(m[3], 16)
            for (let c = start; c <= parseInt(m[2], 16); c++) map.set(c, String.fromCodePoint(base + c - start))
          }
        }
      }
      fonts.set(name.asString(), map)
    }
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((r) => pdf.context.lookup(r) as PDFRawStream)
      : [contents as unknown as PDFRawStream]
    for (const s of streams) {
      let current = new Map<number, string>()
      const content = decode(s)
      for (const m of content.matchAll(/(\/[A-Za-z0-9_.-]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>\s*Tj/g)) {
        if (m[1]) current = fonts.get(m[1]) ?? new Map()
        else {
          let line = ''
          for (let i = 0; i < m[2].length; i += 4) line += current.get(parseInt(m[2].slice(i, i + 4), 16)) ?? ''
          out.push(line)
        }
      }
    }
  }
  return out.join('\n')
}

function utf16(hex: string): string {
  let s = ''
  for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  return s
}
