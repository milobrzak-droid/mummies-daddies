import type { SupabaseClient } from '@supabase/supabase-js'
import {
  OAUTH_AUDIT_ACTION, OAUTH_AUDIT_ENTITY, OAUTH_SOURCE_LABELS, oauthReasonLabel,
  type OAuthProblemPayload, type OAuthProblemSource,
} from '@/lib/oauthDiagnostics'
import { logError } from '@/lib/log'

// Přehled připojení konektoru Claude (/api-klice → „Připojení Claude") a
// denní hlídání (Stav úloh v Nastavení, Stav zdrojů v ranním souhrnu).
//
// Připojení = rodina refresh tokenů (oauth_refresh_token.family_id, 0083):
// jedno schválení v Cockpitu, ze kterého se rotací rodí další tokeny. Stav
// a důvod se skládají z řádků tokenů, klíčů (api_key) a diagnostických
// událostí v audit_event (lib/oauthDiagnostics.ts). Jen čtení; čistá část
// (buildOAuthConnections, assessOAuthHealth, oauthHealthStatus) je bez I/O.

type Db = Pick<SupabaseClient, 'from'>

export type ConnectionStatus = 'active' | 'expired' | 'revoked'

export type OAuthConnection = {
  familyId: string
  clientId: string
  clientName: string | null
  approverName: string | null
  scope: 'read' | 'full'
  connectedAt: string
  lastUsedAt: string | null
  /** Do kdy platí obnovovací token (= připojení bez nového schválení). */
  validUntil: string
  status: ConnectionStatus
  /** Důvod u prošlého / zrušeného připojení (lidsky). */
  reason: string | null
  /** Kdy se stav změnil (zrušení / vypršení). */
  changedAt: string | null
}

export type OAuthProblemRow = {
  id: number
  at: string
  source: string
  reason: string
  clientName: string | null
  /** Konec family_id — rozliší připojení v seznamu bez celého uuid. */
  connection: string | null
  repeats: number
  revoked: boolean
}

export type RefreshRowLite = {
  family_id: string
  client_id: string
  approved_by: string
  scope: string
  api_key_id: number | null
  expires_at: string
  used_at: string | null
  revoked_at: string | null
  created_at: string
}
export type KeyRowLite = { id: number; last_used_at: string | null; revoked_at: string | null; expires_at?: string | null }
export type MemberLite = { id: string; full_name: string | null; deactivated_at?: string | null }
export type AuditRowLite = { id: number; occurred_at: string; after: OAuthProblemPayload | null }

const DAY = 86_400_000
/** Neaktivní připojení se ukazují jen tolik dní po změně stavu. */
export const INACTIVE_SHOWN_DAYS = 30
export const CONNECTIONS_SHOWN_MAX = 50
export const PROBLEMS_SHOWN = 20

const NO_RECORD_REASON = 'zrušeno bez záznamu důvodu (ručně před zavedením diagnostiky, nebo odebráním či deaktivací člověka)'

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

/** Čistá funkce: připojení (rodiny) se stavem a důvodem, aktivní první, pak nejnovější změna. */
export function buildOAuthConnections(input: {
  refreshRows: readonly RefreshRowLite[]
  keys: readonly KeyRowLite[]
  clients: readonly { client_id: string; client_name: string | null }[]
  members: readonly MemberLite[]
  events: readonly AuditRowLite[]
  now: Date
}): OAuthConnection[] {
  const nowMs = input.now.getTime()
  const keyById = new Map(input.keys.map((k) => [k.id, k]))
  const clientName = new Map(input.clients.map((c) => [c.client_id, c.client_name]))
  const memberById = new Map(input.members.map((m) => [m.id, m]))

  const families = new Map<string, RefreshRowLite[]>()
  for (const r of input.refreshRows) {
    const list = families.get(r.family_id) ?? []
    list.push(r)
    families.set(r.family_id, list)
  }

  // Události se zrušením, nejnovější první.
  const revocations = input.events
    .filter((e) => e.after?.revoked && Array.isArray(e.after.revoked_key_ids))
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))

  const out: OAuthConnection[] = []
  for (const [familyId, rows] of families) {
    const sorted = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    const current = sorted[0]
    const first = sorted[sorted.length - 1]
    const keyIds = new Set(sorted.map((r) => r.api_key_id).filter((id): id is number => id != null))
    let lastUsedAt: string | null = null
    for (const id of keyIds) lastUsedAt = latest(lastUsedAt, keyById.get(id)?.last_used_at ?? null)
    const approver = memberById.get(current.approved_by)

    let status: ConnectionStatus = 'active'
    let reason: string | null = null
    let changedAt: string | null = null
    const currentKey = current.api_key_id != null ? keyById.get(current.api_key_id) : undefined
    const revokedAt = current.revoked_at ?? currentKey?.revoked_at ?? null
    if (revokedAt) {
      status = 'revoked'
      changedAt = revokedAt
      const cause = revocations.find((e) =>
        e.after!.family_id === familyId || e.after!.revoked_key_ids!.some((id) => keyIds.has(id)))
      reason = cause ? oauthReasonLabel(cause.after!.reason) : NO_RECORD_REASON
    } else if (Date.parse(current.expires_at) <= nowMs) {
      status = 'expired'
      changedAt = current.expires_at
      reason = 'obnovovací token vypršel (180 dní bez použití)'
    } else if (approver?.deactivated_at) {
      // Přístup už neplatí (validateApiKey), rodina se zruší při příští obnově.
      status = 'revoked'
      changedAt = approver.deactivated_at
      reason = oauthReasonLabel('owner_inactive')
    }

    out.push({
      familyId,
      clientId: current.client_id,
      clientName: clientName.get(current.client_id) ?? null,
      approverName: approver?.full_name ?? null,
      scope: current.scope === 'full' ? 'full' : 'read',
      connectedAt: first.created_at,
      lastUsedAt,
      validUntil: current.expires_at,
      status,
      reason,
      changedAt,
    })
  }

  const shownFrom = nowMs - INACTIVE_SHOWN_DAYS * DAY
  return out
    .filter((c) => c.status === 'active' || (c.changedAt != null && Date.parse(c.changedAt) >= shownFrom))
    .sort((a, b) => {
      if ((a.status === 'active') !== (b.status === 'active')) return a.status === 'active' ? -1 : 1
      const at = Date.parse(a.changedAt ?? a.lastUsedAt ?? a.connectedAt)
      const bt = Date.parse(b.changedAt ?? b.lastUsedAt ?? b.connectedAt)
      return bt - at
    })
    .slice(0, CONNECTIONS_SHOWN_MAX)
}

