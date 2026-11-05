import { createAdminClient } from '@/lib/supabase/admin'
import { verifyPkceS256, CORS_HEADERS } from '@/lib/oauth'
import { readLimitedFormData } from '@/lib/httpBody'
import {
  effectiveScope, issueTokens, pruneOldConnections, refreshTokens, normalizeOAuthScope, scopeString,
  type IssuedTokens,
} from '@/lib/oauthTokens'
import { clientNameOf, recordOAuthProblem, revocationCause, type OAuthProblem } from '@/lib/oauthDiagnostics'

// Token endpoint (RFC 6749 + PKCE, OAuth 2.1). Umí dva grant_type:
//  - authorization_code: vymění jednorázový kód za access + refresh token,
//  - refresh_token: rotace — nový access i refresh token, starý refresh je
//    jednorázový (opakované použití = zneplatnění celé rodiny).
// Access token je API klíč z tabulky api_key — MCP endpoint tak zůstává beze
// změny a token jde kdykoli zneplatnit na /api-klice stejně jako každý jiný
// klíč. Rozsah ('read' / 'full') zvolil schvalovatel na souhlasné obrazovce
// a server ho při vydání znovu ověří (zápis jen pro obchodní roli).
//
// Klíč vzniká až TADY (dřív už při schválení a jeho plaintext ležel v
// oauth_code do vyzvednutí, viz migrace 0043). Nový token NEZNEPLATŇUJE
// tokeny jiných konektorů: dřív se rušil každý token „stejného jména" a dva
// konektory Cockpitu v Claude se tak navzájem odpojovaly dokola. Nově se
// drží jen pár nejnovějších připojení téhož client_id (pruneOldConnections).

// Diagnostika (lib/oauthDiagnostics.ts): každé odmítnutí se zapíše do
// audit_event s důvodem — bez tokenu, kódu i hashů. Odpověď klientovi se tím
// nemění (pořád jen invalid_grant / invalid_request podle RFC 6749).

const TOKEN_BODY_MAX_BYTES = 16 * 1024

// Chybová odpověď token endpointu (RFC 6749 §5.2): 400 + no-store jako u úspěchu.
function invalid(error: string) {
  return Response.json({ error }, { status: 400, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } })
}

type Admin = ReturnType<typeof createAdminClient>

async function reject(admin: Admin | null, error: string, problem: OAuthProblem, status: 400 | 500 = 400) {
  try {
    const db = admin ?? createAdminClient()
    if (!problem.clientName && problem.clientId) problem.clientName = await clientNameOf(db, problem.clientId)
    await recordOAuthProblem(db, problem)
  } catch {
    // diagnostika nesmí změnit odpověď
  }
  return status === 500 ? serverError() : invalid(error)
}

type CodeRow = {
  client_id: string
  redirect_uri: string
  code_challenge: string
  approved_by: string | null
  expires_at: string
  scope?: string | null
}

function tokenResponse(t: IssuedTokens) {
  return Response.json(
    {
      access_token: t.accessToken,
      token_type: 'Bearer',
      expires_in: t.expiresIn,
      ...(t.refreshToken ? { refresh_token: t.refreshToken } : {}),
      scope: scopeString(t.scope),
    },
    { status: 200, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } },
  )
}

const serverError = () => Response.json({ error: 'server_error' }, { status: 500, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } })

export async function POST(req: Request) {
  // Veřejný endpoint: tělo se čte se stropem (žádost o token má stovky bajtů).
  const form = await readLimitedFormData(req, TOKEN_BODY_MAX_BYTES)
  if (!form) return reject(null, 'invalid_request', { source: 'token', reason: 'invalid_request' })

  const grantType = String(form.get('grant_type') ?? '')
  if (grantType === 'refresh_token') return handleRefresh(form)
  if (grantType !== 'authorization_code') {
    return reject(null, 'unsupported_grant_type', {
      source: 'token', reason: 'unsupported_grant_type', clientId: String(form.get('client_id') ?? '') || null,
    })
  }
  return handleCode(form)
}

async function handleRefresh(form: FormData) {
  const refreshToken = String(form.get('refresh_token') ?? '')
  const clientId = String(form.get('client_id') ?? '')
  if (!refreshToken) {
    return reject(null, 'invalid_request', { source: 'token', reason: 'invalid_request', grantType: 'refresh_token', clientId: clientId || null })
  }

  const admin = createAdminClient()
  const res = await refreshTokens(admin, { refreshToken, clientId: clientId || null })
  if (!res.ok) {
    const problem: OAuthProblem = {
      source: 'token',
      reason: res.reason,
      grantType: 'refresh_token',
      // client_id z tokenu (známý řádek), jinak z formuláře.
      clientId: res.clientId ?? (clientId || null),
      familyId: res.familyId ?? null,
      apiKeyId: res.apiKeyId ?? null,
      revokedKeyIds: res.revokedKeyIds,
    }
    if (res.reason === 'revoked') problem.revokedBy = await revocationCause(admin, res.apiKeyId)
    return reject(admin, 'invalid_grant', problem, res.error === 'server_error' ? 500 : 400)
  }
  return tokenResponse(res.tokens)
}

