import { createHash } from 'node:crypto'
import type { createAdminClient } from '@/lib/supabase/admin'
import { hashApiKey } from '@/lib/apiKeyAuth'
import { isInternalRole } from '@/lib/domain'
import { logError } from '@/lib/log'

// Diagnostika konektoru „Cockpit" (Claude, OAuth 2.1 + DCR).
//
// Proč: když se konektor odpojí, dosud nebylo kde zjistit proč. Každé
// odmítnutí na /api/oauth/token a každé 401 na /api/mcp se teď zapíše do
// audit_event (action 'oauth.problem', entity_table 'oauth_connection') s
// důvodem, zdrojem, client_id a názvem klienta. Stejně tak každé zrušení
// připojení pravidly (reuse refresh tokenu, neaktivní schvalovatel, prune
// nad 5 připojení) a ruční zrušení v /api-klice — přehled v /api-klice pak
// umí říct, PROČ je připojení zrušené.
//
// Bez tajemství: nikdy token, hash ani jeho prefix. Identifikace připojení
// = family_id (uuid rodiny refresh tokenů) a id klíče v api_key. audit_event
// nemá retenci (0064), proto ani IP adresa ani nic osobního.
//
// Pravidla tokenů (lib/oauthTokens.ts, lib/apiKeyAuth.ts) se tu NEMĚNÍ —
// tenhle soubor jen čte a zapisuje záznam. Výpadek zápisu nic neodmítne
// ani nepovolí: chyba jde jen do logu.
//
// Proti zaplavení (audit_event roste navždy, /api/mcp je veřejný): v paměti
// instance se stejná událost (zdroj + důvod + připojení) zapíše nejvýš
// jednou za minutu (další se sečtou do `repeats` příštího zápisu) a celkem
// nejvýš GLOBAL_CAP událostí za minutu. Zrušení připojení se zapisuje vždy.
// Na serverless má každá instance vlastní paměť — limit je „na instanci".

type Db = Pick<ReturnType<typeof createAdminClient>, 'from'>

export const OAUTH_AUDIT_ACTION = 'oauth.problem'
export const OAUTH_AUDIT_ENTITY = 'oauth_connection'

export type OAuthProblemSource = 'token' | 'mcp' | 'cockpit'

export type OAuthProblemReason =
  // refresh token / access token
  | 'expired' | 'revoked' | 'refresh_reuse_in_grace' | 'family_revoked_reuse' | 'owner_inactive'
  | 'unknown_token' | 'client_mismatch' | 'pruned' | 'lookup_error'
  // výměna kódu a obecné chyby token endpointu
  | 'invalid_request' | 'unsupported_grant_type' | 'invalid_code' | 'code_expired' | 'pkce_failed'
  | 'redirect_mismatch' | 'no_approver' | 'server_error'
  // ruční zásah v Cockpitu
  | 'manual_revoke'

export const OAUTH_REASON_LABELS: Readonly<Record<OAuthProblemReason, string>> = Object.freeze({
  expired: 'platnost vypršela',
  revoked: 'token je zrušený',
  refresh_reuse_in_grace: 'refresh token použit podruhé do 10 s (souběh) — odmítnuto, připojení žije',
  family_revoked_reuse: 'refresh token použit podruhé po víc než 10 s — zrušeno celé připojení',
  owner_inactive: 'schvalovatel je deaktivovaný nebo není interní člen týmu',
  unknown_token: 'neznámý token',
  client_mismatch: 'token patří jinému klientovi (client_id)',
  pruned: 'zrušeno: víc než 5 připojení téže aplikace od téhož člověka (nejstarší se ruší)',
  lookup_error: 'chyba čtení databáze při ověření',
  invalid_request: 'neúplný požadavek',
  unsupported_grant_type: 'nepodporovaný grant_type',
  invalid_code: 'neznámý nebo už použitý autorizační kód',
  code_expired: 'autorizační kód vypršel',
  pkce_failed: 'nesedí PKCE (code_verifier)',
  redirect_mismatch: 'nesedí redirect_uri',
  no_approver: 'kód bez schvalovatele',
  server_error: 'chyba serveru',
  manual_revoke: 'zrušeno ručně v Cockpitu (API klíče)',
})

export const OAUTH_SOURCE_LABELS: Readonly<Record<OAuthProblemSource, string>> = Object.freeze({
  token: 'obnova / výměna tokenu',
  mcp: 'volání /api/mcp (401)',
  cockpit: 'Cockpit',
})

