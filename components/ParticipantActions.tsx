'use client'
import Link from 'next/link'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import {
  resetParticipantPassword, setParticipantAdmin, setParticipantRole, deactivateParticipant, setParticipantFullName,
  resetParticipantMfa,
} from '@/lib/actions/team'
import { EditFullNameForm } from '@/components/EditFullNameForm'
import { TEAM_ROLES } from '@/lib/domain'
import { CONFIRM_OPEN_WORK_FIELD } from '@/lib/memberWork'
import { buttonClass } from '@/components/ui/Button'

/** Text potvrzení před zrušením 2FA — kdo, co se stane a kdy to udělat. */
export function mfaResetConfirmText(name: string): string {
  return `Zrušit dvoufázové ověření pro ${name}?\n\n`
    + 'Odhlásí se ze všech zařízení a při dalším přihlášení si v Authenticatoru naskenuje nový QR kód. '
    + 'Udělej to, jen když si jsi jistý, že o to žádá opravdu ten člověk (osobně nebo telefonem).'
}

/**
 * Dvoufázové ověření člena: stav a (jen u cizího účtu) zrušení po ztrátě
 * telefonu. `mfa` = má ověřený Authenticator; null = stav se nepodařilo zjistit.
 */
function MfaSection({ userId, name, isSelf, mfa }: { userId: string; name: string; isSelf: boolean; mfa: boolean | null }) {
  const [state, formAction] = useActionState(resetParticipantMfa.bind(null, userId), null)
  const status = mfa === true
    ? 'Nastavené (Authenticator v telefonu).'
    : mfa === false
      ? 'Nenastavené — nastaví si ho při příštím přihlášení.'
      : null
  return (
    <section aria-label="Dvoufázové ověření" className="rounded-btn border border-border bg-surface px-3.5 py-3">
      <p className="m-0 text-headline text-ink">Dvoufázové ověření</p>
      {status && <p className="m-0 mt-0.5 text-footnote text-muted">{status}</p>}
      {isSelf ? (
        <p className="m-0 mt-1.5 text-footnote text-muted">Svoje dvoufázové ověření si tady zrušit nemůžeš. Když ztratíš telefon, požádej jiného správce.</p>
      ) : (
        <>
          <p className="m-0 mt-1.5 text-footnote text-muted">
            Ztracený telefon s Authenticatorem? Zruš ověření: člověk se odhlásí ze všech zařízení a při dalším
            přihlášení naskenuje nový QR kód. Heslo zůstává.
          </p>
          {mfa !== false && !state?.success && (
            <form
              action={formAction}
              className="mt-2"
              onSubmit={(e) => {
                if (!window.confirm(mfaResetConfirmText(name))) e.preventDefault()
              }}
            >
              <SubmitButton variant="danger" aria-label={`Zrušit dvoufázové ověření: ${name}`}>Zrušit dvoufázové ověření</SubmitButton>
            </form>
          )}
        </>
      )}
      {state?.error && <p role="alert" className="m-0 mt-2 text-callout text-neg">{state.error}</p>}
      {state?.success && (
        <p role="status" className="m-0 mt-2 text-callout text-pos">
          Zrušeno. {name} se musí znovu přihlásit na všech zařízeních a při přihlášení si nastaví nový Authenticator.
          Pokud byla v telefonu zkratka pro zápisy schůzek, zruš i její klíč v API klíčích.
        </p>
      )}
    </section>
  )
}

