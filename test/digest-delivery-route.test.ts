// @vitest-environment node
// Route /api/cron/weekly-digest s falešným fetch (Entra token / obnova
// delegovaného tokenu + Graph sendMail) a falešným Supabase (job_run zámek,
// tokenové RPC z 0041). Nic nejde na síť.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { buildDigest, type DigestInput } from '@/domain/crm/digest'
import { MISSING_MAIL_SEND_ERROR, SENDER_TOKEN_SAVE_ERROR, loadDigestAsService } from '@/domain/crm/digestDelivery'
import { GET } from '@/app/api/cron/weekly-digest/route'
import { createSupabaseFake, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'
import { opsReport } from './helpers/opsReportFixture'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/core/connectorState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/connectorState')>()),
  recordConnectorSuccess: vi.fn(async () => {}),
  recordConnectorError: vi.fn(async () => {}),
  getConnectorState: vi.fn(async () => null),
}))
vi.mock('@/domain/crm/digestDelivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/digestDelivery')>()),
  loadDigestAsService: vi.fn(),
}))

const CRON = 'cron-secret-123'
const CLIENT_SECRET = 'ms-client-secret-VALUE-987'
const ACCESS_TOKEN = 'eyJ.access-token-abc.sig'
const MONDAY = new Date('2026-09-28T05:00:00Z')

const digestInput: DigestInput = {
  followUps: [],
  outreach: [],
  blockedDeals: [{ id: 7, account_id: 3, title: 'Pilot', account_name: 'ACME', status_blocker: 'čeká na podpis' }],
  connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null },
  lastMeetingNoteAt: null,
  outlookMailSyncEnabled: true,
  generatedAt: MONDAY,
}

const MEMBER = 'f6d18417-48ac-423b-b459-d09ee5a5103f'
const LOGIN_CLIENT_SECRET = 'login-client-secret-VALUE-555'
const STORED_ACCESS = 'eyJ.stored-access.sig'
const STORED_REFRESH = 'stored-refresh-token-VALUE-111'
const NEW_ACCESS = 'eyJ.refreshed-access.sig'
const NEW_REFRESH = 'rotated-refresh-token-VALUE-222'

type StoredToken = { access_token: string | null; refresh_token: string | null; expires_at: string | null }

type Run = { id: number; status: string; stats: Record<string, unknown>; error: string | null }