export function oauthReasonLabel(reason: unknown): string {
  return typeof reason === 'string' && reason in OAUTH_REASON_LABELS
    ? OAUTH_REASON_LABELS[reason as OAuthProblemReason]
    : 'neznámý důvod'
}

export type OAuthProblem = {
  source: OAuthProblemSource
  reason: OAuthProblemReason
  grantType?: 'authorization_code' | 'refresh_token' | null
  clientId?: string | null
  clientName?: string | null
  familyId?: string | null
  apiKeyId?: number | null
  /** Klíče, které tahle událost zrušila (rodina, prune, ruční zrušení). */
  revokedKeyIds?: number[]
  /** U zrušeného tokenu: co ho dřív zrušilo (z dřívější události). */
  revokedBy?: OAuthProblemReason | null
  /** MCP 401: připojení (rodina) má jiný, platný token — klient poslal starý. */
  familyActive?: boolean | null
  keyKind?: 'oauth' | 'manual' | null
  ownerState?: OwnerState | null
  /** Kdo zásah udělal (ruční zrušení); jinak systém. */
  actorUserId?: string | null
}

// Payload řádku (audit_event.after). Jen identifikátory a číselníky.
export type OAuthProblemPayload = {
  source: OAuthProblemSource
  reason: OAuthProblemReason
  grant_type?: string | null
  client_id?: string | null
  client_name?: string | null
  family_id?: string | null
  api_key_id?: number | null
  revoked?: boolean
  revoked_key_ids?: number[]
  revoked_by?: string | null
  family_active?: boolean | null
  key_kind?: string | null
  owner_state?: string | null
  repeats?: number
}

const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** client_id z formuláře je pod kontrolou volajícího: jen bezpečný tvar, jinak 'invalid'. */
export function safeClientId(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null
  return CLIENT_ID_RE.test(v) ? v : 'invalid'
}

/** client_name volí registrující (DCR): bez řídicích znaků, max 100 znaků. */
export function safeClientName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)
  return clean || null
}

export function toPayload(p: OAuthProblem, repeats = 0): OAuthProblemPayload {
  const out: OAuthProblemPayload = { source: p.source, reason: p.reason }
  if (p.grantType) out.grant_type = p.grantType
  const clientId = safeClientId(p.clientId)
  if (clientId) out.client_id = clientId
  const clientName = safeClientName(p.clientName)
  if (clientName) out.client_name = clientName
  if (p.familyId && UUID_RE.test(p.familyId)) out.family_id = p.familyId
  if (typeof p.apiKeyId === 'number') out.api_key_id = p.apiKeyId
  if (p.revokedKeyIds && p.revokedKeyIds.length > 0) {
    out.revoked = true
    out.revoked_key_ids = p.revokedKeyIds.filter((id) => typeof id === 'number').slice(0, 200)
  }
  if (p.revokedBy) out.revoked_by = p.revokedBy
  if (p.familyActive != null) out.family_active = p.familyActive
  if (p.keyKind) out.key_kind = p.keyKind
  if (p.ownerState) out.owner_state = p.ownerState
  if (repeats > 0) out.repeats = repeats
  return out
}

// ---------------------------------------------------------------------------
// Brzda proti zaplavení (v paměti instance)

const DEDUPE_WINDOW_MS = 60_000
export const OAUTH_AUDIT_GLOBAL_CAP = 60
const recent = new Map<string, { at: number; suppressed: number }>()
let windowStart = 0
let windowCount = 0

/** Jen pro testy: vynuluje paměť brzdy. */
export function resetOAuthAuditThrottle(): void {
  recent.clear()
  windowStart = 0
  windowCount = 0
}

/**
 * Smí se událost s tímto klíčem zapsat? Vrací i počet potlačených opakování
 * od posledního zápisu. `force` (zrušení připojení) projde vždy.
 */
export function admitOAuthAudit(key: string, now: number = Date.now(), force = false): { ok: boolean; repeats: number } {
  if (now - windowStart >= DEDUPE_WINDOW_MS) {
    windowStart = now
    windowCount = 0
  }
  if (recent.size > 5000) {
    for (const [k, v] of recent) if (now - v.at >= DEDUPE_WINDOW_MS) recent.delete(k)
  }
  const hit = recent.get(key)
  if (!force) {
    if (hit && now - hit.at < DEDUPE_WINDOW_MS) {
      hit.suppressed += 1
      return { ok: false, repeats: 0 }
    }
    if (windowCount >= OAUTH_AUDIT_GLOBAL_CAP) return { ok: false, repeats: 0 }
  }
  windowCount += 1
  const repeats = hit?.suppressed ?? 0
  recent.set(key, { at: now, suppressed: 0 })
  return { ok: true, repeats }
}

