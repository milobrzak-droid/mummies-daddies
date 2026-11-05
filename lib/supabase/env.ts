// Central Supabase credentials. All Supabase access in this app is server-side
// (Server Components, Server Actions, proxy middleware) — there is no browser
// client — so non-public env var names are fine and preferable (nothing leaks to
// the client bundle).
//
// Accepts BOTH the new Supabase key names (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY
// / SUPABASE_SECRET_KEY — as set by the Supabase–Vercel integration) and the
// legacy NEXT_PUBLIC_* names, so the app works in either environment.

export const supabaseUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''

// Publishable / anon key — safe to use from server code.
export const supabaseAnonKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  ''

// Secret / service-role key — server-only, bypasses RLS. Never import into a
// Client Component.
export const supabaseSecretKey =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  ''
