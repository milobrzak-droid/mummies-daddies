import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryDb, type Row } from './helpers/memoryDb'

// Upřesnění odpojování konektoru „Cockpit" (Claude): každé odmítnutí
// na /api/oauth/token a každé 401 na /api/mcp se zapíše do audit_event
// s důvodem (bez tajemství); přehled připojení v /api-klice a hlídání za
// 24 h (Stav úloh, ranní souhrn). Pravidla tokenů se nemění — odpovědi
// klientovi musí zůstat stejné (to hlídá i test/oauth-token.test.ts).

let db: MemoryDb
let seq = 0
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { POST as token } from '@/app/api/oauth/token/route'
import { POST as mcpPost } from '@/app/api/mcp/route'
import { GET as asMeta } from '@/app/.well-known/oauth-authorization-server/route'
import { GET as prMeta } from '@/app/.well-known/oauth-protected-resource/api/mcp/route'
import { hashApiKey } from '@/lib/apiKeyAuth'
import {
  OAUTH_AUDIT_ACTION, OAUTH_AUDIT_ENTITY, OAUTH_AUDIT_GLOBAL_CAP, admitOAuthAudit, recordOAuthProblem,
  resetOAuthAuditThrottle, revocationCause, safeClientId, safeClientName, type OAuthProblemPayload,
} from '@/lib/oauthDiagnostics'
import {
  assessOAuthHealth, buildOAuthConnections, buildOAuthProblems, loadOAuthHealth, loadOAuthOverview, oauthHealthStatus,
  type AuditRowLite,
} from '@/lib/oauthOverview'
import { buildDigest } from '@/domain/crm/digest'
import { OAuthConnectionsCard } from '@/components/OAuthConnectionsCard'
import { JobHealthCard } from '@/components/JobHealthCard'

const VERIFIER = 'verifier-verifier-verifier-verifier-verifier-123'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const MIN = 60_000

function makeDb() {
  seq = 0
  return new MemoryDb({
    defaults: {
      api_key: () => ({ created_at: new Date(1_700_000_000_000 + ++seq * 1000).toISOString(), last_used_at: null }),
      oauth_refresh_token: () => ({ created_at: new Date(Date.now() + ++seq).toISOString() }),
      audit_event: () => ({ occurred_at: new Date().toISOString() }),
    },
  })
}

function seed() {
  db.seed('oauth_client', [
    { client_id: 'cockpit-client_aaa111', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] },
    { client_id: 'cockpit-client_bbb222', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] },
  ])
  db.seed('team_member', [
    { id: 'user-1', role: 'vedeni', deactivated_at: null, full_name: 'Viktor' },
    { id: 'user-2', role: 'lektor', deactivated_at: null, full_name: 'Eva' },
  ])
}

function codeRow(over: Row = {}): Row {
  return {
    code: `code-${++seq}`, client_id: 'cockpit-client_aaa111', redirect_uri: 'https://claude.ai/cb', code_challenge: CHALLENGE,
    approved_by: 'user-1', expires_at: new Date(Date.now() + 60_000).toISOString(), scope: 'read', ...over,
  }
}
function codeReq(code: string, fields: Record<string, string> = {}): Request {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, client_id: 'cockpit-client_aaa111',
    redirect_uri: 'https://claude.ai/cb', code_verifier: VERIFIER, ...fields,
  })
  return new Request('http://localhost/api/oauth/token', { method: 'POST', body })
}
function refreshReq(refresh_token: string, fields: Record<string, string> = {}): Request {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id: 'cockpit-client_aaa111', ...fields })
  return new Request('http://localhost/api/oauth/token', { method: 'POST', body })
}
type Tokens = { access_token: string; refresh_token: string }
async function connect(over: Row = {}): Promise<Tokens> {
  const row = codeRow(over)
  db.seed('oauth_code', [row])
  const res = await token(codeReq(String(row.code), { client_id: String(row.client_id) }))
  expect(res.status).toBe(200)
  return res.json()
}
function mcpReq(bearer?: string): Request {
  return new Request('https://cockpit.example/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: '{}',
  })
}
const events = () => db.rows('audit_event').filter((e) => e.action === OAUTH_AUDIT_ACTION)
const payloads = () => events().map((e) => e.after as OAuthProblemPayload)
const lastPayload = () => payloads().at(-1)!
const keyByPlain = (plain: string) => db.rows('api_key').find((k) => k.key_hash === hashApiKey(plain))!

