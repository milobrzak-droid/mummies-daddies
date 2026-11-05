'use server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { revokeOAuthOfMember } from '@/lib/oauthTokens'
import { participantSchema, resetPasswordSchema, teamRole, teamMemberId, displayNameSchema } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { pragueToday } from '@/lib/pragueDate'
import { logError } from '@/lib/log'
import { formatPersonName } from '@/lib/format'
import { loadMemberOpenWork } from '@/lib/queries/memberWork'
import {
  CONFIRM_OPEN_WORK_FIELD,
  TRANSFER_ERRORS,
  TRANSFER_SEZNAMY_PENDING,
  deactivationBlock,
  parseTransferForm,
  transferResultMessage,
  workCounts,
  type MemberWork,
  type TransferCounts,
} from '@/lib/memberWork'
import type { ZodError } from 'zod'
import { readActiveMember } from '@/lib/auth/activeMember'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

// Every admin Server Action must call this FIRST and bail out if it doesn't
// return ok:true. The admin flag is re-read from the DB row on every call —
// never trust the JWT or user_metadata, both of which a user can edit.
async function requireAdmin() {
  // AAL2: admin akce jdou přes service role, proxy není hranice (viz requireUser).
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false as const, error: AUTH_ERROR_MESSAGE }
  const supabase = await createClient()
  const { row: data } = await readActiveMember<{ is_admin?: boolean | null }>(supabase, user.id, 'is_admin')
  if (!data?.is_admin) return { ok: false as const, error: 'Nemáš oprávnění.' }
  return { ok: true as const, userId: user.id }
}

// Hlavička, kterou DB audit trigger (0064/0082) čte pod service_role, aby zápis
// do team_member nesl admina jako aktéra. lib/ nesmí importovat core/, proto je
// název kopie z core/auditCoverage.ts (AUDIT_ACTOR_HEADER); shodu hlídá
// test/hardening-0082.test.ts.
const AUDIT_ACTOR_HEADER = 'x-cockpit-audit-actor'
function adminActingAs(userId: string) {
  return createAdminClient({ headers: { [AUDIT_ACTOR_HEADER]: `user:${userId}` } })
}

const INVALID_USER_MESSAGE = 'Neplatný uživatel.'
const LAST_ADMIN_MESSAGE = 'Nelze odebrat posledního administrátora — nejdřív udělej administrátorem někoho jiného.'

// PostgREST PGRST202 = funkce není ve schema cache; 42883 = undefined_function.
function isMissingFunction(err: { code?: string } | null): boolean {
  return err?.code === 'PGRST202' || err?.code === '42883'
}

// Zneplatní klíče (API i OAuth), které daný člověk vytvořil nebo schválil.
// `scope` = jen klíče s tímto rozsahem (např. 'full' při odebrání admina).
async function revokeKeysOf(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  scope?: 'full',
): Promise<{ error: unknown }> {
  let q = admin.from('api_key').update({ revoked_at: new Date().toISOString() }).eq('created_by', userId)
  if (scope) q = q.eq('scope', scope)
  const { error } = await q.is('revoked_at', null)
  // Refresh tokeny konektoru (OAuth) — jinak by si zrušený přístup obnovily.
  await revokeOAuthOfMember(admin, userId, scope)
  return { error }
}

function isMissingColumn(err: { code?: string } | null): boolean {
  return err?.code === '42703' || err?.code === 'PGRST204'
}

