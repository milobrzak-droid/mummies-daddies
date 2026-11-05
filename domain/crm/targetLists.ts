// Cílové seznamy (PLAN-PRESTAVBY kap. 4) — čistá doménová logika bez DB.
//
// Seznam = segment + proč oslovit + hypotéza hodnoty. Položka = firma
// s důvodem, kým (kontakt), dalším krokem a stavem. Klíčové pravidlo:
// první oslovení vytvoří AKTIVITU (sales_activity), nikdy fiktivní obchod.
// planStatusChange proto vrací jen zápisy do target_list_item a
// sales_activity — tabulku deal nezná.
import { z } from 'zod'

export const TARGET_STATUSES = ['navrzeno', 'osloveno', 'odpovedel', 'vyrazeno'] as const
export type TargetStatus = (typeof TARGET_STATUSES)[number]

export const TARGET_STATUS_LABEL: Record<TargetStatus, string> = {
  navrzeno: 'Navrženo',
  osloveno: 'Osloveno',
  odpovedel: 'Odpověděl',
  vyrazeno: 'Vyřazeno',
}

// Povolené přechody. Vyřazenou firmu jde vrátit do návrhu; z „odpověděl"
// se už neoslovuje znovu (další kroky patří na firmu / do pipeline).
const TRANSITIONS: Record<TargetStatus, readonly TargetStatus[]> = {
  navrzeno: ['osloveno', 'vyrazeno'],
  osloveno: ['odpovedel', 'vyrazeno'],
  odpovedel: ['vyrazeno'],
  vyrazeno: ['navrzeno'],
}

export function allowedTransitions(from: TargetStatus): readonly TargetStatus[] {
  return TRANSITIONS[from]
}

export function canTransition(from: TargetStatus, to: TargetStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export type TargetListCounts = Record<TargetStatus, number> & { total: number }

export function countByStatus(items: readonly { status: TargetStatus }[]): TargetListCounts {
  const c: TargetListCounts = { navrzeno: 0, osloveno: 0, odpovedel: 0, vyrazeno: 0, total: 0 }
  for (const i of items) {
    c[i.status] += 1
    c.total += 1
  }
  return c
}

/** Seskupí položky (list_id + status) do počtů pro přehled seznamů. */
export function countsByList(items: readonly { list_id: number; status: TargetStatus }[]): Map<number, TargetListCounts> {
  const groups = new Map<number, { status: TargetStatus }[]>()
  for (const i of items) {
    const g = groups.get(i.list_id) ?? []
    g.push(i)
    groups.set(i.list_id, g)
  }
  return new Map([...groups].map(([id, g]) => [id, countByStatus(g)]))
}

// --- validace ---------------------------------------------------------------

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const optionalId = z.preprocess((v) => (v === '' || v == null ? null : v), id.nullable())
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v ?? null),
    z.string().trim().max(max, `Nejvýš ${max} znaků.`).nullable(),
  )
const requiredText = (max: number, msg: string) => z.string().trim().min(1, msg).max(max, `Nejvýš ${max} znaků.`)

export const targetListSchema = z.object({
  name: requiredText(200, 'Vyplň název seznamu.'),
  segment: requiredText(200, 'Vyplň segment.'),
  rationale: requiredText(4000, 'Napiš, proč tenhle segment oslovit.'),
  value_hypothesis: optionalText(4000),
})

export const targetListItemSchema = z.object({
  list_id: id,
  account_id: z.coerce.number({ message: 'Vyber firmu.' }).int().positive('Vyber firmu.').max(Number.MAX_SAFE_INTEGER),
  reason: requiredText(2000, 'Důvod je povinný — proč právě tahle firma?'),
  contact_id: optionalId,
  next_step: optionalText(500),
  next_step_due: z.preprocess(
    (v) => (v === '' || v == null ? null : v),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Neplatné datum.').nullable(),
  ),
})

export const targetStatusSchema = z.enum(TARGET_STATUSES)
export const targetEntityId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

// --- plán změny stavu -------------------------------------------------------

export type OutreachActivity = {
  account_id: number
  contact_id: number | null
  kind: 'other'
  outcome: 'completed'
  subject: string
  body: string
  deal_id: null
}

export type StatusChangePlan =
  | { ok: false; error: string }
  | { ok: true; itemUpdate: { status: TargetStatus }; activity: OutreachActivity | null }

/**
 * Co se má zapsat při změně stavu položky. Přechod na „osloveno" přidá
 * aktivitu na firmu (kind 'other' — enum sales_activity_kind z 0020 nemá
 * 'outreach'), deal_id je vždy null. Obchod nevzniká nikdy.
 */
export function planStatusChange(
  item: { account_id: number; contact_id: number | null; reason: string; status: TargetStatus },
  listName: string,
  to: TargetStatus,
): StatusChangePlan {
  if (!canTransition(item.status, to)) {
    return { ok: false, error: `Ze stavu „${TARGET_STATUS_LABEL[item.status]}" nejde přejít na „${TARGET_STATUS_LABEL[to]}".` }
  }
  const activity: OutreachActivity | null =
    to === 'osloveno'
      ? {
          account_id: item.account_id,
          contact_id: item.contact_id,
          kind: 'other',
          outcome: 'completed',
          subject: `První oslovení — cílový seznam „${listName}"`.slice(0, 200),
          body: `Důvod oslovení: ${item.reason}`,
          deal_id: null,
        }
      : null
  return { ok: true, itemUpdate: { status: to }, activity }
}