beforeEach(() => {
  db = makeDb()
  resetOAuthAuditThrottle()
})
afterEach(() => vi.useRealTimers())

describe('token endpoint — důvod odmítnutí v audit_event', () => {
  it('neznámý refresh token: unknown_token, odpověď beze změny (400 invalid_grant, no-store)', async () => {
    seed()
    const res = await token(refreshReq('cockpit_rt_neznamy'))
    expect(res.status).toBe(400)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await res.json()).error).toBe('invalid_grant')
    expect(events()).toHaveLength(1)
    expect(events()[0]).toMatchObject({ actor_type: 'system', entity_table: OAUTH_AUDIT_ENTITY })
    expect(lastPayload()).toMatchObject({ source: 'token', reason: 'unknown_token', grant_type: 'refresh_token', client_id: 'cockpit-client_aaa111', client_name: 'Claude' })
  })

  it('cizí client_id: client_mismatch s rodinou; rodina se nezruší', async () => {
    seed()
    const t = await connect()
    await token(refreshReq(t.refresh_token, { client_id: 'cockpit-client_bbb222' }))
    const p = lastPayload()
    expect(p).toMatchObject({ reason: 'client_mismatch', client_id: 'cockpit-client_aaa111' })
    expect(p.family_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.revoked).toBeUndefined()
  })

  it('souběh do 10 s: refresh_reuse_in_grace, bez zrušení', async () => {
    seed()
    const t = await connect()
    expect((await token(refreshReq(t.refresh_token))).status).toBe(200)
    expect((await token(refreshReq(t.refresh_token))).status).toBe(400)
    expect(lastPayload()).toMatchObject({ reason: 'refresh_reuse_in_grace' })
    expect(lastPayload().revoked).toBeUndefined()
  })

  it('reuse po >10 s: family_revoked_reuse se seznamem zrušených klíčů; další pokus = revoked (dřív: reuse)', async () => {
    seed()
    const first = await connect()
    const second: Tokens = await (await token(refreshReq(first.refresh_token))).json()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + MIN)
    await token(refreshReq(first.refresh_token))
    const p = lastPayload()
    expect(p).toMatchObject({ reason: 'family_revoked_reuse', revoked: true })
    expect(p.revoked_key_ids!.sort()).toEqual([keyByPlain(first.access_token).id, keyByPlain(second.access_token).id].sort())

    await token(refreshReq(second.refresh_token))
    expect(lastPayload()).toMatchObject({ reason: 'revoked', revoked_by: 'family_revoked_reuse' })
  })

  it('vypršelý refresh token: expired', async () => {
    seed()
    const t = await connect()
    db.rows('oauth_refresh_token')[0].expires_at = new Date(Date.now() - 1000).toISOString()
    await token(refreshReq(t.refresh_token))
    expect(lastPayload().reason).toBe('expired')
  })

  it('deaktivovaný schvalovatel: owner_inactive a zrušení rodiny', async () => {
    seed()
    const t = await connect()
    db.rows('team_member')[0].deactivated_at = new Date().toISOString()
    await token(refreshReq(t.refresh_token))
    expect(lastPayload()).toMatchObject({ reason: 'owner_inactive', revoked: true, revoked_key_ids: [keyByPlain(t.access_token).id] })
  })

  it('6. připojení téhož klienta: událost pruned; refresh zrušeného = revoked (dřív: pruned)', async () => {
    seed()
    const all: Tokens[] = []
    for (let i = 0; i < 6; i++) all.push(await connect())
    const pruned = payloads().filter((p) => p.reason === 'pruned')
    expect(pruned).toHaveLength(1)
    expect(pruned[0]).toMatchObject({ revoked: true, revoked_key_ids: [keyByPlain(all[0].access_token).id], client_name: 'Claude' })
    await token(refreshReq(all[0].refresh_token))
    expect(lastPayload()).toMatchObject({ reason: 'revoked', revoked_by: 'pruned' })
  })

  it('výměna kódu: invalid_code, code_expired, pkce_failed, redirect_mismatch, no_approver, client_mismatch', async () => {
    seed()
    await token(codeReq('neexistuje'))
    db.seed('oauth_code', [codeRow({ code: 'old', expires_at: new Date(Date.now() - 1000).toISOString() })])
    await token(codeReq('old'))
    db.seed('oauth_code', [codeRow({ code: 'pk' })])
    await token(codeReq('pk', { code_verifier: 'spatny' }))
    db.seed('oauth_code', [codeRow({ code: 'rd' })])
    await token(codeReq('rd', { redirect_uri: 'https://claude.ai/jina' }))
    db.seed('oauth_code', [codeRow({ code: 'na', approved_by: null })])
    await token(codeReq('na'))
    db.seed('oauth_code', [codeRow({ code: 'cm', client_id: 'cockpit-client_bbb222' })])
    await token(codeReq('cm'))
    expect(payloads().map((p) => p.reason)).toEqual(['invalid_code', 'code_expired', 'pkce_failed', 'redirect_mismatch', 'no_approver', 'client_mismatch'])
    expect(payloads().every((p) => p.grant_type === 'authorization_code')).toBe(true)
  })

  it('neúplný požadavek a neznámý grant_type', async () => {
    await token(new Request('http://localhost/api/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }) }))
    await token(new Request('http://localhost/api/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'x' }) }))
    expect(payloads().map((p) => p.reason)).toEqual(['invalid_request', 'unsupported_grant_type'])
  })

  it('v audit_event není žádný token, kód, verifier ani hash', async () => {
    seed()
    const first = await connect()
    const second: Tokens = await (await token(refreshReq(first.refresh_token))).json()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + MIN)
    await token(refreshReq(first.refresh_token))
    await mcpPost(mcpReq(second.access_token))
    await token(codeReq('tajny-kod-123', { code_verifier: VERIFIER }))
    const dump = JSON.stringify(db.rows('audit_event'))
    expect(events().length).toBeGreaterThanOrEqual(3)
    for (const secret of [first.access_token, first.refresh_token, second.access_token, second.refresh_token, VERIFIER, 'tajny-kod-123']) {
      expect(dump).not.toContain(secret)
      expect(dump).not.toContain(hashApiKey(secret))
      expect(dump).not.toContain(secret.slice(0, 16))
    }
  })
})

describe('/api/mcp — 401 s důvodem a WWW-Authenticate', () => {
  it('bez tokenu (discovery): 401, WWW-Authenticate bez error, nic se nezapíše', async () => {
    const res = await mcpPost(mcpReq())
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://cockpit.example/.well-known/oauth-protected-resource/api/mcp"',
    )
    expect(events()).toHaveLength(0)
  })

  it('neznámý token: error="invalid_token" + resource_metadata, záznam unknown_token', async () => {
    const res = await mcpPost(mcpReq('cockpit_neznamy'))
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://cockpit.example/.well-known/oauth-protected-resource/api/mcp"',
    )
    expect(lastPayload()).toMatchObject({ source: 'mcp', reason: 'unknown_token' })
  })

  it('starý access token po rotaci (>5 min): expired + family_active (klient poslal starý token)', async () => {
    seed()
    const first = await connect()
    expect((await mcpPost(mcpReq(first.access_token))).status).not.toBe(401)
    await token(refreshReq(first.refresh_token))
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 6 * MIN)
    const res = await mcpPost(mcpReq(first.access_token))
    expect(res.status).toBe(401)
    expect(lastPayload()).toMatchObject({
      source: 'mcp', reason: 'expired', family_active: true, key_kind: 'oauth', client_name: 'Claude',
      api_key_id: keyByPlain(first.access_token).id,
    })
  })

  it('token zrušený pravidlem prune: revoked + revoked_by pruned', async () => {
    seed()
    const all: Tokens[] = []
    for (let i = 0; i < 6; i++) all.push(await connect())
    await mcpPost(mcpReq(all[0].access_token))
    expect(lastPayload()).toMatchObject({ source: 'mcp', reason: 'revoked', revoked_by: 'pruned', family_active: false })
  })

  it('ruční klíč s deaktivovaným vlastníkem: owner_inactive, key_kind manual', async () => {
    seed()
    db.seed('api_key', [{ id: 500, name: 'Claude Code', key_hash: hashApiKey('cockpit_rucni'), created_by: 'user-2', scope: 'full', revoked_at: null }])
    db.rows('team_member')[1].deactivated_at = new Date().toISOString()
    await mcpPost(mcpReq('cockpit_rucni'))
    expect(lastPayload()).toMatchObject({ reason: 'owner_inactive', owner_state: 'deactivated', key_kind: 'manual', api_key_id: 500 })
  })

  it('stejný neplatný token opakovaně: jeden záznam za minutu, další nese repeats', async () => {
    for (let i = 0; i < 4; i++) await mcpPost(mcpReq('cockpit_neznamy'))
    expect(events()).toHaveLength(1)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + MIN + 1)
    await mcpPost(mcpReq('cockpit_neznamy'))
    expect(events()).toHaveLength(2)
    expect(lastPayload().repeats).toBe(3)
  })

  it('výpadek zápisu auditu nezmění odpověď', async () => {
    db = new MemoryDb({ fail: (t, op) => (t === 'audit_event' && op === 'insert' ? { code: 'XX000', message: 'boom' } : null) })
    const res = await mcpPost(mcpReq('cockpit_neznamy'))
    expect(res.status).toBe(401)
  })
})

