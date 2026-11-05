'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { AccountPicker } from '@/components/AccountPicker'
import { useUndoToast } from '@/components/ui/Toast'
import type { ActionResult } from '@/lib/actionResult'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
type Member = { id: string; full_name: string }
type DealOption = { id: number; title: string; account?: { name: string } | null }

export const TASK_QUICK_ANCHOR = 'novy-ukol'

// Rychlé přidání úkolu řádkem nahoře v prvním sloupci tabule
// (docs/PROVOZ.md §11 „Formulář pro rychlé založení je přímo na
// stránce seznamu“). Stačí název a Enter; termín, přiřazení, prioritu,
// klienta a obchod schovává `<details>`. Zodpovědný je předvyplněný
// přihlášeným člověkem, jinak by nový úkol ve výběru „Moje“ nebyl vidět.
//
// showDeals: výběr obchodu jen pro obchodní role (rozhodnutí 2026-09-28) —
// ostatním by se ukázal prázdný select, protože deal jim RLS (0058) nevrátí.
// Klient se vybírá hledáním (AccountPicker), ne ze seznamu všech ~663 firem.
export function TaskForm({ action, members, deals = [], showDeals = true, defaultAssigneeId = null }: {
  action: Action
  members: Member[]
  deals?: DealOption[]
  showDeals?: boolean
  /** Přihlášený člověk (výchozí zodpovědný), pokud je v týmu. */
  defaultAssigneeId?: string | null
}) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const lastTitle = useRef('')
  const toast = useUndoToast()
  const fe = state?.fieldErrors ?? {}
  const assignee = defaultAssigneeId && members.some((m) => m.id === defaultAssigneeId) ? defaultAssigneeId : ''

  useEffect(() => {
    if (!state?.success) return
    ref.current?.reset()
    titleRef.current?.focus()
    const name = lastTitle.current.length > 40 ? `${lastTitle.current.slice(0, 39)}…` : lastTitle.current
    toast.show({ message: name ? `Úkol „${name}“ je založený.` : 'Úkol je založený.' })
  }, [state, toast])

  // Odkaz /tasks#novy-ukol (paleta příkazů, tlačítko v hlavičce) rovnou
  // nastaví kurzor do pole názvu.
  useEffect(() => {
    function focusFromHash() {
      if (window.location.hash === `#${TASK_QUICK_ANCHOR}`) titleRef.current?.focus()
    }
    focusFromHash()
    window.addEventListener('hashchange', focusFromHash)
    return () => window.removeEventListener('hashchange', focusFromHash)
  }, [])

  return (
    <form
      ref={ref}
      action={formAction}
      onSubmit={() => { lastTitle.current = titleRef.current?.value.trim() ?? '' }}
      aria-label="Přidat úkol"
      className="rounded-tile bg-surface p-2 shadow-e1"
    >
      {state?.error && <p role="alert" className="m-0 mb-2 px-1 text-callout text-neg">{state.error}</p>}
      <div className="flex items-center gap-2">
        <label htmlFor="task-quick-title" className="sr-only">Název nového úkolu</label>
        <input
          id="task-quick-title"
          ref={titleRef}
          name="title"
          required
          autoComplete="off"
          placeholder="Přidat úkol…"
          aria-invalid={fe.title ? true : undefined}
          aria-describedby={fe.title ? 'task-quick-title-error' : undefined}
          className="min-w-0 flex-1"
        />
        <SubmitButton size="sm" pendingLabel="Přidávám…">Přidat</SubmitButton>
      </div>
      {fe.title && <p id="task-quick-title-error" role="alert" className="m-0 mt-1.5 px-1 text-callout text-neg">{fe.title}</p>}
      <details className="group mt-1" open={Object.keys(fe).some((k) => k !== 'title') || undefined}>
        <summary className="flex min-h-[36px] cursor-pointer list-none items-center gap-1.5 rounded-btn px-2 text-footnote font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
          Termín, zodpovědný, klient
        </summary>
        <div className="flex flex-col gap-3 px-1 pb-1 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Termín" error={fe.due_on}>
              <input name="due_on" type="date" />
            </FormField>
            <FormField label="Priorita" error={fe.priority}>
              <select name="priority" defaultValue="normal">
                <option value="low">Nízká</option>
                <option value="normal">Normální</option>
                <option value="high">Vysoká</option>
              </select>
            </FormField>
          </div>
          <FormField label="Zodpovědný" error={fe.assignee_id}>
            <select name="assignee_id" defaultValue={assignee}>
              <option value="">— nikdo —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Klient (volitelně)" error={fe.account_id}>
            <AccountPicker name="account_id" placeholder="Název nebo IČO…" />
          </FormField>
          {showDeals && (
            <FormField label="Obchod (volitelně)" error={fe.deal_id}>
              <select name="deal_id" defaultValue="">
                <option value="">— bez obchodu —</option>
                {deals.map((deal) => (
                  <option key={deal.id} value={deal.id}>{deal.account?.name ? `${deal.account.name} · ` : ''}{deal.title}</option>
                ))}
              </select>
            </FormField>
          )}
          <FormField label="Popis" error={fe.description}>
            <textarea name="description" rows={2} />
          </FormField>
        </div>
      </details>
    </form>
  )
}
