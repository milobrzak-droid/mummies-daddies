'use server'
import { AUTH_ERROR_MESSAGE, requireUser, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { companyAliasSchema, companyRelationshipSchema, entityId } from '@/lib/validation/schemas'
import { wouldCreateDirectCycle } from '@/domain/crm/queries/companyRelationships'
import { recordAudit, type AuditActor } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { logError } from '@/lib/log'
import type { ActionResult } from '@/lib/actionResult'
import type { ZodError } from 'zod'
import { judgeSingleRowDelete } from '@/domain/crm/deleteVerdict'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) { const k = String(i.path[0] ?? '_'); if (!out[k]) out[k] = i.message }
  return out
}

const INVALID_ID_MESSAGE = 'Neplatný odkaz na firmu. Obnov stránku a zkus to znovu.'
const GENERIC_SAVE_MESSAGE = 'Uložení se nepodařilo. Zkus to znovu.'
const GENERIC_DELETE_MESSAGE = 'Smazání se nepodařilo. Zkus to znovu.'

// Unique violation (kód Postgresu 23505) je běžný případ, který uživatel
// pochopí; ostatní chyby se jen logují a klient dostane obecnou hlášku, ať
// se z ní nedá vyčíst schéma ani názvy omezení.
function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === '23505'
}

async function currentActor(s: Awaited<ReturnType<typeof createClient>>): Promise<AuditActor> {
  const { data: { user } } = await s.auth.getUser()
  return { type: 'user', id: user?.id ?? null }
}

// Po migraci 0064 zapisuje vznik a smazání aliasu i vztahu DB trigger
// (company_alias.created/.deleted, relationship.created/.deleted) — i při
// kaskádě ze smazání firmy, kterou appka nevidí. Do té doby je zapisuje
// appka sama; nikdy obojí.
async function auditUnlessDbDoes(
  s: Awaited<ReturnType<typeof createClient>>,
  table: 'company_alias' | 'relationship',
  id: number,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  try {
    if (await dbAuditActive()) return
    await recordAudit(table, id, action, before, after, await currentActor(s))
  } catch {
    // úmyslně tiché — recordAudit už zalogoval, tady se jen jistíme
  }
}

export async function addCompanyAlias(accountId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const account = entityId.safeParse(accountId)
  if (!account.success) return { success: false, error: INVALID_ID_MESSAGE }
  accountId = account.data
  const parsed = companyAliasSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }

  const s = await createClient()
  const { data, error } = await s.from('company_alias')
    .insert({ account_id: accountId, ...parsed.data })
    .select('id').single()
  if (error) {
    if (isUniqueViolation(error)) return { success: false, error: 'Tenhle alias už u firmy existuje.' }
    logError('company_alias.insert', error, { accountId })
    return { success: false, error: GENERIC_SAVE_MESSAGE }
  }

  await auditUnlessDbDoes(s, 'company_alias', data.id, 'company_alias.created', null, { account_id: accountId, ...parsed.data })
  revalidatePath(`/cockpit/clients/${accountId}`)
  return { success: true }
}

export async function removeCompanyAlias(accountId: number, aliasId: number): Promise<void> {
  await requireUser({ aal2: true })
  const account = entityId.safeParse(accountId)
  const alias = entityId.safeParse(aliasId)
  if (!account.success || !alias.success) return
  accountId = account.data
  aliasId = alias.data
  const s = await createClient()
  // Alias se čte PŘED smazáním, aby měl audit záznam co uložit do `before`.
  const { data: existing } = await s.from('company_alias')
    .select('*').eq('id', aliasId).eq('account_id', accountId).maybeSingle()
  // Smazání se MUSÍ potvrdit dřív, než se zapíše audit: DELETE zamítnutý
  // přes RLS/AAL1 nevrací chybu, jen 0 řádků — stejný důvod jako u
  // deleteContact v domain/crm/actions/contacts.ts. Při selhání se nedotkneme
  // ničeho dalšího.
  const { data: deleted, error } = await s.from('company_alias')
    .delete().eq('id', aliasId).eq('account_id', accountId).select('id')
  const verdict = judgeSingleRowDelete(error, deleted)
  if (!verdict.ok) {
    logError('company_alias.delete', error ?? new Error(verdict.reason), { accountId, aliasId, reason: verdict.reason })
    throw new Error(GENERIC_DELETE_MESSAGE)
  }
  revalidatePath(`/cockpit/clients/${accountId}`)

  if (existing) {
    await auditUnlessDbDoes(s, 'company_alias', aliasId, 'company_alias.deleted', existing, null)
  }
}

