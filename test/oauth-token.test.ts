import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { MemoryDb, type Row } from './helpers/memoryDb'

// Token endpoint konektoru (Claude / Cowork): výměna kódu (atomicky, PKCE,
// rozsah), refresh_token s rotací a detekcí reuse, revokace jen stejného
// klienta a tolerance k nenasazené migraci 0083. Databáze je MemoryDb.

let db: MemoryDb
let seq = 0
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }))

import { POST } from '@/app/api/oauth/token/route'
import { hashApiKey } from '@/lib/apiKeyAuth'
import { revokeOAuthFamilyOfKey, revokeOAuthOfMember } from '@/lib/oauthTokens'

const VERIFIER = 'verifier-verifier-verifier-verifier-verifier-123'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const DAY = 86_400_000

function makeDb(fail?: ConstructorParameters<typeof MemoryDb>[0] extends infer O ? (O extends { fail?: infer F } ? F : never) : never) {
  seq = 0
  return new MemoryDb({
    fail,
    // created_at s rostoucím pořadím, ať řazení v testu odpovídá vydání.
    defaults: { api_key: () => ({ created_at: new Date(1_700_000_000_000 + ++seq * 1000).toISOString() }) },
  })
}

function seedBase(scopeCode: string | null = 'read') {
  db.seed('oauth_client', [
    { client_id: 'c1', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] },
    { client_id: 'c2', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] },
  ])
  db.seed('team_member', [
    { id: 'user-1', role: 'vedeni', deactivated_at: null },
    { id: 'user-2', role: 'lektor', deactivated_at: null },
  ])
  db.seed('oauth_code', [codeRow(scopeCode === null ? {} : { scope: scopeCode })])
}

function codeRow(over: Row = {}): Row {
  return {
    code: 'abc',
    client_id: 'c1',
    redirect_uri: 'https://claude.ai/cb',
    code_challenge: CHALLENGE,
    approved_by: 'user-1',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  }
}

function codeReq(fields: Record<string, string> = {}): Request {
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code: 'abc', client_id: 'c1',
    redirect_uri: 'https://claude.ai/cb', code_verifier: VERIFIER, ...fields,
  })
  return new Request('http://localhost/api/oauth/token', { method: 'POST', body })
}
function refreshReq(refresh_token: string, fields: Record<string, string> = {}): Request {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id: 'c1', ...fields })
  return new Request('http://localhost/api/oauth/token', { method: 'POST', body })
}

type Tokens = { access_token: string; refresh_token?: string; expires_in: number; scope: string; error?: string }
async function connect(over: Row = {}, client = 'c1'): Promise<Tokens> {
  db.seed('oauth_code', [codeRow({ code: `code-${++seq}`, client_id: client, ...over })])
  const res = await POST(codeReq({ code: `code-${seq}`, client_id: client }))
  return res.json()
}
const keyByPlain = (plain: string) => db.rows('api_key').find((k) => k.key_hash === hashApiKey(plain))!
const refreshRow = (plain: string) => db.rows('oauth_refresh_token').find((r) => r.token_hash === hashApiKey(plain))!

beforeEach(() => {
  db = makeDb()
})
afterEach(() => vi.useRealTimers())