// Stavový zástupce job_run/job_lock: zámek drží jen běžící běh, finish ho
// uvolní — přesně jako 0040. digest_send_log (0053) = množina (den|druh):
// upsert s ignoreDuplicates vrátí řádek jen, když vložil; delete ho odebere.
// team_member vrací e-maily členů týmu.
function setupDb(opts: {
  rpcMissing?: boolean
  sendLogMissing?: boolean
  teamEmails?: string[]
  /** email (lowercase) -> role; chybějící = 'vedeni' (výchozí pro fixture). */
  teamRoles?: Record<string, string>
  /** calendar_token odesílatele (0041); výchozí = prošlý token. */
  token?: StoredToken | null
  tokenSaveFails?: boolean
  tokenRpcMissing?: boolean
} = {}) {
  const runs: Run[] = []
  const tokenCalls: { name: string; args: Record<string, unknown> }[] = []
  let token: StoredToken | null = opts.token === undefined
    ? { access_token: STORED_ACCESS, refresh_token: STORED_REFRESH, expires_at: '2026-09-28T01:00:00Z' }
    : opts.token
  const markers = new Set<string>()
  const teamEmails = opts.teamEmails ?? ['Viktor@MummiesDaddies.com', 'jana@mummiesdaddies.com']
  const teamRoles = opts.teamRoles ?? {}
  const roleFor = (email: string) => teamRoles[email.toLowerCase()] ?? 'vedeni'
  let lockedBy: number | null = null
  const fake = createSupabaseFake({
    rpc: (name, args): QueryResult => {
      const a = args as Record<string, unknown>
      if (opts.rpcMissing) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.try_acquire_job_lock' } }
      if (name === 'try_acquire_job_lock') {
        if (lockedBy !== null) return { data: null, error: null }
        const id = runs.length + 1
        runs.push({ id, status: 'running', stats: {}, error: null })
        lockedBy = id
        return { data: id, error: null }
      }
      if (name === 'calendar_token_get_for_service' || name === 'calendar_token_update_for_service') {
        tokenCalls.push({ name, args: a })
        if (opts.tokenRpcMissing) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } }
        if (name === 'calendar_token_get_for_service') return { data: token ? [{ provider: 'microsoft', ...token, account_email: 'viktor@mummiesdaddies.com' }] : [], error: null }
        if (opts.tokenSaveFails) return { data: null, error: { code: 'XX000', message: 'vault unavailable' } }
        token = { access_token: a.p_access_token as string, refresh_token: a.p_refresh_token as string, expires_at: a.p_expires_at as string }
        return { data: null, error: null }
      }
      if (name === 'finish_job_run') {
        const run = runs.find((r) => r.id === a.run_id)!
        run.status = a.status as string
        run.stats = a.stats as Record<string, unknown>
        run.error = a.error as string | null
        if (lockedBy === run.id) lockedBy = null
        return { data: true, error: null }
      }
      return { data: null, error: { code: 'X', message: `unexpected rpc ${name}` } }
    },
    resolve: (call: QueryCall): QueryResult => {
      if (call.table === 'team_member') {
        return { data: teamEmails.map((email) => ({ email, role: roleFor(email) })), error: null }
      }
      if (call.table === 'digest_send_log') {
        if (opts.sendLogMissing) return { data: null, error: { code: 'PGRST205', message: 'Could not find the table public.digest_send_log' } }
        const up = opArgs(call, 'upsert')
        if (up) {
          const [row, o] = up as [{ prague_day: string; kind: string }, { onConflict: string; ignoreDuplicates: boolean }]
          expect(o).toEqual({ onConflict: 'prague_day,kind', ignoreDuplicates: true })
          const key = `${row.prague_day}|${row.kind}`
          if (markers.has(key)) return { data: [], error: null }
          markers.add(key)
          return { data: [{ prague_day: row.prague_day }], error: null }
        }
        if (call.ops.some((o) => o.method === 'delete')) {
          const eqs = Object.fromEntries(call.ops.filter((o) => o.method === 'eq').map((o) => o.args as [string, unknown]))
          markers.delete(`${eqs.prague_day}|${eqs.kind}`)
          return { data: null, error: null }
        }
      }
      return { data: null, error: { message: `unexpected table ${call.table}` } }
    },
  })
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
  return { runs, fake, markers, tokenCalls, token: () => token, holdLock: () => { lockedBy = 999 } }
}

type FetchCall = { url: string; init: RequestInit }

function setupFetch(opts: { tokenStatus?: number; sendStatus?: number; refreshStatus?: number } = {}) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const grant = typeof init.body === 'string' ? new URLSearchParams(init.body).get('grant_type') : null
    if (url.startsWith('https://login.microsoftonline.com/') && grant === 'refresh_token') {
      // Obnova delegovaného tokenu (connectors/graph refreshAccessToken).
      if (opts.refreshStatus && opts.refreshStatus !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: `AADSTS65001 consent ${STORED_REFRESH}` }), { status: opts.refreshStatus })
      }
      return new Response(JSON.stringify({ access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 3600, scope: 'Mail.Send' }), { status: 200 })
    }
    if (url === 'https://graph.microsoft.com/v1.0/me/sendMail') {
      const status = opts.sendStatus ?? 202
      if (status === 202) return new Response(null, { status })
      return new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: `Access is denied ${NEW_ACCESS}` } }), { status })
    }
    if (url.startsWith('https://login.microsoftonline.com/')) {
      if (opts.tokenStatus && opts.tokenStatus !== 200) {
        return new Response(JSON.stringify({
          error: 'invalid_client',
          error_description: `AADSTS7000215: Invalid client secret provided: ${CLIENT_SECRET}`,
          error_codes: [7000215],
        }), { status: opts.tokenStatus })
      }
      return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' }), { status: 200 })
    }
    if (url.startsWith('https://graph.microsoft.com/v1.0/users/')) {
      const status = opts.sendStatus ?? 202
      if (status === 202) return new Response(null, { status })
      return new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: `denied for ${ACCESS_TOKEN}` } }), { status })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const sends = () => calls.filter((c) => c.url.includes('/sendMail'))
  return { calls, sends }
}

