import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import { detectInjectionMarkers, type InjectionFlag } from '@/core/untrusted'
import { dbErrorMessage } from '@/lib/actionResult'
import { logWarn } from '@/lib/log'
import { DO_NOT_CONTACT_REASON_MAX } from '@/lib/domain'
import { OPT_OUT_MISSING_MIGRATION_MESSAGE, writeContactWithOptOut } from '@/domain/crm/contactOptOut'
import { fold } from '@/domain/crm/bulkImport'
import { resolveAccountForApi } from '@/domain/crm/apiAccountMatch'
import { SALES_ONLY_ERROR, type WriteResult } from '@/domain/crm/apiWrite'

// Zakládání a úprava kontaktních osob přes API/MCP (create_contact,
// update_contact). Mazání tudy nejde (to je v Cockpitu jen pro admina kvůli
// GDPR redakci zápisů). Firma kontaktu se při úpravě nemění — stejně jako ve
// formuláři.
//
// Kontakty jsou osobní údaje a přes konektor je čte jen obchodní role
// (get_contacts), proto i zápis je jen pro ni.
//
// Nesouhlas s oslovením (do_not_contact, 0087) jde přes API jen ZAPNOUT.
// Zrušit ho smí jen člověk v Cockpitu: agent nesmí nikoho „odblokovat" k
// oslovení na základě textu z e-mailu.
//
// Audit: admin klient s hlavičkou aktéra → DB trigger 0064/0087 zapíše
// contact.created / contact.updated jménem vlastníka klíče (jen bezpečné
// sloupce s hodnotou, jméno, e-mail a telefon nikdy).

export const API_CONTACT_LIMITS = { name: 200, role: 200, email: 320, phone: 50, notes: 5_000 } as const

const text = (max: number, what: string) =>
  z.string().trim().min(1, `${what} nesmí být prázdný`).max(max, `${what} je delší než ${max} znaků`)
const email = z.string().trim().max(API_CONTACT_LIMITS.email, 'email je moc dlouhý')
  .regex(/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/, 'email nemá platný tvar')
  .transform((v) => v.toLowerCase())
const phone = z.string().trim().min(3, 'phone je moc krátký').max(API_CONTACT_LIMITS.phone, 'phone je moc dlouhý')
  .regex(/^[0-9+()\-./ ]+$/, 'phone smí obsahovat jen číslice, mezery a znaky + ( ) - . /')
const reason = z.string().trim().min(1).max(DO_NOT_CONTACT_REASON_MAX, `Důvod nesouhlasu může mít nejvýš ${DO_NOT_CONTACT_REASON_MAX} znaků.`)

export const createContactInput = z.object({
  account_id: z.number().int().positive().nullish(),
  account_name: z.string().trim().min(2, 'account_name je moc krátký').max(200).nullish(),
  account_ico: z.string().trim().max(20).nullish(),
  partner_id: z.number().int().positive().nullish(),
  full_name: text(API_CONTACT_LIMITS.name, 'full_name'),
  role: text(API_CONTACT_LIMITS.role, 'role').nullish(),
  email: email.nullish(),
  phone: phone.nullish(),
  notes: text(API_CONTACT_LIMITS.notes, 'notes').nullish(),
  is_champion: z.boolean().optional(),
  do_not_contact: z.boolean().optional(),
  do_not_contact_reason: reason.nullish(),
}).strict()

export const UPDATE_CONTACT_FIELDS = [
  'full_name', 'role', 'email', 'phone', 'notes', 'is_champion', 'do_not_contact', 'do_not_contact_reason',
] as const

export const updateContactInput = z.object({
  contact_id: z.number().int().positive('contact_id musí být kladné celé číslo'),
  full_name: text(API_CONTACT_LIMITS.name, 'full_name').optional(),
  role: text(API_CONTACT_LIMITS.role, 'role').nullable().optional(),
  email: email.nullable().optional(),
  phone: phone.nullable().optional(),
  notes: text(API_CONTACT_LIMITS.notes, 'notes').nullable().optional(),
  is_champion: z.boolean().optional(),
  do_not_contact: z.boolean().optional(),
  do_not_contact_reason: reason.optional(),
}).strict()

