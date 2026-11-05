'use client'
// Formulář „Předat práci" (Tým a nastavení → člen → Předat práci). Komu
// a které druhy práce; server (transferMemberWork → transfer_member_work,
// 0088, od 0093 i cílové seznamy) předá všechno jednou transakcí a vrátí souhrn.
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { transferMemberWork } from '@/lib/actions/team'
import { WORK_KINDS, countLabel, type WorkKind } from '@/lib/memberWork'

export function MemberHandoverForm({
  fromId, fromName, targets, counts, unavailable,
}: {
  fromId: string
  fromName: string
  targets: { id: string; name: string; roleLabel: string }[]
  counts: Record<WorkKind, number>
  /** Druhy, které v DB ještě nejsou (migrace) — nejdou vybrat. */
  unavailable: WorkKind[]
}) {
  const [state, formAction] = useActionState(transferMemberWork.bind(null, fromId), null)
  const fe = state?.fieldErrors ?? {}
  if (targets.length === 0) {
    return <p className="m-0 text-callout text-muted">V týmu není nikdo další aktivní s interní rolí, komu by šlo práci předat.</p>
  }
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label={`Komu předat práci (${fromName} →)`} error={fe.to_member_id}>
        <select name="to_member_id" defaultValue="" required className="w-full sm:max-w-md">
          <option value="" disabled>Vyber člena týmu…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>{t.name} · {t.roleLabel}</option>
          ))}
        </select>
      </FormField>

      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-callout font-semibold text-[color:#39414D]">Co předat</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {WORK_KINDS.map((k) => {
            const n = counts[k.key] ?? 0
            const off = unavailable.includes(k.key)
            return (
              <label
                key={k.key}
                className={`flex min-h-[44px] items-center gap-3 rounded-btn border border-border bg-surface px-3 py-2 text-body ${off ? 'opacity-60' : 'cursor-pointer has-[:checked]:border-[color:var(--c-navy)] has-[:checked]:bg-[color:var(--c-soft)]'}`}
              >
                <input
                  type="checkbox"
                  name="kinds"
                  value={k.key}
                  defaultChecked={!off && n > 0}
                  disabled={off}
                  className="h-[18px] w-[18px] shrink-0 accent-[color:var(--c-navy)]"
                />
                <span className="min-w-0 flex-1">
                  <b className="block font-semibold">{k.label}</b>
                  <span className="block text-footnote text-muted">{off ? 'připravuje se' : k.role}</span>
                </span>
                <span className="whitespace-nowrap text-footnote font-bold tabular-nums">{off ? '—' : countLabel(k.key, n)}</span>
              </label>
            )
          })}
        </div>
        {fe.kinds && <span role="alert" className="mt-1 block text-callout text-neg">{fe.kinds}</span>}
      </fieldset>

      <p className="m-0 text-callout text-muted">
        Předá se jen otevřená práce: obchody mimo Vyhráno/Prohráno/Odloženo, všechny cílové seznamy člověka, neuzavřené
        dodávky a milníky, nedokončené úkoly a případy, běžící a budoucí alokace (běžící se ukončí včerejškem a od dneška pokračují u nového člověka).
        Kde by nový člověk byl vlastníkem i zástupcem zároveň, zástupce se uvolní. Každá změna jde do auditu.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="coral">Předat vybranou práci</SubmitButton>
        {state?.success && state.message && <p role="status" className="m-0 text-callout font-semibold text-pos">{state.message}</p>}
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}
