// Jednotlivá změna vlastníka (a zástupce) případu, milníku, obchodu, dodávky
// a cílového seznamu — čistá logika bez I/O. Hromadné předání práce člověka
// řeší lib/memberWork.ts; tady je totéž po jedné věci, přímo na jejím detailu.
//
// Pravidla drží databázová funkce change_work_owner (migrace 0093, jen
// service_role); test/owner-change.test.ts porovnává kódy chyb a druhy s SQL,
// test/owner-change-0093-pglite.test.ts zkouší funkci v opravdovém Postgresu.
// Zápis je v lib/actions/ownerChange.ts, tlačítko a formulář v
// components/OwnerChange.tsx.
//
// Leží v lib/ (ne v domain/), protože ji potřebují stránky ze všech domén
// a lib/ nesmí importovat domain/ ani core/.
import { z } from 'zod'
import { TEAM_ROLES, isInternalRole } from '@/lib/domain'
import { formatPersonName } from '@/lib/format'

export const OWNER_KINDS = [
  { key: 'pripady', noun: 'případu', ownerLabel: 'Vlastník případu', hasDeputy: true },
  { key: 'milniky', noun: 'milníku', ownerLabel: 'Vlastník milníku', hasDeputy: true },
  { key: 'obchody', noun: 'obchodu', ownerLabel: 'Vlastník obchodu', hasDeputy: false },
  { key: 'dodavky', noun: 'dodávky', ownerLabel: 'Vlastník dodávky', hasDeputy: true },
  { key: 'seznamy', noun: 'cílového seznamu', ownerLabel: 'Vlastník seznamu', hasDeputy: false },
] as const

export type OwnerKind = (typeof OWNER_KINDS)[number]['key']
export const OWNER_KIND_KEYS = OWNER_KINDS.map((k) => k.key) as unknown as readonly [OwnerKind, ...OwnerKind[]]

export function isOwnerKind(v: unknown): v is OwnerKind {
  return typeof v === 'string' && OWNER_KINDS.some((k) => k.key === v)
}

export function ownerKindInfo(kind: OwnerKind) {
  return OWNER_KINDS.find((k) => k.key === kind)!
}

// --- Vstup akce ---------------------------------------------------------------

const optionalMemberId = z.string().uuid('Vyber člena týmu.').nullable()

export const ownerChangeSchema = z.object({
  kind: z.enum(OWNER_KIND_KEYS),
  id: z.number().int().positive(),
  /** Nový vlastník (null jen tam, kde věc žádného nemá — odebrat vlastníka nejde). */
  owner_id: optionalMemberId,
  /** Nový zástupce (jen druhy, které zástupce mají). */
  deputy_id: optionalMemberId.optional().transform((v) => v ?? null),
  /** Stav, který uživatel viděl — když se mezitím změnil, změna neprojde. */
  expect: z.object({ owner: optionalMemberId, deputy: optionalMemberId.optional().transform((v) => v ?? null) }).nullable().optional(),
  /** Id záznamu auditu, který se vrací (tlačítko Zpět). */
  undo_of: z.number().int().positive().nullable().optional(),
})
export type OwnerChangeInput = z.input<typeof ownerChangeSchema>

/** Návratový tvar akce changeWorkOwner. */
export type OwnerChangeUndo = { auditId: number; owner: string | null; deputy: string | null }
export type OwnerChangeResult =
  | { success: true; changed: boolean; message: string; undo: OwnerChangeUndo | null }
  | { success: false; error: string; fieldErrors?: Record<string, string> }

// --- Chyby funkce change_work_owner (0093) česky ------------------------------

export const OWNER_CHANGE_ERRORS: Readonly<Record<string, string>> = {
  OC001: 'Vlastníka téhle věci smí měnit správce týmu, vedení nebo ten, kdo ji vlastní či zastupuje.',
  OC002: 'Věc už neexistuje. Obnov stránku.',
  OC003: 'Vlastníka smí měnit jen aktivní člen týmu s interní rolí.',
  OC004: 'Neznámý druh věci.',
  OC005: 'Uzavřenou věc už nejde předat.',
  OC006: 'Věc mezitím změnil někdo jiný. Obnov stránku a zkus to znovu.',
  OC007: 'Vybrat jde jen aktivního člena týmu s interní rolí (ne Partnera ani deaktivovaného).',
  OC008: 'Zástupce musí být jiný člověk než vlastník.',
  OC009: 'Vlastníka nejde jen odebrat, předej ho jinému člověku.',
  OC010: 'Tuhle změnu už nejde vrátit. Změň vlastníka znovu ručně.',
  OC011: 'Tenhle druh věci zástupce nemá.',
  OC012: 'Zástupce bez vlastníka nedává smysl. Nejdřív vyber vlastníka.',
}