describe('/api/oauth/token — authorization_code', () => {
  it('vydá access i refresh token; v DB je jen hash refresh tokenu', async () => {
    seedBase()
    const res = await POST(codeReq())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const json: Tokens = await res.json()
    expect(json.access_token).toMatch(/^cockpit_/)
    expect(json.refresh_token).toMatch(/^cockpit_rt_/)
    expect(json.scope).toBe('read')
    expect(json.expires_in).toBe(90 * 86_400)
    const rt = db.rows('oauth_refresh_token')
    expect(rt).toHaveLength(1)
    expect(JSON.stringify(rt)).not.toContain(json.refresh_token!)
    expect(rt[0]).toMatchObject({ token_hash: hashApiKey(json.refresh_token!), client_id: 'c1', approved_by: 'user-1', scope: 'read' })
    const key = db.rows('api_key')[0]
    expect(key).toMatchObject({ scope: 'read', created_by: 'user-1', name: 'OAuth · Claude (' + 'c1'.slice(-6) + ')' })
    expect(rt[0].api_key_id).toBe(key.id)
  })

  it('access token ~90 dní, refresh token ~180 dní', async () => {
    seedBase()
    const before = Date.now()
    await POST(codeReq())
    const access = Date.parse(String(db.rows('api_key')[0].expires_at)) - before
    const refresh = Date.parse(String(db.rows('oauth_refresh_token')[0].expires_at)) - before
    expect(access).toBeGreaterThan(89 * DAY)
    expect(access).toBeLessThan(91 * DAY)
    expect(refresh).toBeGreaterThan(179 * DAY)
    expect(refresh).toBeLessThan(181 * DAY)
  })

  it('kód jde uplatnit jen jednou, i souběžně', async () => {
    seedBase()
    const [a, b] = await Promise.all([POST(codeReq()), POST(codeReq())])
    expect([a.status, b.status].sort()).toEqual([200, 400])
    expect(db.rows('api_key')).toHaveLength(1)
  })

  describe('rozsah', () => {
    it('kód se scope full a schvalovatel s obchodní rolí → full ("read write")', async () => {
      seedBase('full')
      const json: Tokens = await (await POST(codeReq())).json()
      expect(json.scope).toBe('read write')
      expect(db.rows('api_key')[0].scope).toBe('full')
      expect(db.rows('oauth_refresh_token')[0].scope).toBe('full')
    })

    it('kód se scope full, ale schvalovatel bez obchodní role → srazí se na read', async () => {
      seedBase('full')
      db.rows('oauth_code')[0].approved_by = 'user-2'
      const json: Tokens = await (await POST(codeReq())).json()
      expect(json.scope).toBe('read')
      expect(db.rows('api_key')[0].scope).toBe('read')
    })

    it('kód bez scope (starý kód) nebo s neznámou hodnotou → read', async () => {
      seedBase(null)
      expect((await (await POST(codeReq())).json() as Tokens).scope).toBe('read')
      db.seed('oauth_code', [codeRow({ code: 'x2', scope: 'admin' })])
      expect((await (await POST(codeReq({ code: 'x2' }))).json() as Tokens).scope).toBe('read')
    })
  })

  describe('zneplatňování při novém připojení', () => {
    it('připojení jiného client_id se stejným jménem NEZNEPLATNÍ token prvního (příčina odpojování)', async () => {
      seedBase()
      db.rows('oauth_code').length = 0
      const first = await connect({}, 'c1')
      const second = await connect({}, 'c2')
      expect(keyByPlain(first.access_token).revoked_at ?? null).toBeNull()
      expect(keyByPlain(second.access_token).revoked_at ?? null).toBeNull()
      expect(refreshRow(first.refresh_token!).revoked_at ?? null).toBeNull()
      expect(keyByPlain(first.access_token).name).not.toBe(keyByPlain(second.access_token).name)
    })

    it('stejný client_id: dvě připojení (dva konektory) obě platí', async () => {
      seedBase()
      db.rows('oauth_code').length = 0
      const a = await connect({}, 'c1')
      const b = await connect({}, 'c1')
      expect(keyByPlain(a.access_token).revoked_at ?? null).toBeNull()
      expect(keyByPlain(b.access_token).revoked_at ?? null).toBeNull()
    })

    it('drží se jen 5 nejnovějších připojení téhož klienta; nejstarší se zruší i s refresh tokenem', async () => {
      seedBase()
      db.rows('oauth_code').length = 0
      const all: Tokens[] = []
      for (let i = 0; i < 6; i++) all.push(await connect({}, 'c1'))
      expect(keyByPlain(all[0].access_token).revoked_at).toBeTruthy()
      expect(refreshRow(all[0].refresh_token!).revoked_at).toBeTruthy()
      for (const t of all.slice(1)) expect(keyByPlain(t.access_token).revoked_at ?? null).toBeNull()
    })

    it('starý klíč s původním názvem a klíče jiných lidí se nedotknou', async () => {
      seedBase()
      db.rows('oauth_code').length = 0
      db.seed('api_key', [
        { id: 900, name: 'OAuth · Claude', key_hash: 'old', created_by: 'user-1', scope: 'read', revoked_at: null },
        { id: 901, name: 'Ruční klíč', key_hash: 'man', created_by: 'user-1', scope: 'full', revoked_at: null },
      ])
      for (let i = 0; i < 7; i++) await connect({}, 'c1')
      expect(db.rows('api_key').find((k) => k.id === 900)!.revoked_at).toBeNull()
      expect(db.rows('api_key').find((k) => k.id === 901)!.revoked_at).toBeNull()
    })
  })

  describe('chybové stavy', () => {
    it('vypršelý kód / špatný PKCE / cizí redirect_uri / starý kód bez approved_by → invalid_grant a žádný klíč', async () => {
      seedBase()
      db.rows('oauth_code')[0].expires_at = new Date(Date.now() - 1000).toISOString()
      expect((await (await POST(codeReq())).json()).error).toBe('invalid_grant')

      db.seed('oauth_code', [codeRow({ code: 'p' })])
      expect((await (await POST(codeReq({ code: 'p', code_verifier: 'wrong' }))).json()).error).toBe('invalid_grant')
      db.seed('oauth_code', [codeRow({ code: 'r' })])
      expect((await (await POST(codeReq({ code: 'r', redirect_uri: 'https://evil.example/cb' }))).json()).error).toBe('invalid_grant')
      db.seed('oauth_code', [codeRow({ code: 'n', approved_by: null })])
      expect((await (await POST(codeReq({ code: 'n' }))).json()).error).toBe('invalid_grant')
      expect(db.rows('api_key')).toHaveLength(0)
      expect(db.rows('oauth_refresh_token')).toHaveLength(0)
    })

    it('chybějící redirect_uri: u klienta s více adresami invalid_request, s jedinou projde', async () => {
      seedBase()
      db.rows('oauth_client')[0].redirect_uris = ['https://claude.ai/cb', 'http://localhost:1/cb']
      expect((await (await POST(codeReq({ redirect_uri: '' }))).json()).error).toBe('invalid_request')
      db.seed('oauth_code', [codeRow({ code: 'z' })])
      db.rows('oauth_client')[0].redirect_uris = ['https://claude.ai/cb']
      expect((await POST(codeReq({ code: 'z', redirect_uri: '' }))).status).toBe(200)
    })

    it('neznámý grant_type → unsupported_grant_type', async () => {
      const body = new URLSearchParams({ grant_type: 'password' })
      const res = await POST(new Request('http://localhost/api/oauth/token', { method: 'POST', body }))
      expect((await res.json()).error).toBe('unsupported_grant_type')
    })
  })

  describe('tolerance k nenasazené migraci 0083', () => {
    it('bez tabulky oauth_refresh_token vydá jen access token (jako dřív)', async () => {
      db = makeDb((t) => (t === 'oauth_refresh_token' ? { code: '42P01', message: 'no table' } : null))
      seedBase()
      const res = await POST(codeReq())
      expect(res.status).toBe(200)
      const json: Tokens = await res.json()
      expect(json.access_token).toMatch(/^cockpit_/)
      expect(json.refresh_token).toBeUndefined()
    })

    it('bez sloupce oauth_code.scope se vydá read', async () => {
      let failed = false
      db = makeDb((t, op) => {
        if (t === 'oauth_code' && op === 'delete' && !failed) { failed = true; return { code: '42703', message: 'no scope' } }
        return null
      })
      seedBase('full')
      const json: Tokens = await (await POST(codeReq())).json()
      expect(json.scope).toBe('read')
    })

    it('jiná chyba při zápisu refresh tokenu → 500 a access token se zruší', async () => {
      db = makeDb((t, op) => (t === 'oauth_refresh_token' && op === 'insert' ? { code: 'XX000', message: 'boom' } : null))
      seedBase()
      const res = await POST(codeReq())
      expect(res.status).toBe(500)
      expect(db.rows('api_key')[0].revoked_at).toBeTruthy()
    })
  })
})