// Demotion guard (fallback bez migrace 0045): tým musí mít vždy aspoň
// jednoho admina. Počet se čte těsně před UPDATE; mezi čtením a zápisem
// zůstává malé závodní okno — atomicky to řeší RPC set_team_member_admin.
async function wouldRemoveLastAdmin(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<{ blocked: boolean; error?: unknown }> {
  const { data, error } = await admin.from('team_member').select('id').eq('is_admin', true)
  if (error) return { blocked: true, error }
  const ids = ((data ?? []) as { id: string }[]).map(r => r.id)
  if (!ids.includes(userId)) return { blocked: false } // cíl není admin — nic se neubírá
  return { blocked: ids.length <= 1 }
}

export async function createParticipant(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsed = participantSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { email, full_name, password, role, is_admin } = parsed.data

  // Zápis do team_member zapíše DB trigger (0082) s adminem jako aktérem.
  const admin = adminActingAs(gate.userId)
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name },
    // app_metadata smí nastavit jen service role. Trigger handle_new_user
    // (0069) podle něj pozná člověka založeného adminem — samoregistrace
    // bez pozvánky team_member nedostane.
    app_metadata: { cockpit_member: true },
  })
  if (error) {
    const isDuplicate = /already registered|already exists|duplicate/i.test(error.message)
    return { success: false, error: isDuplicate ? 'Uživatel s tímto e-mailem už existuje.' : dbErrorMessage('action.team', error) }
  }
  if (!data.user) return { success: false, error: 'Nepodařilo se vytvořit uživatele.' }

  // The DB trigger already created a team_member row (full_name from
  // user_metadata, is_admin false, role = DB default 'partner' since 0056);
  // patch it to the role the admin explicitly chose in the form.
  const { error: updateError } = await admin
    .from('team_member')
    .update({ full_name, role, is_admin })
    .eq('id', data.user.id)
  if (updateError) return { success: false, error: updateError.message }

  revalidatePath('/cockpit/tym')
  return { success: true }
}

export async function resetParticipantPassword(
  userId: string,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }
  if (!teamMemberId.safeParse(userId).success) return { success: false, error: INVALID_USER_MESSAGE }

  const parsed = resetPasswordSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }

  // Zápis do team_member zapíše DB trigger (0082) s adminem jako aktérem.
  const admin = adminActingAs(gate.userId)
  const { error } = await admin.auth.admin.updateUserById(userId, { password: parsed.data.password })
  if (error) return { success: false, error: dbErrorMessage('action.team', error) }

  revalidatePath('/cockpit/tym')
  return { success: true }
}

export async function setParticipantAdmin(userId: string, isAdmin: boolean): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  if (!teamMemberId.safeParse(userId).success) return { success: false, error: INVALID_USER_MESSAGE }
  if (typeof isAdmin !== 'boolean') return { success: false, error: 'Neplatná hodnota.' }

  // Atomická cesta: RPC zamkne admin řádky a guard + UPDATE udělá v jedné
  // transakci (migrace 0045). Volá se klientem s uživatelskou session —
  // funkce ověřuje auth.uid() a AAL2 sama.
  const supabase = await createClient()
  const { error: rpcError } = await supabase.rpc('set_team_member_admin', { p_user_id: userId, p_is_admin: isAdmin })
  if (!rpcError) {
    // Bývalý admin nesmí dál zapisovat plnými klíči, které si jako admin vytvořil.
    if (!isAdmin) {
      const revoke = await revokeKeysOf(createAdminClient(), userId, 'full')
      if (revoke.error) return { success: false, error: dbErrorMessage('action.team', revoke.error) }
    }
    revalidatePath('/cockpit/tym')
    return { success: true }
  }
  if (!isMissingFunction(rpcError)) {
    if (rpcError.message === 'last_admin') return { success: false, error: LAST_ADMIN_MESSAGE }
    if (rpcError.code === '42501') return { success: false, error: 'Nemáš oprávnění.' }
    return { success: false, error: dbErrorMessage('action.team', rpcError) }
  }

  // Fallback, dokud 0045 není nasazená: check-then-update (malé závodní okno).
  // Zápis do team_member zapíše DB trigger (0082) s adminem jako aktérem.
  const admin = adminActingAs(gate.userId)
  if (!isAdmin) {
    const guard = await wouldRemoveLastAdmin(admin, userId)
    if (guard.error) return { success: false, error: dbErrorMessage('action.team', guard.error) }
    if (guard.blocked) return { success: false, error: LAST_ADMIN_MESSAGE }
  }
  const { error } = await admin.from('team_member').update({ is_admin: isAdmin }).eq('id', userId)
  if (error) return { success: false, error: dbErrorMessage('action.team', error) }
  if (!isAdmin) {
    const revoke = await revokeKeysOf(admin, userId, 'full')
    if (revoke.error) return { success: false, error: dbErrorMessage('action.team', revoke.error) }
  }

  revalidatePath('/cockpit/tym')
  return { success: true }
}

