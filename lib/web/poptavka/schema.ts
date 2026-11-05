/**
 * Validace průvodce poptávkou (zod). Hlášky jsou doslova z mikrotextů
 * (CHYBA — …) přes MESSAGES z lib/web/validation.ts, pravidla stejná jako
 * validateInquiry (mock submitInquiry) + to, co copy formuláře značí hvězdičkou
 * navíc: místo (adresa, nebo „Hledám prostor“) a telefon.
 *
 * validateDraft(draft, step?) → FieldErrors podle cest kontraktu (InquiryField).
 * Bezpečné pro klienta.
 */
import { z } from 'zod'
import type { FieldErrors, InquiryField } from '../api'
import { isoDate } from '../format'
import { EVENT_TYPES, minimumGuests, type EventType } from '../options'
import { isEmail, isIco, isPhone, MESSAGES } from '../validation'
import { STEP_FIELDS, STEP_IDS, isBusiness, type InquiryDraft, type StepId } from './draft'

const EVENT_VALUES = EVENT_TYPES.map((e) => e.value) as [EventType, ...EventType[]]
const MAX_GUESTS = 5000

const required = z.string().trim().min(1, MESSAGES.required)
const optional = z.string().trim()

/**
 * Schéma stavu průvodce. `today` = YYYY-MM-DD (kvůli testům).
 * Dvě části: `fields` (každé pole zvlášť) a `rules` (pravidla mezi poli –
 * minimum osob podle typu akce, místo, nebo „Hledám prostor“). Zod spouští
 * superRefine jen nad bezchybným objektem, proto jsou pravidla ve vlastním
 * schématu nad typy, které nemohou selhat.
 */
export function inquiryDraftSchema(today = isoDate()) {
  const fields = z.object({
    eventType: z.enum(EVENT_VALUES, { error: MESSAGES.required }),
    eventDate: optional.refine((v) => !v || v >= today, MESSAGES.pastDate),
    customerKind: z.enum(['firma', 'soukrome', 'agentura'], { error: MESSAGES.required }),
    companyIco: optional.refine((v) => !v || isIco(v), MESSAGES.ico),
    name: required,
    email: required.refine(isEmail, MESSAGES.email),
    phone: required.refine(isPhone, MESSAGES.phone),
    consent: z.literal(true, { error: MESSAGES.consent }),
  })
  const rules = z
    .object({ eventType: z.string().nullable(), guests: z.string(), address: z.string(), needsVenue: z.boolean() })
    .superRefine((d, ctx) => {
      if (d.eventType === 'konzultace') return
      const n = Number(d.guests.replace(/\s/g, ''))
      if (!d.guests.trim() || !Number.isInteger(n) || n < 1 || n > MAX_GUESTS) {
        ctx.addIssue({ code: 'custom', path: ['guests'], message: MESSAGES.required })
      } else if (d.eventType && EVENT_VALUES.includes(d.eventType as EventType)) {
        const min = minimumGuests(d.eventType as EventType)
        if (min && n < min) ctx.addIssue({ code: 'custom', path: ['guests'], message: MESSAGES.belowMinimum(min) })
      }
      if (!d.address.trim() && !d.needsVenue) ctx.addIssue({ code: 'custom', path: ['address'], message: MESSAGES.required })
    })
  return { fields, rules }
}

/** Klíč ve stavu → cesta pole v kontraktu. */
const PATH: Record<string, InquiryField> = {
  eventType: 'eventType',
  guests: 'guests',
  eventDate: 'eventDate',
  address: 'venue.address',
  budget: 'budgetPerPerson',
  customerKind: 'customerKind',
  companyName: 'company.name',
  companyIco: 'company.ico',
  name: 'contact.name',
  email: 'contact.email',
  phone: 'contact.phone',
  consent: 'consent',
}

/**
 * Chyby celého průvodce, nebo jen polí jednoho kroku (`step`).
 * Firma a IČO se kontrolují jen u B2B (Za firmu / agentura).
 */
export function validateDraft(draft: InquiryDraft, step?: StepId, today = isoDate()): FieldErrors<InquiryField> {
  const input = {
    ...draft,
    companyIco: isBusiness(draft.customerKind) ? draft.companyIco.replace(/\s/g, '') : '',
  }
  const { fields, rules } = inquiryDraftSchema(today)
  const issues = [fields.safeParse(input), rules.safeParse(input)].flatMap((r) => (r.success ? [] : r.error.issues))
  const out: FieldErrors<InquiryField> = {}
  const allowed = step ? new Set<string>(STEP_FIELDS[step]) : null
  for (const issue of issues) {
    const field = PATH[String(issue.path[0])]
    if (!field || out[field]) continue
    if (allowed && !allowed.has(field)) continue
    out[field] = issue.message
  }
  return out
}

/** První krok (v pořadí průvodce), ve kterém je chyba. */
export function firstStepWithError(errors: FieldErrors<InquiryField>): StepId | null {
  for (const id of STEP_IDS) if (STEP_FIELDS[id].some((f) => errors[f])) return id
  return null
}
