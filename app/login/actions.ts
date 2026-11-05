'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { safeNext } from '@/lib/auth/safeNext'

// Verifies the Cloudflare Turnstile token against Cloudflare's siteverify
// endpoint. Only runs when TURNSTILE_SECRET_KEY is configured — with no
// secret set, this is skipped entirely and signIn behaves exactly as before
// (no CAPTCHA gate), so login keeps working before/without Turnstile setup.
async function verifyTurnstile(formData: FormData): Promise<string | null> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return null

  const token = String(formData.get('cf-turnstile-response') ?? '')
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token }),
  })
  const data = await res.json()
  if (data?.success !== true) return 'Ověření selhalo, zkuste to znovu.'
  return null
}

export async function signIn(_prev: unknown, formData: FormData) {
  const captchaError = await verifyTurnstile(formData)
  if (captchaError) return { error: captchaError }

  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { error: 'Nesprávný e-mail nebo heslo.' }
  revalidatePath('/', 'layout')
  // Kam po přihlášení — jen cesta v rámci appky (viz lib/auth/safeNext.ts).
  // Origin je tu jen základ pro parsování; porovnává se s ním výsledek.
  const h = await headers()
  const origin = `https://${h.get('host') ?? 'localhost'}`
  redirect(safeNext(formData.get('next'), origin))
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  revalidatePath('/', 'layout')
  redirect('/login')
}