export async function setParticipantRole(
  userId: string,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  if (!teamMemberId.safeParse(userId).success) return { success: false, error: INVALID_USER_MESSAGE }

  const parsed = teamRole.safeParse(formData.get('role'))
  if (!parsed.success) return { success: false, error: 'Neplatná role.' }

  // Zápis do team_member zapíše DB trigger (0082) s adminem jako aktérem.
  const admin = adminActingAs(gate.userId)
  const { error } = await admin.from('team_member').update({ role: parsed.data }).eq('id', userId)
  if (error) return { success: false, error: dbErrorMessage('action.team', error) }

  revalidatePath('/cockpit/tym')
  return { success: true }
}

// Admin mění zobrazované jméno komukoli jinému v týmu — sám sobě si ho
// mění přes updateMyDisplayName na /nastaveni (stejná zod validace).
export async function setParticipantFullName(
  userId: string,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }
  if (!teamMemberId.safeParse(userId).success) return { success: false, error: INVALID_USER_MESSAGE }

  const parsed = displayNameSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }

  // Zápis do team_member zapíše DB trigger (0082) s adminem jako aktérem.
  const admin = adminActingAs(gate.userId)
  const { error } = await admin.from('team_member').update({ full_name: parsed.data.full_name }).eq('id', userId)
  if (error) return { success: false, error: dbErrorMessage('action.team', error) }

  revalidatePath('/cockpit/tym')
  return { success: true }
}

const MFA_RESET_SELF_MESSAGE = 'Vlastní dvoufázové ověření si tady zrušit nemůžeš. Požádej jiného správce.'
const MFA_RESET_NONE_MESSAGE = 'Dvoufázové ověření nemá nastavené, nic se nezměnilo. Při příštím přihlášení si ho nastaví sám.'
const MFA_RESET_AUDIT_PENDING = 'Zrušení dvoufázového ověření čeká na migraci 0082 (zápis do auditu).'
const MFA_RESET_PARTIAL = 'Část dvoufázového ověření se nepodařilo zrušit. Zkus to prosím znovu.'

/**
 * Zrušení dvoufázového ověření (2FA) člověku, který ztratil telefon
 * s Authenticatorem. Jen správce (requireAdmin: AAL2 + is_admin z DB), nikdy
 * na vlastním účtu, jen člen týmu. Přes Supabase Admin API — jen na serveru
 * se service role: auth.admin.mfa.listFactors({ userId }) a pro každý faktor
 * auth.admin.mfa.deleteFactor({ id, userId }) (@supabase/auth-js 2.117).
 * Smazání ověřeného faktoru Supabase člověka odhlásí ze všech sezení, takže
 * ani ztracený telefon nezůstane přihlášený. Při dalším přihlášení nemá
 * žádný faktor a proxy (lib/supabase/middleware.ts) ho pošle na
 * /auth/mfa/enroll — bez nového Authenticatoru se k datům nedostane.
 *
 * Audit: faktory žijí ve schématu auth, trigger je nevidí — řádek
 * audit_event zapisuje akce sama: aktér = správce, entita team_member
 * s entity_ref = uuid člena (0082), jen počty faktorů. Bez sloupce
 * entity_ref (nenasazená 0082) se nic nezmění.
 */
