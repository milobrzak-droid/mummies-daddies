// Vstupy formulářů pracovních případů (Loop Core). Vlastní soubor, ať se
// nemíchá se sdíleným lib/validation/schemas.ts.
import { z } from 'zod'
import { CASE_STATUSES, NODES, STEP_STATUSES } from './workCase'
import { isApprovalActionType } from './approvalActions'

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)

export const entityId = z.coerce.number().int().positive()
const optionalId = z.preprocess(emptyToNull, entityId.nullable()).default(null)
const optionalUuid = z.preprocess(emptyToNull, z.uuid().nullable()).default(null)
const title = z.string().trim().min(1, 'Vyplňte název.').max(300, 'Nejvýš 300 znaků.')

export const createCaseSchema = z.object({
  title,
  node: z.enum(NODES, 'Vyberte uzel.'),
  account_id: optionalId,
  deal_id: optionalId,
  lead_owner_id: optionalUuid,
  template: z.preprocess(emptyToNull, z.string().max(64).nullable()).default(null),
})

export const addStepSchema = z.object({ case_id: entityId, title })

export const stepStatusSchema = z.object({ step_id: entityId, to: z.enum(STEP_STATUSES) })

export const caseStatusSchema = z.object({ case_id: entityId, to: z.enum(CASE_STATUSES) })

export const requestApprovalSchema = z.object({
  case_id: entityId,
  action_kind: z.string().trim()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'Malá písmena, číslice a podtržítko (např. external_commitment).')
    // Druh akce s provedením (0084) má vlastní formulář — obecná žádost by
    // vypadala jako akce, ale nic by neprovedla (CHECK approval_request_typed_kind).
    .refine((v) => !isApprovalActionType(v), 'Tuhle činnost žádej vlastním formulářem (Navrhnout další krok ke schválení).'),
  expires_on: z.preprocess(emptyToNull, z.iso.date('Neplatné datum.').nullable()).default(null),
})

// „Potvrdit další krok" (0084): krok případu a úkol řešiteli po schválení.
export const requestNextStepSchema = z.object({
  case_id: entityId,
  title: z.string().trim().min(1, 'Vyplňte, jaký krok následuje.').max(300, 'Nejvýš 300 znaků.'),
  assignee_id: z.uuid('Vyberte, kdo krok udělá.'),
  due_on: z.iso.date('Vyplňte termín.'),
  decision_id: optionalId,
  expires_on: z.preprocess(emptyToNull, z.iso.date('Neplatné datum.').nullable()).default(null),
})

// „Odložit do…" na serveru (0084): zítra, týden, nebo vrátit mezi čekající.
export const snoozeApprovalSchema = z.object({
  request_id: entityId,
  choice: z.enum(['zitra', 'tyden', 'vratit']),
})

export const retryExecutionSchema = z.object({ request_id: entityId })

export const recordDecisionSchema = z.object({
  case_id: entityId,
  question: z.string().trim().min(1, 'Vyplňte otázku.').max(1000, 'Nejvýš 1000 znaků.'),
  options: z.string().max(2000).default(''),
})

export const resolveDecisionSchema = z.object({
  decision_id: entityId,
  chosen: z.string().trim().min(1, 'Vyberte možnost.').max(300),
})

export const decideApprovalSchema = z.object({
  request_id: entityId,
  approve: z.enum(['1', '0']),
  note: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable()).default(null),
})
