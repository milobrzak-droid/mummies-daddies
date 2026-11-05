import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { mfaEnforced } from '@/lib/auth/mfa'
import { isInternalRole } from '@/lib/domain'
import { readActiveMember } from '@/lib/auth/activeMember'

// Autentizační brána pro Server Actions.
//
// Proxy (lib/supabase/middleware.ts) není hranice: Server Action jde zavolat
// POSTem na libovolnou cestu s hlavičkou `Next-Action` a matcher/výjimky proxy
// se pak mohou minout. Každá action, která sahá na admin klienta (service
// role, obchází RLS), proto MUSÍ sama zavolat `requireUser({ aal2: true })`.
//
// AAL2 = uživatel v této session prošel TOTP výzvou. Vypnout jde jen nouzově
// přes MFA_ENFORCED=false (stejný přepínač jako v proxy); pak stačí přihlášení
// a do logu jde varování.
//
// Role: brána pustí jen interní role (lib/domain.ts INTERNAL_ROLES). Partner
// (externí účet) neprojde, protože akce přes service role RLS obchází a
// nespoléhají se na is_team_member(); deaktivovaný člen (deactivated_at) neprojde nikdy, ani s `allowExternal`;
// ban v Auth ho zastaví až s expirací už vydaného JWT.
// Výjimka `allowExternal` je jen pro správu vlastního účtu (2FA, heslo, jméno),
// aby se Partner mohl přihlásit s MFA; k datům to přístup nedává.
//
// Při jakékoli chybě (výjimka ze Supabase, chybějící data) brána selže
// zavřená — raději odmítnout než pustit dál.

export class AuthError extends Error {
  constructor() {
    super('Nejsi přihlášený nebo nemáš ověřené dvoufázové přihlášení.')
    this.name = 'AuthError'
  }
}

export async function requireUser(opts: { aal2?: boolean; allowExternal?: boolean } = {}): Promise<User> {
  let user: User | null = null
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) throw new AuthError()
    user = data.user

    // Čtení řádku člena vždy, i s allowExternal: deaktivovaný člen neprojde nikdy
    // (jeho JWT žije do expirace a akce se servisním klíčem RLS obchází).
    const member = await readActiveMember<{ role?: string | null }>(supabase, user.id, 'role')
    if (member.error || member.deactivated) throw new AuthError()
    if (!opts.allowExternal && (!member.row || !isInternalRole(member.row.role))) throw new AuthError()

    if (opts.aal2 && mfaEnforced()) {
      const { data: aal, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aalErr || aal?.currentLevel !== 'aal2') throw new AuthError()
    }
  } catch {
    throw new AuthError()
  }
  return user
}

// Nevyhazující varianta pro actions, které vracejí chybu ve svém tvaru výsledku.
export async function tryRequireUser(opts: { aal2?: boolean; allowExternal?: boolean } = {}): Promise<User | null> {
  try {
    return await requireUser(opts)
  } catch {
    return null
  }
}

export const AUTH_ERROR_MESSAGE = new AuthError().message
