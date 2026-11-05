'use client'
// Formuláře alokací a kapacity (kap. 10, migrace 0062): přidat alokaci
// (obecně s výběrem dodávky/případu, nebo pevně k dodávce), upravit,
// ukončit k dnešku a změnit týdenní kapacitu. Validace a pravidla jsou
// v domain/delivery/capacity.ts; tady jen formuláře a stav odeslání.
import { useActionState, useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import {
  createAllocation,
  createEngagementAllocation,
  endAllocation,
  setMemberCapacity,
  updateAllocation,
} from '@/domain/delivery/actions/capacity'
import { MAX_WEEKLY_HOURS, NOTE_MAX } from '@/domain/delivery/capacity'
import { buttonClass } from '@/components/ui/Button'
import { CARD, CARD_PAD } from '@/components/ui/Card'

export type PersonOption = { id: string; full_name: string }
export type TargetOption = { key: string; kind: 'engagement' | 'work_case'; label: string }

function SubstituteSelect({ members, defaultValue, error }: { members: PersonOption[]; defaultValue?: string | null; error?: string }) {
  return (
    <FormField label="Zástup (nepovinné)" error={error} hint="Kdo práci převezme, když člověk vypadne.">
      <select name="substitute_id" defaultValue={defaultValue ?? ''} className="w-full">
        <option value="">— bez zástupu —</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>{m.full_name}</option>
        ))}
      </select>
    </FormField>
  )
}

function PeriodFields({
  startsOn,
  endsOn,
  errors,
}: {
  startsOn: string
  endsOn?: string | null
  errors?: Record<string, string>
}) {
  return (
    <>
      <FormField label="Od" error={errors?.starts_on}>
        <input name="starts_on" type="date" required defaultValue={startsOn} className="w-full" />
      </FormField>
      <FormField label="Do (nepovinné)" error={errors?.ends_on} hint="Prázdné = bez konce.">
        <input name="ends_on" type="date" defaultValue={endsOn ?? ''} className="w-full" />
      </FormField>
    </>
  )
}

function HoursField({ defaultValue, error }: { defaultValue?: number; error?: string }) {
  return (
    <FormField label="Hodin týdně" error={error}>
      <input
        name="hours_per_week"
        type="number"
        inputMode="decimal"
        required
        min={0.1}
        max={MAX_WEEKLY_HOURS}
        step={0.1}
        defaultValue={defaultValue}
        className="w-full"
      />
    </FormField>
  )
}

function NoteField({ defaultValue, error }: { defaultValue?: string | null; error?: string }) {
  return (
    <FormField label="Poznámka (nepovinné)" error={error}>
      <input name="note" maxLength={NOTE_MAX} defaultValue={defaultValue ?? ''} className="w-full" />
    </FormField>
  )
}

/**
 * Nová alokace. Bez `engagement` vybírá cíl (dodávka / případ) z `targets`;
 * s `engagement` je cíl pevně tahle dodávka.
 */
