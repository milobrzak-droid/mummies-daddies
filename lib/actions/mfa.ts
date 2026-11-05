'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { safeNext } from '@/lib/auth/safeNext'
import type { ActionResult } from '@/lib/actionResult'
import { createAdminClient } from '@/lib/supabase/admin'

// Brzda proti hádání TOTP: Supabase limituje jen per IP, a to je u nás
// sdílená egress IP Vercelu. Počítá se tedy na uživatele (tabulka
// mfa_failure, 0069, jen service role): nejvýš MFA_MAX_FAILURES pokusů za
// MFA_WINDOW_MS, pak se session odhlásí a je nutné nové přihlášení heslem.
//
// Atomicky (insert-then-count): pokus se ZAPÍŠE dřív, než se ověřuje kód,
// a teprve pak se spočítají pokusy v okně včetně vlastního. Původní
// count-then-verify nechalo desítky souběžných požadavků z jedné session
// projít kontrolou s nulou zapsaných chyb. Takhle pokus, jehož insert byl
// k-tý v pořadí, vidí aspoň k řádků, takže dál než k MFA_MAX_FAILURES se
// nedostane nikdo, ať běží kolik chce souběžných požadavků. Zamítnutý pokus
// svůj řádek smaže (zámek se tím neprodlužuje a počet drží jen pokusy, které
// skutečně došly k ověření). Úspěch smaže řádky uživatele.
const MFA_MAX_FAILURES = 5
const MFA_WINDOW_MS = 10 * 60 * 1000
const MFA_LOCKED_MESSAGE = 'Příliš mnoho nesprávných kódů. Přihlas se znovu za 10 minut.'
const MFA_UNAVAILABLE_MESSAGE = 'Ověření se teď nepodařilo provést. Zkus to za chvíli znovu.'

type Admin = ReturnType<typeof createAdminClient>
type AttemptSlot = { ok: true; id: number | null } | { ok: false; reason: 'locked' | 'unavailable' }

function isMissingTable(e: { code?: string } | null): boolean {
  return e?.code === '42P01' || e?.code === 'PGRST205'
}

// Zapíše pokus a rozhodne, jestli smí pokračovat k ověření kódu. Nenasazená
// 0069 (tabulka chybí) = počítadlo není k dispozici, pokus projde jako dřív;
// jakákoli jiná chyba brzdy selže zavřeně.
async function claimAttemptSlot(admin: Admin, userId: string): Promise<AttemptSlot> {
  const { data: inserted, error: insertError } = await admin
    .from('mfa_failure').insert({ user_id: userId }).select('id').single()
  if (insertError) return isMissingTable(insertError) ? { ok: true, id: null } : { ok: false, reason: 'unavailable' }
  const id = (inserted as { id: number } | null)?.id ?? null

  const since = new Date(Date.now() - MFA_WINDOW_MS).toISOString()
  const { count, error: countError } = await admin
    .from('mfa_failure')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('at', since)
  if (countError || count === null || count === undefined) {
    await releaseAttemptSlot(admin, id)
    return { ok: false, reason: 'unavailable' }
  }
  if (count > MFA_MAX_FAILURES) {
    await releaseAttemptSlot(admin, id)
    return { ok: false, reason: 'locked' }
  }
  return { ok: true, id }
}

async function releaseAttemptSlot(admin: Admin, id: number | null): Promise<void> {
  if (id === null) return
  await admin.from('mfa_failure').delete().eq('id', id)
}

// Verify a TOTP code for a given factor (used by BOTH first-time enrollment and
// login challenge — the API is identical: challenge then verify).
// Záměrně jen AAL1 (tahle action z AAL1 teprve dělá AAL2). `next` = kam se po
// ověření vrátit (např. /api/oauth/authorize); prochází přes safeNext.
export async function verifyFactor(factorId: string, next: string | null, _prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await tryRequireUser({ allowExternal: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  const code = String(formData.get('code') ?? '').trim()
  if (!/^\d{6}$/.test(code)) return { success: false, error: 'Zadej 6místný kód z aplikace.' }
  const supabase = await createClient()
  const admin = createAdminClient()
  const slot = await claimAttemptSlot(admin, user.id)
  if (!slot.ok) {
    if (slot.reason === 'locked') {
      await supabase.auth.signOut()
      return { success: false, error: MFA_LOCKED_MESSAGE }
    }
    return { success: false, error: MFA_UNAVAILABLE_MESSAGE }
  }
  const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({ factorId })
  if (cErr || !challenge) {
    // Chyba výzvy není hádání kódu, pokus se nepočítá.
    await releaseAttemptSlot(admin, slot.id)
    return { success: false, error: cErr?.message ?? 'Nepodařilo se vytvořit výzvu.' }
  }
  const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code })
  // Nesprávný kód: řádek pokusu zůstává (už je zapsaný předem).
  if (vErr) return { success: false, error: 'Nesprávný kód. Zkus to znovu.' }
  await admin.from('mfa_failure').delete().eq('user_id', user.id)
  revalidatePath('/', 'layout')
  const h = await headers()
  redirect(safeNext(next, `https://${h.get('host') ?? 'localhost'}`))
}
