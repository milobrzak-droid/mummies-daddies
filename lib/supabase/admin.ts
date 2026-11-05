import { createClient } from '@supabase/supabase-js'
import { supabaseUrl, supabaseSecretKey } from './env'

// Bypasses RLS. Only import from server code, never from a Client Component.
// Reserved for rare admin tasks; app reads/writes use the authenticated client.
//
// `headers` se posílají s každým požadavkem klienta. Používá je
// createAuditedAdminClient (core/auditDb.ts), aby DB audit trigger (0064)
// poznal, za koho servisní zápis jde.
export function createAdminClient(options: { headers?: Record<string, string> } = {}) {
  return createClient(
    supabaseUrl,
    supabaseSecretKey,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      ...(options.headers && Object.keys(options.headers).length > 0 ? { global: { headers: options.headers } } : {}),
    },
  )
}
