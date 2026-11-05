// Provozní alarm do 15 minut a /api/health (balík P8, docs/PROVOZ.md).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { createAdminClient } from '@/lib/supabase/admin'
import type { JobRunRow } from '@/domain/crm/jobHealth'
import {
  assessOps,
  classifyJobError,
  expectedJobsFromEnv,
  fingerprintSignals,
  loadStuckQueues,
  renderAlarmText,
  statsSignals,
} from '@/domain/ops/opsHealth'
import { alarmWebhookUrl, decideAlarm, postAlarm, repeatMinutesFromEnv } from '@/domain/ops/opsAlarm'
import { HEALTH_CACHE_MS, HEALTH_RATE_LIMIT, resetHealthEndpoint } from '@/domain/ops/healthEndpoint'

const NOW = new Date('2026-11-05T10:00:00Z')
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()
let nextId = 1
const run = (job: string, status: JobRunRow['status'], startedMin: number, over: Partial<JobRunRow> = {}): JobRunRow => ({
  id: nextId++,
  job_name: job,
  status,
  started_at: ago(startedMin),
  finished_at: status === 'running' ? null : ago(startedMin - 1),
  locked_until: null,
  error: null,
  ...over,
})

describe('classifyJobError', () => {
  it('pozná kódy z konvence i surové hlášky Google / Anthropic', () => {
    expect(classifyJobError('gmail_oauth')).toBe('gmail_oauth')
    expect(classifyJobError('Google token: invalid_grant (Token has been expired or revoked.)')).toBe('gmail_oauth')
    expect(classifyJobError('model_credit')).toBe('model_credit')
    expect(classifyJobError('400 Your credit balance is too low to access the Anthropic API')).toBe('model_credit')
    expect(classifyJobError('timeout')).toBeNull()
    expect(classifyJobError(null)).toBeNull()
  })
})

describe('statsSignals (chyby Gmail OAuth a fronty P2/P3 ze statistik běhu)', () => {
  it('agent poptávek: neplatný token schránky, výpadek čtení, selhané poptávky', () => {
    expect(statsSignals('inquiry-agent', { mailbox: { errors: { token_invalid_grant: 1 } }, agent: { failed: 0 } })).toEqual(['gmail_oauth'])
    expect(statsSignals('inquiry-agent', { mailbox: { error: 'Google: invalid_grant' }, agent: {} })).toEqual(['gmail_oauth'])
    expect(statsSignals('inquiry-agent', { mailbox: { errors: { token_error: 1 } }, agent: { failed: 2 } })).toEqual(['queue_error'])
    expect(statsSignals('inquiry-agent', { mailbox: { errors: {} }, agent: { failed: 0 } })).toEqual([])
  })

  it('odchozí fronta: token / 401 = gmail_oauth, selhané nebo nejisté zprávy = queue_error', () => {
    expect(statsSignals('agent-outbox', { reasons: { token_invalid_grant: 3 }, failed: 0, uncertain: 0 })).toEqual(['gmail_oauth'])
    expect(statsSignals('agent-outbox', { reasons: { unauthorized: 1 }, failed: 1, uncertain: 0 })).toEqual(['gmail_oauth', 'queue_error'])
    expect(statsSignals('agent-outbox', { reasons: { token_not_configured: 1 }, failed: 0, uncertain: 1 })).toEqual(['queue_error'])
    expect(statsSignals('agent-outbox', { status: 'waiting_for_migration' })).toEqual([])
    expect(statsSignals('ares-enrich', { failed: 5 })).toEqual([])
  })

  it('assessOps bere jen poslední úspěšný běh a signál nese název úlohy', () => {
    const h = assessOps({
      now: NOW,
      stuckQueues: [],
      jobRows: [
        { ...run('agent-outbox', 'succeeded', 2), stats: { reasons: { token_invalid_grant: 1 }, failed: 0, uncertain: 0 } },
        { ...run('agent-outbox', 'succeeded', 7), stats: { failed: 4 } },
        { ...run('inquiry-agent', 'succeeded', 3), stats: { mailbox: { errors: {} }, agent: { failed: 0 } } },
      ],
    })
    expect(h.signals).toEqual([{ code: 'gmail_oauth', subject: 'agent-outbox', since: ago(2) }])
    expect(renderAlarmText(h.signals, null)).toMatch(/Gmail/)
  })
})