describe('brzda a sanitizace', () => {
  it('globální strop za minutu; zrušení připojení projde vždy', () => {
    const now = 1_000_000
    for (let i = 0; i < OAUTH_AUDIT_GLOBAL_CAP; i++) expect(admitOAuthAudit(`k${i}`, now).ok).toBe(true)
    expect(admitOAuthAudit('dalsi', now).ok).toBe(false)
    expect(admitOAuthAudit('zruseni', now, true).ok).toBe(true)
    expect(admitOAuthAudit('dalsi', now + MIN).ok).toBe(true)
  })

  it('client_id z formuláře jen v bezpečném tvaru; client_name bez řídicích znaků a zkrácený', () => {
    expect(safeClientId('cockpit-client_abc')).toBe('cockpit-client_abc')
    expect(safeClientId('<script>')).toBe('invalid')
    expect(safeClientId('')).toBeNull()
    expect(safeClientName('Claude\u0000\n')).toBe('Claude')
    expect(safeClientName('x'.repeat(300))!.length).toBe(100)
  })

  it('revocationCause: poslední zrušení s daným klíčem', async () => {
    await recordOAuthProblem(db.client as never, { source: 'cockpit', reason: 'manual_revoke', revokedKeyIds: [7, 8], actorUserId: 'user-1' })
    expect(await revocationCause(db.client as never, 8)).toBe('manual_revoke')
    expect(await revocationCause(db.client as never, 9)).toBeNull()
    expect(events()[0]).toMatchObject({ actor_type: 'user', actor_id: 'user-1' })
  })
})