/** Čistá funkce: posledních N problémů pro seznam v /api-klice. */
export function buildOAuthProblems(
  events: readonly AuditRowLite[],
  clients: readonly { client_id: string; client_name: string | null }[],
  limit = PROBLEMS_SHOWN,
): OAuthProblemRow[] {
  const clientName = new Map(clients.map((c) => [c.client_id, c.client_name]))
  return [...events]
    .filter((e) => e.after && typeof e.after.reason === 'string')
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || b.id - a.id)
    .slice(0, limit)
    .map((e) => {
      const a = e.after!
      const base = oauthReasonLabel(a.reason)
      const extra: string[] = []
      if (a.revoked_by) extra.push(`dřív: ${oauthReasonLabel(a.revoked_by)}`)
      if (a.family_active === true) extra.push('připojení má novější platný token — klient poslal starý')
      if (a.key_kind === 'manual') extra.push('ruční API klíč')
      if (a.owner_state && a.owner_state !== 'active') extra.push(`schvalovatel: ${a.owner_state}`)
      return {
        id: e.id,
        at: e.occurred_at,
        source: OAUTH_SOURCE_LABELS[a.source as OAuthProblemSource] ?? String(a.source),
        reason: extra.length > 0 ? `${base} (${extra.join('; ')})` : base,
        clientName: a.client_name ?? (a.client_id ? clientName.get(a.client_id) ?? null : null),
        connection: a.family_id ? a.family_id.slice(-6) : null,
        repeats: typeof a.repeats === 'number' ? a.repeats : 0,
        revoked: a.revoked === true,
      }
    })
}

// ---------------------------------------------------------------------------
// Denní hlídání (Stav úloh, ranní souhrn)

export const OAUTH_HEALTH_HOURS = 24
/** Kolik 401 u jinak platného připojení za 24 h už je „opakovaně". */
export const OAUTH_REPEATED_401 = 3

/** Zrušení, která připojení ukončí bez lidského zásahu (ruční zrušení sem nepatří). */
const AUTOMATIC_REVOCATIONS = new Set(['family_revoked_reuse', 'owner_inactive', 'pruned'])

export type OAuthHealth = {
  /** Kolik připojení za 24 h zrušila pravidla (reuse, neaktivní schvalovatel, prune). */
  revocations: number
  revocationReasons: string[]
  /** Kolik připojení dostalo za 24 h opakovaně 401, ačkoli mají platný token. */
  repeated401Connections: number
  alert: boolean
}

/** Čistá funkce: z diagnostických událostí stav za posledních 24 h. */
export function assessOAuthHealth(events: readonly AuditRowLite[], now: Date): OAuthHealth {
  const from = now.getTime() - OAUTH_HEALTH_HOURS * 3_600_000
  const recent = events.filter((e) => e.after && Date.parse(e.occurred_at) >= from)
  const revoked = recent.filter((e) => e.after!.revoked && AUTOMATIC_REVOCATIONS.has(e.after!.reason))
  const per = new Map<string, number>()
  for (const e of recent) {
    const a = e.after!
    if (a.source !== 'mcp' || a.family_active !== true || !a.family_id) continue
    per.set(a.family_id, (per.get(a.family_id) ?? 0) + 1 + (typeof a.repeats === 'number' ? a.repeats : 0))
  }
  const repeated = [...per.values()].filter((n) => n >= OAUTH_REPEATED_401).length
  return {
    revocations: revoked.length,
    revocationReasons: [...new Set(revoked.map((e) => oauthReasonLabel(e.after!.reason)))],
    repeated401Connections: repeated,
    alert: revoked.length > 0 || repeated > 0,
  }
}