describe('assessOps', () => {
  it('vše v pořádku → ok a prázdný otisk', () => {
    const h = assessOps({ jobRows: [run('inquiry-agent', 'succeeded', 3), run('agent-outbox', 'succeeded', 1)], stuckQueues: [], now: NOW })
    expect(h).toEqual({ status: 'ok', signals: [], fingerprint: '' })
  })

  it('selhání úlohy se klasifikuje (token Gmailu, kredit modelu, obecné)', () => {
    const h = assessOps({
      now: NOW,
      stuckQueues: [],
      jobRows: [
        run('inquiry-agent', 'failed', 4, { error: 'model_credit' }),
        run('agent-outbox', 'failed', 3, { error: 'invalid_grant' }),
        run('ares-enrich', 'failed', 300, { error: 'ARES 503' }),
      ],
    })
    expect(h.status).toBe('degraded')
    expect(h.signals.map((s) => [s.code, s.subject])).toEqual([
      ['gmail_oauth', 'agent-outbox'],
      ['job_failed', 'ares-enrich'],
      ['model_credit', 'inquiry-agent'],
    ])
  })

  it('úspěšný běh po selhání problém ruší', () => {
    const h = assessOps({ now: NOW, stuckQueues: [], jobRows: [run('agent-outbox', 'failed', 9, { error: 'x' }), run('agent-outbox', 'succeeded', 4)] })
    expect(h.signals).toEqual([])
  })

  it('visící běh s vypršelým zámkem = job_stuck', () => {
    const h = assessOps({ now: NOW, stuckQueues: [], jobRows: [run('inquiry-agent', 'running', 12, { locked_until: ago(6) })] })
    expect(h.signals.map((s) => s.code)).toEqual(['job_stuck'])
  })

  it('ticho sledované úlohy nad limit = job_silent; vypnutá úloha (24 h bez běhu) ne', () => {
    const silent = assessOps({ now: NOW, stuckQueues: [], jobRows: [run('inquiry-agent', 'succeeded', 45)] })
    expect(silent.signals).toEqual([{ code: 'job_silent', subject: 'inquiry-agent', since: ago(45) }])
    const off = assessOps({ now: NOW, stuckQueues: [], jobRows: [run('inquiry-agent', 'succeeded', 25 * 60)] })
    expect(off.signals.filter((s) => s.code === 'job_silent')).toEqual([])
  })

  it('stojící fronta = queue_stuck; otisk nezávisí na času', () => {
    const a = assessOps({ now: NOW, jobRows: [], stuckQueues: [{ subject: 'web_inquiry:new', since: ago(30) }] })
    const b = assessOps({ now: NOW, jobRows: [], stuckQueues: [{ subject: 'web_inquiry:new', since: ago(40) }] })
    expect(a.signals[0].code).toBe('queue_stuck')
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(fingerprintSignals([{ code: 'queue_stuck', subject: 'agent_outbox:claimed', since: null }]))
  })

  it('OPS_EXPECTED_JOBS přepíše sledované úlohy; nesmysl se ignoruje', () => {
    expect(expectedJobsFromEnv({})).toEqual({ 'inquiry-agent': 20, 'agent-outbox': 20 })
    expect(expectedJobsFromEnv({ OPS_EXPECTED_JOBS: 'gmail-sync:10, x:1, BAD:20' })).toEqual({ 'gmail-sync': 10 })
  })
})