export function ParticipantActions({
  userId, isAdmin, isSelf, role, fullName, displayName, mfa = null, deactivated = false,
}: {
  userId: string
  isAdmin: boolean
  isSelf: boolean
  role: string
  fullName: string
  /** Jméno do potvrzení a hlášek (jméno, jinak e-mail). */
  displayName?: string
  /** Má ověřený Authenticator? null = nezjištěno. */
  mfa?: boolean | null
  deactivated?: boolean
}) {
  const [resetState, resetFormAction] = useActionState(resetParticipantPassword.bind(null, userId), null)
  const resetRef = useRef<HTMLFormElement>(null)
  useEffect(() => { if (resetState?.success) resetRef.current?.reset() }, [resetState])

  const [toggleState, toggleFormAction] = useActionState(
    setParticipantAdmin.bind(null, userId, !isAdmin), null,
  )
  const [roleState, roleFormAction] = useActionState(setParticipantRole.bind(null, userId), null)
  const [deactivateState, deactivateFormAction] = useActionState(
    deactivateParticipant.bind(null, userId), null,
  )
  const needsConfirm = !deactivateState?.success && Boolean(deactivateState?.fieldErrors?.[CONFIRM_OPEN_WORK_FIELD])

  return (
    <div className="flex flex-col gap-4">
      <EditFullNameForm action={setParticipantFullName.bind(null, userId)} initialFullName={fullName} variant="soft" />

      <form ref={resetRef} action={resetFormAction} className="flex flex-wrap items-end gap-2">
        <FormField label="Nové heslo" error={resetState?.fieldErrors?.password}>
          <input name="password" type="password" minLength={8} required className="w-40" />
        </FormField>
        <SubmitButton variant="soft">Reset hesla</SubmitButton>
      </form>
      {resetState?.error && <p role="alert" className="m-0 text-callout text-neg">{resetState.error}</p>}
      {resetState?.success && <p role="status" className="m-0 text-callout text-pos">Heslo změněno.</p>}

      <MfaSection userId={userId} name={displayName ?? (fullName || 'člen týmu')} isSelf={isSelf} mfa={mfa} />

      <form action={roleFormAction} className="flex flex-wrap items-center gap-2">
        <select name="role" defaultValue={role} aria-label="Role v týmu" className="w-auto min-w-[160px] flex-1">
          {TEAM_ROLES.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
        <SubmitButton variant="soft">Uložit roli</SubmitButton>
      </form>
      {roleState?.error && <p role="alert" className="m-0 text-callout text-neg">{roleState.error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <form action={toggleFormAction}>
          <SubmitButton variant="soft">{isAdmin ? 'Odebrat admina' : 'Udělat adminem'}</SubmitButton>
        </form>
        {!isSelf && !deactivated && !needsConfirm && (
          <form action={deactivateFormAction}>
            <SubmitButton variant="danger">Deaktivovat</SubmitButton>
          </form>
        )}
      </div>
      {toggleState?.error && <p role="alert" className="m-0 text-callout text-neg">{toggleState.error}</p>}
      {deactivateState?.error && !needsConfirm && <p role="alert" className="m-0 text-callout text-neg">{deactivateState.error}</p>}
      {deactivateState?.success && <p role="status" className="m-0 text-callout text-muted">Účet je deaktivovaný.</p>}
      {needsConfirm && !isSelf && (
        // Člověk má otevřenou práci: nejdřív předat, nebo výslovně potvrdit.
        <form action={deactivateFormAction} className="flex flex-col gap-3 rounded-tile border border-[color:var(--c-neg)] bg-surface p-4">
          <p role="alert" className="m-0 text-callout font-semibold text-neg">{deactivateState?.error}</p>
          <Link href={`/cockpit/tym/${userId}/predat`} className={buttonClass('secondary', 'md', 'w-fit')}>
            Předat práci
          </Link>
          <label className="flex items-start gap-2.5 text-body">
            <input type="checkbox" name={CONFIRM_OPEN_WORK_FIELD} required className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[color:var(--c-navy)]" />
            <span>Rozumím, deaktivovat i tak — otevřené věci zůstanou u deaktivovaného člověka, dokud je někdo nepředá.</span>
          </label>
          <div>
            <SubmitButton variant="danger">Deaktivovat i s otevřenou prací</SubmitButton>
          </div>
        </form>
      )}
    </div>
  )
}
