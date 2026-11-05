'use client'
import { Suspense, useActionState } from 'react'
import { useSearchParams } from 'next/navigation'
import { signIn } from './actions'
import { Turnstile } from '@/components/Turnstile'
import { COMPANY } from '@/config'
import { AuthShell, AUTH_CARD } from '@/components/ui/AuthCard'
import { FormField } from '@/components/FormField'
import { buttonClass } from '@/components/ui/Button'

// Kam se vrátit po přihlášení (nastavuje middleware). Drží OAuth flow
// pohromadě, když uživatel přijde na /api/oauth/authorize nepřihlášený.
// Vlastní komponenta v Suspense, protože useSearchParams jinak zablokuje
// prerender celé stránky.
function NextField() {
  const next = useSearchParams().get('next') ?? ''
  return <input type="hidden" name="next" value={next} />
}

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signIn, null)
  return (
    <AuthShell>
      <form action={formAction} className={`${AUTH_CARD} space-y-4`}>
        <div>
          <p className="eyebrow mb-1.5">Přihlášení</p>
          <h1 className="m-0 font-heading text-title1 font-bold">{COMPANY.productName}</h1>
        </div>
        <Suspense fallback={null}><NextField /></Suspense>
        <FormField label="E-mail">
          <input name="email" type="email" autoComplete="email" required className="min-h-[44px]" />
        </FormField>
        <FormField label="Heslo">
          <input name="password" type="password" autoComplete="current-password" required className="min-h-[44px]" />
        </FormField>
        {state?.error && <p role="alert" className="m-0 rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-2.5 text-callout text-neg">{state.error}</p>}
        <Turnstile />
        <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass('primary', 'lg', 'w-full')}>
          {pending ? 'Přihlašuji…' : 'Přihlásit se'}
        </button>
      </form>
    </AuthShell>
  )
}