export async function resetParticipantMfa(userId: string): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }
  if (!teamMemberId.safeParse(userId).success) return { success: false, error: INVALID_USER_MESSAGE }
  if (gate.userId === userId) return { success: false, error: MFA_RESET_SELF_MESSAGE }

  const admin = createAdminClient()
  // Jen člen týmu — ne libovolný účet v Auth.
  const { data: member, error: memberError } = await admin.from('team_member').select('id').eq('id', userId).maybeSingle()
  if (memberError) return { success: false, error: dbErrorMessage('action.team.mfa', memberError) }
  if (!member) return { success: false, error: INVALID_USER_MESSAGE }

  // Bez auditu se 2FA nesahá: zápis potřebuje audit_event.entity_ref (0082).
  const probe = await admin.from('audit_event').select('entity_ref').limit(0)
  if (probe.error) {
    return {
      success: false,
      error: isMissingColumn(probe.error as { code?: string }) ? MFA_RESET_AUDIT_PENDING : dbErrorMessage('action.team.mfa', probe.error),
    }
  }

  const { data: listed, error: listError } = await admin.auth.admin.mfa.listFactors({ userId })
  if (listError || !listed) return { success: false, error: dbErrorMessage('action.team.mfa', listError) }
  const factors = listed.factors ?? []
  if (factors.length === 0) return { success: false, error: MFA_RESET_NONE_MESSAGE }

  let deleted = 0
  let failure: unknown = null
  for (const f of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId })
    if (error) {
      failure = error
      break
    }
    deleted++
  }

  if (deleted > 0) {
    // Počítadlo chybných kódů (mfa_failure, 0069): nový Authenticator nemá
    // začínat zamčený kvůli pokusům se starým. Chybějící tabulka nevadí.
    await admin.from('mfa_failure').delete().eq('user_id', userId)
    const { error: auditError } = await admin.from('audit_event').insert({
      actor_type: 'user',
      actor_id: gate.userId,
      action: 'team_member.mfa_reset',
      entity_table: 'team_member',
      entity_ref: userId,
      before: { factors: factors.length, verified: factors.filter((f) => f.status === 'verified').length },
      after: { factors: factors.length - deleted },
    })
    // Změna už proběhla — výpadek auditu ji nevrací, jen se zaloguje (core/audit.ts).
    if (auditError) logError('action.team.mfa.audit', auditError, { userId })
  }

  if (failure) return { success: false, error: deleted > 0 ? MFA_RESET_PARTIAL : dbErrorMessage('action.team.mfa', failure) }
  revalidatePath('/cockpit/tym')
  return { success: true }
}

