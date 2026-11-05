'use server'
import { dbErrorMessage } from '@/lib/actionResult'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { generateApiKey } from '@/lib/apiKeyAuth'
import { revokeOAuthFamilyOfKey } from '@/lib/oauthTokens'
import { recordOAuthProblem } from '@/lib/oauthDiagnostics'
import { apiKeyName, entityId } from '@/lib/validation/schemas'
import { readActiveMember } from '@/lib/auth/activeMember'

// Same admin-gate shape as lib/actions/team.ts's requireAdmin — re-read
// from the DB row on every call, never trust the JWT or user_metadata.
async function requireAdmin() {
  // AAL2: admin akce jdou přes service role, proxy není hranice (viz requireUser).
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false as const, error: AUTH_ERROR_MESSAGE }
  const supabase = await createClient()
  const { row: data } = await readActiveMember<{ is_admin?: boolean | null }>(supabase, user.id, 'is_admin')
  if (!data?.is_admin) return { ok: false as const, error: 'Nemáš oprávnění.' }
  return { ok: true as const, userId: user.id }
}

export type CreateApiKeyResult = {
  success: boolean
  error?: string
  fieldErrors?: Record<string, string>
  plaintext?: string
}

export async function createApiKey(_prev: unknown, formData: FormData): Promise<CreateApiKeyResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }

  const parsedName = apiKeyName.safeParse(String(formData.get('name') ?? ''))
  if (!parsedName.success) return { success: false, fieldErrors: { name: parsedName.error.issues[0]?.message ?? 'Neplatný název.' } }
  const name = parsedName.data

  // Rozsah: výchozí 'full' (jako dřív); 'intake' = klíč jen pro příjem zápisů
  // schůzek z Wispr Flow (0079). Cokoli jiného než přesně 'intake' = 'full'
  // — DB scope neznámé hodnoty stejně odmítne a 'read' se tudy nevydává.
  const intakeOnly = String(formData.get('scope') ?? '') === 'intake'

  const { plaintext, hash, prefix } = generateApiKey()
  const admin = createAdminClient()
  const { error } = await admin.from('api_key').insert({
    name, key_hash: hash, key_prefix: prefix, created_by: gate.userId,
    ...(intakeOnly ? { scope: 'intake' } : {}),
  })
  if (error) {
    // 23514 = CHECK api_key_scope_check: 0079 ještě není aplikovaná.
    if (intakeOnly && (error as { code?: string }).code === '23514') {
      return { success: false, error: 'Klíč jen pro zápisy schůzek vyžaduje migraci 0079 (zatím neaplikovaná).' }
    }
    return { success: false, error: dbErrorMessage('action.apiKeys', error) }
  }

  revalidatePath('/cockpit/api-klice')
  return { success: true, plaintext }
}

export async function revokeApiKey(id: number): Promise<{ success: boolean; error?: string }> {
  const gate = await requireAdmin()
  if (!gate.ok) return { success: false, error: gate.error }
  if (!entityId.safeParse(id).success) return { success: false, error: 'Neplatný API klíč.' }

  const admin = createAdminClient()
  const { error } = await admin.from('api_key').update({ revoked_at: new Date().toISOString() }).eq('id', id)
  if (error) return { success: false, error: dbErrorMessage('action.apiKeys', error) }
  // OAuth token konektoru: bez refresh tokenu by se hned obnovil.
  const familyKeys = await revokeOAuthFamilyOfKey(admin, id)
  // Diagnostika konektoru: přehled v /api-klice pak u připojení ukáže
  // „zrušeno ručně" místo neznámého důvodu. Výpadek zápisu nic nevrací.
  await recordOAuthProblem(admin, {
    source: 'cockpit',
    reason: 'manual_revoke',
    apiKeyId: id,
    keyKind: familyKeys.length > 0 ? 'oauth' : 'manual',
    revokedKeyIds: [...new Set([id, ...familyKeys])],
    actorUserId: gate.userId,
  })

  revalidatePath('/cockpit/api-klice')
  return { success: true }
}
