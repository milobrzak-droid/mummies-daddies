import { baseUrlFrom, CORS_HEADERS, MCP_DISPLAY_NAME } from '@/lib/oauth'

// Metadata chráněného zdroje /api/mcp (RFC 9728). Klientovi říká, který
// autorizační server má pro tenhle MCP endpoint použít — jinak by po 401
// nevěděl, kde si vyzvednout token, a flow by se zasekl.

export async function GET(req: Request) {
  const base = baseUrlFrom(req)

  const metadata = {
    resource: `${base}/api/mcp`,
    // Stabilní název, pod kterým se konektor v klientech (Claude) ukazuje.
    resource_name: MCP_DISPLAY_NAME,
    authorization_servers: [base],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  }

  return Response.json(metadata, { headers: CORS_HEADERS })
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
