import { randomBytes, createHash } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { isInternalRole } from '@/lib/domain'
import { logError } from '@/lib/log'

// sha256(plaintext) — no salt/slow-hash needed: the input has 192 bits of
// entropy from randomBytes, unlike a user-chosen password. Same approach
// Stripe/GitHub use for API keys.
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const random = randomBytes(24).toString('base64url')
  const plaintext = `cockpit_${random}`
  return { plaintext, hash: hashApiKey(plaintext), prefix: plaintext.slice(0, 16) }
}

// Při úspěchu vracíme i toho, kdo klíč vytvořil — zápisy přes API se pak
// dají přiřadit konkrétnímu člověku místo anonymního „někdo přes API".
// Rozsah klíče (migrace 0043): 'read' = jen čtení, 'full' = i zápis.
// Klíče vydané přes OAuth konektor jsou 'read'; ručně vytvořené 'full'.
// 'intake' (migrace 0079) = klíč jen pro příjem zápisů schůzek z diktátu
// (POST /api/ingest/meeting-notes): nic jiného nepřečte ani nezapíše.
export type ApiKeyScope = 'read' | 'full' | 'intake'

// canSeeSales (rozhodnutí majitele 2026-09-28, migrace 0058): obchody
// a částky vidí jen obchodní role. API a MCP čtou přes admin klienta, který
// RLS obchází — proto se role vlastníka klíče (api_key.created_by →
// team_member.role) musí zkontrolovat tady, v kódu. Klíč bez vlastníka
// (člověk odešel, ON DELETE SET NULL) obchodní data nevidí.
export type ApiKeyAuthResult =
  | { ok: true; createdBy: string | null; keyId: number; scope: ApiKeyScope; canSeeSales: boolean }
  | { ok: false; status: number; error: string }

// Stejná množina rolí jako can_see_sales() (0020, naposledy 0069) a sees_byznys
// v lib/domain.ts; shodu hlídá test/sales-roles.test.ts.
export const SALES_ROLES: readonly string[] = ['vedeni', 'obchodnik']

export function isSalesRole(role: unknown): boolean {
  return typeof role === 'string' && SALES_ROLES.includes(role)
}

// Smí vlastník klíče vidět obchody a částky? Fail closed: bez vlastníka,
// s chybou dotazu nebo s neznámou rolí = ne.
export async function ownerCanSeeSales(
  createdBy: string | null,
  admin: ReturnType<typeof createAdminClient> = createAdminClient(),
): Promise<boolean> {
  if (!createdBy) return false
  return (await loadKeyOwner(createdBy, admin)).canSeeSales
}

// Kolik volání za minutu snese jeden klíč. Legitimní použití (Cowork skill,
// naplánovaná úloha) se sem vejde s velkou rezervou; smysl je zastavit
// tlučení uniklým klíčem, ne omezovat práci.
const RATE_LIMIT_PER_MINUTE = 120
// Příjem zápisů schůzek má vlastní, přísnější strop: zkratka pošle jeden zápis
// po schůzce, ne desítky za minutu — a každý zápis nese až desítky kB textu.
export const INTAKE_RATE_LIMIT_PER_MINUTE = 20

// Vlastník klíče: role (obchodní data) a jestli není deaktivovaný.
// Fail closed: chyba dotazu nebo chybějící řádek = neaktivní vlastník.
export async function loadKeyOwner(
  createdBy: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ active: boolean; canSeeSales: boolean }> {
  try {
    let res = await admin.from('team_member').select('role, deactivated_at').eq('id', createdBy).maybeSingle()
    // Tolerance k nenasazené 0069 (sloupec deactivated_at chybí).
    if (res.error && isMissingColumn(res.error)) {
      res = await admin.from('team_member').select('role').eq('id', createdBy).maybeSingle()
    }
    if (res.error || !res.data) return { active: false, canSeeSales: false }
    const row = res.data as { role?: unknown; deactivated_at?: unknown }
    if (row.deactivated_at) return { active: false, canSeeSales: false }
    // Partner (externí účet, 0082) klíč nepoužije: API čte přes service role a RLS neplatí.
    if (!isInternalRole(row.role as string)) return { active: false, canSeeSales: false }
    return { active: true, canSeeSales: isSalesRole(row.role) }
  } catch {
    return { active: false, canSeeSales: false }
  }
}

// Je klíč použitelný? Zneplatněný, prošlý (expires_at, OAuth tokeny od 0069)
// nebo bez vlastníka (člověk smazán, created_by = NULL) = ne.
export function isKeyUsable(row: KeyRow, now: number = Date.now()): boolean {
  if (row.revoked_at) return false
  if (!row.created_by) return false
  if (row.expires_at && Date.parse(row.expires_at) <= now) return false
  return true
}

// Looks up a raw key string taken from the Authorization: Bearer header.
// Klíče mají desítky znaků; nesmyslně dlouhá hlavička se odmítne bez hashování a dotazu do DB.
const API_KEY_MAX_LENGTH = 512