// Formulář se ptá na směr vztahu vůči aktuální firmě (accountId), ne rovnou
// na parent/child — z pohledu uživatele na kartě klienta dává smysl otázka
// "je tahle firma naše mateřská, nebo dceřiná", ne abstraktní parent/child.
export async function addRelationship(accountId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const account = entityId.safeParse(accountId)
  if (!account.success) return { success: false, error: INVALID_ID_MESSAGE }
  accountId = account.data
  const parsed = companyRelationshipSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { direction, other_account_id } = parsed.data

  if (other_account_id === accountId) {
    return { success: false, fieldErrors: { other_account_id: 'Firma nemůže být sama sobě mateřská/dceřiná.' } }
  }

  const parent_account_id = direction === 'parent_of' ? accountId : other_account_id
  const child_account_id = direction === 'parent_of' ? other_account_id : accountId

  const s = await createClient()

  // Guard proti přímému cyklu A→B→A — viz komentář u wouldCreateDirectCycle
  // v domain/crm/queries/companyRelationships.ts, proč se to neřeší jako DB CHECK.
  const { data: reverse } = await s.from('relationship')
    .select('parent_account_id, child_account_id')
    .eq('parent_account_id', child_account_id)
    .eq('child_account_id', parent_account_id)
    .maybeSingle()
  if (wouldCreateDirectCycle(reverse ? [reverse] : [], { parent_account_id, child_account_id })) {
    return { success: false, error: 'Tohle by vytvořilo přímý cyklus — opačný vztah mezi těmito firmami už existuje.' }
  }

  const { data, error } = await s.from('relationship')
    .insert({ parent_account_id, child_account_id })
    .select('id').single()
  if (error) {
    if (isUniqueViolation(error)) return { success: false, error: 'Tenhle vztah mezi firmami už existuje.' }
    logError('relationship.insert', error, { parent_account_id, child_account_id })
    return { success: false, error: GENERIC_SAVE_MESSAGE }
  }

  await auditUnlessDbDoes(s, 'relationship', data.id, 'relationship.created', null, { parent_account_id, child_account_id })
  revalidatePath(`/cockpit/clients/${accountId}`)
  revalidatePath(`/cockpit/clients/${other_account_id}`)
  return { success: true }
}

export async function removeRelationship(accountId: number, relationshipId: number): Promise<void> {
  await requireUser({ aal2: true })
  const account = entityId.safeParse(accountId)
  const relationship = entityId.safeParse(relationshipId)
  if (!account.success || !relationship.success) return
  accountId = account.data
  relationshipId = relationship.data
  const s = await createClient()
  // Řádek se maže jen tehdy, když se accountId ze stránky skutečně účastní
  // tohohle vztahu (jako parent, nebo jako child) — stejná obrana jako
  // .eq('account_id', accountId) u removeCompanyAlias. Relationship nemá
  // jediný account_id sloupec, proto se řádek čte podle id a účast se ověří
  // tady; žádný .or() se skládaným řetězcem.
  const { data: row } = await s.from('relationship')
    .select('*').eq('id', relationshipId)
    .maybeSingle()
  const existing = row && (row.parent_account_id === accountId || row.child_account_id === accountId) ? row : null
  if (!existing) return
  // DELETE musí mířit přesně na přečtený a autorizovaný řádek — id samotné
  // by smazalo řádek i kdyby ho mezitím někdo přepsal na jiný parent/child
  // pár, který accountId už neobsahuje. Žádný .or() se skládaným řetězcem
  // (viz komentář výše), místo toho oba sloupce z přečteného řádku.
  // Smazání se MUSÍ potvrdit počtem řádků dřív, než se zapíše audit —
  // stejný důvod jako u deleteContact v domain/crm/actions/contacts.ts.
  const { data: deleted, error } = await s.from('relationship')
    .delete()
    .eq('id', relationshipId)
    .eq('parent_account_id', existing.parent_account_id)
    .eq('child_account_id', existing.child_account_id)
    .select('id')
  const verdict = judgeSingleRowDelete(error, deleted)
  if (!verdict.ok) {
    logError('relationship.delete', error ?? new Error(verdict.reason), { accountId, relationshipId, reason: verdict.reason })
    throw new Error(GENERIC_DELETE_MESSAGE)
  }
  revalidatePath(`/cockpit/clients/${accountId}`)

  const otherId = existing.parent_account_id === accountId ? existing.child_account_id : existing.parent_account_id
  revalidatePath(`/cockpit/clients/${otherId}`)
  await auditUnlessDbDoes(s, 'relationship', relationshipId, 'relationship.deleted', existing, null)
}
