import { baseUrlFrom, CORS_HEADERS } from '@/lib/oauth'

// Discovery dokument autorizačního serveru (RFC 8414). Claude si ho stáhne
// dřív, než vůbec zkusí zavolat /api/mcp — bez něj custom connector odmítne
// pokračovat, protože netuší, kam poslat authorize/token/register.

export async function GET(req: Request) {
  const base = baseUrlFrom(req)

  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  }

  return Response.json(metadata, { headers: CORS_HEADERS })
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