describe('/api/oauth/token — refresh_token (rotace)', () => {
  async function setup(scope = 'read') {
    seedBase(scope)
    db.rows('oauth_code').length = 0
    return connect({ scope })
  }

  it('vydá nový access i refresh token a starý refresh označí jako použitý', async () => {
    const first = await setup()
    const res = await POST(refreshReq(first.refresh_token!))
    expect(res.status).toBe(200)
    const next: Tokens = await res.json()
    expect(next.access_token).not.toBe(first.access_token)
    expect(next.refresh_token).not.toBe(first.refresh_token)
    expect(next.scope).toBe('read')
    expect(next.expires_in).toBe(90 * 86_400)
    expect(refreshRow(first.refresh_token!).used_at).toBeTruthy()
    expect(refreshRow(next.refresh_token!).family_id).toBe(refreshRow(first.refresh_token!).family_id)
    expect(keyByPlain(next.access_token).created_by).toBe('user-1')
  })

  it('řetěz refreshů funguje opakovaně (každý nový token jde použít)', async () => {
    let t = await setup()
    for (let i = 0; i < 4; i++) {
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 60_000)
      const res = await POST(refreshReq(t.refresh_token!))
      expect(res.status).toBe(200)
      t = await res.json()
      vi.useRealTimers()
    }
  })

  it('refresh je klouzavý: nový refresh token platí ~180 dní od refreshe', async () => {
    const first = await setup()
    const before = Date.now()
    const next: Tokens = await (await POST(refreshReq(first.refresh_token!))).json()
    const exp = Date.parse(String(refreshRow(next.refresh_token!).expires_at)) - before
    expect(exp).toBeGreaterThan(179 * DAY)
    expect(exp).toBeLessThan(181 * DAY)
  })

  it('starý access token po rotaci dožije za pár minut, nezruší se hned', async () => {
    const first = await setup()
    await POST(refreshReq(first.refresh_token!))
    const old = keyByPlain(first.access_token)
    expect(old.revoked_at ?? null).toBeNull()
    const left = Date.parse(String(old.expires_at)) - Date.now()
    expect(left).toBeLessThanOrEqual(5 * 60_000)
    expect(left).toBeGreaterThan(0)
  })

  it('refresh jednoho klienta NEZASÁHNE access tokeny jiného klienta ani jiného připojení', async () => {
    const a = await setup()
    const other = await connect({}, 'c2')
    const sibling = await connect({}, 'c1') // druhé připojení stejného klienta
    await POST(refreshReq(a.refresh_token!))
    for (const t of [other, sibling]) {
      const k = keyByPlain(t.access_token)
      expect(k.revoked_at ?? null).toBeNull()
      expect(Date.parse(String(k.expires_at)) - Date.now()).toBeGreaterThan(89 * DAY)
    }
  })

  it('reuse po prodlevě: invalid_grant a zneplatní se celá rodina (refresh i access tokeny)', async () => {
    const first = await setup()
    const second: Tokens = await (await POST(refreshReq(first.refresh_token!))).json()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_000)
    const replay = await POST(refreshReq(first.refresh_token!))
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe('invalid_grant')
    for (const t of [first, second]) {
      expect(keyByPlain(t.access_token).revoked_at).toBeTruthy()
      expect(refreshRow(t.refresh_token!).revoked_at).toBeTruthy()
    }
    // Ani legitimní nástupce už nejde použít.
    const res = await POST(refreshReq(second.refresh_token!))
    expect((await res.json()).error).toBe('invalid_grant')
  })

  it('reuse zneplatní jen SVOJI rodinu, jiné připojení zůstane', async () => {
    const first = await setup()
    const other = await connect({}, 'c1')
    await POST(refreshReq(first.refresh_token!))
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_000)
    await POST(refreshReq(first.refresh_token!))
    expect(keyByPlain(other.access_token).revoked_at ?? null).toBeNull()
    expect(refreshRow(other.refresh_token!).revoked_at ?? null).toBeNull()
  })

  it('druhé použití během pár vteřin (souběh) se odmítne, ale rodina žije', async () => {
    const first = await setup()
    const [a, b] = await Promise.all([POST(refreshReq(first.refresh_token!)), POST(refreshReq(first.refresh_token!))])
    expect([a.status, b.status].sort()).toEqual([200, 400])
    const winner: Tokens = await (a.status === 200 ? a : b).json()
    expect(keyByPlain(winner.access_token).revoked_at ?? null).toBeNull()
    expect((await POST(refreshReq(winner.refresh_token!))).status).toBe(200)
  })

  it('vypršelý, zrušený, cizí nebo neznámý refresh token → invalid_grant', async () => {
    const t = await setup()
    expect((await (await POST(refreshReq('neznamy'))).json()).error).toBe('invalid_grant')
    expect((await (await POST(refreshReq(t.refresh_token!, { client_id: 'c2' }))).json()).error).toBe('invalid_grant')
    // nic z toho refresh token nespotřebovalo
    expect(refreshRow(t.refresh_token!).used_at ?? null).toBeNull()

    refreshRow(t.refresh_token!).expires_at = new Date(Date.now() - 1000).toISOString()
    expect((await (await POST(refreshReq(t.refresh_token!))).json()).error).toBe('invalid_grant')

    const t2 = await connect({}, 'c1')
    refreshRow(t2.refresh_token!).revoked_at = new Date().toISOString()
    expect((await (await POST(refreshReq(t2.refresh_token!))).json()).error).toBe('invalid_grant')
  })

  it('chybí refresh_token → invalid_request', async () => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: 'c1' })
    const res = await POST(new Request('http://localhost/api/oauth/token', { method: 'POST', body }))
    expect((await res.json()).error).toBe('invalid_request')
  })

  it('deaktivovaný schvalovatel: refresh selže a rodina se zruší', async () => {
    const t = await setup()
    db.rows('team_member').find((m) => m.id === 'user-1')!.deactivated_at = new Date().toISOString()
    expect((await (await POST(refreshReq(t.refresh_token!))).json()).error).toBe('invalid_grant')
    expect(keyByPlain(t.access_token).revoked_at).toBeTruthy()
  })

  it('scope full se při refreshu zachová; když schvalovatel o obchodní roli přijde, srazí se na read', async () => {
    const t = await setup('full')
    expect(t.scope).toBe('read write')
    const kept: Tokens = await (await POST(refreshReq(t.refresh_token!))).json()
    expect(kept.scope).toBe('read write')
    db.rows('team_member').find((m) => m.id === 'user-1')!.role = 'lektor'
    const downgraded: Tokens = await (await POST(refreshReq(kept.refresh_token!))).json()
    expect(downgraded.scope).toBe('read')
    expect(keyByPlain(downgraded.access_token).scope).toBe('read')
  })

  it('výpadek při vydání nových tokenů vrátí refresh token do hry (klient to zkusí znovu)', async () => {
    const t = await setup()
    let failNext = true
    db = Object.assign(db, {})
    const original = db.from.bind(db)
    db.from = (table: string) => {
      const q = original(table)
      if (table === 'api_key' && failNext) {
        const ins = q.insert.bind(q)
        q.insert = (p: unknown) => { failNext = false; ins(p); return Object.assign(q, { then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: 'XX000', message: 'x' } }).then(ok) }) }
      }
      return q
    }
    const res = await POST(refreshReq(t.refresh_token!))
    expect(res.status).toBe(500)
    expect(refreshRow(t.refresh_token!).used_at ?? null).toBeNull()
    const retry = await POST(refreshReq(t.refresh_token!))
    expect(retry.status).toBe(200)
  })
})