async function handleCode(form: FormData) {
  const code = String(form.get('code') ?? '')
  const clientId = String(form.get('client_id') ?? '')
  const redirectUri = String(form.get('redirect_uri') ?? '')
  const codeVerifier = String(form.get('code_verifier') ?? '')
  const codeProblem = (reason: OAuthProblem['reason']): OAuthProblem =>
    ({ source: 'token', reason, grantType: 'authorization_code', clientId: clientId || null })
  if (!code || !clientId || !codeVerifier) return reject(null, 'invalid_request', codeProblem('invalid_request'))

  const admin = createAdminClient()

  // Atomické uplatnění: DELETE ... RETURNING. Dva souběžné požadavky se
  // stejným kódem nemůžou oba dostat řádek — druhý dostane null. Dál se
  // pracuje jen s vráceným řádkem, žádné SELECT-pak-DELETE.
  let res = await admin
    .from('oauth_code')
    .delete()
    .eq('code', code)
    .select('client_id, redirect_uri, code_challenge, approved_by, expires_at, scope')
    .maybeSingle()
  // Tolerance k nenasazené 0083 (sloupec scope chybí): DELETE selhal celý,
  // takže kód je pořád v tabulce; vydá se jen 'read'.
  if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204')) {
    res = await admin
      .from('oauth_code')
      .delete()
      .eq('code', code)
      .select('client_id, redirect_uri, code_challenge, approved_by, expires_at')
      .maybeSingle()
  }
  if (res.error) return reject(admin, 'invalid_grant', codeProblem('lookup_error'))
  if (!res.data) return reject(admin, 'invalid_grant', codeProblem('invalid_code'))
  const row = res.data as CodeRow

  if (new Date(row.expires_at).getTime() < Date.now()) return reject(admin, 'invalid_grant', codeProblem('code_expired'))
  if (row.client_id !== clientId) return reject(admin, 'invalid_grant', codeProblem('client_mismatch'))
  if (!verifyPkceS256(codeVerifier, row.code_challenge)) return reject(admin, 'invalid_grant', codeProblem('pkce_failed'))

  // redirect_uri: když přišel, musí sedět. Když nepřišel, je to v pořádku
  // jen u klienta s jedinou registrovanou adresou — jinak by nebylo jasné,
  // pro kterou z nich byl kód vydán.
  if (redirectUri !== '') {
    if (row.redirect_uri !== redirectUri) return reject(admin, 'invalid_grant', codeProblem('redirect_mismatch'))
  } else {
    const { data: client } = await admin
      .from('oauth_client').select('redirect_uris').eq('client_id', clientId).maybeSingle()
    if (!client || client.redirect_uris.length !== 1) return reject(admin, 'invalid_request', codeProblem('redirect_mismatch'))
  }

  // Kód bez schvalovatele = starý kód z doby před migrací 0043 (nebo
  // nenasazená migrace). Nevydávat — ať se nic nezaloží bez stopy, kdo to povolil.
  if (!row.approved_by) return reject(admin, 'invalid_grant', codeProblem('no_approver'))

  const { data: client } = await admin
    .from('oauth_client').select('client_name').eq('client_id', clientId).maybeSingle()
  const clientName = (client as { client_name: string | null } | null)?.client_name ?? null

  try {
    // Zápis jen pro schvalovatele s obchodní rolí — i kdyby kód nesl 'full'.
    const scope = await effectiveScope(normalizeOAuthScope(row.scope), row.approved_by, admin)
    const tokens = await issueTokens(admin, { clientId, clientName, approvedBy: row.approved_by, scope })
    const pruned = await pruneOldConnections(admin, { clientId, clientName, approvedBy: row.approved_by })
    // Prune nad MAX_ACTIVE_CONNECTIONS ruší starší připojení — do diagnostiky,
    // ať je v /api-klice vidět, proč se jiný konektor odpojil.
    if (pruned.length > 0) {
      await recordOAuthProblem(admin, {
        source: 'token', reason: 'pruned', grantType: 'authorization_code', clientId, clientName, revokedKeyIds: pruned,
      })
    }
    return tokenResponse(tokens)
  } catch {
    return reject(admin, 'server_error', { ...codeProblem('server_error'), clientName }, 500)
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