export async function validateApiKey(plaintext: string): Promise<ApiKeyAuthResult> {
  if (!plaintext || plaintext.length > API_KEY_MAX_LENGTH) return { ok: false, status: 401, error: 'unauthorized' }

  const admin = createAdminClient()
  const data = await lookupKey(admin, hashApiKey(plaintext))

  if (!data || !isKeyUsable(data)) return { ok: false, status: 401, error: 'unauthorized' }

  // Deaktivovaný vlastník (lib/actions/team.ts deactivateParticipant) = klíč
  // neplatí, i kdyby ho někdo zapomněl zneplatnit.
  const createdBy = data.created_by as string
  const owner = await loadKeyOwner(createdBy, admin)
  if (!owner.active) return { ok: false, status: 401, error: 'unauthorized' }

  // Čeká se schválně. Dřív to bylo fire-and-forget „ať nezdržuje", jenže
  // ve serverless se funkce po odeslání odpovědi zmrazí a zápis se nikdy
  // neprovedl — last_used_at bylo null i u klíčů používaných denně, takže
  // nešlo poznat aktivní klíč od mrtvého. Jedno kolo do databáze je cena
  // za to, že ten údaj vůbec existuje.
  await admin.from('api_key').update({ last_used_at: new Date().toISOString() }).eq('id', data.id)

  return { ok: true, createdBy, keyId: data.id, scope: data.scope, canSeeSales: owner.canSeeSales }
}

type KeyRow = {
  id: number
  revoked_at: string | null
  created_by: string | null
  scope: ApiKeyScope
  expires_at?: string | null
}

// Tolerance k nenasazeným migracím: bez sloupce expires_at (0069) se čte
// bez něj; bez sloupce scope (0043) se klíč bere jako 'full' — to je
// chování před 0043. OAuth klíče se 'read' bez migrace vydat nedají
// (token endpoint pak selže), takže tahle cesta nikdy nezvedne práva.
async function lookupKey(admin: ReturnType<typeof createAdminClient>, keyHash: string): Promise<KeyRow | null> {
  const full = await admin
    .from('api_key')
    .select('id, revoked_at, created_by, scope, expires_at')
    .eq('key_hash', keyHash)
    .maybeSingle()
  if (!full.error) {
    if (!full.data) return null
    return { ...full.data, scope: normalizeScope(full.data.scope) }
  }
  if (!isMissingColumn(full.error)) return null

  const withScope = await admin
    .from('api_key')
    .select('id, revoked_at, created_by, scope')
    .eq('key_hash', keyHash)
    .maybeSingle()
  if (!withScope.error) {
    if (!withScope.data) return null
    return { ...withScope.data, scope: normalizeScope(withScope.data.scope) }
  }
  if (!isMissingColumn(withScope.error)) return null

  const legacy = await admin
    .from('api_key')
    .select('id, revoked_at, created_by')
    .eq('key_hash', keyHash)
    .maybeSingle()
  if (legacy.error || !legacy.data) return null
  return { ...legacy.data, scope: 'full' }
}

// Cokoli jiného než přesně 'full' nebo 'intake' se bere jako 'read' —
// neznámá hodnota nesmí omylem otevřít zápis.
export function normalizeScope(value: unknown): ApiKeyScope {
  if (value === 'full') return 'full'
  if (value === 'intake') return 'intake'
  return 'read'
}

function isMissingColumn(error: { code?: string } | null): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204'
}

// Smí klíč s daným scope zapisovat (aktivity, úkoly, další kroky)? Klíč
// 'intake' nesmí — smí jen příjem zápisů schůzek (canIngestMeetingNotes).
export function canWrite(scope: ApiKeyScope): boolean {
  return scope === 'full'
}

// Smí klíč poslat zápis schůzky? 'full' ano (zápis je užší než to, co smí),
// 'intake' ano, 'read' ne.
export function canIngestMeetingNotes(scope: ApiKeyScope): boolean {
  return scope === 'full' || scope === 'intake'
}

// Scope klíče, kterým je podepsaný MCP požadavek — z hlavičky Authorization.
// Slouží serveMcp, když mu volající scope nepředá. Když klíč nejde určit,
// vrací 'read' (fail closed).
export async function scopeFromRequest(req: Request): Promise<ApiKeyScope> {
  try {
    const header = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/)
    const plaintext = header?.[1] ?? ''
    if (!plaintext) return 'read'
    const row = await lookupKey(createAdminClient(), hashApiKey(plaintext))
    if (!row || !isKeyUsable(row)) return 'read'
    // MCP klíč 'intake' nemá — kdyby se sem přesto dostal, je jen ke čtení.
    return row.scope === 'intake' ? 'read' : row.scope
  } catch {
    return 'read'
  }
}