describe('text alarmu', () => {
  it('je česky a nenese chybovou hlášku úlohy', () => {
    const h = assessOps({ now: NOW, stuckQueues: [], jobRows: [run('inquiry-agent', 'failed', 4, { error: 'invalid_grant pro jan.novak@example.cz' })] })
    const text = renderAlarmText(h.signals, 'https://www.example.cz/')
    expect(text).toMatch(/neplatný nebo odvolaný přístup ke Gmailu/)
    expect(text).toMatch(/https:\/\/www\.example\.cz\/cockpit\/nastaveni/)
    expect(text).not.toContain('jan.novak')
    expect(renderAlarmText([], null)).toMatch(/vyřešené/)
  })
})

describe('decideAlarm (potlačení opakování)', () => {
  const degraded = assessOps({ now: NOW, jobRows: [], stuckQueues: [{ subject: 'web_inquiry:new', since: null }] })
  const ok = assessOps({ now: NOW, jobRows: [], stuckQueues: [] })

  it('nový problém se oznámí, stejný do intervalu ne, po intervalu znovu', () => {
    expect(decideAlarm(degraded, null, NOW, 180)).toEqual({ send: true, kind: 'alarm' })
    expect(decideAlarm(degraded, { fingerprint: degraded.fingerprint, at: ago(30) }, NOW, 180)).toEqual({ send: false })
    expect(decideAlarm(degraded, { fingerprint: degraded.fingerprint, at: ago(181) }, NOW, 180)).toEqual({ send: true, kind: 'alarm' })
  })

  it('vyřešení se oznámí jednou', () => {
    expect(decideAlarm(ok, { fingerprint: degraded.fingerprint, at: ago(10) }, NOW, 180)).toEqual({ send: true, kind: 'resolved' })
    expect(decideAlarm(ok, { fingerprint: '', at: ago(5) }, NOW, 180)).toEqual({ send: false })
    expect(decideAlarm(ok, null, NOW, 180)).toEqual({ send: false })
  })

  it('interval z env jen v rozumných mezích', () => {
    expect(repeatMinutesFromEnv({})).toBe(180)
    expect(repeatMinutesFromEnv({ OPS_ALARM_REPEAT_MINUTES: '60' })).toBe(60)
    expect(repeatMinutesFromEnv({ OPS_ALARM_REPEAT_MINUTES: '1' })).toBe(180)
  })
})

describe('webhook alarmu', () => {
  it('jen https', () => {
    expect(alarmWebhookUrl({ ALERT_WEBHOOK_URL: 'https://hook.example/x' })).toBe('https://hook.example/x')
    expect(alarmWebhookUrl({ ALERT_WEBHOOK_URL: 'http://hook.example/x' })).toBeNull()
    expect(alarmWebhookUrl({})).toBeNull()
  })

  it('POST s textem a kódy; chyba sítě vrátí false bez výjimky', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    const signals = [{ code: 'model_credit' as const, subject: 'inquiry-agent', since: null }]
    expect(await postAlarm('https://hook.example/x', signals, null, f as unknown as typeof fetch)).toBe(true)
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.signals).toEqual([{ code: 'model_credit', subject: 'inquiry-agent', since: null }])
    expect(body.text).toMatch(/kredit/)
    const broken = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect(await postAlarm('https://hook.example/x', signals, null, broken as unknown as typeof fetch)).toBe(false)
  })
})

// --- Fake Supabase pro routy ------------------------------------------------

type Result = { data: unknown; error: { code: string } | null }
function fakeDb(tables: Record<string, Result>, inserts: unknown[] = []) {
  return {
    from(table: string) {
      const res = tables[table] ?? { data: [], error: null }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'gte', 'lt', 'eq', 'order', 'neq']) chain[m] = () => chain
      chain.limit = async () => res
      chain.insert = async (row: unknown) => { inserts.push({ table, row }); return { error: null } }
      return chain
    },
  }
}

