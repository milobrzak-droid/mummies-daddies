'use client'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { findAccountOptions } from '@/domain/crm/actions/accountPicker'

export type AccountOption = { id: number; name: string }

const DEBOUNCE_MS = 200

// Výběr firmy s hledáním na serveru. Po importu radaru (~663 firem) nahrazuje
// <select> s celým seznamem ve formulářích (úkol, aktivita, případ, schůzka,
// cílový seznam, vztah firem, nový obchod). Do formuláře jde skryté pole
// `name` s id firmy — server akce se nemění.
//
// Přístupnost: vzor WAI-ARIA combobox (role=combobox + listbox,
// aria-activedescendant), šipky/Enter/Escape, výsledek hledání hlásí
// aria-live. Text, který neodpovídá vybrané firmě, formulář neodešle
// (setCustomValidity) — ať se úkol tiše neuloží „bez klienta", když člověk
// napsal název a nevybral ho ze seznamu.
export function AccountPicker({
  name = 'account_id',
  initial = null,
  required = false,
  placeholder = 'Začni psát název nebo IČO…',
  excludeId = null,
  onChange,
  keepOnReset = false,
}: {
  name?: string
  initial?: AccountOption | null
  required?: boolean
  placeholder?: string
  /** firma, která se nenabízí (vztah firmy sama se sebou) */
  excludeId?: number | null
  onChange?: (option: AccountOption | null) => void
  /** po resetu formuláře nechat vybranou firmu (rychlý zápis dalších aktivit) */
  keepOnReset?: boolean
}) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const [selected, setSelected] = useState<AccountOption | null>(initial)
  const [text, setText] = useState(initial?.name ?? '')
  const [options, setOptions] = useState<AccountOption[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  // Nepotvrzený text = neplatné pole (hlášku ukáže prohlížeč při odeslání).
  useEffect(() => {
    inputRef.current?.setCustomValidity(
      text.trim() && !selected ? 'Vyber firmu ze seznamu, nebo pole vymaž.' : '',
    )
  }, [text, selected])

  // form.reset() po úspěšném odeslání: vrátit výchozí firmu (nebo nechat).
  const initialRef = useRef(initial)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => {
    const form = inputRef.current?.form
    if (!form) return
    const onReset = () => {
      seq.current += 1
      if (timer.current) clearTimeout(timer.current)
      setOptions([])
      setOpen(false)
      setStatus('idle')
      if (keepOnReset) return
      const init = initialRef.current
      setSelected(init)
      setText(init?.name ?? '')
      onChangeRef.current?.(init)
    }
    form.addEventListener('reset', onReset)
    return () => form.removeEventListener('reset', onReset)
  }, [keepOnReset])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function search(value: string) {
    if (timer.current) clearTimeout(timer.current)
    const q = value.trim()
    const mine = ++seq.current
    if (!q) {
      setOptions([])
      setStatus('idle')
      setOpen(false)
      return
    }
    setStatus('loading')
    setOpen(true)
    timer.current = setTimeout(async () => {
      let res: Awaited<ReturnType<typeof findAccountOptions>>
      try {
        res = await findAccountOptions(q, excludeId)
      } catch {
        res = { ok: false, error: 'Hledání selhalo — zkus to prosím znovu.' }
      }
      if (mine !== seq.current) return // mezitím přišel novější dotaz
      if (res.ok) {
        setOptions(res.options)
        setActive(res.options.length > 0 ? 0 : -1)
        setStatus('done')
        setError(null)
      } else {
        setOptions([])
        setActive(-1)
        setStatus('error')
        setError(res.error)
      }
    }, DEBOUNCE_MS)
  }

  function choose(option: AccountOption) {
    seq.current += 1
    setSelected(option)
    setText(option.name)
    setOpen(false)
    setOptions([])
    setStatus('idle')
    onChange?.(option)
  }

  function clear() {
    seq.current += 1
    setSelected(null)
    setText('')
    setOptions([])
    setOpen(false)
    setStatus('idle')
    onChange?.(null)
    inputRef.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open && options.length > 0) setOpen(true)
      else if (options.length > 0) setActive((i) => (i + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (options.length > 0) setActive((i) => (i <= 0 ? options.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      // Enter v otevřeném seznamu vybírá, formulář neodesílá.
      if (open && active >= 0 && options[active]) {
        e.preventDefault()
        choose(options[active])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
      }
    }
  }

  const liveMessage = status === 'loading'
    ? 'Hledám…'
    : status === 'error'
      ? (error ?? 'Hledání selhalo.')
      : status === 'done'
        ? (options.length === 0 ? 'Nic nenalezeno.' : `Nalezeno: ${options.length}. Vyber šipkami a firmou.`)
        : ''

  return (
    <div className="relative">
      <input type="hidden" name={name} value={selected ? String(selected.id) : ''} />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 && options[active] ? `${listId}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        required={required}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          const value = e.target.value
          setText(value)
          if (selected) {
            setSelected(null)
            onChange?.(null)
          }
          search(value)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => { if (!selected && options.length > 0) setOpen(true) }}
        onBlur={() => setOpen(false)}
        className={selected ? 'pr-9' : undefined}
      />
      {selected && (
        <button
          type="button"
          onClick={clear}
          aria-label={`Zrušit výběr firmy ${selected.name}`}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full text-muted hover:text-ink hover:bg-[color:var(--c-soft)]"
        >
          ×
        </button>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label="Nalezené firmy"
        hidden={!open}
        className="absolute left-0 right-0 z-20 mt-1.5 max-h-64 overflow-auto rounded-[16px] border border-border bg-surface p-1.5 shadow-card-hover list-none"
      >
        {options.map((o, i) => (
          <li
            key={o.id}
            id={`${listId}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            // mousedown by jinak vzal inputu fokus dřív, než proběhne click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(o)}
            onMouseEnter={() => setActive(i)}
            className={`cursor-pointer rounded-[10px] px-3 py-2.5 text-sm text-ink ${i === active ? 'bg-[color:var(--c-soft)]' : ''}`}
          >
            {o.name}
          </li>
        ))}
        {status !== 'done' || options.length === 0 ? (
          <li role="presentation" className="px-3 py-2 text-sm text-muted">
            {liveMessage || 'Začni psát název nebo IČO.'}
          </li>
        ) : null}
      </ul>
      <span className="sr-only" aria-live="polite">{liveMessage}</span>
    </div>
  )
}
