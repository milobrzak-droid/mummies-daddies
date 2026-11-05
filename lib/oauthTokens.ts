import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateApiKey, hashApiKey, loadKeyOwner } from '@/lib/apiKeyAuth'
import { randomToken } from '@/lib/oauth'

// Tokeny OAuth konektoru (Claude / Cowork). Access token je API klíč
// z tabulky api_key (MCP endpoint ho ověřuje jako každý jiný klíč), refresh
// token je samostatný jednorázový řetězec v oauth_refresh_token (migrace
// 0083), uložený jen jako sha256 hash.
//
// Proč to celé existuje: dřív šlo jen o authorization_code → jediný access
// token na 90 dní. Po vypršení nebo zneplatnění se klient nemohl obnovit
// a hlásil odpojení. Refresh token s rotací (OAuth 2.1) drží připojení
// naživu bez dalšího schvalování.

type Admin = ReturnType<typeof createAdminClient>

export const ACCESS_TTL_MS = 90 * 24 * 60 * 60 * 1000
// Klouzavě: každý refresh vydá nový refresh token s platností od teď.
export const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000
// Dva refresh požadavky se stejným tokenem během pár vteřin jsou skoro jistě
// souběh téhož klienta (dvě okna, opakování po výpadku sítě), ne útok. Druhý
// se odmítne, ale rodinu kvůli němu neničíme. Později = reuse = celá rodina pryč.
export const REFRESH_REUSE_GRACE_MS = 10_000
// Starý access token po rotaci ještě chvíli žije, ať se nepřeruší rozdělaný
// požadavek, který ho už poslal.
export const OLD_ACCESS_GRACE_MS = 5 * 60_000
// Kolik platných připojení jednoho klienta od jednoho schvalovatele se drží.
// Starší se při novém připojení zneplatní. Víc než jedno záměrně: dva
// konektory v Claude (i s deduplikovanou registrací sdílejí client_id) se
// nesmí navzájem odpojovat.
export const MAX_ACTIVE_CONNECTIONS = 5

export type OAuthScope = 'read' | 'full'

// Hodnota `scope` v odpovědi token endpointu (RFC 6749 §5.1).
export function scopeString(scope: OAuthScope): string {
  return scope === 'full' ? 'read write' : 'read'
}

// Cokoli jiného než přesně 'full' je 'read' — neznámá hodnota nesmí otevřít zápis.
export function normalizeOAuthScope(value: unknown): OAuthScope {
  return value === 'full' ? 'full' : 'read'
}

// Název klíče v /api-klice. Obsahuje konec client_id, aby dvě registrace
// se stejným client_name byly rozlišitelné a nezneplatňovaly si tokeny.
export function connectorKeyName(clientName: string | null | undefined, clientId: string): string {
  const base = clientName ? `OAuth · ${clientName}` : 'OAuth konektor'
  return `${base} (${clientId.slice(-6)})`
}

function isMissingColumn(e: { code?: string } | null): boolean {
  return e?.code === '42703' || e?.code === 'PGRST204'
}
function isMissingTable(e: { code?: string } | null): boolean {
  return e?.code === '42P01' || e?.code === 'PGRST205'
}

// Zápis smí dostat jen schvalovatel s obchodní rolí; jinak se rozsah
// srazí na 'read'. Kontrola je na serveru, ne jen ve formuláři.
export async function effectiveScope(
  requested: OAuthScope,
  approvedBy: string,
  admin: Admin,
): Promise<OAuthScope> {
  if (requested !== 'full') return 'read'
  const owner = await loadKeyOwner(approvedBy, admin)
  return owner.active && owner.canSeeSales ? 'full' : 'read'
}

export type IssuedTokens = {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
  scope: OAuthScope
}

// Vydá access token (api_key) a k němu refresh token v dané rodině.
// Bez tabulky oauth_refresh_token (nenasazená 0083) vrací refreshToken null
// a konektor funguje jako dřív. Jiná chyba = výjimka (route odpoví 500):
// radši připojení neprovést, než vydat token, který nejde obnovit ani dohledat.
export async function issueTokens(
  admin: Admin,
  p: { clientId: string; clientName: string | null; approvedBy: string; scope: OAuthScope; familyId?: string },
): Promise<IssuedTokens> {
  const { plaintext, hash, prefix } = generateApiKey()
  const keyRow = {
    name: connectorKeyName(p.clientName, p.clientId),
    key_hash: hash,
    key_prefix: prefix,
    created_by: p.approvedBy,
    scope: p.scope,
  }
  const expiresAt = new Date(Date.now() + ACCESS_TTL_MS).toISOString()
  let ins = await admin.from('api_key').insert({ ...keyRow, expires_at: expiresAt }).select('id').single()
  // Tolerance k nenasazené 0069 (sloupec expires_at chybí).
  if (ins.error && isMissingColumn(ins.error)) {
    ins = await admin.from('api_key').insert(keyRow).select('id').single()
  }
  // Bez sloupce scope (nenasazená 0043) insert selže → žádný token.
  // Fail closed: radši nepřipojit, než vydat plný klíč.
  if (ins.error || !ins.data) throw new Error('api_key insert failed')
  const keyId = (ins.data as { id: number }).id

  const refreshPlain = `cockpit_rt_${randomToken(32)}`
  const { error } = await admin.from('oauth_refresh_token').insert({
    token_hash: hashApiKey(refreshPlain),
    family_id: p.familyId ?? randomUUID(),
    client_id: p.clientId,
    approved_by: p.approvedBy,
    scope: p.scope,
    api_key_id: keyId,
    expires_at: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  })
  if (error) {
    if (isMissingTable(error)) {
      return { accessToken: plaintext, refreshToken: null, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scope: p.scope }
    }
    await admin.from('api_key').update({ revoked_at: new Date().toISOString() }).eq('id', keyId)
    throw new Error('refresh token insert failed')
  }
  return { accessToken: plaintext, refreshToken: refreshPlain, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scope: p.scope }
}