/** Jedna věta pro Stav zdrojů / Stav úloh; null = není co hlásit. */
export function oauthHealthStatus(h: OAuthHealth | null | undefined): { line: string; alert: boolean } | null {
  if (!h || !h.alert) return null
  const parts: string[] = []
  if (h.revocations > 0) parts.push(`${h.revocations}× zrušené připojení (${h.revocationReasons.join('; ')})`)
  if (h.repeated401Connections > 0) {
    parts.push(`${h.repeated401Connections}× připojení s opakovaným 401, ačkoli má platný token`)
  }
  return { line: `Konektor Claude za 24 h: ${parts.join(', ')} — detail v API klíčích (Připojení Claude)`, alert: true }
}

// ---------------------------------------------------------------------------
// Čtení

const MISSING = new Set(['42P01', 'PGRST205', '42703', 'PGRST204'])

async function loadEvents(db: Db, sinceIso: string | null, limit: number): Promise<AuditRowLite[] | null> {
  let q = db
    .from('audit_event')
    .select('id, occurred_at, after')
    .eq('action', OAUTH_AUDIT_ACTION)
    .eq('entity_table', OAUTH_AUDIT_ENTITY)
  if (sinceIso) q = q.gte('occurred_at', sinceIso)
  const { data, error } = await q.order('occurred_at', { ascending: false }).limit(limit)
  if (error) {
    if (!MISSING.has(String((error as { code?: unknown }).code))) logError('oauthOverview.events', error)
    return null
  }
  return (data ?? []) as AuditRowLite[]
}

/** Stav za 24 h; null = audit_event nejde přečíst. Nevyhazuje. */
export async function loadOAuthHealth(db: Db, now: Date = new Date()): Promise<OAuthHealth | null> {
  try {
    const since = new Date(now.getTime() - OAUTH_HEALTH_HOURS * 3_600_000).toISOString()
    const events = await loadEvents(db, since, 1000)
    return events ? assessOAuthHealth(events, now) : null
  } catch (e) {
    logError('oauthOverview.health', e)
    return null
  }
}

export type OAuthOverview = {
  /** false = chybí tabulka oauth_refresh_token (0083) — připojení nejde vypsat. */
  available: boolean
  connections: OAuthConnection[]
  problems: OAuthProblemRow[]
  health: OAuthHealth | null
}

/**
 * Přehled pro /api-klice. Čte servisním klientem (oauth_refresh_token
 * a api_key jsou jen pro service role) — volat jen pro admina.
 */
export async function loadOAuthOverview(db: Db, now: Date = new Date()): Promise<OAuthOverview> {
  const rt = await db
    .from('oauth_refresh_token')
    .select('family_id, client_id, approved_by, scope, api_key_id, expires_at, used_at, revoked_at, created_at')
    .order('created_at', { ascending: false })
    .limit(2000)
  const events = (await loadEvents(db, null, 500)) ?? []
  if (rt.error) {
    if (!MISSING.has(String((rt.error as { code?: unknown }).code))) logError('oauthOverview.refresh', rt.error)
    return { available: false, connections: [], problems: buildOAuthProblems(events, []), health: assessOAuthHealth(events, now) }
  }
  const refreshRows = (rt.data ?? []) as RefreshRowLite[]
  const keyIds = [...new Set(refreshRows.map((r) => r.api_key_id).filter((id): id is number => id != null))]
  const clientIds = [...new Set([
    ...refreshRows.map((r) => r.client_id),
    ...events.map((e) => e.after?.client_id).filter((c): c is string => typeof c === 'string'),
  ])]
  const memberIds = [...new Set(refreshRows.map((r) => r.approved_by))]

  const [keys, clients, members] = await Promise.all([
    keyIds.length > 0
      ? db.from('api_key').select('id, last_used_at, revoked_at, expires_at').in('id', keyIds)
      : Promise.resolve({ data: [], error: null }),
    clientIds.length > 0
      ? db.from('oauth_client').select('client_id, client_name').in('client_id', clientIds)
      : Promise.resolve({ data: [], error: null }),
    loadMembers(db, memberIds),
  ])
  const clientRows = ((clients.data ?? []) as { client_id: string; client_name: string | null }[])
  return {
    available: true,
    connections: buildOAuthConnections({
      refreshRows,
      keys: (keys.data ?? []) as KeyRowLite[],
      clients: clientRows,
      members,
      events,
      now,
    }),
    problems: buildOAuthProblems(events, clientRows),
    health: assessOAuthHealth(events, now),
  }
}

async function loadMembers(db: Db, ids: string[]): Promise<MemberLite[]> {
  if (ids.length === 0) return []
  const res = await db.from('team_member').select('id, full_name, deactivated_at').in('id', ids)
  if (res.error && MISSING.has(String((res.error as { code?: unknown }).code))) {
    const legacy = await db.from('team_member').select('id, full_name').in('id', ids)
    return (legacy.data ?? []) as MemberLite[]
  }
  return (res.data ?? []) as MemberLite[]
}