describe('loadStuckQueues', () => {
  it('chybějící tabulka balíku se přeskočí, jiná chyba = výjimka', async () => {
    const db = fakeDb({
      web_inquiry: { data: [{ received_at: ago(30) }], error: null },
      inquiry_agent_run: { data: null, error: { code: '42P01' } },
      agent_outbox: { data: null, error: { code: '42703' } },
    })
    const out = await loadStuckQueues(db as never, NOW)
    expect(out.map((q) => q.subject)).toEqual(['web_inquiry:new', 'web_inquiry:processing'])
    const broken = fakeDb({ web_inquiry: { data: null, error: { code: '57014' } } })
    await expect(loadStuckQueues(broken as never, NOW)).rejects.toThrow(/web_inquiry/)
  })
})

describe('/api/health', () => {
  beforeEach(() => {
    resetHealthEndpoint()
    vi.mocked(createAdminClient).mockReset()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })
  const call = async (url = 'https://x/api/health', headers: Record<string, string> = {}) => {
    const { GET } = await import('@/app/api/health/route')
    const res = await GET(new Request(url, { headers }))
    return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }
  }

  it('ok bez detailů; detail jen se správným HEALTH_TOKEN', async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeDb({}) as never)
    vi.stubEnv('HEALTH_TOKEN', 'h-token')
    const pub = await call()
    expect(pub.status).toBe(200)
    expect(Object.keys(pub.body).sort()).toEqual(['checkedAt', 'status'])
    expect(pub.cache).toBe('no-store')
    expect((await call('https://x/api/health', { authorization: 'Bearer spatne' })).body.signals).toBeUndefined()
    expect((await call('https://x/api/health', { authorization: 'Bearer h-token' })).body.signals).toEqual([])
  })

  it('degraded → 200, se strict=1 → 503; nedostupná DB → down 503', async () => {
    vi.mocked(createAdminClient).mockReturnValue(fakeDb({ web_inquiry: { data: [{ received_at: ago(30) }], error: null } }) as never)
    expect((await call()).body.status).toBe('degraded')
    expect((await call()).status).toBe(200)
    expect((await call('https://x/api/health?strict=1')).status).toBe(503)
    resetHealthEndpoint()
    vi.mocked(createAdminClient).mockReturnValue(fakeDb({ job_run: { data: null, error: { code: '08006' } } }) as never)
    const down = await call()
    expect(down).toMatchObject({ status: 503, body: { status: 'down' } })
  })

  it('výsledek kontroly se 30 s drží v paměti: opakované volání nesahá do DB', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const db = fakeDb({})
    const from = vi.spyOn(db, 'from')
    vi.mocked(createAdminClient).mockReturnValue(db as never)
    const first = await call()
    const reads = from.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    vi.setSystemTime(new Date(NOW.getTime() + HEALTH_CACHE_MS - 1000))
    const second = await call()
    expect(from.mock.calls.length).toBe(reads)
    expect(second.body).toEqual(first.body)
    // Po vypršení cache nová kontrola.
    vi.setSystemTime(new Date(NOW.getTime() + HEALTH_CACHE_MS + 1))
    const third = await call()
    expect(from.mock.calls.length).toBe(reads * 2)
    expect(third.body.checkedAt).not.toBe(first.body.checkedAt)
  })

  it('výpadek DB se také krátce cachuje (výpadek nezhorší zahlcení)', async () => {
    vi.mocked(createAdminClient).mockImplementation(() => { throw new Error('chybí SUPABASE_SERVICE_ROLE_KEY') })
    expect((await call()).status).toBe(503)
    expect((await call()).status).toBe(503)
    expect(createAdminClient).toHaveBeenCalledTimes(1)
  })

  it('limit na IP adresu: nad limitem 429 bez dotazu do DB; jiná adresa a HEALTH_TOKEN projdou', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    vi.mocked(createAdminClient).mockReturnValue(fakeDb({}) as never)
    vi.stubEnv('HEALTH_TOKEN', 'h-token')
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    for (let i = 0; i < HEALTH_RATE_LIMIT; i++) expect((await call('https://x/api/health', ip)).status).toBe(200)
    const calls = vi.mocked(createAdminClient).mock.calls.length
    // Cache vypršela (31 s), okno limitu (60 s) ne: odmítnutí nesmí sáhnout do DB.
    vi.setSystemTime(new Date(NOW.getTime() + HEALTH_CACHE_MS + 1000))
    const limited = await call('https://x/api/health', ip)
    expect(limited).toMatchObject({ status: 429, body: { status: 'rate_limited' }, cache: 'no-store' })
    expect(vi.mocked(createAdminClient).mock.calls.length).toBe(calls)
    expect((await call('https://x/api/health', { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200)
    expect((await call('https://x/api/health', { ...ip, authorization: 'Bearer h-token' })).status).toBe(200)
  })
})