/** Režim app (volitelná alternativa) — beze změny proti dřívějšku. */
function enableEnv() {
  vi.stubEnv('DIGEST_SEND_ENABLED', 'true')
  vi.stubEnv('DIGEST_SEND_MODE', 'app')
  vi.stubEnv('CRON_SECRET', CRON)
  vi.stubEnv('APP_URL', 'https://cockpit.example.cz')
  vi.stubEnv('DIGEST_RECIPIENTS', 'viktor@mummiesdaddies.com, jana@mummiesdaddies.com')
  vi.stubEnv('DIGEST_SENDER', '')
  vi.stubEnv('MS_APP_TENANT_ID', 'mummiesdaddies.com')
  vi.stubEnv('MS_APP_CLIENT_ID', 'client-id-1')
  vi.stubEnv('MS_APP_CLIENT_SECRET', CLIENT_SECRET)
}

/** Výchozí režim delegated: z Viktorovy schránky, bez MS_APP_* a bez DIGEST_SENDER. */
function enableDelegatedEnv() {
  vi.stubEnv('DIGEST_SEND_ENABLED', 'true')
  vi.stubEnv('DIGEST_SEND_MODE', '')
  vi.stubEnv('CRON_SECRET', CRON)
  vi.stubEnv('APP_URL', 'https://cockpit.example.cz')
  vi.stubEnv('DIGEST_RECIPIENTS', 'viktor@mummiesdaddies.com, jana@mummiesdaddies.com')
  vi.stubEnv('DIGEST_SENDER', '')
  vi.stubEnv('DIGEST_SENDER_MEMBER_ID', '')
  vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', MEMBER)
  vi.stubEnv('MS_CLIENT_ID', 'login-client-id')
  vi.stubEnv('MS_CLIENT_SECRET', LOGIN_CLIENT_SECRET)
  vi.stubEnv('MS_TENANT_ID', 'common')
  vi.stubEnv('MS_APP_TENANT_ID', '')
  vi.stubEnv('MS_APP_CLIENT_ID', '')
  vi.stubEnv('MS_APP_CLIENT_SECRET', '')
}

const req = (auth?: string) =>
  new Request('https://cockpit.example.cz/api/cron/weekly-digest', { headers: auth ? { authorization: auth } : {} })