export function AllocationCreateForm({
  members,
  targets = [],
  engagement,
  today,
}: {
  members: PersonOption[]
  targets?: TargetOption[]
  engagement?: { accountId: number; engagementId: number }
  today: string
}) {
  const action = engagement
    ? createEngagementAllocation.bind(null, engagement.accountId, engagement.engagementId)
    : createAllocation
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.success) ref.current?.reset()
  }, [state])
  const engagements = targets.filter((t) => t.kind === 'engagement')
  const cases = targets.filter((t) => t.kind === 'work_case')
  const fe = state?.fieldErrors
  return (
    <form ref={ref} action={formAction} className={`${CARD} ${CARD_PAD} grid gap-3 md:grid-cols-2 lg:grid-cols-3`}>
      <FormField label="Kdo" error={fe?.member_id}>
        <select name="member_id" required defaultValue="" className="w-full">
          <option value="" disabled>Vyber člena týmu…</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.full_name}</option>
          ))}
        </select>
      </FormField>
      {!engagement && (
        <FormField label="Na čem" error={fe?.target}>
          <select name="target" required defaultValue="" className="w-full">
            <option value="" disabled>Vyber dodávku nebo případ…</option>
            {engagements.length > 0 && (
              <optgroup label="Dodávky">
                {engagements.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </optgroup>
            )}
            {cases.length > 0 && (
              <optgroup label="Případy">
                {cases.map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </optgroup>
            )}
          </select>
        </FormField>
      )}
      <HoursField error={fe?.hours_per_week} />
      <PeriodFields startsOn={today} errors={fe} />
      <SubstituteSelect members={members} error={fe?.substitute_id} />
      <div className="md:col-span-2 lg:col-span-3">
        <NoteField error={fe?.note} />
      </div>
      <div className="md:col-span-2 lg:col-span-3 flex flex-wrap items-center gap-3">
        <SubmitButton>Přidat alokaci</SubmitButton>
        {state?.success && <p role="status" className="m-0 text-callout text-pos">Alokace je přidaná.</p>}
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}

export type EditableAllocation = {
  id: number
  member_id: string
  memberName: string
  targetLabel: string
  hours_per_week: number
  starts_on: string
  ends_on: string | null
  substitute_id: string | null
  note: string | null
}

/** Úprava alokace; po uložení zavře panel (odstraní ?alokace= z adresy). */
export function AllocationEditForm({
  allocation,
  members,
  closeHref,
}: {
  allocation: EditableAllocation
  members: PersonOption[]
  closeHref: string
}) {
  const [state, formAction] = useActionState(updateAllocation.bind(null, allocation.id), null)
  const router = useRouter()
  useEffect(() => {
    if (state?.success) router.replace(closeHref, { scroll: false })
  }, [state, router, closeHref])
  const fe = state?.fieldErrors
  return (
    <form action={formAction} className={`${CARD} ${CARD_PAD} grid gap-3 md:grid-cols-2 lg:grid-cols-3`}>
      <p className="md:col-span-2 lg:col-span-3 m-0 text-sm text-muted">
        <span className="font-medium text-ink">{allocation.memberName}</span> · {allocation.targetLabel}. Pro jiného
        člověka nebo jinou práci alokaci ukonči a přidej novou.
      </p>
      <HoursField defaultValue={allocation.hours_per_week} error={fe?.hours_per_week} />
      <PeriodFields startsOn={allocation.starts_on} endsOn={allocation.ends_on} errors={fe} />
      <SubstituteSelect
        members={members.filter((m) => m.id !== allocation.member_id)}
        defaultValue={allocation.substitute_id}
        error={fe?.substitute_id}
      />
      <div className="md:col-span-2 lg:col-span-3">
        <NoteField defaultValue={allocation.note} error={fe?.note} />
      </div>
      <div className="md:col-span-2 lg:col-span-3 flex flex-wrap items-center gap-3">
        <SubmitButton>Uložit změny</SubmitButton>
        <Link href={closeHref} scroll={false} className={buttonClass('quiet')}>
          Zrušit
        </Link>
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}

function EndButtonInner({ planned, label }: { planned: boolean; label: string }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={`${planned ? 'Zrušit' : 'Ukončit'} alokaci — ${label}`}
      className={buttonClass(planned ? 'danger' : 'quiet', 'sm', planned ? '' : '!text-neg')}
    >
      {pending ? '…' : planned ? 'Zrušit' : 'Ukončit'}
    </button>
  )
}

/**
 * Ukončit k dnešku. Nezačatá alokace se smaže (potvrzení), běžící dostane
 * konec = dnes.
 */
export function AllocationEndButton({ allocationId, planned, label }: { allocationId: number; planned: boolean; label: string }) {
  const [state, formAction] = useActionState(endAllocation.bind(null, allocationId), null)
  return (
    <form
      action={formAction}
      className="inline-flex items-center gap-2"
      onSubmit={(e) => {
        if (planned && !window.confirm('Alokace ještě nezačala — opravdu ji smazat?')) e.preventDefault()
      }}
    >
      <EndButtonInner planned={planned} label={label} />
      {state?.error && <span role="alert" className="text-neg text-xs">{state.error}</span>}
    </form>
  )
}

/** Týdenní kapacita člověka (inline v tabulce). */
export function CapacityForm({ memberId, memberName, current }: { memberId: string; memberName: string; current: number }) {
  const [state, formAction] = useActionState(setMemberCapacity.bind(null, memberId), null)
  const error = state?.fieldErrors?.weekly_capacity_hours ?? state?.error
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <label className="inline-flex items-center gap-2 text-sm text-muted">
        <span className="sr-only">Týdenní kapacita — {memberName} (hodin)</span>
        <input
          name="weekly_capacity_hours"
          type="number"
          inputMode="decimal"
          required
          min={0}
          max={MAX_WEEKLY_HOURS}
          step={0.5}
          defaultValue={current}
          className="w-24"
        />
        <span aria-hidden="true">h</span>
      </label>
      <SubmitButton variant="soft" size="sm" aria-label={`Uložit kapacitu — ${memberName}`}>Uložit</SubmitButton>
      {state?.success && <span role="status" className="text-xs text-pos">Uloženo.</span>}
      {error && <span role="alert" className="text-neg text-xs">{error}</span>}
    </form>
  )
}
