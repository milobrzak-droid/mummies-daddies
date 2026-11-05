import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { verifyFactor } from '@/lib/actions/mfa'
import { MfaCodeForm } from '@/components/MfaCodeForm'
import { AuthShell, AuthStep, AUTH_CARD } from '@/components/ui/AuthCard'

export default async function MfaEnrollPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next
  // Jen řetězec; bezpečnost cíle hlídá safeNext až při přesměrování.
  const next = typeof raw === 'string' ? raw : null
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : ''
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Clean any leftover unverified TOTP factors so we show a fresh QR.
  // (listFactors() types `data.totp` as always-verified; `data.all` carries the real status union.)
  const { data: factors } = await supabase.auth.mfa.listFactors()
  for (const f of factors?.all ?? []) {
    if (f.factor_type === 'totp' && f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id })
  }

  // Already enrolled with a verified factor → go challenge instead.
  if (factors?.totp?.some((f) => f.status === 'verified')) redirect(`/auth/mfa${nextQuery}`)

  // Unique friendly name avoids the "factor with friendly name '' already exists"
  // conflict if a stale unverified factor lingers past the cleanup above.
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Authenticator',
  })

  return (
    <AuthShell>
      <div className={`${AUTH_CARD} space-y-4`}>
        <div>
          <p className="eyebrow mb-1.5">Zabezpečení účtu</p>
          <h1 className="m-0 font-heading text-title1 font-bold">Zabezpeč účet (2FA)</h1>
        </div>
        {error || !data ? (
          <p role="alert" className="m-0 rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-2.5 text-callout text-neg">{error?.message ?? 'Nepodařilo se založit dvoufázové ověření.'}</p>
        ) : (
          <>
            <AuthStep n={1}>
              <p className="m-0">
                Naskenuj QR kód v aplikaci Google/Microsoft Authenticator.
              </p>
            </AuthStep>
            <div className="mx-auto w-fit rounded-tile border border-border bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.totp.qr_code} alt="QR kód pro Authenticator" width={200} height={200} />
            </div>
            <p className="m-0 text-callout text-muted">
              Nebo zadej ručně: <code className="break-all rounded-full bg-[color:var(--c-soft)] px-3 py-0.5 font-mono">{data.totp.secret}</code>
            </p>
            <AuthStep n={2}>
              <p className="m-0">Opiš 6místný kód z aplikace.</p>
            </AuthStep>
            <MfaCodeForm action={verifyFactor.bind(null, data.id, next)} submitLabel="Ověřit a dokončit" />
          </>
        )}
      </div>
    </AuthShell>
  )
}
