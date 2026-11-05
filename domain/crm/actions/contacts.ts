'use server'
import { AUTH_ERROR_MESSAGE, requireUser, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { contactSchema, areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'
import { recordAudit, type AuditActor } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { redactContactFromSalesActivity } from '@/domain/crm/gdprSweep'
import { logError } from '@/lib/log'
import { contactDeletedAuditBefore } from '@/domain/crm/auditPayload'
import { judgeSingleRowDelete, CONTACT_DELETE_FAILED_MESSAGE, NOT_ADMIN_MESSAGE } from '@/domain/crm/deleteVerdict'
import { isCurrentUserAdmin } from '@/lib/queries/team'
import { OPT_OUT_MISSING_MIGRATION_MESSAGE, writeContactWithOptOut } from '@/domain/crm/contactOptOut'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) { const k = String(i.path[0] ?? '_'); if (!out[k]) out[k] = i.message }
  return out
}

// Po migraci 0064 zapisuje smazání kontaktu DB trigger (contact.deleted,
// bez jména, e-mailu a role — jen názvy sloupců a account_id/partner_id)
// i při kaskádě ze smazání firmy. Do té doby ho zapisuje appka sama
// v zúženém tvaru z 0037; nikdy obojí. recordAudit sám nevyhazuje (loguje
// a degraduje), try/catch je pojistka — smazání je hotové a selhání auditu
// ho nesmí strhnout s sebou.
async function auditContactDeleted(
  contactId: number,
  existing: { email: string | null; account_id?: number | null },
  actor: AuditActor,
): Promise<void> {
  try {
    if (await dbAuditActive()) return
    await recordAudit('contact', contactId, 'contact.deleted', contactDeletedAuditBefore(existing), null, actor)
  } catch {
    // úmyslně tiché — recordAudit už zalogoval, tady se jen jistíme
  }
}

export async function createContact(accountId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = contactSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  // Nesouhlas s oslovením (0087): kdy a kdo doplní databáze; bez migrace viz contactOptOut.ts.
  const w = await writeContactWithOptOut({ ...parsed.data, account_id: accountId, partner_id: null },
    (row) => s.from('contact').insert(row))
  if (w.optOutBlocked) return { success: false, error: OPT_OUT_MISSING_MIGRATION_MESSAGE }
  if (w.result.error) return { success: false, error: dbErrorMessage('action.contacts', w.result.error) }
  revalidatePath(`/cockpit/clients/${accountId}`)
  return { success: true }
}

export async function deleteContact(accountId: number, contactId: number): Promise<void> {
  await requireUser({ aal2: true })
  if (!await isCurrentUserAdmin()) throw new Error(NOT_ADMIN_MESSAGE)
  if (!areEntityIds(accountId, contactId)) return
  const s = await createClient()
  // Kontakt se čte PŘED smazáním — jinak by audit záznam neměl co uložit
  // do `before`. Pokud řádek už neexistuje (souběžné smazání odjinud),
  // audit se prostě vynechá — nemá smysl zaznamenávat smazání ničeho.
  const { data: existing } = await s.from('contact')
    .select('full_name, email, role, account_id')
    .eq('id', contactId)
    .maybeSingle()
  // Kontakt, který nejde přečíst (už neexistuje, nebo ho RLS neukáže), není
  // co mazat ani auditovat.
  if (!existing) {
    revalidatePath(`/cockpit/clients/${accountId}`)
    return
  }
  // Smazání se MUSÍ potvrdit dřív, než se zapíše audit a nevratně zredigují
  // sales_activity: DELETE zamítnutý přes RLS/AAL1 nevrací chybu, jen 0 řádků,
  // a FK chyba by jinak zůstala nepovšimnuta. Při selhání se nedotkneme ničeho dalšího.
  // Filtr account_id (jako partner_id u deletePartnerContact): kontakt se smaže
  // jen pod firmou, z jejíž stránky akce přišla — cizí contactId smaže 0 řádků.
  const { data: deleted, error: deleteError } = await s.from('contact')
    .delete().eq('id', contactId).eq('account_id', accountId).select('id')
  const verdict = judgeSingleRowDelete(deleteError, deleted)
  if (!verdict.ok) {
    logError('contact.delete', deleteError ?? new Error(verdict.reason), { contactId, accountId, reason: verdict.reason })
    throw new Error(CONTACT_DELETE_FAILED_MESSAGE)
  }
  revalidatePath(`/cockpit/clients/${accountId}`)

  const { data: { user } } = await s.auth.getUser()
  const actor: AuditActor = { type: 'user', id: user?.id ?? null }
  await auditContactDeleted(contactId, existing, actor)

  // Právo na výmaz (GDPR): kontakt jako řádek je pryč, ale jméno/e-mail
  // téhle osoby mohly zůstat viset ve volném textu sales_activity
  // (poznámky z hovorů, shrnutí schůzek) patřících stejnému klientovi —
  // viz zdůvodnění v domain/crm/gdprSweep.ts. Spouští se AŽ TEĎ, po potvrzeném
  // smazání kontaktu, a je obalené vlastním try/catch: selhání redakce
  // nesmí strhnout už hotové smazání kontaktu, jen se zaloguje jako
  // varování, ať to někdo dožene ručně.
  if (existing.account_id) {
    try {
      await redactContactFromSalesActivity(
        { accountId: existing.account_id },
        { email: existing.email, name: existing.full_name },
        actor,
      )
    } catch (e) {
      logError('gdpr', e, { contactId, accountId: existing.account_id })
    }
  }
}

