'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { accountSchema, areEntityIds } from '@/lib/validation/schemas'
import { aresByIco, aresRegionValue } from '@/connectors/ares'
import { recordAudit, type AuditActor } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'

function parseForm(formData: FormData) {
  const raw = Object.fromEntries(formData.entries())
  return accountSchema.safeParse(raw)
}

export async function createAccount(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = parseForm(formData)
  if (!parsed.success) {
    return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  }
  const s = await createClient()
  const { data, error } = await s.from('account').insert(parsed.data).select('id').single()
  if (error) return { success: false, error: dbErrorMessage('action.accounts', error) }
  revalidatePath('/cockpit/clients')
  redirect(`/cockpit/clients/${data.id}`)
}

export async function updateAccount(id: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(id)) return { success: false, error: 'Neplatné ID.' }
  const parsed = parseForm(formData)
  if (!parsed.success) {
    return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  }
  const s = await createClient()
  // owner_id se čte PŘED update — jinak by nebylo s čím porovnat novou
  // hodnotu a přeobsazení klienta (kdo ho u nás vede) by zůstalo bez stopy.
  const { data: existing } = await s.from('account').select('owner_id').eq('id', id).maybeSingle()
  const { error } = await s.from('account').update(parsed.data).eq('id', id)
  if (error) return { success: false, error: dbErrorMessage('action.accounts', error) }

  // Update už proběhl — audit se zapisuje k faktu, který se stal. Porovnává
  // se i null vs. hodnota (klient bez ownera dostal ownera, nebo naopak) —
  // to je stejně důležité zaznamenat jako přeobsazení mezi dvěma lidmi.
  // Po migraci 0064 zapisuje změnu (včetně owner_id) DB trigger jako
  // account.updated — appka pak nesmí psát podruhé.
  if (existing && existing.owner_id !== parsed.data.owner_id && !(await dbAuditActive())) {
    const { data: { user } } = await s.auth.getUser()
    const actor: AuditActor = { type: 'user', id: user?.id ?? null }
    try {
      await recordAudit(
        'account',
        id,
        'account.owner_changed',
        { owner_id: existing.owner_id },
        { owner_id: parsed.data.owner_id },
        actor,
      )
    } catch {
      // úmyslně tiché — recordAudit už zalogoval, tady se jen jistíme
    }
  }

  revalidatePath(`/cockpit/clients/${id}`)
  redirect(`/cockpit/clients/${id}`)
}

// Doplnění IČO ze stránky /clients/doplnit-ico — ať už kliknutím na
// nabídnutého ARES kandidáta, nebo ručním zadáním čísla u zahraniční firmy.
// V obou případech se IČO znovu ověří přes aresByIco: překlep nebo cizí
// (zastaralé) číslo je v CRM horší než prázdné pole — viz poznámka
// u pickAresMatch v connectors/ares, proč se tahle stránka vůbec dělá ručně
// a ne nějakým "chytřejším" automatickým pravidlem.
//
// Doplňování ostatních polí drží stejná pravidla jako dávkový automat
// (domain/crm/aresEnrich.ts, aresFillPatch): jen do prázdných polí (člověk
// mohl mezitím region vyplnit sám — nikdy ho nepřepisujeme) a sídlo je OBEC
// (aresRegionValue), ne kraj — aplikace jinde region takhle čte a filtruje.
// Obor z jediného NACE kódu se nedoplňuje vůbec, ten kód je náhoda (migrace
// 0030) — člověk si obor doplní sám v editaci klienta, kde vidí, co píše.
export async function setAccountIco(
  accountId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId)) return { success: false, error: 'Neplatné ID.' }
  const raw = String(formData.get('ico') ?? '').trim()
  const clean = raw.replace(/\s/g, '')
  if (!/^\d{1,8}$/.test(clean)) {
    return { success: false, error: 'IČO musí být číslo, max. 8 číslic.' }
  }
  const company = await aresByIco(clean)
  if (!company) {
    return { success: false, error: 'Toto IČO ARES nezná — zkontroluj číslo.' }
  }
  const s = await createClient()
  // Přečíst současné sídlo PŘED zápisem — doplní se, jen když je pořád
  // prázdné (souběh s člověkem, co pole mezitím vyplnil ručně jinde).
  const { data: existing, error: fetchError } = await s
    .from('account')
    .select('region')
    .eq('id', accountId)
    .maybeSingle()
  if (fetchError) return { success: false, error: dbErrorMessage('action.accounts', fetchError) }

  const update: Record<string, unknown> = { ico: company.ico }
  const region = aresRegionValue(company)
  const hasRegion = typeof existing?.region === 'string' && existing.region.trim() !== ''
  if (region && !hasRegion) update.region = region

  const { error } = await s.from('account').update(update).eq('id', accountId)
  if (error) return { success: false, error: dbErrorMessage('action.accounts', error) }
  revalidatePath('/cockpit/clients')
  revalidatePath('/cockpit/clients/doplnit-ico')
  return { success: true }
}

function fieldErrorsOf(err: import('zod').ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '_')
    if (!out[key]) out[key] = issue.message
  }
  return out
}