// Zneplatní celou rodinu: refresh tokeny i všechny access tokeny, které
// z ní vznikly. Volá se při reuse (refresh token použitý podruhé).
// Vrací id klíčů rodiny — jen pro diagnostiku (lib/oauthDiagnostics.ts).
export async function revokeFamily(admin: Admin, familyId: string): Promise<number[]> {
  const now = new Date().toISOString()
  const { data } = await admin.from('oauth_refresh_token').select('api_key_id').eq('family_id', familyId)
  const keyIds = ((data ?? []) as { api_key_id: number | null }[])
    .map((r) => r.api_key_id)
    .filter((id): id is number => id != null)
  await admin.from('oauth_refresh_token').update({ revoked_at: now }).eq('family_id', familyId).is('revoked_at', null)
  if (keyIds.length > 0) {
    await admin.from('api_key').update({ revoked_at: now }).in('id', keyIds).is('revoked_at', null)
  }
  return keyIds
}

// Po novém připojení nechá jen MAX_ACTIVE_CONNECTIONS nejnovějších platných
// klíčů TOHOTO klienta od TOHOTO schvalovatele (název klíče nese client_id).
// Klíče jiného client_id ani starý název „OAuth · <jméno>" se nedotknou.
// Vrací id zrušených klíčů — jen pro diagnostiku (lib/oauthDiagnostics.ts).
export async function pruneOldConnections(
  admin: Admin,
  p: { clientId: string; clientName: string | null; approvedBy: string },
): Promise<number[]> {
  const { data } = await admin
    .from('api_key')
    .select('id')
    .eq('created_by', p.approvedBy)
    .eq('name', connectorKeyName(p.clientName, p.clientId))
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
  const stale = ((data ?? []) as { id: number }[]).slice(MAX_ACTIVE_CONNECTIONS).map((r) => r.id)
  if (stale.length === 0) return []
  const now = new Date().toISOString()
  await admin.from('api_key').update({ revoked_at: now }).in('id', stale).is('revoked_at', null)
  await admin.from('oauth_refresh_token').update({ revoked_at: now }).in('api_key_id', stale).is('revoked_at', null)
  return stale
}

type RefreshRow = {
  id: number
  family_id: string
  client_id: string
  approved_by: string
  scope: string
  api_key_id: number | null
  expires_at: string
  used_at: string | null
  revoked_at: string | null
}

// Proč refresh neprošel — jen pro diagnostiku (audit_event přes
// lib/oauthDiagnostics.ts). Na odpovědi klientovi ani na pravidlech nic nemění.
export type RefreshFailReason =
  | 'unknown_token' | 'client_mismatch' | 'revoked' | 'refresh_reuse_in_grace'
  | 'family_revoked_reuse' | 'expired' | 'owner_inactive' | 'server_error'

export type RefreshFailInfo = {
  reason: RefreshFailReason
  clientId?: string
  familyId?: string
  apiKeyId?: number | null
  /** Klíče zrušené tímto požadavkem (zrušení rodiny). */
  revokedKeyIds?: number[]
}

export type RefreshResult =
  | { ok: true; tokens: IssuedTokens }
  | ({ ok: false; error: 'invalid_grant' | 'server_error' } & RefreshFailInfo)