function throttleKey(p: OAuthProblem): string {
  return `${p.source}:${p.reason}:${p.familyId ?? p.apiKeyId ?? p.clientId ?? '-'}`
}

/** Zapíše jeden řádek do audit_event. Nikdy nevyhodí. */
export async function insertOAuthProblem(db: Db, p: OAuthProblem, repeats = 0): Promise<void> {
  try {
    const payload = toPayload(p, repeats)
    const { error } = await db.from('audit_event').insert({
      actor_type: p.actorUserId ? 'user' : 'system',
      actor_id: p.actorUserId ?? `oauth:${p.source}`,
      action: OAUTH_AUDIT_ACTION,
      entity_table: OAUTH_AUDIT_ENTITY,
      entity_id: typeof p.apiKeyId === 'number' ? p.apiKeyId : null,
      // entity_ref (0082): připojení = rodina; bez ní klient; jinak 'unknown'.
      entity_ref: payload.family_id ?? payload.client_id ?? 'unknown',
      before: null,
      after: payload,
    })
    if (error) logError('oauth.diagnostics', error, { reason: p.reason, source: p.source })
  } catch (e) {
    logError('oauth.diagnostics', e, { reason: p.reason, source: p.source })
  }
}

/** Zapíše problém s brzdou proti zaplavení. Zrušení připojení projde vždy. */
export async function recordOAuthProblem(db: Db, p: OAuthProblem, now: number = Date.now()): Promise<void> {
  const force = (p.revokedKeyIds?.length ?? 0) > 0
  const gate = admitOAuthAudit(throttleKey(p), now, force)
  if (!gate.ok) return
  await insertOAuthProblem(db, p, gate.repeats)
}

// ---------------------------------------------------------------------------
// Dohledání důvodu (jen čtení)

/** Co dřív zrušilo klíč: poslední událost, která ho má v revoked_key_ids. */
export async function revocationCause(db: Db, keyId: number | null | undefined): Promise<OAuthProblemReason | null> {
  if (typeof keyId !== 'number') return null
  try {
    const { data, error } = await db
      .from('audit_event')
      .select('after, occurred_at')
      .eq('action', OAUTH_AUDIT_ACTION)
      .eq('entity_table', OAUTH_AUDIT_ENTITY)
      .contains('after', { revoked_key_ids: [keyId] })
      .order('occurred_at', { ascending: false })
      .limit(1)
    if (error || !data || data.length === 0) return null
    const reason = (data[0] as { after?: { reason?: unknown } }).after?.reason
    return typeof reason === 'string' && reason in OAUTH_REASON_LABELS ? (reason as OAuthProblemReason) : null
  } catch {
    return null
  }
}

/** Má rodina platný (nepoužitý, nezrušený, neprošlý) refresh token? */
async function familyIsActive(db: Db, familyId: string, now: number): Promise<boolean | null> {
  try {
    const { data, error } = await db
      .from('oauth_refresh_token')
      .select('id')
      .eq('family_id', familyId)
      .is('revoked_at', null)
      .is('used_at', null)
      .gt('expires_at', new Date(now).toISOString())
      .limit(1)
    if (error) return null
    return (data ?? []).length > 0
  } catch {
    return null
  }
}

export type OwnerState = 'active' | 'missing' | 'deactivated' | 'not_internal' | 'error'

type KeyDiagnosis = {
  reason: OAuthProblemReason
  keyId?: number
  ownerState?: OwnerState
}

/**
 * Proč validateApiKey (lib/apiKeyAuth.ts) token odmítl — dohledá se znovu,
 * jen pro záznam. Pořadí kontrol odpovídá validateApiKey a isKeyUsable.
 * Ověřování samo se nemění a na výsledku tohohle nic nezávisí.
 */
