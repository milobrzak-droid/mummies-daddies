import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { safeNext } from '@/lib/auth/safeNext'
import { createClient } from '@/lib/supabase/server'
import { verifyFactor } from '@/lib/actions/mfa'
import { signOut } from '@/app/login/actions'
import { MfaCodeForm } from '@/components/MfaCodeForm'
import { AuthShell, AUTH_CARD } from '@/components/ui/AuthCard'
import { buttonClass } from '@/components/ui/Button'

export default async function MfaChallengePage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next
  // Jen řetězec; bezpečnost cíle hlídá safeNext až při přesměrování.
  const next = typeof raw === 'string' ? raw : null
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : ''
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: factors } = await supabase.auth.mfa.listFactors()
  const totp = factors?.totp?.find((f) => f.status === 'verified')
  if (!totp) redirect(`/auth/mfa/enroll${nextQuery}`)

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (aal?.currentLevel === 'aal2') {
    const h = await headers()
    redirect(safeNext(next, `https://${h.get('host') ?? 'localhost'}`))
  }

  return (
    <AuthShell>
      <div className={`${AUTH_CARD} space-y-4`}>
        <div>
          <p className="eyebrow mb-1.5">Zabezpečení účtu</p>
          <h1 className="m-0 font-heading text-title1 font-bold">Dvoufázové ověření</h1>
        </div>
        <p className="m-0 text-body text-muted">Opiš 6místný kód z Authenticatoru.</p>
        <MfaCodeForm action={verifyFactor.bind(null, totp.id, next)} submitLabel="Ověřit" />
        <p className="m-0 text-footnote text-muted">
          Ztratil jsi telefon s Authenticatorem? Napiš správci. Zruší ti dvoufázové ověření a při dalším přihlášení
          naskenuješ nový QR kód. Kód ani heslo nikomu neposílej.
        </p>
        <form action={signOut}>
          <button type="submit" className={buttonClass('quiet', 'sm', '-ml-2 text-muted')}>Odhlásit</button>
        </form>
      </div>
    </AuthShell>
  )
}