// Kontakty na straně partnera (TAUPARTNER, BETA TRADE, RSM…) — pro obchod stejně
// důležité jako kontakty u klientů, protože přes ně chodí poptávky.
export async function createPartnerContact(partnerId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(partnerId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = contactSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const w = await writeContactWithOptOut({ ...parsed.data, partner_id: partnerId, account_id: null },
    (row) => s.from('contact').insert(row))
  if (w.optOutBlocked) return { success: false, error: OPT_OUT_MISSING_MIGRATION_MESSAGE }
  if (w.result.error) return { success: false, error: dbErrorMessage('action.contacts', w.result.error) }
  revalidatePath(`/cockpit/partners/${partnerId}/edit`)
  return { success: true }
}

export async function deletePartnerContact(partnerId: number, contactId: number): Promise<void> {
  await requireUser({ aal2: true })
  if (!await isCurrentUserAdmin()) throw new Error(NOT_ADMIN_MESSAGE)
  if (!areEntityIds(partnerId, contactId)) return
  const s = await createClient()
  // Stejný postup jako u deleteContact výše — přečíst před smazáním, audit
  // jen když řádek opravdu existoval.
  const { data: existing } = await s.from('contact')
    .select('full_name, email, role, partner_id')
    .eq('id', contactId)
    .maybeSingle()
  if (!existing) {
    revalidatePath(`/cockpit/partners/${partnerId}/edit`)
    return
  }
  // Stejné potvrzení smazání jako u deleteContact (RLS/AAL1 vrací 0 řádků, ne chybu).
  // Filtr partner_id: kontakt se smaže jen pod partnerem, z jehož stránky
  // akce přišla — cizí contactId s nesouhlasným partnerId smaže 0 řádků.
  const { data: deleted, error: deleteError } = await s.from('contact')
    .delete().eq('id', contactId).eq('partner_id', partnerId).select('id')
  const verdict = judgeSingleRowDelete(deleteError, deleted)
  if (!verdict.ok) {
    logError('contact.delete', deleteError ?? new Error(verdict.reason), { contactId, partnerId, reason: verdict.reason })
    throw new Error(CONTACT_DELETE_FAILED_MESSAGE)
  }
  revalidatePath(`/cockpit/partners/${partnerId}/edit`)

  const { data: { user } } = await s.auth.getUser()
  const actor: AuditActor = { type: 'user', id: user?.id ?? null }
  await auditContactDeleted(contactId, existing, actor)

  // Stejný důvod jako u deleteContact výše — partnerský kontakt (TAUPARTNER,
  // BETA TRADE, RSM…) se stejně tak může objevit jménem/e-mailem ve volném
  // textu sales_activity vázané na partnera.
  if (existing.partner_id) {
    try {
      await redactContactFromSalesActivity(
        { partnerId: existing.partner_id },
        { email: existing.email, name: existing.full_name },
        actor,
      )
    } catch (e) {
      logError('gdpr', e, { contactId, partnerId: existing.partner_id })
    }
  }
}

// Úprava kontaktu. Chyběla úplně: po založení nešlo opravit jméno, doplnit
// telefon ani roli, takže jediná cesta byla založit kontakt znovu — a vznikaly
// duplicity, které taky nešly smazat. U 48 kontaktů, z nichž většina vznikla
// automaticky z e-mailů účastníků schůzek, se databáze takhle rozpadne během
// pár měsíců.
export async function updateContact(
  contactId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(contactId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = contactSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  // account_id/partner_id se schválně nemění — přesun kontaktu jinam je jiná
  // operace než oprava údajů a nemá se stát omylem při editaci telefonu.
  // Nesouhlas s oslovením (0087): odškrtnutí ho zruší (DB vymaže kdy, kdo
  // i důvod); trvající nesouhlas si čas a autora drží (trigger v 0087).
  const w = await writeContactWithOptOut(parsed.data, (row) => s.from('contact')
    .update(row).eq('id', contactId)
    .select('account_id, partner_id').maybeSingle())
  if (w.optOutBlocked) return { success: false, error: OPT_OUT_MISSING_MIGRATION_MESSAGE }
  const { data, error } = w.result
  if (error) return { success: false, error: dbErrorMessage('action.contacts', error) }
  if (data?.account_id) revalidatePath(`/cockpit/clients/${data.account_id}`)
  if (data?.partner_id) revalidatePath(`/cockpit/partners/${data.partner_id}/edit`)
  revalidatePath(`/cockpit/kontakty/${contactId}/edit`)
  // Štítek „Nesouhlasí s oslovením" u firmy ve frontě a v seznamech k oslovení.
  revalidatePath('/cockpit/oslovovani')
  revalidatePath('/cockpit/cilove-seznamy', 'layout')
  return { success: true }
}
