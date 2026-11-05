'use client'
import { useState, useTransition } from 'react'
import { buttonClass } from '@/components/ui/Button'
import { useUndoToast } from '@/components/ui/Toast'
import type { ActionResult } from '@/lib/actionResult'

export type ClientsAlias = { id: number; alias_domain: string | null; alias_name: string | null }

// Aliasy domén a názvů firmy. Odebrání aliasu je vratné (docs/PROVOZ.md
// §11 „Zpět místo Opravdu?“, plán vlny 2 „odebrat alias hned + toast se Zpět“):
// provede se hned a toast nabídne Zpět, které alias založí znovu tou samou
// serverovou akcí jako formulář „Přidat alias“ – pravidla na serveru se nemění.
export function ClientsAliasList({ aliases, remove, add }: {
  aliases: ClientsAlias[]
  /** removeCompanyAlias navázaná na firmu: (aliasId) => … */
  remove: (aliasId: number) => Promise<void>
  /** addCompanyAlias navázaná na firmu (stejná akce jako formulář). */
  add: (prev: unknown, formData: FormData) => Promise<ActionResult>
}) {
  const toast = useUndoToast()
  const [hidden, setHidden] = useState<number[]>([])
  const [pending, startTransition] = useTransition()
  const visible = aliases.filter((a) => !hidden.includes(a.id))

  function onRemove(alias: ClientsAlias) {
    const text = aliasText(alias)
    setHidden((h) => [...h, alias.id])
    startTransition(async () => {
      try {
        await remove(alias.id)
      } catch {
        setHidden((h) => h.filter((id) => id !== alias.id))
        toast.show({ message: 'Alias se nepodařilo odebrat. Zkus to znovu.' })
        return
      }
      toast.show({
        message: `Alias ${text} je odebraný.`,
        undo: async () => {
          const fd = new FormData()
          fd.set('alias_domain', alias.alias_domain ?? '')
          fd.set('alias_name', alias.alias_name ?? '')
          const result = await add(null, fd)
          if (!result.success) throw new Error(result.error ?? 'Alias se nepodařilo vrátit.')
        },
      })
    })
  }

  if (visible.length === 0) {
    return <p className="m-0 mb-4 text-callout text-muted">Žádné aliasy – firma není evidovaná pod jinou doménou ani názvem.</p>
  }
  return (
    <ul className="m-0 mb-4 list-none divide-y divide-[color:var(--c-line-2)] p-0" aria-busy={pending}>
      {visible.map((a) => (
        <li key={a.id} className="flex min-h-[44px] items-center justify-between gap-3 py-1.5 text-body">
          <span className="min-w-0 break-words">{aliasText(a)}</span>
          <button
            type="button"
            onClick={() => onRemove(a)}
            aria-label={`Odebrat alias ${aliasText(a)}`}
            className={buttonClass('quiet', 'sm', 'shrink-0')}
          >
            Odebrat
          </button>
        </li>
      ))}
    </ul>
  )
}

function aliasText(a: ClientsAlias): string {
  return [a.alias_domain, a.alias_name].filter(Boolean).join(' · ')
}
