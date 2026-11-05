'use client'
import { useState, type Ref } from 'react'
import { LOST_REASONS, formatLostReason, parseLostReason, type LostReasonOption } from '@/domain/crm/lostReason'

// Výběr důvodu prohry (P5): kód z COMPANY.lostReasons + volitelná poznámka.
// Hodnota je jeden text „kod: poznámka" (deal.lost_reason, bez změny
// schématu) — ve formuláři jde jako skryté pole `name`, v dialogu přes
// onChange. Bez nastavených důvodů zůstane jen volný text jako dřív.
// Důvod „Jiné" (nebo volný text) poznámku vyžaduje.

export function lostReasonComplete(value: string, reasons: readonly LostReasonOption[] = LOST_REASONS): boolean {
  if (reasons.length === 0) return value.trim() !== ''
  const p = parseLostReason(value, reasons)
  if (!p.key) return false
  return p.key !== 'jine' || p.note !== ''
}

export function LostReasonSelect({
  value, onChange, name, reasons = LOST_REASONS, selectRef, label = 'Důvod prohry', invalid,
}: {
  value: string
  onChange: (value: string) => void
  /** Název skrytého pole ve formuláři (např. 'lost_reason'); bez něj jen onChange. */
  name?: string
  reasons?: readonly LostReasonOption[]
  /** Fokus při otevření dialogu. */
  selectRef?: Ref<HTMLSelectElement & HTMLInputElement>
  label?: string
  invalid?: boolean
}) {
  const parsed = parseLostReason(value, reasons)
  // Starý volný text bez kódu se nezahodí: zůstane v poznámce, kód se vybere znovu.
  const [note, setNote] = useState(parsed.note)
  const key = parsed.key ?? ''

  if (reasons.length === 0) {
    return (
      <>
        <input
          ref={selectRef}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Co se tým může z tohoto obchodu naučit?"
          aria-invalid={invalid || undefined}
          required
        />
        {name && <input type="hidden" name={name} value={value} />}
      </>
    )
  }

  const noteRequired = key === 'jine'
  return (
    <div className="grid gap-2">
      <select
        ref={selectRef}
        aria-label={label}
        value={key}
        onChange={(e) => onChange(formatLostReason(e.target.value, note, reasons))}
        aria-invalid={invalid || undefined}
        required
      >
        <option value="">— vyber důvod —</option>
        {reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
      <input
        aria-label={`${label} – poznámka`}
        value={note}
        onChange={(e) => { setNote(e.target.value); onChange(key ? formatLostReason(key, e.target.value, reasons) : e.target.value) }}
        placeholder={noteRequired ? 'Napiš, co se stalo (povinné u „Jiné")' : 'Poznámka (nepovinné): co se tým může naučit?'}
        required={noteRequired}
        maxLength={300}
      />
      {name && <input type="hidden" name={name} value={key ? value : ''} />}
    </div>
  )
}