// Výměna refresh tokenu (rotace). Starý token se atomicky označí jako
// použitý (UPDATE … WHERE used_at IS NULL … RETURNING), takže dva souběžné
// požadavky nemůžou oba uspět.
export async function refreshTokens(
  admin: Admin,
  p: { refreshToken: string; clientId: string | null },
): Promise<RefreshResult> {
  const hash = hashApiKey(p.refreshToken)
  const { data, error } = await admin
    .from('oauth_refresh_token')
    .select('id, family_id, client_id, approved_by, scope, api_key_id, expires_at, used_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle()
  if (error) return { ok: false, error: 'server_error', reason: 'server_error' }
  if (!data) return { ok: false, error: 'invalid_grant', reason: 'unknown_token' }
  const row = data as RefreshRow
  const now = Date.now()
  // Identifikace připojení pro diagnostiku (žádné tajemství ani hash).
  const ident = { clientId: row.client_id, familyId: row.family_id, apiKeyId: row.api_key_id }

  if (p.clientId && row.client_id !== p.clientId) return { ok: false, error: 'invalid_grant', reason: 'client_mismatch', ...ident }
  if (row.revoked_at) return { ok: false, error: 'invalid_grant', reason: 'revoked', ...ident }

  if (row.used_at) {
    // Reuse. V toleranci souběhu jen odmítnout, jinak celá rodina pryč.
    if (now - Date.parse(row.used_at) > REFRESH_REUSE_GRACE_MS) {
      const revokedKeyIds = await revokeFamily(admin, row.family_id)
      return { ok: false, error: 'invalid_grant', reason: 'family_revoked_reuse', ...ident, revokedKeyIds }
    }
    return { ok: false, error: 'invalid_grant', reason: 'refresh_reuse_in_grace', ...ident }
  }
  if (Date.parse(row.expires_at) <= now) return { ok: false, error: 'invalid_grant', reason: 'expired', ...ident }

  // Schvalovatel odešel / byl deaktivován: připojení končí.
  const owner = await loadKeyOwner(row.approved_by, admin)
  if (!owner.active) {
    const revokedKeyIds = await revokeFamily(admin, row.family_id)
    return { ok: false, error: 'invalid_grant', reason: 'owner_inactive', ...ident, revokedKeyIds }
  }

  const { data: claimed } = await admin
    .from('oauth_refresh_token')
    .update({ used_at: new Date(now).toISOString() })
    .eq('id', row.id)
    .is('used_at', null)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle()
  // Souběžný požadavek nás předběhl — bez zneplatnění rodiny, viz výše.
  if (!claimed) return { ok: false, error: 'invalid_grant', reason: 'refresh_reuse_in_grace', ...ident }

  const { data: client } = await admin
    .from('oauth_client').select('client_name').eq('client_id', row.client_id).maybeSingle()
  const scope: OAuthScope = owner.canSeeSales ? normalizeOAuthScope(row.scope) : 'read'

  let tokens: IssuedTokens
  try {
    tokens = await issueTokens(admin, {
      clientId: row.client_id,
      clientName: (client as { client_name: string | null } | null)?.client_name ?? null,
      approvedBy: row.approved_by,
      scope,
      familyId: row.family_id,
    })
  } catch {
    // Token jsme už označili jako použitý; klient dostane chybu a zkusí to
    // znovu — po odmlce by to vyšlo jako reuse. Vrátíme ho do hry.
    await admin.from('oauth_refresh_token').update({ used_at: null }).eq('id', row.id)
    return { ok: false, error: 'server_error', reason: 'server_error', ...ident }
  }

  // Předchozí access token té samé rodiny dožije za pár minut (jen zkrátit,
  // nikdy neprodloužit). Access tokeny jiných rodin ani klientů se nemění.
  if (row.api_key_id != null) {
    const graceEnd = new Date(now + OLD_ACCESS_GRACE_MS).toISOString()
    await admin
      .from('api_key')
      .update({ expires_at: graceEnd })
      .eq('id', row.api_key_id)
      .is('revoked_at', null)
      .gt('expires_at', graceEnd)
  }
  return { ok: true, tokens }
}

// Ruční zrušení tokenu v /api-klice: samotný access token nestačí, refresh
// token by z něj hned vyrobil nový. Zruší se proto celá rodina, do které
// klíč patří. Best effort — bez tabulky (nenasazená 0083) není co rušit
// a zrušení klíče samo tím neselže.
// Vrací id klíčů zrušených rodin — jen pro diagnostiku.
export async function revokeOAuthFamilyOfKey(admin: Admin, keyId: number): Promise<number[]> {
  const revoked: number[] = []
  try {
    const { data } = await admin.from('oauth_refresh_token').select('family_id').eq('api_key_id', keyId)
    const families = [...new Set(((data ?? []) as { family_id: string }[]).map((r) => r.family_id))]
    for (const f of families) revoked.push(...(await revokeFamily(admin, f)))
  } catch {
    // viz výše
  }
  return revoked
}

// Zrušení klíčů člověka (odebrání admina / deaktivace): zruší i jeho refresh
// tokeny, ať se konektor sám neobnoví. `scope` = jen tokeny s tímto rozsahem.
export async function revokeOAuthOfMember(admin: Admin, userId: string, scope?: OAuthScope): Promise<void> {
  try {
    let q = admin.from('oauth_refresh_token').update({ revoked_at: new Date().toISOString() }).eq('approved_by', userId)
    if (scope) q = q.eq('scope', scope)
    await q.is('revoked_at', null)
  } catch {
    // viz výše
  }
}