/** Databáze bez 0093 funkci change_work_owner nezná. */
export const OWNER_CHANGE_PENDING = 'Změna vlastníka čeká na migraci 0093.'

// --- Oprávnění (zrcadlo change_work_owner) -------------------------------------

export type OwnerActor = { id: string; role: string | null; is_admin?: boolean | null }
export type OwnerItem = {
  ownerId: string | null
  deputyId?: string | null
  /** Jen případ: vlastník oblasti případu (loop_node.owner_id). */
  nodeOwnerId?: string | null
}

/**
 * Smí aktér měnit vlastníka téhle věci? Stejné pravidlo jako v SQL: správce
 * týmu, vedení, dnešní vlastník nebo zástupce (u případu i vlastník oblasti).
 * Slouží jen k tomu, aby stránka ukázala tlačítko těm, kdo ho smějí použít;
 * autoritativní je databáze.
 */
export function canChangeOwner(kind: OwnerKind, actor: OwnerActor | null, item: OwnerItem): boolean {
  if (!actor || !isInternalRole(actor.role)) return false
  if (actor.is_admin || actor.role === 'vedeni') return true
  if (item.ownerId === actor.id) return true
  if (ownerKindInfo(kind).hasDeputy && item.deputyId === actor.id) return true
  return kind === 'pripady' && !!item.nodeOwnerId && item.nodeOwnerId === actor.id
}

// --- Kdo jde vybrat -----------------------------------------------------------

export type OwnerPerson = { id: string; name: string; roleLabel: string }

type MemberLike = { id: string; full_name: string | null; email?: string | null; role: string | null; deactivated_at?: string | null }

/**
 * Aktivní členové s interní rolí (deaktivovaný ani Partner nejdou vybrat),
 * seřazení podle jména. Stejná pravidla jako příjemce v „Předat práci".
 */
export function ownerOptions(members: readonly MemberLike[]): OwnerPerson[] {
  return members
    .filter((m) => !m.deactivated_at && isInternalRole(m.role))
    .map((m) => ({
      id: m.id,
      name: formatPersonName(m.full_name, m.email),
      roleLabel: TEAM_ROLES.find((r) => r.key === m.role)?.label ?? String(m.role),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'cs'))
}

// --- Texty --------------------------------------------------------------------

/** „Vlastník případu: Petr → Lenka." (+ věta o uvolněném zástupci). */
export function ownerChangeMessage(input: {
  kind: OwnerKind
  role: 'owner' | 'deputy'
  fromName: string | null
  toName: string | null
  freedDeputy?: boolean
  undone?: boolean
}): string {
  const info = ownerKindInfo(input.kind)
  const label = input.role === 'owner' ? info.ownerLabel : `Zástupce ${info.noun}`
  const arrow = `${input.fromName ?? 'nikdo'} → ${input.toName ?? 'nikdo'}`
  const tail = input.freedDeputy ? ' Zástupce se uvolnil, doplň nového.' : ''
  return `${input.undone ? 'Vráceno zpět. ' : ''}${label}: ${arrow}.${tail}`
}

/** Cesty, které se po změně přegenerují (detail věci a přehledy, kde je vlastník vidět). */
export function ownerChangePaths(kind: OwnerKind, id: number, accountId: number | null, engagementId: number | null): string[] {
  const out = ['/cockpit']
  if (kind === 'pripady') out.push(`/cockpit/pripady/${id}`, '/cockpit/pripady')
  if (kind === 'obchody') out.push('/cockpit/pipeline', ...(accountId ? [`/cockpit/clients/${accountId}/deals/${id}`] : []))
  if (kind === 'seznamy') out.push('/cockpit/cilove-seznamy', `/cockpit/cilove-seznamy/${id}`)
  if (kind === 'milniky' || kind === 'dodavky') {
    out.push('/cockpit/dodavky')
    if (accountId && engagementId) out.push(`/cockpit/clients/${accountId}/engagements/${engagementId}/edit`)
  }
  return out
}
