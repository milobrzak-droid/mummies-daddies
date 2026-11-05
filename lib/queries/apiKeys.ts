import { createAdminClient } from '@/lib/supabase/admin'
import type { ApiKey } from '@/lib/types'

// api_key has RLS enabled with zero policies (see migration 0017) — only
// the service-role client can read it, by design. Never switch this to
// the cookie-session client from lib/supabase/server.
export async function listApiKeys(): Promise<ApiKey[]> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('api_key')
    .select('id, name, key_prefix, created_by, created_at, last_used_at, revoked_at, scope')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as ApiKey[]
}
