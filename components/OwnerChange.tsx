'use client'
// Změna vlastníka (a zástupce) jedné věci přímo na jejím detailu: případ,
// milník, obchod, dodávka, cílový seznam. Tlačítko „Změnit vlastníka" otevře
// dva výběry; uložení se provede hned a toast nabídne „Zpět"
// (docs/PROVOZ.md §9, §11). Pravidla drží databáze (change_work_owner,
// 0093): oprávnění, aktivní člověk s interní rolí, vlastník ≠ zástupce,
// jen otevřená věc, audit se jménem toho, kdo změnil, a položka v „Co se
// změnilo". Tady se jen nenabízí to, co by databáze odmítla (deaktivovaný
// člověk, zástupce shodný s vlastníkem) a zástupce, který se stal vlastníkem,
// se uvolní jako u hromadného předání.
import { useRef, useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { FormField } from '@/components/FormField'
import { buttonClass } from '@/components/ui/Button'
import { useUndoToast } from '@/components/ui/Toast'
import { changeWorkOwner } from '@/lib/actions/ownerChange'
import { ownerKindInfo, type OwnerKind, type OwnerPerson } from '@/lib/ownerChange'

export type OwnerHolder = { id: string | null; name: string | null }

type Option = { id: string; label: string }

/** Výběr: aktivní lidé, u stávajícího držitele, který už není aktivní, jeho jméno zůstane vidět. */
function optionsFor(members: readonly OwnerPerson[], current: OwnerHolder): Option[] {
  const list = members.map((m) => ({ id: m.id, label: `${m.name} · ${m.roleLabel}` }))
  if (current.id && !members.some((m) => m.id === current.id)) {
    list.unshift({ id: current.id, label: `${current.name ?? 'Člen týmu'} (už není aktivní)` })
  }
  return list
}

export function OwnerChange({
  kind,
  itemId,
  itemLabel,
  owner,
  deputy,
  members,
  canChange = true,
  onOpenChange,
  className = '',
}: {
  kind: OwnerKind
  itemId: number
  /** Název věci pro čtečku a popisky („Případ Nabídka ALFATECH"). */
  itemLabel: string
  owner: OwnerHolder
  /** Jen druhy se zástupcem (případ, milník, dodávka). */
  deputy?: OwnerHolder
  /** Aktivní členové s interní rolí (ownerOptions). */
  members: readonly OwnerPerson[]
  /** Smí přihlášený člověk vlastníka měnit (canChangeOwner). Jinak se nic nezobrazí. */
  canChange?: boolean
  /** Karta na tabuli se během úpravy nesmí dát táhnout. */
  onOpenChange?: (open: boolean) => void
  className?: string
}) {
  const info = ownerKindInfo(kind)
  const hasDeputy = info.hasDeputy && deputy !== undefined
  const router = useRouter()
  const toast = useUndoToast()
  const [open, setOpen] = useState(false)
  const [ownerSel, setOwnerSel] = useState(owner.id ?? '')
  const [deputySel, setDeputySel] = useState(deputy?.id ?? '')
  const [error, setError] = useState<{ text: string; owner?: string; deputy?: string } | null>(null)
  const [freedHint, setFreedHint] = useState(false)
  const [pending, startTransition] = useTransition()
  const buttonRef = useRef<HTMLButtonElement>(null)

  if (!canChange) return null

  const setOpenState = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
    if (next) {
      setOwnerSel(owner.id ?? '')
      setDeputySel(deputy?.id ?? '')
      setError(null)
      setFreedHint(false)
    } else {
      // Fokus zpět na tlačítko, které formulář otevřelo.
      queueMicrotask(() => buttonRef.current?.focus())
    }
  }

  function pickOwner(id: string) {
    setOwnerSel(id)
    // Zástupce, který se stává vlastníkem, se uvolní (jako u hromadného předání).
    if (hasDeputy && id !== '' && id === deputySel) {
      setDeputySel('')
      setFreedHint(true)
    } else {
      setFreedHint(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError(null)
    const before = { owner: owner.id, deputy: hasDeputy ? deputy!.id : null }
    startTransition(async () => {
      const result = await changeWorkOwner({
        kind,
        id: itemId,
        owner_id: ownerSel || null,
        deputy_id: hasDeputy ? deputySel || null : null,
        expect: before,
      })
      if (!result.success) {
        setError({ text: result.error, owner: result.fieldErrors?.owner_id, deputy: result.fieldErrors?.deputy_id })
        return
      }
      setOpenState(false)
      if (!result.changed) {
        toast.show({ message: result.message })
        return
      }
      const undo = result.undo
      toast.show({
        message: result.message,
        undo: undo
          ? async () => {
              const back = await changeWorkOwner({
                kind,
                id: itemId,
                owner_id: undo.owner,
                deputy_id: undo.deputy,
                undo_of: undo.auditId,
              })
              if (!back.success) throw new Error(back.error)
              router.refresh()
              toast.show({ message: back.message })
            }
          : undefined,
      })
      router.refresh()
    })
  }

  if (!open) {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpenState(true)}
        aria-label={`Změnit vlastníka: ${itemLabel}`}
        className={buttonClass('quiet', 'sm', className)}
      >
        Změnit vlastníka
      </button>
    )
  }

  const ownerOptions = optionsFor(members, owner)
  const deputyOptions = hasDeputy ? optionsFor(members, deputy!) : []
  return (
    <form
      onSubmit={submit}
      aria-label={`Změna vlastníka: ${itemLabel}`}
      className={`flex min-w-0 flex-col gap-3 rounded-btn border border-[color:var(--c-line)] bg-surface p-3 ${className}`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpenState(false) } }}
    >
      <FormField label={info.ownerLabel} error={error?.owner}>
        <select
          name="owner_id"
          value={ownerSel}
          onChange={(e) => pickOwner(e.target.value)}
          className="w-full"
          autoFocus
        >
          {/* Prázdná volba jen tam, kde věc dnes vlastníka nemá; existujícího vlastníka jde jen předat. */}
          {owner.id === null && <option value="">— nikdo —</option>}
          {ownerOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </FormField>
      {hasDeputy && (
        <FormField
          label="Zástupce"
          error={error?.deputy}
          hint={freedHint ? 'Nový vlastník byl zástupcem, zástupce se uvolnil. Doplň nového.' : 'Jiný člověk než vlastník.'}
        >
          <select
            name="deputy_id"
            value={deputySel}
            onChange={(e) => { setDeputySel(e.target.value); setFreedHint(false) }}
            className="w-full"
            disabled={ownerSel === ''}
          >
            <option value="">— nikdo —</option>
            {deputyOptions.map((o) => (
              <option key={o.id} value={o.id} disabled={o.id === ownerSel}>{o.label}</option>
            ))}
          </select>
        </FormField>
      )}
      {error && !error.owner && !error.deputy && <p role="alert" className="m-0 text-callout text-neg">{error.text}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
          {pending ? 'Ukládám…' : 'Uložit'}
        </button>
        <button type="button" onClick={() => setOpenState(false)} disabled={pending} className={buttonClass('quiet', 'sm')}>
          Zrušit
        </button>
      </div>
    </form>
  )
}
