'use client'

import { useActionState, useMemo, useRef, useState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { buttonClass } from '@/components/ui/Button'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { AccountPicker, type AccountOption } from '@/components/AccountPicker'
import { findContactOptionsForAccount } from '@/domain/crm/actions/accountPicker'
import type { ActionResult } from '@/lib/actionResult'
import type { SalesActivityKind } from '@/lib/types'

// Formulář potřebuje z kontaktu jen tohle — Contact (celý řádek) vyhoví.
type ContactOption = { id: number; full_name: string; account_id: number | null; partner_id: number | null }

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

// Lineární ikony 24 × 24 (docs/PROVOZ.md §7), žádné znaky ani emoji.
const KIND_ICON: Record<string, string> = {
  call: 'M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  email: 'M4 6h16v12H4zM4 7l8 6 8-6',
  meeting: 'M8 3v3M16 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  note: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
}

const ACTIVITY_KINDS: { value: SalesActivityKind; label: string }[] = [
  { value: 'call', label: 'Telefonát' },
  { value: 'email', label: 'E-mail' },
  { value: 'meeting', label: 'Schůzka' },
  { value: 'note', label: 'Poznámka' },
]

function KindIcon({ kind }: { kind: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="hidden shrink-0 sm:block">
      <path d={KIND_ICON[kind]} />
    </svg>
  )
}

const localDate = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const dateAfter = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return localDate(date)
}

const nowForInput = () => {
  const now = new Date()
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset())
  return now.toISOString().slice(0, 16)
}

/**
 * `partnerId` přepne formulář do partnerského režimu: místo výběru klienta
 * a obchodu se aktivita zapíše partnerovi. firma prodává přes BETA TRADE,
 * TAUPARTNER a DeltaHost — telefonát s kanálem, ke kterému nevznikl zápis schůzky, se
 * do CRM do teď nedal zapsat vůbec.
 *
 * Výběr klienta: s `accounts` (detail klienta — jedna firma) zůstává select.
 * Bez `accounts` (stránka /aktivity) se klient hledá (AccountPicker) a
 * kontakty zvolené firmy se dotáhnou ze serveru — `contacts` pak nese jen
 * kontakty předvybrané firmy (`initialAccount`). Dřív se na /aktivity
 * posílaly všechny firmy i všechny kontakty.
 */
