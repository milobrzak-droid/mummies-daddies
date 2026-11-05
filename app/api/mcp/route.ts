import { NextResponse } from 'next/server'
import { requireApiKey } from '@/lib/apiKeyAuth'
import { mcpLogPath, serveMcp } from '@/lib/mcpServer'
import { wwwAuthenticate } from '@/lib/oauth'
import { readLimitedBody, type BodyRead } from '@/lib/httpBody'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordMcpUnauthorized } from '@/lib/oauthDiagnostics'

// Strop těla MCP požadavku. Nástroje berou krátké argumenty (nejdelší je
// zápis z jednání), 256 kB je s velkou rezervou. Tělo se čte až po ověření
// klíče, po částech a s tvrdým stropem (i když odesílatel zamlčí délku).
const MCP_BODY_MAX_BYTES = 256 * 1024

// Pojistka: jeden MCP request (JSON odpověď) má trvat sekundy. Kdyby přesto
// něco viselo, ať to Vercel utne po minutě, ne po 300 s.
export const maxDuration = 60

// MCP endpoint. Klíč jde vždy v hlavičce Authorization: Bearer — buď ruční
// API klíč (Claude Code CLI: `claude mcp add --transport http ... --header`),
// nebo OAuth token z claude.ai / Cowork custom connectoru.
// Každé volání (i čtení kontaktů) projde stejnou branou: zápis do api_request
// s názvem nástroje (/api/mcp#get_contacts) a limit 120 za minutu na klíč.
async function handleMcp(req: Request): Promise<Response> {
  const hasBody = req.method === 'POST'
  let buffered: Promise<BodyRead> | null = null
  const readBody = () => (buffered ??= readLimitedBody(req, MCP_BODY_MAX_BYTES))
  const auth = await requireApiKey(req, {
    logPath: async () => {
      if (!hasBody) return mcpLogPath(req)
      const body = await readBody()
      return mcpLogPath(req, body.ok ? body.text : null)
    },
  })
  if (!auth.ok) {
    const headers: Record<string, string> = {}
    // 401: řekni klientovi, kde získat / obnovit token. 429: brzda je jen
    // dočasná — Retry-After říká, že autorizace zůstává platná. 503 (brzda
    // nejde ověřit, výpadek DB) je taky dočasná, ne odhlášení.
    if (auth.status === 401) {
      headers['WWW-Authenticate'] = wwwAuthenticate(req)
      // Diagnostika: proč (prošlý, zrušený, neznámý token…) do audit_event.
      // Bez tokenu v hlavičce (běžný první krok OAuth discovery) se nezapisuje.
      await recordMcpUnauthorized(safeAdmin(), req)
    }
    if (auth.status === 429) headers['Retry-After'] = '60'
    if (auth.status === 503) headers['Retry-After'] = '30'
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers })
  }
  if (!hasBody) return serveMcp(req, auth.createdBy, auth.scope, auth.canSeeSales)

  // Tělo je už přečtené (stream se dá číst jen jednou) — SDK dostane jeho kopii.
  const body = await readBody()
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status })
  const headers = new Headers(req.headers)
  headers.delete('content-length')
  return serveMcp(new Request(req.url, { method: 'POST', headers, body: body.text }), auth.createdBy, auth.scope, auth.canSeeSales)
}

// Klient pro diagnostiku; kdyby ho nešlo vytvořit (chybí env), zápis se
// jen přeskočí — odpověď 401 se tím nemění.
function safeAdmin() {
  try {
    return createAdminClient()
  } catch {
    return { from: () => { throw new Error('admin client unavailable') } } as unknown as ReturnType<typeof createAdminClient>
  }
}

export async function GET(req: Request) { return handleMcp(req) }
export async function POST(req: Request) { return handleMcp(req) }
export async function DELETE(req: Request) { return handleMcp(req) }