let logs: string[]

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(MONDAY)
  vi.mocked(loadDigestAsService).mockResolvedValue({ digest: buildDigest(digestInput), source: digestInput })
  logs = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/cron/weekly-digest — režim app (DIGEST_SEND_MODE=app)', () => {
  it('vypnuto (bez DIGEST_SEND_ENABLED=true) → 404 a nic nedělá', async () => {
    enableEnv()
    vi.stubEnv('DIGEST_SEND_ENABLED', 'TRUE')
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(404)
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })

  it('špatný nebo chybějící secret → 401', async () => {
    enableEnv()
    const f = setupFetch()
    expect((await GET(req(`Bearer ${CRON}-x`))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req(CRON))).status).toBe(401)
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })

  it('odešle ze cockpit@ všem příjemcům a zapíše graph_send úspěch', async () => {
    enableEnv()
    const db = setupDb()
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'succeeded', stats: { outcome: 'sent', sent_day: '2026-09-28', kind: 'weekly', recipients: 2 } })
    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0].url).toBe('https://graph.microsoft.com/v1.0/users/cockpit%40mummiesdaddies.com/sendMail')
    const payload = JSON.parse(String(f.sends()[0].init.body))
    expect(payload.message.toRecipients.map((r: { emailAddress: { address: string } }) => r.emailAddress.address))
      .toEqual(['viktor@mummiesdaddies.com', 'jana@mummiesdaddies.com'])
    expect(recordConnectorSuccess).toHaveBeenCalledWith('graph_send', null)
    expect(db.runs).toEqual([expect.objectContaining({ status: 'succeeded' })])
    expect([...db.markers]).toEqual(['2026-09-28|weekly'])
  })

  it('M1: příjemce mimo team_member se nepošle, log nese jen počet', async () => {
    enableEnv()
    setupDb({ teamEmails: ['viktor@mummiesdaddies.com'] })
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ stats: { outcome: 'sent', recipients: 1, dropped_recipients: 1 } })
    const payload = JSON.parse(String(f.sends()[0].init.body))
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: 'viktor@mummiesdaddies.com' } }])
    const text = logs.join('\n')
    expect(text).toContain('dropped=1')
    expect(text).not.toContain('jana')
  })

  it('M1: člen týmu bez role vedeni/obchodnik (stejné jako can_see_sales, 0020) se vyřadí jako mimo tým', async () => {
    enableEnv()
    setupDb({ teamRoles: { 'viktor@mummiesdaddies.com': 'vedeni', 'jana@mummiesdaddies.com': 'projektak' } })
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ stats: { outcome: 'sent', recipients: 1, dropped_recipients: 1 } })
    const payload = JSON.parse(String(f.sends()[0].init.body))
    expect(payload.message.toRecipients).toEqual([{ emailAddress: { address: 'viktor@mummiesdaddies.com' } }])
  })

  it('M1: adresa mimo @mummiesdaddies.com → 500 config s počtem, nic neposílá', async () => {
    enableEnv()
    vi.stubEnv('DIGEST_RECIPIENTS', 'viktor@mummiesdaddies.com,externi@klient.cz')
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('1 adresu/adres mimo @mummiesdaddies.com')
    expect(text).not.toContain('externi')
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })

  it('L1: marker přežije i job_run — existující marker = nic se nepošle', async () => {
    enableEnv()
    const db = setupDb()
    db.markers.add('2026-09-28|weekly')
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(await res.json()).toMatchObject({ status: 'succeeded', stats: { outcome: 'already_sent' } })
    expect(f.sends()).toHaveLength(0)
    expect(loadDigestAsService).not.toHaveBeenCalled()
  })

  it('L1: selhání odeslání smaže marker → další běh pošle', async () => {
    enableEnv()
    const db = setupDb()
    setupFetch({ sendStatus: 403 })
    expect((await GET(req(`Bearer ${CRON}`))).status).toBe(500)
    expect(db.markers.size).toBe(0)
    const f = setupFetch()
    vi.setSystemTime(new Date('2026-09-28T06:00:00Z'))
    expect(await (await GET(req(`Bearer ${CRON}`))).json()).toMatchObject({ stats: { outcome: 'sent' } })
    expect(f.sends()).toHaveLength(1)
    expect([...db.markers]).toEqual(['2026-09-28|weekly'])
  })

  it('L1: chybí migrace 0053 → běh selže s jasnou chybou, nic neposílá', async () => {
    enableEnv()
    setupDb({ sendLogMissing: true })
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).toContain('0053')
    expect(f.calls).toHaveLength(0)
  })

  it('L1: selhání recordSuccess nezmění odeslaný mail na chybu', async () => {
    enableEnv()
    setupDb()
    vi.mocked(recordConnectorSuccess).mockRejectedValueOnce(new Error('connector_state down'))
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'succeeded', stats: { outcome: 'sent' } })
    expect(f.sends()).toHaveLength(1)
  })

  it('idempotence: druhé doručení cronu týž pražský den nic nepošle', async () => {
    enableEnv()
    const db = setupDb()
    const f = setupFetch()
    expect((await GET(req(`Bearer ${CRON}`))).status).toBe(200)
    vi.setSystemTime(new Date('2026-09-28T05:03:00Z'))
    const second = await GET(req(`Bearer ${CRON}`))
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ status: 'succeeded', stats: { outcome: 'already_sent' } })
    expect(f.sends()).toHaveLength(1)
    expect(loadDigestAsService).toHaveBeenCalledTimes(1)
    expect(db.runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded'])

    // Další den (pátek) se posílá znovu.
    vi.setSystemTime(new Date('2026-10-02T05:00:00Z'))
    expect(await (await GET(req(`Bearer ${CRON}`))).json()).toMatchObject({ stats: { outcome: 'sent', sent_day: '2026-10-02' } })
    expect(f.sends()).toHaveLength(2)
  })

  it('souběžné doručení (zámek drží jiný běh) → skipped, nic neposílá', async () => {
    enableEnv()
    const db = setupDb()
    db.holdLock()
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'skipped' })
    expect(f.calls).toHaveLength(0)
  })

  it('chybí RPC z migrace 0040 → 503 se srozumitelnou chybou, nic neposílá', async () => {
    enableEnv()
    setupDb({ rpcMissing: true })
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('skipped')
    expect(body.error).toContain('0040')
    expect(f.calls).toHaveLength(0)
  })

  it('neplatní příjemci → 500 config bez odeslání a bez vypsání adres', async () => {
    enableEnv()
    vi.stubEnv('DIGEST_RECIPIENTS', 'viktor@mummiesdaddies.com,soukroma-adresa@@x')
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('DIGEST_RECIPIENTS')
    expect(text).not.toContain('soukroma-adresa')
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })

  it('žádná tajemství v logu, odpovědi ani job_run — token i Graph selhání', async () => {
    enableEnv()
    const db = setupDb()
    setupFetch({ tokenStatus: 401 })
    const r1 = await GET(req(`Bearer ${CRON}`))
    expect(r1.status).toBe(500)
    const b1 = JSON.stringify(await r1.json())
    expect(recordConnectorError).toHaveBeenCalledWith('graph_send', 'Token 401 invalid_client AADSTS7000215')

    setupFetch({ sendStatus: 403 })
    const r2 = await GET(req(`Bearer ${CRON}`))
    expect(r2.status).toBe(500)
    const b2 = JSON.stringify(await r2.json())
    expect(recordConnectorError).toHaveBeenCalledWith('graph_send', 'Graph 403 ErrorAccessDenied')

    const everything = [
      ...logs,
      b1,
      b2,
      JSON.stringify(db.runs),
      JSON.stringify(vi.mocked(recordConnectorError).mock.calls),
    ].join('\n')
    for (const secret of [CLIENT_SECRET, ACCESS_TOKEN, CRON]) expect(everything).not.toContain(secret)
    // a job_run nenese adresy
    expect(JSON.stringify(db.runs)).not.toContain('@')
    expect(logs.length).toBeGreaterThan(0)
  })
})