export async function deactivateParticipant(userId: string, _prev?: unknown, formData?: FormData): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }
  if (!teamMemberId.safeParse(userId).success) return { success: false, error: INVALID_USER_MESSAGE }
  // Zákaz deaktivace sebe sama zároveň chrání posledního admina: volající je
  // admin a zůstává aktivní, takže po deaktivaci kohokoli jiného admin zbývá.
  if (gate.userId === userId) return { success: false, error: 'Nemůžeš deaktivovat sám sebe.' }

  // Zápis do team_member zapíše DB trigger (0082) s adminem jako aktérem.
  const admin = adminActingAs(gate.userId)

  // Osiřelá práce (revize 29. 9., zastupitelnost): dokud má člověk otevřené
  // věci, deaktivace neprojde bez výslovného potvrzení správce. Nejde-li práci
  // spočítat, platí totéž (fail closed).
  const confirmed = formData?.get(CONFIRM_OPEN_WORK_FIELD) === 'on'
  let work: MemberWork | null = null
  try {
    work = await loadMemberOpenWork(userId, { canSeeSales: false, today: pragueToday(), admin })
  } catch (e) {
    logError('action.team.openWork', e)
  }
  const block = deactivationBlock(work, confirmed)
  if (block) return { success: false, error: block, fieldErrors: { [CONFIRM_OPEN_WORK_FIELD]: block } }
  // ~100 years — effectively permanent without deleting the auth user or its data.
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' })
  if (error) return { success: false, error: dbErrorMessage('action.team', error) }

  // Ban zastaví jen přihlášení. Klíče (API i OAuth konektor) jdou přes
  // service role, takže je nutné je zneplatnit, a řádek člena označit jako
  // deaktivovaný — RLS helpery (0069) i validateApiKey ho pak odmítnou.
  const revoke = await revokeKeysOf(admin, userId)
  if (revoke.error) return { success: false, error: dbErrorMessage('action.team', revoke.error) }

  let { error: memberError } = await admin
    .from('team_member')
    .update({ is_admin: false, deactivated_at: new Date().toISOString() })
    .eq('id', userId)
  // Tolerance k nenasazené 0069 (sloupec deactivated_at chybí).
  if (isMissingColumn(memberError as { code?: string } | null)) {
    ;({ error: memberError } = await admin.from('team_member').update({ is_admin: false }).eq('id', userId))
  }
  if (memberError) return { success: false, error: dbErrorMessage('action.team', memberError) }

  // Vědomé rozhodnutí nechat práci bez vlastníka patří do auditu (0082:
  // entity_ref = uuid člena). Selhání auditu deaktivaci nevrací.
  if (work === null || work.total > 0 || work.incomplete) {
    const { error: auditError } = await admin.from('audit_event').insert({
      actor_type: 'user',
      actor_id: gate.userId,
      action: 'team_member.deactivated_with_open_work',
      entity_table: 'team_member',
      entity_id: null,
      entity_ref: userId,
      before: null,
      after: work ? { counts: workCounts(work), incomplete: work.incomplete } : { counts: null, incomplete: true },
      info_state: 'human_confirmed',
    })
    if (auditError) logError('action.team.deactivateAudit', auditError)
  }

  revalidatePath('/cockpit/tym')
  return { success: true }
}

export type TransferResult = ActionResult & { message?: string }

/**
 * „Předat práci": všechny zvolené druhy otevřené práce člověka přejdou na
 * jiného člena týmu jednou transakcí (transfer_member_work, 0088, od 0093 i cílové seznamy). Jen správce
 * (AAL2 + is_admin z DB); funkce oprávnění ověří znovu. Řádky zapíše audit
 * tabulek s adminem jako aktérem (hlavička), souhrn 'team_member.work_transferred'
 * zapíše funkce a ukáže ho „Co se změnilo".
 */
export async function transferMemberWork(fromId: string, _prev: unknown, formData: FormData): Promise<TransferResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }
  if (!teamMemberId.safeParse(fromId).success) return { success: false, error: INVALID_USER_MESSAGE }
  const parsed = parseTransferForm(formData)
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { to_member_id: toId, kinds } = parsed.data
  if (toId === fromId) return { success: false, fieldErrors: { to_member_id: TRANSFER_ERRORS.TW001 } }

  const admin = adminActingAs(gate.userId)
  const { data, error } = await admin.rpc('transfer_member_work', {
    p_from: fromId,
    p_to: toId,
    p_actor: gate.userId,
    p_kinds: kinds,
    p_today: pragueToday(),
  })
  if (error) {
    if (isMissingFunction(error)) return { success: false, error: 'Předání práce čeká na migraci 0088.' }
    // Starší DB (jen 0088) druh „seznamy" nezná: TW004 pak neznamená chybu uživatele.
    if (error.code === 'TW004' && kinds.includes('seznamy')) return { success: false, error: TRANSFER_SEZNAMY_PENDING }
    const known = error.code ? TRANSFER_ERRORS[error.code] : undefined
    if (known) return { success: false, error: known }
    return { success: false, error: dbErrorMessage('action.team.transfer', error) }
  }

  const { data: to } = await admin.from('team_member').select('full_name, email').eq('id', toId).maybeSingle()
  const toName = formatPersonName((to as { full_name?: string | null } | null)?.full_name, (to as { email?: string | null } | null)?.email)

  revalidatePath('/cockpit/tym')
  revalidatePath(`/cockpit/tym/${fromId}/predat`)
  return { success: true, message: transferResultMessage((data ?? {}) as TransferCounts, toName) }
}