describe('přehled připojení a hlídání', () => {
  const NOW = new Date('2026-10-08T08:00:00Z')
  const iso = (minAgo: number) => new Date(NOW.getTime() - minAgo * MIN).toISOString()
  const ev = (id: number, minAgo: number, after: OAuthProblemPayload): AuditRowLite => ({ id, occurred_at: iso(minAgo), after })
  const fam = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
  const rt = (familyId: string, o: Partial<Record<string, unknown>> = {}) => ({
    family_id: familyId, client_id: 'c1', approved_by: 'user-1', scope: 'full', api_key_id: 1,
    expires_at: new Date(NOW.getTime() + 100 * 86_400_000).toISOString(), used_at: null, revoked_at: null, created_at: iso(60), ...o,
  })

  it('stav: aktivní / prošlé / zrušené s důvodem z události', () => {
    const conns = buildOAuthConnections({
      refreshRows: [
        rt(fam(1), { api_key_id: 1 }),
        rt(fam(2), { api_key_id: 2, expires_at: iso(10) }),
        rt(fam(3), { api_key_id: 3, revoked_at: iso(5) }),
        rt(fam(4), { api_key_id: 4, revoked_at: iso(5) }),
      ],
      keys: [{ id: 1, last_used_at: iso(1), revoked_at: null }, { id: 3, last_used_at: null, revoked_at: iso(5) }],
      clients: [{ client_id: 'c1', client_name: 'Claude' }],
      members: [{ id: 'user-1', full_name: 'Viktor', deactivated_at: null }],
      events: [ev(1, 5, { source: 'token', reason: 'family_revoked_reuse', family_id: fam(3), revoked: true, revoked_key_ids: [3] })],
      now: NOW,
    })
    const by = new Map(conns.map((c) => [c.familyId, c]))
    expect(conns[0].familyId).toBe(fam(1))
    expect(by.get(fam(1))).toMatchObject({ status: 'active', clientName: 'Claude', approverName: 'Viktor', scope: 'full', lastUsedAt: iso(1) })
    expect(by.get(fam(2))).toMatchObject({ status: 'expired' })
    expect(by.get(fam(3))!.status).toBe('revoked')
    expect(by.get(fam(3))!.reason).toContain('po víc než 10 s')
    expect(by.get(fam(4))!.reason).toContain('bez záznamu důvodu')
  })

  it('posledních 20 problémů: nejnovější první, s doplňkem k důvodu', () => {
    const list = buildOAuthProblems(
      Array.from({ length: 25 }, (_, i) => ev(i + 1, i, { source: 'mcp', reason: 'expired', family_id: fam(1), family_active: true, client_id: 'c1' })),
      [{ client_id: 'c1', client_name: 'Claude' }],
    )
    expect(list).toHaveLength(20)
    expect(list[0].id).toBe(1)
    expect(list[0]).toMatchObject({ clientName: 'Claude', connection: fam(1).slice(-6) })
    expect(list[0].reason).toContain('klient poslal starý')
  })

  it('24 h: zrušení rodiny nebo opakované 401 u platného připojení = alert; ruční zrušení ne', () => {
    expect(assessOAuthHealth([ev(1, 10, { source: 'cockpit', reason: 'manual_revoke', revoked: true, revoked_key_ids: [1] })], NOW).alert).toBe(false)
    const reuse = assessOAuthHealth([ev(1, 10, { source: 'token', reason: 'family_revoked_reuse', revoked: true, revoked_key_ids: [1] })], NOW)
    expect(reuse).toMatchObject({ alert: true, revocations: 1 })
    const old = assessOAuthHealth([ev(1, 25 * 60, { source: 'token', reason: 'pruned', revoked: true, revoked_key_ids: [1] })], NOW)
    expect(old.alert).toBe(false)
    const twice = [ev(1, 10, { source: 'mcp', reason: 'expired', family_id: fam(1), family_active: true })]
    expect(assessOAuthHealth(twice, NOW).alert).toBe(false)
    const repeated = [...twice, ev(2, 5, { source: 'mcp', reason: 'expired', family_id: fam(1), family_active: true, repeats: 4 })]
    expect(assessOAuthHealth(repeated, NOW)).toMatchObject({ alert: true, repeated401Connections: 1 })
    expect(oauthHealthStatus(assessOAuthHealth(repeated, NOW))!.line).toMatch(/^Konektor Claude za 24 h: 1× připojení s opakovaným 401/)
    expect(oauthHealthStatus(assessOAuthHealth([], NOW))).toBeNull()
  })

  it('ranní souhrn: řádek ve Stavu zdrojů jen při problému a počítá se do sourceAlerts', () => {
    const base = {
      followUps: [], outreach: [], blockedDeals: [], lastMeetingNoteAt: null, outlookMailSyncEnabled: false, generatedAt: NOW,
      connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null },
    }
    const without = buildDigest(base)
    const ok = buildDigest({ ...base, oauthHealth: assessOAuthHealth([], NOW) })
    expect(ok.sources.lines).toEqual(without.sources.lines)
    const bad = buildDigest({ ...base, oauthHealth: assessOAuthHealth([ev(1, 10, { source: 'token', reason: 'family_revoked_reuse', revoked: true, revoked_key_ids: [1] })], NOW) })
    expect(bad.sources.lines.at(-1)).toMatch(/^Konektor Claude za 24 h: 1× zrušené připojení/)
    expect(bad.sourceAlerts).toBe(without.sourceAlerts + 1)
  })

  it('Stav úloh v Nastavení ukáže problém konektoru s odkazem', () => {
    const health = { windowDays: 7, problems: [], failuresInWindow: 0, jobsSeen: 3, recentProblem: false }
    const oauth = assessOAuthHealth([ev(1, 10, { source: 'token', reason: 'pruned', revoked: true, revoked_key_ids: [1] })], NOW)
    const html = renderToStaticMarkup(JobHealthCard({ health, oauth }))
    expect(html).toContain('Konektor Claude')
    expect(html).toContain('/cockpit/api-klice#pripojeni-claude')
    expect(html).toContain('Problém')
    expect(renderToStaticMarkup(JobHealthCard({ health }))).not.toContain('Konektor Claude')
  })

  it('end-to-end: loadOAuthOverview po reuse ukáže zrušené připojení s důvodem; karta se vykreslí', async () => {
    seed()
    const first = await connect({ scope: 'full' })
    const keep = await connect()
    await token(refreshReq(first.refresh_token))
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + MIN)
    await token(refreshReq(first.refresh_token))
    const overview = await loadOAuthOverview(db.client as never, new Date())
    expect(overview.available).toBe(true)
    const revoked = overview.connections.find((c) => c.status === 'revoked')!
    expect(revoked).toMatchObject({ clientName: 'Claude', approverName: 'Viktor', scope: 'full' })
    expect(revoked.reason).toContain('po víc než 10 s')
    expect(overview.connections.filter((c) => c.status === 'active')).toHaveLength(1)
    expect(keyByPlain(keep.access_token).revoked_at ?? null).toBeNull()
    expect(overview.problems[0].revoked).toBe(true)
    expect(overview.health!.alert).toBe(true)
    expect((await loadOAuthHealth(db.client as never, new Date()))!.revocations).toBe(1)

    const html = renderToStaticMarkup(OAuthConnectionsCard({ overview }))
    expect(html).toContain('Připojení Claude')
    expect(html).toContain('Zrušené')
    expect(html).toContain('Aktivní')
    expect(html).not.toContain(first.refresh_token)
    expect(renderToStaticMarkup(OAuthConnectionsCard({ overview: null }))).toContain('nepodařilo načíst')
  })

  it('bez tabulky oauth_refresh_token (0083): přehled řekne proč, nespadne', async () => {
    db = new MemoryDb({ fail: (t) => (t === 'oauth_refresh_token' ? { code: '42P01', message: 'no table' } : null) })
    const overview = await loadOAuthOverview(db.client as never)
    expect(overview.available).toBe(false)
    expect(renderToStaticMarkup(OAuthConnectionsCard({ overview }))).toContain('migrace 0083')
  })
})