// Zaznamená volání a zároveň řekne, jestli klíč nepřekročil limit.
// Log slouží dvěma věcem: brzdě proti uniklému klíči a stopě, co přes API
// externí nástroje dělaly — do teď se u zápisu vědělo jen „čí klíč", ne kdy.
//
// Primárně RPC api_request_hit (0096): zámek klíče, počet a zápis v jedné
// transakci, takže souběžné požadavky limit nepřeskočí. Bez migrace (funkce
// neexistuje) se použije původní count-then-insert. V obou případech platí:
// chyba databáze = odmítnout (503), ne povolit. Brzda, která při výpadku
// propustí všechno, by byla jen dekorace.
export const RATE_UNAVAILABLE = { ok: false as const, status: 503, error: 'rate_limit_unavailable' }

function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === '42883' || error.code === 'PGRST202' || error.code === 'rpc_unavailable'
}

export async function recordAndCheckRate(
  keyId: number,
  path: string,
  limitPerMinute: number = RATE_LIMIT_PER_MINUTE,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const admin = createAdminClient()

  let viaRpc: { data: unknown; error: { code?: string; message?: string } | null }
  try {
    viaRpc = (await admin.rpc('api_request_hit', { p_key_id: keyId, p_path: path, p_limit: limitPerMinute })) as typeof viaRpc
  } catch {
    // Klient bez rpc (nebo výjimka na cestě k DB): zkusí se původní cesta níž,
    // která při chybě DB odmítne.
    viaRpc = { data: null, error: { code: 'rpc_unavailable' } }
  }
  if (!viaRpc.error) {
    return viaRpc.data === true ? { ok: true } : { ok: false, status: 429, error: 'rate_limited' }
  }
  if (!isMissingFunction(viaRpc.error)) {
    logError('apiKey.rate', viaRpc.error, { keyId })
    return RATE_UNAVAILABLE
  }

  // Původní cesta (migrace 0096 zatím nenasazená).
  const since = new Date(Date.now() - 60_000).toISOString()
  const counted = await admin
    .from('api_request')
    .select('id', { count: 'exact', head: true })
    .eq('key_id', keyId)
    .gte('at', since)
  if (counted.error) {
    logError('apiKey.rate', counted.error, { keyId })
    return RATE_UNAVAILABLE
  }

  if ((counted.count ?? 0) >= limitPerMinute) {
    return { ok: false, status: 429, error: 'rate_limited' }
  }

  // Také se čeká, a ze stejného důvodu: nedokončený zápis by znamenal, že
  // počítadlo zůstane na nule a limit se nikdy nespustí — brzda by tu jen
  // vypadala, že je.
  const written = await admin.from('api_request').insert({ key_id: keyId, path })
  if (written.error) {
    logError('apiKey.rate', written.error, { keyId })
    return RATE_UNAVAILABLE
  }
  return { ok: true }
}

// Validates the Authorization: Bearer <key> header on a /api/v1/* request.
// No cookie session, no MFA — this is server-to-server auth, separate from
// the rest of the app's auth model.
//
// `write: true` = zápisová routa: klíč se scope 'read' dostane 403.
// `sales: true` = routa vrací nebo mění obchody/částky: klíč vlastníka bez
// obchodní role (nebo bez vlastníka) dostane 403 sales_role_required.
// `intake: true` = routa příjmu zápisů schůzek: smí ji klíč 'intake' i 'full',
// 'read' dostane 403. Klíč 'intake' se na VŠECH ostatních routách (bez
// tohohle příznaku) odmítne 403 insufficient_scope — nic jiného číst ani
// zapisovat nesmí. `rateLimitPerMinute` přepíše výchozí strop 120/min.
// `logPath` = pod jakou cestou se volání zapíše do api_request (výchozí
// pathname); MCP tak přidá název nástroje. Volá se až po ověření klíče,
// takže neověřený požadavek nic navíc (např. tělo) nečte. Na limit nemá vliv.
export async function requireApiKey(
  req: Request,
  opts: { write?: boolean; sales?: boolean; intake?: boolean; rateLimitPerMinute?: number; logPath?: () => Promise<string> } = {},
): Promise<ApiKeyAuthResult> {
  const auth = req.headers.get('authorization') ?? ''
  const match = auth.match(/^Bearer\s+(.+)$/)
  if (!match) return { ok: false, status: 401, error: 'unauthorized' }

  const result = await validateApiKey(match[1])
  if (!result.ok) return result
  if (opts.intake) {
    if (!canIngestMeetingNotes(result.scope)) return { ok: false, status: 403, error: 'insufficient_scope' }
  } else if (result.scope === 'intake') {
    return { ok: false, status: 403, error: 'insufficient_scope' }
  }
  if (opts.write && !canWrite(result.scope)) {
    return { ok: false, status: 403, error: 'insufficient_scope' }
  }
  if (opts.sales && !result.canSeeSales) {
    return { ok: false, status: 403, error: 'sales_role_required' }
  }

  // Limit se kontroluje tady, ne v každé routě zvlášť — jinak by stačilo
  // jednou zapomenout a ta routa by zůstala bez brzdy.
  const pathname = new URL(req.url).pathname
  const path = opts.logPath ? await opts.logPath().catch(() => pathname) : pathname
  const rate = await recordAndCheckRate(result.keyId, path, opts.rateLimitPerMinute)
  if (!rate.ok) return rate
  return result
}