export async function diagnoseBearerToken(db: Db, plaintext: string, now: number = Date.now()): Promise<KeyDiagnosis> {
  if (!plaintext || plaintext.length > 512) return { reason: 'unknown_token' }
  try {
    const { data, error } = await db
      .from('api_key')
      .select('id, revoked_at, created_by, expires_at')
      .eq('key_hash', hashApiKey(plaintext))
      .maybeSingle()
    if (error) return { reason: 'lookup_error' }
    if (!data) return { reason: 'unknown_token' }
    const row = data as { id: number; revoked_at: string | null; created_by: string | null; expires_at?: string | null }
    if (row.revoked_at) return { reason: 'revoked', keyId: row.id }
    if (!row.created_by) return { reason: 'owner_inactive', keyId: row.id, ownerState: 'missing' }
    if (row.expires_at && Date.parse(row.expires_at) <= now) return { reason: 'expired', keyId: row.id }
    const ownerState = await readOwnerState(db, row.created_by)
    if (ownerState === 'error') return { reason: 'lookup_error', keyId: row.id, ownerState }
    if (ownerState !== 'active') return { reason: 'owner_inactive', keyId: row.id, ownerState }
    // Teď by klíč prošel: odmítnutí způsobil přechodný výpadek (chyba DB).
    return { reason: 'lookup_error', keyId: row.id }
  } catch {
    return { reason: 'lookup_error' }
  }
}

async function readOwnerState(db: Db, userId: string): Promise<OwnerState> {
  try {
    let res = await db.from('team_member').select('role, deactivated_at').eq('id', userId).maybeSingle()
    if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204')) {
      res = await db.from('team_member').select('role').eq('id', userId).maybeSingle()
    }
    if (res.error) return 'error'
    if (!res.data) return 'missing'
    const row = res.data as { role?: unknown; deactivated_at?: unknown }
    if (row.deactivated_at) return 'deactivated'
    if (!isInternalRole(row.role as string)) return 'not_internal'
    return 'active'
  } catch {
    return 'error'
  }
}

/** K id klíče dohledá rodinu, klienta a jeho název (OAuth), nebo pozná ruční klíč. */
async function connectionOfKey(
  db: Db,
  keyId: number,
): Promise<{ keyKind: 'oauth' | 'manual' | null; familyId: string | null; clientId: string | null; clientName: string | null }> {
  try {
    const { data, error } = await db
      .from('oauth_refresh_token')
      .select('family_id, client_id')
      .eq('api_key_id', keyId)
      .limit(1)
    if (error) return { keyKind: null, familyId: null, clientId: null, clientName: null }
    const row = (data ?? [])[0] as { family_id: string; client_id: string } | undefined
    if (!row) return { keyKind: 'manual', familyId: null, clientId: null, clientName: null }
    return { keyKind: 'oauth', familyId: row.family_id, clientId: row.client_id, clientName: await clientNameOf(db, row.client_id) }
  } catch {
    return { keyKind: null, familyId: null, clientId: null, clientName: null }
  }
}

export async function clientNameOf(db: Db, clientId: string | null | undefined): Promise<string | null> {
  if (!clientId) return null
  try {
    const { data } = await db.from('oauth_client').select('client_name').eq('client_id', clientId).maybeSingle()
    return (data as { client_name?: string | null } | null)?.client_name ?? null
  } catch {
    return null
  }
}

/** Otisk tokenu jen pro brzdu v paměti (nikdy se neukládá). */
function fingerprint(plaintext: string): string {
  return createHash('sha256').update(`diag:${plaintext}`).digest('hex').slice(0, 24)
}

/**
 * 401 z /api/mcp: zjistí důvod a zapíše ho. Bez hlavičky Authorization
 * (první krok OAuth discovery — klient teprve zjišťuje, kam se přihlásit)
 * se nic nezapisuje, to je běžný stav, ne problém. Nikdy nevyhodí.
 */
export async function recordMcpUnauthorized(db: Db, req: Request, now: number = Date.now()): Promise<void> {
  try {
    const match = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/)
    if (!match) return
    const plaintext = match[1]
    // Brzda před dotazy do DB: stejný token nejvýš jednou za minutu.
    const gate = admitOAuthAudit(`mcp:${fingerprint(plaintext)}`, now)
    if (!gate.ok) return
    const d = await diagnoseBearerToken(db, plaintext, now)
    const p: OAuthProblem = { source: 'mcp', reason: d.reason, apiKeyId: d.keyId ?? null, ownerState: d.ownerState ?? null }
    if (typeof d.keyId === 'number') {
      const conn = await connectionOfKey(db, d.keyId)
      p.keyKind = conn.keyKind
      p.familyId = conn.familyId
      p.clientId = conn.clientId
      p.clientName = conn.clientName
      if (conn.familyId && (d.reason === 'expired' || d.reason === 'revoked')) {
        p.familyActive = await familyIsActive(db, conn.familyId, now)
      }
      if (d.reason === 'revoked') p.revokedBy = await revocationCause(db, d.keyId)
    }
    await insertOAuthProblem(db, p, gate.repeats)
  } catch (e) {
    logError('oauth.diagnostics', e, { source: 'mcp' })
  }
}