describe('/api/cron/ops-alarm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const call = async (auth = 'Bearer s3cret') => {
    const { GET } = await import('@/app/api/cron/ops-alarm/route')
    const res = await GET(new Request('https://x/api/cron/ops-alarm', { headers: { authorization: auth } }))
    return { status: res.status, body: res.status === 404 ? null : await res.json() }
  }

  it('bez OPS_ALARM_ENABLED=true 404 a nic nečte', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('OPS_ALARM_ENABLED', '1')
    expect((await call()).status).toBe(404)
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('špatný Bearer 401', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('OPS_ALARM_ENABLED', 'true')
    expect((await call('Bearer x')).status).toBe(401)
  })

  it('problém → oznámení na webhook a zápis do job_run; bez problému nic', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('OPS_ALARM_ENABLED', 'true')
    vi.stubEnv('ALERT_WEBHOOK_URL', 'https://hook.example/alarm')
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const inserts: unknown[] = []
    vi.mocked(createAdminClient).mockReturnValue(fakeDb({
      job_run: { data: [run('inquiry-agent', 'failed', 4, { error: 'model_credit' })], error: null },
    }, inserts) as never)
    const r = await call()
    expect(r.body).toMatchObject({ notified: true, kind: 'alarm', signals: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(inserts).toHaveLength(1)
    expect(JSON.stringify(inserts[0])).toMatch(/"notified":true/)

    fetchMock.mockClear()
    vi.mocked(createAdminClient).mockReturnValue(fakeDb({}, inserts) as never)
    expect((await call()).body).toMatchObject({ notified: false, status: 'ok' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('vercel.json pro nasazení (P8)', () => {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as {
    regions?: string[]
    crons: { path: string; schedule: string }[]
  }
  const every = (path: string) => cfg.crons.find((c) => c.path === path)?.schedule

  it('region fra1 (Frankfurt, blízko Supabase EU)', () => {
    expect(cfg.regions).toEqual(['fra1'])
  })

  it('agent, outbox a alarm nejvýš po 5 minutách', () => {
    for (const p of ['/api/cron/inquiry-agent', '/api/cron/agent-outbox', '/api/cron/ops-alarm']) {
      expect(every(p), p).toMatch(/^(\*|\d+-59)\/5 \* \* \* \*$/)
    }
  })

  it('každá cron cesta, jejíž routa v repu je, ověřuje CRON_SECRET', () => {
    for (const c of cfg.crons) {
      const file = join(__dirname, '..', 'app', c.path, 'route.ts')
      if (existsSync(file)) expect(readFileSync(file, 'utf8'), c.path).toMatch(/CRON_SECRET/)
    }
  })

  it('úlohy agenta (až je dodají P2/P3) mají maxDuration 300', () => {
    for (const p of ['inquiry-agent', 'agent-outbox']) {
      const file = join(__dirname, '..', 'app', 'api', 'cron', p, 'route.ts')
      if (existsSync(file)) expect(readFileSync(file, 'utf8'), p).toMatch(/export const maxDuration = 300\b/)
    }
  })
})
