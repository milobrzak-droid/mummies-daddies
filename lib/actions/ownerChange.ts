'use server'
// Jednotlivá změna vlastníka (a zástupce) případu, milníku, obchodu, dodávky
// a cílového seznamu. Stejná pravidla jako hromadné „Předat práci"
// (lib/actions/team.ts): zápis dělá databázová funkce change_work_owner
// (0093) přes servisního klienta s hlavičkou aktéra, takže řádkový audit
// tabulky nese přihlášeného člověka a souhrn „Co se změnilo" ho jmenuje.
// Oprávnění ověří funkce znovu (správce, vedení, dnešní vlastník nebo zástupce),
// tady jen AAL2 přihlášení a tvar vstupu.
//
// Vrácení (toast Zpět) je tatáž akce s undo_of = id záznamu auditu; funkce
// pustí jen vlastní čerstvou změnu (do 30 minut, věc ve stavu po změně).
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { dbErrorMessage } from '@/lib/actionResult'
import { formatPersonName } from '@/lib/format'
import {
  OWNER_CHANGE_ERRORS,
  OWNER_CHANGE_PENDING,
  ownerChangeMessage,
  ownerChangePaths,
  ownerChangeSchema,
  type OwnerChangeResult,
  type OwnerKind,
} from '@/lib/ownerChange'

// Hlavička, kterou DB audit trigger (0064/0082) čte pod service_role. lib/ nesmí
// importovat core/, proto kopie AUDIT_ACTOR_HEADER z core/auditCoverage.ts
// (shodu hlídá test/hardening-0082.test.ts, tady test/owner-change.test.ts).
const AUDIT_ACTOR_HEADER = 'x-cockpit-audit-actor'

// PostgREST PGRST202 = funkce není ve schema cache; 42883 = undefined_function.
function isMissingFunction(err: { code?: string } | null): boolean {
  return err?.code === 'PGRST202' || err?.code === '42883'
}

type ChangeRow = {
  changed?: boolean
  audit_id?: number
  kind?: OwnerKind
  id?: number
  account_id?: number | null
  engagement_id?: number | null
  role?: 'owner' | 'deputy'
  owner?: string | null
  deputy?: string | null
  before_owner?: string | null
  before_deputy?: string | null
  freed_deputy?: number
}

export async function changeWorkOwner(input: unknown): Promise<OwnerChangeResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = ownerChangeSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Neplatný vstup. Obnov stránku a zkus to znovu.' }
  const v = parsed.data
  if (v.owner_id !== null && v.owner_id === v.deputy_id) {
    return { success: false, fieldErrors: { deputy_id: OWNER_CHANGE_ERRORS.OC008 }, error: OWNER_CHANGE_ERRORS.OC008 }
  }

  const admin = createAdminClient({ headers: { [AUDIT_ACTOR_HEADER]: `user:${user.id}` } })
  const { data, error } = await admin.rpc('change_work_owner', {
    p_kind: v.kind,
    p_id: v.id,
    p_actor: user.id,
    p_owner: v.owner_id,
    p_deputy: v.deputy_id,
    p_expect: v.expect ? { owner: v.expect.owner, deputy: v.expect.deputy } : null,
    p_undo_of: v.undo_of ?? null,
  })
  if (error) {
    if (isMissingFunction(error)) return { success: false, error: OWNER_CHANGE_PENDING }
    const known = error.code ? OWNER_CHANGE_ERRORS[error.code] : undefined
    if (known) {
      const field = error.code === 'OC008' || error.code === 'OC012' ? 'deputy_id' : error.code === 'OC007' || error.code === 'OC009' ? 'owner_id' : null
      return { success: false, error: known, ...(field ? { fieldErrors: { [field]: known } } : {}) }
    }
    return { success: false, error: dbErrorMessage('action.ownerChange', error) }
  }

  const row = (data ?? {}) as ChangeRow
  if (!row.changed) return { success: true, changed: false, message: 'Beze změny.', undo: null }

  const role = row.role === 'deputy' ? 'deputy' : 'owner'
  const fromId = role === 'owner' ? row.before_owner ?? null : row.before_deputy ?? null
  const toId = role === 'owner' ? row.owner ?? null : row.deputy ?? null
  const names = await memberNames(admin, [fromId, toId])

  for (const path of ownerChangePaths(v.kind, v.id, row.account_id ?? null, row.engagement_id ?? null)) revalidatePath(path)

  const undone = v.undo_of != null
  return {
    success: true,
    changed: true,
    message: ownerChangeMessage({
      kind: v.kind,
      role,
      fromName: fromId ? names.get(fromId) ?? 'člen týmu' : null,
      toName: toId ? names.get(toId) ?? 'člen týmu' : null,
      freedDeputy: (row.freed_deputy ?? 0) > 0,
      undone,
    }),
    // Vrátit jde jen změna, která vznikla ručně; vrácení se už znovu nevrací.
    undo: !undone && typeof row.audit_id === 'number'
      ? { auditId: row.audit_id, owner: row.before_owner ?? null, deputy: row.before_deputy ?? null }
      : null,
  }
}

async function memberNames(admin: ReturnType<typeof createAdminClient>, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))]
  if (wanted.length === 0) return new Map()
  const { data } = await admin.from('team_member').select('id, full_name, email').in('id', wanted)
  return new Map(
    ((data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((m) => [m.id, formatPersonName(m.full_name, m.email)]),
  )
}