export const CONTACT_NOT_FOUND = 'Kontakt nenalezen.'
export const CONTACT_OWNER_REQUIRED = 'Vyplň právě jedno: klienta (account_id nebo account_name), nebo partnera (partner_id).'
export const PARTNER_NOT_FOUND = 'Partner s tímto id v Cockpitu není.'
export const OPT_OUT_CLEAR_REFUSED =
  'Nesouhlas s oslovením přes konektor zrušit nejde. Když ho člověk opravdu odvolal, ať ho zruší uživatel v Cockpitu.'
export const OPT_OUT_REASON_ONLY_WITH_FLAG = 'do_not_contact_reason jde poslat jen spolu s do_not_contact: true.'

function failed(error: string, status = 400): WriteResult<never> {
  return { ok: false, status, error }
}

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0]
  if (!issue) return 'Neplatný vstup.'
  if (issue.code === 'unrecognized_keys') return `Tohle pole přes konektor zadat nejde: ${issue.keys.join(', ')}.`
  return issue.message
}

const flagsOf = (...texts: (string | null | undefined)[]): InjectionFlag[] =>
  detectInjectionMarkers(texts.filter((t): t is string => typeof t === 'string' && t !== '').join('\n'))

type Sibling = { id: number; full_name: string | null; email: string | null }

/** Stejný člověk u téže firmy: shodný e-mail, nebo shodné jméno (bez diakritiky a velikosti). */
export function findDuplicateContact(
  siblings: readonly Sibling[],
  candidate: { full_name: string; email: string | null },
): Sibling | null {
  const name = fold(candidate.full_name)
  const mail = candidate.email?.toLowerCase() ?? null
  return siblings.find((s) => (mail != null && s.email?.toLowerCase() === mail) || (name !== '' && fold(s.full_name ?? '') === name)) ?? null
}

export type CreatedContact = {
  id: number
  account: { id: number; name: string } | null
  partner_id: number | null
  injection_flags?: InjectionFlag[]
}