describe('ruční zrušení v /api-klice a odebrání člověka', () => {
  it('zrušení access tokenu zruší i jeho rodinu, takže se konektor sám neobnoví; jiné připojení zůstane', async () => {
    seedBase()
    db.rows('oauth_code').length = 0
    const a = await connect({}, 'c1')
    const other = await connect({}, 'c1')
    const next: Tokens = await (await POST(refreshReq(a.refresh_token!))).json()
    const keyId = keyByPlain(next.access_token).id as number
    await revokeOAuthFamilyOfKey(db.client as never, keyId)
    expect(refreshRow(next.refresh_token!).revoked_at).toBeTruthy()
    expect(keyByPlain(a.access_token).revoked_at).toBeTruthy()
    expect((await (await POST(refreshReq(next.refresh_token!))).json()).error).toBe('invalid_grant')
    expect(refreshRow(other.refresh_token!).revoked_at ?? null).toBeNull()
  })

  it('odebrání zápisu člověku zruší jen jeho full refresh tokeny', async () => {
    seedBase('full')
    db.rows('oauth_code').length = 0
    const full = await connect({ scope: 'full' }, 'c1')
    const read = await connect({ scope: 'read' }, 'c1')
    await revokeOAuthOfMember(db.client as never, 'user-1', 'full')
    expect(refreshRow(full.refresh_token!).revoked_at).toBeTruthy()
    expect(refreshRow(read.refresh_token!).revoked_at ?? null).toBeNull()
  })
})