describe('protokol (metadata, 429/503)', () => {
  it('autorizační server: issuer, endpointy, refresh_token, veřejný klient, S256', async () => {
    const m = await (await asMeta(new Request('https://cockpit.example/.well-known/oauth-authorization-server'))).json()
    expect(m).toMatchObject({
      issuer: 'https://cockpit.example',
      authorization_endpoint: 'https://cockpit.example/api/oauth/authorize',
      token_endpoint: 'https://cockpit.example/api/oauth/token',
      registration_endpoint: 'https://cockpit.example/api/oauth/register',
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      response_types_supported: ['code'],
    })
  })

  it('chráněný zdroj ukazuje na stejný issuer a resource = /api/mcp', async () => {
    const pr = await (await prMeta(new Request('https://cockpit.example/.well-known/oauth-protected-resource/api/mcp'))).json()
    const as = await (await asMeta(new Request('https://cockpit.example/.well-known/oauth-authorization-server'))).json()
    expect(pr.resource).toBe('https://cockpit.example/api/mcp')
    expect(pr.authorization_servers).toEqual([as.issuer])
    expect(pr.bearer_methods_supported).toEqual(['header'])
  })

  it('503 (brzdu nejde ověřit) nese Retry-After a nic se nezapíše', async () => {
    seed()
    const t = await connect()
    db = Object.assign(db, {})
    const original = db.from.bind(db)
    db.from = (table: string) => {
      const q = original(table)
      if (table === 'api_request') return Object.assign(q, { then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: 'XX000', message: 'x' }, count: null }).then(ok) })
      return q
    }
    const before = events().length
    const res = await mcpPost(mcpReq(t.access_token))
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
    expect(events().length).toBe(before)
  })
})