describe('GET /api/cron/weekly-digest — režim delegated (výchozí)', () => {
  it('prošlý token: obnoví, uloží rotovaný refresh token a pošle přes /me/sendMail', async () => {
    enableDelegatedEnv()
    const db = setupDb()
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'succeeded', stats: { outcome: 'sent', kind: 'weekly', recipients: 2 } })

    // 1) načtení tokenu Viktorova člena, 2) uložení obnoveného (s rotovaným refresh tokenem)
    expect(db.tokenCalls.map((c) => c.name)).toEqual(['calendar_token_get_for_service', 'calendar_token_update_for_service'])
    expect(db.tokenCalls[0].args).toEqual({ p_member_id: MEMBER })
    expect(db.tokenCalls[1].args).toEqual({
      p_member_id: MEMBER,
      p_access_token: NEW_ACCESS,
      p_refresh_token: NEW_REFRESH,
      p_expires_at: '2026-09-28T06:00:00.000Z',
    })
    expect(db.token()).toMatchObject({ refresh_token: NEW_REFRESH })

    // obnova přes přihlašovací appku (ne MS_APP_*), s původním refresh tokenem
    const refresh = f.calls.find((c) => new URLSearchParams(String(c.init.body)).get('grant_type') === 'refresh_token')!
    expect(refresh.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token')
    const body = new URLSearchParams(String(refresh.init.body))
    expect(body.get('client_id')).toBe('login-client-id')
    expect(body.get('refresh_token')).toBe(STORED_REFRESH)
    expect(body.get('scope')).toContain('Mail.Send')
    expect(f.calls.some((c) => new URLSearchParams(String(c.init.body)).get('grant_type') === 'client_credentials')).toBe(false)

    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0].url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    expect((f.sends()[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${NEW_ACCESS}`)
    expect(recordConnectorSuccess).toHaveBeenCalledWith('graph_send', null)
    expect([...db.markers]).toEqual(['2026-09-28|weekly'])
  })

  it('platný token: bez obnovy a bez zápisu, pošle s uloženým tokenem', async () => {
    enableDelegatedEnv()
    const db = setupDb({ token: { access_token: STORED_ACCESS, refresh_token: STORED_REFRESH, expires_at: '2026-09-28T05:45:00Z' } })
    const f = setupFetch()
    expect((await GET(req(`Bearer ${CRON}`))).status).toBe(200)
    expect(db.tokenCalls.map((c) => c.name)).toEqual(['calendar_token_get_for_service'])
    expect(f.calls.filter((c) => c.url.startsWith('https://login.microsoftonline.com/'))).toHaveLength(0)
    expect((f.sends()[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${STORED_ACCESS}`)
  })

  it('DIGEST_SENDER_MEMBER_ID má přednost před OUTLOOK_MAIL_SYNC_MEMBER_ID', async () => {
    enableDelegatedEnv()
    const other = '11111111-2222-3333-4444-555555555555'
    vi.stubEnv('DIGEST_SENDER_MEMBER_ID', other)
    const db = setupDb()
    setupFetch()
    expect((await GET(req(`Bearer ${CRON}`))).status).toBe(200)
    expect(db.tokenCalls.every((c) => c.args.p_member_id === other)).toBe(true)
  })

  it('uložení obnoveného tokenu selže → NIC se nepošle, chyba graph_send, marker uvolněn', async () => {
    enableDelegatedEnv()
    const db = setupDb({ tokenSaveFails: true })
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).toContain(SENDER_TOKEN_SAVE_ERROR)
    expect(f.sends()).toHaveLength(0)
    expect(recordConnectorError).toHaveBeenCalledWith('graph_send', SENDER_TOKEN_SAVE_ERROR)
    expect(db.markers.size).toBe(0)
  })

  it('token bez Mail.Send (Graph 403) → chyba konektoru graph_send s pokynem znovu připojit', async () => {
    enableDelegatedEnv()
    const db = setupDb()
    setupFetch({ sendStatus: 403 })
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(500)
    expect(recordConnectorError).toHaveBeenCalledWith('graph_send', MISSING_MAIL_SEND_ERROR)
    expect(recordConnectorError).toHaveBeenCalledWith('graph_send', 'Chybí oprávnění Mail.Send — znovu připojte Outlook v Nastavení')
    expect(db.runs).toEqual([expect.objectContaining({ status: 'failed', error: MISSING_MAIL_SEND_ERROR })])
    expect(db.markers.size).toBe(0)
  })

  it('obnova odmítnuta (např. chybí souhlas s Mail.Send) → chyba graph_send, nic neposlané', async () => {
    enableDelegatedEnv()
    setupDb()
    const f = setupFetch({ refreshStatus: 400 })
    expect((await GET(req(`Bearer ${CRON}`))).status).toBe(500)
    expect(recordConnectorError).toHaveBeenCalledWith('graph_send', expect.stringContaining('znovu připojte Outlook v Nastavení'))
    expect(f.sends()).toHaveLength(0)
  })

  it('Outlook odesílatele nepřipojený → chyba graph_send, nic neposlané', async () => {
    enableDelegatedEnv()
    setupDb({ token: null })
    const f = setupFetch()
    expect((await GET(req(`Bearer ${CRON}`))).status).toBe(500)
    expect(recordConnectorError).toHaveBeenCalledWith('graph_send', expect.stringContaining('není připojený'))
    expect(f.calls).toHaveLength(0)
  })

  it('chybí migrace 0041 → srozumitelná chyba, nic neposlané', async () => {
    enableDelegatedEnv()
    setupDb({ tokenRpcMissing: true })
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).toContain('Chybí migrace 0041')
    expect(f.calls).toHaveLength(0)
  })

  it('config: bez member id a bez přihlašovací appky → 500 se jmény proměnných, MS_APP_* se nevyžaduje', async () => {
    enableDelegatedEnv()
    vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', '')
    vi.stubEnv('MS_CLIENT_SECRET', '')
    const f = setupFetch()
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('DIGEST_SENDER_MEMBER_ID chybí')
    expect(text).toContain('MS_CLIENT_SECRET chybí')
    expect(text).not.toContain('MS_APP_')
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(0)
  })

  it('pondělí: provozní přehled z Viktorovy schránky přes /me/sendMail stejným příjemcům, jednou za den', async () => {
    enableDelegatedEnv()
    const db = setupDb()
    const f = setupFetch()
    vi.mocked(loadDigestAsService).mockResolvedValue({ digest: buildDigest(digestInput), source: digestInput, report: opsReport() })
    const res = await GET(req(`Bearer ${CRON}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'succeeded', stats: { outcome: 'sent', kind: 'weekly', recipients: 2, format: 'provozni_prehled' } })
    expect(loadDigestAsService).toHaveBeenCalledWith(MONDAY, 'weekly')
    expect(f.sends()).toHaveLength(1)
    expect(f.sends()[0].url).toBe('https://graph.microsoft.com/v1.0/me/sendMail')
    const payload = JSON.parse(String(f.sends()[0].init.body))
    expect(payload.message.toRecipients.map((r: { emailAddress: { address: string } }) => r.emailAddress.address)).toEqual(['viktor@mummiesdaddies.com', 'jana@mummiesdaddies.com'])
    expect(payload.message.subject).toMatch(/^Přehled týdne pondělí 28\. 9\. 2026: 22 položek \(Riziko: 6/)
    expect(payload.message.body.contentType).toBe('HTML')
    expect(payload.message.body.content).toContain('Dodávky podle milníků')
    expect(payload.saveToSentItems).toBe(true)
    expect([...db.markers]).toEqual(['2026-09-28|weekly'])
    // druhé doručení cronu týž den už nic nepošle
    expect(await (await GET(req(`Bearer ${CRON}`))).json()).toMatchObject({ stats: { outcome: 'already_sent' } })
    expect(f.sends()).toHaveLength(1)
  })

  it('ranní souhrn (středa): bez položek a se zdravými zdroji nic nepošle; rozbitý zdroj ano', async () => {
    enableDelegatedEnv()
    const db = setupDb()
    const f = setupFetch()
    const WEDNESDAY = new Date('2026-09-30T05:00:00Z')
    vi.setSystemTime(WEDNESDAY)
    const ok = { ...digestInput, blockedDeals: [], generatedAt: WEDNESDAY, lastMeetingNoteAt: '2026-09-30T04:00:00Z', outlookMailSyncEnabled: false }
    const healthy = { connector: 'graph_calendar', cursor: null, last_success_at: '2026-09-30T04:30:00Z', last_error: null, last_error_at: null, consecutive_errors: 0, updated_at: '2026-09-30T04:30:00Z' }
    const quiet = { ...ok, connectorStates: { ...ok.connectorStates, graphCalendar: healthy } }
    vi.mocked(loadDigestAsService).mockResolvedValueOnce({ digest: buildDigest(quiet), source: quiet })
    expect(await (await GET(req(`Bearer ${CRON}`))).json()).toMatchObject({ stats: { kind: 'daily', outcome: 'nothing_to_report', source_alerts: 0 } })
    expect(loadDigestAsService).toHaveBeenLastCalledWith(WEDNESDAY, 'daily')
    expect(f.sends()).toHaveLength(0)
    expect(db.markers.size).toBe(0)

    const broken = { ...quiet, connectorStates: { ...quiet.connectorStates, graphCalendar: { ...healthy, consecutive_errors: 1, last_error: 'Přihlášení k Outlooku vypršelo.' } } }
    vi.mocked(loadDigestAsService).mockResolvedValueOnce({ digest: buildDigest(broken), source: broken })
    expect(await (await GET(req(`Bearer ${CRON}`))).json()).toMatchObject({ stats: { kind: 'daily', outcome: 'sent', source_alerts: 1 } })
    expect(f.sends()).toHaveLength(1)
    expect(JSON.parse(String(f.sends()[0].init.body)).message.subject).toBe('Ranní souhrn středa 30. 9. 2026: zdroje dat vyžadují pozornost')
    expect([...db.markers]).toEqual(['2026-09-30|daily'])
  })

  it('žádná tajemství v logu, odpovědi, job_run ani chybě konektoru', async () => {
    enableDelegatedEnv()
    const db = setupDb()
    setupFetch({ sendStatus: 403 })
    const r1 = await GET(req(`Bearer ${CRON}`))
    const b1 = JSON.stringify(await r1.json())
    setupFetch({ refreshStatus: 400 })
    const r2 = await GET(req(`Bearer ${CRON}`))
    const b2 = JSON.stringify(await r2.json())
    const saveFail = setupDb({ tokenSaveFails: true })
    setupFetch()
    const b3 = JSON.stringify(await (await GET(req(`Bearer ${CRON}`))).json())
    const everything = [
      ...logs, b1, b2, b3,
      JSON.stringify(db.runs), JSON.stringify(saveFail.runs),
      JSON.stringify(vi.mocked(recordConnectorError).mock.calls),
    ].join('\n')
    for (const secret of [STORED_ACCESS, STORED_REFRESH, NEW_ACCESS, NEW_REFRESH, LOGIN_CLIENT_SECRET, CRON]) {
      expect(everything).not.toContain(secret)
    }
    expect(JSON.stringify(db.runs)).not.toContain('@')
  })
})
