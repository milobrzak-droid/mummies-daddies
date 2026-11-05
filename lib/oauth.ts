import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { COMPANY } from '@/config'

// Základ URL, na které aplikace běží. OAuth metadata musí vracet absolutní
// URL a musí sedět s tím, co klient volal, jinak flow selže na neshodě
// issueru.
//
// Přednost má env APP_URL (např. https://www.mummiesdaddies.com): hlavička
// x-forwarded-host je pod kontrolou volajícího všude, kde ji proxy
// nepřepisuje, a z issueru by si útočník mohl udělat vlastní doménu.
// Bez APP_URL (lokální vývoj, preview deploye) se URL odvozuje z požadavku
// jako dřív — na Vercelu x-forwarded-* nastavuje sama platforma.
export function baseUrlFrom(req: Request): string {
  const configured = process.env.APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  const url = new URL(req.url)
  // Za Vercel proxy je skutečný protokol/host v x-forwarded-*.
  const host = req.headers.get('x-forwarded-host') ?? url.host
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

// PKCE S256: challenge = base64url(sha256(verifier)).
// Porovnání v konstantním čase, ať délka shody neprozrazuje nic přes timing.
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const expected = Buffer.from(challenge)
  if (computed.length !== expected.length) return false
  return timingSafeEqual(computed, expected)
}

// Hosty, na které se smí vracet OAuth kód. Výchozí seznam = callbacky Claude
// konektorů (claude.ai, případně claude.com — dokumentace Claude uvádí
// https://claude.ai/api/mcp/auth_callback s možným přesunem na claude.com).
// api.anthropic.com tu není záměrně: MCP konektor v Claude API dostává token
// od volajícího, žádný OAuth redirect na něj nevede. Další hosty přidá env
// OAUTH_REDIRECT_HOSTS (čárkou oddělené hostname, např. "cowork.example.cz");
// přidává k výchozím, nenahrazuje je.
export const DEFAULT_REDIRECT_HOSTS = ['claude.ai', 'claude.com'] as const
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export function extraRedirectHosts(env: string | undefined = process.env.OAUTH_REDIRECT_HOSTS): string[] {
  return (env ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    // jen holý hostname: bez schématu, cesty, portu a wildcardů
    .filter((h) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h))
}

export function allowedRedirectHosts(): string[] {
  return [...new Set([...DEFAULT_REDIRECT_HOSTS, ...extraRedirectHosts()])]
}

function parseRedirect(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.hash || u.username || u.password) return null
  return u
}

// Povolené redirect_uri při registraci klienta (a znovu při schvalování, aby
// se dřív zaregistrovaný klient s cizím hostem nedal použít): https jen na
// hosty ze seznamu výše, http jen na loopback (localhost / 127.0.0.1 — nativní
// a CLI klienti jako Claude Code). Jiná schémata (javascript:, data:, vlastní
// app schémata, http na veřejný host) i libovolný cizí https host odmítáme.
export function isAllowedRedirectUri(raw: string): boolean {
  const u = parseRedirect(raw)
  if (!u) return false
  if (u.protocol === 'https:') return allowedRedirectHosts().includes(u.hostname.toLowerCase())
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.includes(u.hostname)
  return false
}

// Redirect je z výchozího seznamu Claude (ne z env a ne loopback). Jen pro
// takový redirect se na souhlasné obrazovce předvybírá zápis.
export function isDefaultClaudeRedirect(raw: string): boolean {
  const u = parseRedirect(raw)
  if (!u || u.protocol !== 'https:') return false
  return (DEFAULT_REDIRECT_HOSTS as readonly string[]).includes(u.hostname.toLowerCase())
}

// Jednoduchý per-IP limit pro /api/oauth/register (pevné okno v paměti).
// OMEZENÍ: na serverless (Vercel) má každá instance funkce vlastní paměť
// a studený start ji vynuluje, takže limit je „na instanci", ne globální.
// Zastaví naivní tlučení z jedné IP, ne distribuovaný útok. Stávající brzda
// API klíčů (tabulka api_request) je vázaná na key_id, pro anonymní DCR
// se nehodí; kdyby to bylo potřeba, další krok je tabulka / KV podle IP.
export const REGISTER_LIMIT = 10
const REGISTER_WINDOW_MS = 60 * 60_000
const registerHits = new Map<string, { count: number; resetAt: number }>()

export function checkRegisterRate(ip: string, now = Date.now()): boolean {
  if (registerHits.size > 10_000) {
    for (const [k, v] of registerHits) if (v.resetAt <= now) registerHits.delete(k)
  }
  const hit = registerHits.get(ip)
  if (!hit || hit.resetAt <= now) {
    registerHits.set(ip, { count: 1, resetAt: now + REGISTER_WINDOW_MS })
    return true
  }
  hit.count += 1
  return hit.count <= REGISTER_LIMIT
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  return (fwd?.split(',')[0]?.trim()) || req.headers.get('x-real-ip') || 'unknown'
}

// CORS pro metadata a token endpointy — klient je volá z jiného originu.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
} as const

// Jediný název a jediná adresa MCP konektoru. Klient ho v seznamu konektorů
// ukazuje podle serverInfo (lib/mcpServer.ts) a resource_name v metadatech.
export const MCP_DISPLAY_NAME = COMPANY.productName
export const MCP_PATH = '/api/mcp'
export const MCP_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/api/mcp'

// Hlavička WWW-Authenticate pro 401 z MCP endpointu (RFC 9728 §5.1, MCP
// autorizace): klient z ní pozná, kde jsou metadata, a umí si obnovit token
// (refresh_token) nebo znovu zahájit autorizaci. Bez ní klient jen hlásí,
// že Cockpit „nejde zastihnout".
//
// Když požadavek token nesl (a neprošel), přidá error="invalid_token"
// (RFC 6750 §3.1) — klient tak ví, že token je neplatný a má ho obnovit.
// Bez tokenu (první krok discovery) se kód chyby podle RFC 6750 neuvádí.
export function wwwAuthenticate(req: Request): string {
  const metadata = `resource_metadata="${baseUrlFrom(req)}${MCP_RESOURCE_METADATA_PATH}"`
  const hadToken = /^Bearer\s+\S/.test(req.headers.get('authorization') ?? '')
  return hadToken ? `Bearer error="invalid_token", ${metadata}` : `Bearer ${metadata}`
}