export async function createContactForApi(
  raw: unknown,
  createdBy: string | null,
  canSeeSales: boolean,
): Promise<WriteResult<CreatedContact>> {
  if (!canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  const parsed = createContactInput.safeParse(raw)
  if (!parsed.success) return failed(firstIssue(parsed.error))
  const input = parsed.data
  const accountGiven = input.account_id != null || !!input.account_name || !!input.account_ico
  const partnerGiven = input.partner_id != null
  if (accountGiven === partnerGiven) return failed(CONTACT_OWNER_REQUIRED)
  if (input.do_not_contact_reason && input.do_not_contact !== true) return failed(OPT_OUT_REASON_ONLY_WITH_FLAG)

  const check = createAdminClient()
  let account: { id: number; name: string } | null = null
  let partnerId: number | null = null
  if (accountGiven) {
    const res = await resolveAccountForApi(input)
    if (!res.ok) return failed(res.error, res.status)
    account = { id: res.account.id, name: res.account.name }
  } else {
    const { data, error } = await check.from('partner').select('id').eq('id', input.partner_id as number).maybeSingle()
    if (error) return failed(dbErrorMessage('apiContacts.create', error), 500)
    if (!data) return failed(PARTNER_NOT_FOUND, 404)
    partnerId = input.partner_id as number
  }

  // Duplicity: stejný člověk u téže firmy se nezakládá podruhé.
  const siblingsQuery = check.from('contact').select('id, full_name, email')
  const { data: siblings, error: siblingsError } = account
    ? await siblingsQuery.eq('account_id', account.id)
    : await siblingsQuery.eq('partner_id', partnerId as number)
  if (siblingsError) return failed(dbErrorMessage('apiContacts.create', siblingsError), 500)
  const twin = findDuplicateContact((siblings ?? []) as Sibling[], { full_name: input.full_name, email: input.email ?? null })
  if (twin) return failed(`Tenhle kontakt u firmy už je (id ${twin.id}). Uprav ho přes update_contact.`, 409)

  const row: Record<string, unknown> = {
    account_id: account?.id ?? null,
    partner_id: partnerId,
    full_name: input.full_name,
    role: input.role ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    notes: input.notes ?? null,
    is_champion: input.is_champion ?? false,
  }
  if (input.do_not_contact === true) {
    row.do_not_contact = true
    row.do_not_contact_reason = input.do_not_contact_reason ?? null
  }
  const admin = createAuditedAdminClient({ actor: { type: 'api_key', id: createdBy } })
  const w = await writeContactWithOptOut(row, (r) => admin.from('contact').insert(r).select('id').single())
  if (w.optOutBlocked) return failed(OPT_OUT_MISSING_MIGRATION_MESSAGE, 409)
  if (w.result.error) return failed(dbErrorMessage('apiContacts.create', w.result.error), 500)
  const id = (w.result.data as { id: number }).id

  const flags = flagsOf(input.full_name, input.role, input.notes, input.do_not_contact_reason)
  if (flags.length > 0) logWarn('api.contact', 'text kontaktu nese příznaky možných pokynů pro AI', { flags, contact: id })
  return {
    ok: true,
    data: { id, account, partner_id: partnerId, ...(flags.length > 0 ? { injection_flags: flags } : {}) },
  }
}

export type UpdatedContact = { id: number; changed: string[]; injection_flags?: InjectionFlag[] }

export async function updateContactForApi(
  raw: unknown,
  createdBy: string | null,
  canSeeSales: boolean,
): Promise<WriteResult<UpdatedContact>> {
  if (!canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  const parsed = updateContactInput.safeParse(raw)
  if (!parsed.success) return failed(firstIssue(parsed.error))
  const input = parsed.data
  const has = (k: (typeof UPDATE_CONTACT_FIELDS)[number]) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined
  if (!UPDATE_CONTACT_FIELDS.some(has)) return failed('Nic ke změně: pošli aspoň jedno pole kontaktu.')
  if (has('do_not_contact_reason') && input.do_not_contact !== true) return failed(OPT_OUT_REASON_ONLY_WITH_FLAG)

  // select('*'): sloupce nesouhlasu (0087) před migrací chybí → undefined.
  const check = createAdminClient()
  const { data: found, error: readError } = await check.from('contact').select('*').eq('id', input.contact_id).maybeSingle()
  if (readError) return failed(dbErrorMessage('apiContacts.update', readError), 500)
  if (!found) return failed(CONTACT_NOT_FOUND, 404)
  const existing = found as { id: number; do_not_contact?: boolean | null }

  if (input.do_not_contact === false && existing.do_not_contact === true) return failed(OPT_OUT_CLEAR_REFUSED, 403)

  const u: Record<string, unknown> = {}
  if (has('full_name')) u.full_name = input.full_name
  if (has('role')) u.role = input.role ?? null
  if (has('email')) u.email = input.email ?? null
  if (has('phone')) u.phone = input.phone ?? null
  if (has('notes')) u.notes = input.notes ?? null
  if (has('is_champion')) u.is_champion = input.is_champion
  if (input.do_not_contact === true) {
    u.do_not_contact = true
    if (has('do_not_contact_reason')) u.do_not_contact_reason = input.do_not_contact_reason
  }
  const changed = Object.keys(u).sort()
  if (changed.length === 0) return { ok: true, data: { id: existing.id, changed } }

  const admin = createAuditedAdminClient({ actor: { type: 'api_key', id: createdBy } })
  const w = await writeContactWithOptOut(u, (r) => admin.from('contact').update(r).eq('id', existing.id).select('id').maybeSingle())
  if (w.optOutBlocked) return failed(OPT_OUT_MISSING_MIGRATION_MESSAGE, 409)
  if (w.result.error) return failed(dbErrorMessage('apiContacts.update', w.result.error), 500)
  if (!w.result.data) return failed(CONTACT_NOT_FOUND, 404)

  const flags = flagsOf(input.full_name, input.role, input.notes, input.do_not_contact_reason)
  if (flags.length > 0) logWarn('api.contact', 'text kontaktu nese příznaky možných pokynů pro AI', { flags, contact: existing.id })
  return { ok: true, data: { id: existing.id, changed, ...(flags.length > 0 ? { injection_flags: flags } : {}) } }
}