export function ActivityForm({
  action, accounts, deals, contacts, initialAccountId, initialAccount, initialDealId, partnerId,
}: {
  action: Action
  accounts?: { id: number; name: string }[]
  deals: { id: number; account_id: number; title: string }[]
  contacts: ContactOption[]
  initialAccountId?: number
  initialAccount?: AccountOption | null
  initialDealId?: number
  partnerId?: number
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const pickerMode = accounts === undefined && partnerId == null
  const startAccount = String(initialAccountId ?? initialAccount?.id ?? accounts?.[0]?.id ?? '')
  const [accountId, setAccountId] = useState(startAccount)
  const [contactPool, setContactPool] = useState<ContactOption[]>(contacts)
  const contactRequest = useRef(0)
  const [dealId, setDealId] = useState(String(initialDealId ?? ''))
  const [kind, setKind] = useState<SalesActivityKind>('call')
  const [followUp, setFollowUp] = useState('')
  const [occurredAt, setOccurredAt] = useState(nowForInput)
  const subjectRef = useRef<HTMLInputElement>(null)
  const [state, formAction] = useActionState(async (previous: unknown, formData: FormData) => {
    const result = await action(previous, formData)
    if (result.success) {
      formRef.current?.reset()
      setKind('call')
      setFollowUp('')
      setOccurredAt(nowForInput())
      setDealId(String(initialDealId ?? ''))
      requestAnimationFrame(() => subjectRef.current?.focus())
    }
    return result
  }, null)
  const accountDeals = useMemo(
    () => deals.filter((deal) => String(deal.account_id) === accountId),
    [deals, accountId],
  )
  // V partnerském režimu nabízíme kontakty partnera, ne klienta — jinak by
  // šlo k jednání s BETA TRADEem připnout člověka z úplně jiné firmy.
  const accountContacts = useMemo(
    () => (partnerId != null
      ? contacts.filter((contact) => contact.partner_id === partnerId)
      : (pickerMode ? contactPool : contacts).filter((contact) => String(contact.account_id) === accountId)),
    [contacts, contactPool, pickerMode, accountId, partnerId],
  )

  function onPickAccount(option: AccountOption | null) {
    setAccountId(option ? String(option.id) : '')
    setDealId('')
    const mine = ++contactRequest.current
    setContactPool([])
    if (!option) return
    findContactOptionsForAccount(option.id)
      .then((res) => {
        if (mine !== contactRequest.current) return
        setContactPool(res.ok ? res.options.map((c) => ({ ...c, account_id: option.id, partner_id: null })) : [])
      })
      .catch(() => { /* bez kontaktů jde aktivita uložit i tak */ })
  }

  const errors = state?.fieldErrors ?? {}
  const placeholder = kind === 'call'
    ? 'Např. klient chce demo pro vedení'
    : kind === 'email'
      ? 'Např. odeslána upravená nabídka'
      : kind === 'meeting'
        ? 'Např. potvrzen rozpočet a rozhodovatel'
        : 'Co je důležité vědět?'

  return (
    <form
      ref={formRef}
      action={formAction}
      className={`${CARD} ${CARD_PAD}`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault()
          formRef.current?.requestSubmit()
        }
      }}
    >
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="m-0 font-heading text-title2 font-bold">Rychlý zápis</h2>
          <p className="m-0 mt-0.5 text-callout text-muted">Minimum polí. Detaily přidej, jen když dávají smysl.</p>
        </div>
        <kbd className="hidden rounded-xs bg-[color:var(--c-soft)] px-2 py-1 font-mono text-[11px] text-muted sm:inline">⌘ Enter</kbd>
      </div>

      {state?.error && <p role="alert" className="mb-4 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-callout text-neg">{state.error}</p>}
      {state?.success && <p role="status" className="mb-4 rounded-btn bg-[color:var(--c-pos-soft)] px-3 py-2 text-callout text-pos">Hotovo. Aktivita je v historii.</p>}

      <div className="mb-4 grid grid-cols-4 gap-0.5 rounded-full bg-[rgba(23,32,46,.06)] p-[3px]" role="radiogroup" aria-label="Typ aktivity">
        {ACTIVITY_KINDS.map((item) => (
          <label key={item.value} className="cursor-pointer">
            <input
              className="peer sr-only"
              type="radio"
              name="kind"
              value={item.value}
              checked={kind === item.value}
              onChange={() => setKind(item.value)}
            />
            <span className={`flex min-h-11 items-center justify-center gap-1.5 rounded-full px-1.5 text-[12.5px] font-semibold transition-colors duration-fast peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-[color:var(--focus-ring)] sm:min-h-[38px] ${kind === item.value ? 'bg-surface text-ink shadow-e1' : 'text-[color:#39414D] hover:text-ink'}`}>
              <KindIcon kind={item.value} />{item.label}
            </span>
          </label>
        ))}
      </div>

      {partnerId != null ? (
        <input type="hidden" name="partner_id" value={partnerId} />
      ) : (
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Klient" error={errors.account_id}>
          {pickerMode ? (
            <AccountPicker name="account_id" initial={initialAccount ?? null} required keepOnReset onChange={onPickAccount} />
          ) : (
            <select
              name="account_id"
              value={accountId}
              onChange={(event) => { setAccountId(event.target.value); setDealId('') }}
              required
            >
              <option value="">— vyber klienta —</option>
              {(accounts ?? []).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          )}
        </FormField>
        <FormField label="Obchod (volitelné)" error={errors.deal_id}>
          <select name="deal_id" value={dealId} onChange={(event) => setDealId(event.target.value)}>
            <option value="">— obecně ke klientovi —</option>
            {accountDeals.map((deal) => <option key={deal.id} value={deal.id}>{deal.title}</option>)}
          </select>
        </FormField>
      </div>
      )}

      <div className="mt-3">
        <FormField label="Co se stalo / co platí dál" error={errors.subject}>
          <input ref={subjectRef} name="subject" placeholder={placeholder} autoComplete="off" required />
        </FormField>
      </div>

      <fieldset className="mt-4">
        <legend className="mb-2 text-callout font-semibold text-[color:#39414D]">Kdy navázat (volitelně)</legend>
        <div className="flex flex-wrap items-center gap-2">
          {[{ label: 'Zítra', days: 1 }, { label: 'Za 3 dny', days: 3 }, { label: 'Za týden', days: 7 }].map((item) => {
            const value = dateAfter(item.days)
            return (
              <button
                key={item.days}
                type="button"
                onClick={() => setFollowUp(value)}
                aria-pressed={followUp === value}
                className={buttonClass(followUp === value ? 'secondary' : 'outline', 'sm')}
              >
                {item.label}
              </button>
            )
          })}
          <input
            aria-label="Vlastní datum navázání"
            name="follow_up_on"
            type="date"
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            className="!w-auto min-w-[150px]"
          />
          {followUp && <button type="button" onClick={() => setFollowUp('')} className={buttonClass('quiet', 'sm')}>Zrušit datum</button>}
        </div>
        {errors.follow_up_on && <span role="alert" className="mt-1 block text-callout text-neg">{errors.follow_up_on}</span>}
      </fieldset>

      <details className="group mt-4 border-t border-border pt-3">
        <summary className="flex min-h-[36px] cursor-pointer list-none items-center gap-1.5 rounded-btn text-callout font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-fast group-open:rotate-90"><path d="m9 6 6 6-6 6" /></svg>
          Přidat poznámku a detaily
        </summary>
        <div className="mt-4 space-y-3">
          <FormField label="Poznámka" error={errors.body}>
            <textarea name="body" rows={3} placeholder="Potřeby, námitky, rozhodovatelé nebo kontext pro tým…" />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Kontakt" error={errors.contact_id}>
              <select name="contact_id" defaultValue="">
                <option value="">—</option>
                {accountContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.full_name}</option>)}
              </select>
            </FormField>
            <FormField label="Výsledek" error={errors.outcome}>
              <select name="outcome" defaultValue="completed">
                <option value="completed">Dokončeno</option>
                <option value="no_answer">Bez odpovědi</option>
                <option value="follow_up">Navázat</option>
                <option value="cancelled">Zrušeno</option>
              </select>
            </FormField>
            <FormField label="Kdy" error={errors.occurred_at}>
              <input name="occurred_at" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required />
            </FormField>
          </div>
        </div>
      </details>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="m-0 max-w-sm text-footnote text-muted">
          {dealId && followUp ? 'Datum navázání se zároveň uloží jako další krok obchodu.' : 'Vyber obchod a datum navázání, pokud se má posunout i další krok obchodu.'}
        </p>
        <SubmitButton>Uložit aktivitu</SubmitButton>
      </div>
    </form>
  )
}
