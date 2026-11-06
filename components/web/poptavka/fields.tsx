import type { ReactNode } from 'react'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'

/**
 * Formulářové prvky průvodce poptávkou. Bez stavu (hodnoty a onChange
 * dodává InquiryWizard). Vzhled podle design systému: bílé pole, jemný
 * rámeček, malinový focus; chyba = text v barvě danger + aria-invalid.
 */
export const FIELD_CLASS =
  'block min-h-12 w-full rounded-soft bg-paper px-4 font-copy text-copy text-cocoa ring-2 ring-inset ring-cocoa ' +
  'transition-shadow duration-quick ease-md-out placeholder:text-cocoa-soft hover:bg-cream focus:outline-none focus:ring-[3px] focus:ring-daddy-ink ' +
  'aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger'

export const LABEL_CLASS = 'mb-2 block font-copy text-small font-bold text-cocoa'

const hintId = (id: string) => `${id}-napoveda`
const errorId = (id: string) => `${id}-chyba`

/** aria-describedby z nápovědy a chyby (jen existující). */
export function describedBy(id: string, hint?: ReactNode, error?: string | null): string | undefined {
  const out = [hint ? hintId(id) : null, error ? errorId(id) : null].filter(Boolean)
  return out.length ? out.join(' ') : undefined
}

/** Hvězdička povinného pole (čtečka ji přečte jako „povinné“ z atributu required). */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-raspberry-ink">
      *
    </span>
  )
}

export function FieldHint({ id, hint }: { id: string; hint?: ReactNode }) {
  if (!hint) return null
  return (
    <p id={hintId(id)} className="mt-2 font-copy text-small text-cocoa-soft">
      {typeof hint === 'string' ? <PlaceholderText text={hint} /> : hint}
    </p>
  )
}

export function FieldError({ id, error }: { id: string; error?: string | null }) {
  if (!error) return null
  return (
    <p id={errorId(id)} className="mt-2 font-copy text-small font-bold text-danger">
      {error}
    </p>
  )
}

/** Popisek + pole + nápověda + chyba. `children` je samotné <input>/<textarea>. */
export function Field({
  id,
  label,
  required,
  hint,
  error,
  className,
  children,
}: {
  id: string
  label: ReactNode
  required?: boolean
  hint?: ReactNode
  error?: string | null
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
        {required ? <RequiredMark /> : null}
      </label>
      {children}
      <FieldHint id={id} hint={hint} />
      <FieldError id={id} error={error} />
    </div>
  )
}

export interface ChoiceOption {
  value: string
  label: string
  /** Drobný doplněk pod popiskem (např. „od 15 osob“). */
  meta?: string | null
}

/**
 * Skupina voleb jako dlaždice (radio = jedna volba, checkbox = víc voleb)
 * s legendou. Celá dlaždice je klikací (label), fokus a stav jsou vidět.
 */
export function ChoiceGroup({
  id,
  name,
  legend,
  type,
  options,
  value,
  onChange,
  required,
  hint,
  error,
  columns = 2,
  legendClassName,
  className,
}: {
  id: string
  name: string
  legend: ReactNode
  type: 'radio' | 'checkbox'
  options: readonly ChoiceOption[]
  /** radio: vybraná hodnota (nebo null); checkbox: pole vybraných hodnot. */
  value: string | null | readonly string[]
  onChange: (value: string) => void
  required?: boolean
  hint?: ReactNode
  error?: string | null
  columns?: 1 | 2 | 3
  legendClassName?: string
  className?: string
}) {
  const isChecked = (v: string) => (Array.isArray(value) ? value.includes(v) : value === v)
  return (
    <fieldset
      id={id}
      tabIndex={-1}
      aria-describedby={describedBy(id, hint, error)}
      aria-invalid={error ? true : undefined}
      aria-required={type === 'radio' && required ? true : undefined}
      className={cx('min-w-0 outline-none', className)}
    >
      <legend className={cx(LABEL_CLASS, 'mb-3', legendClassName)}>
        {legend}
        {required ? <RequiredMark /> : null}
      </legend>
      <div className={cx('grid gap-2.5', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3')}>
        {options.map((o) => {
          const inputId = `${id}-${o.value}`
          return (
            <label
              key={o.value}
              htmlFor={inputId}
              className={cx(
                'relative flex min-h-12 cursor-pointer items-start gap-3 rounded-soft bg-paper px-4 py-3 ring-2 ring-inset ring-cocoa',
                'transition-[box-shadow,background-color] duration-quick ease-md-out hover:bg-cream',
                'has-[:checked]:bg-blush-soft has-[:checked]:bg-raspberry-tint has-[:checked]:shadow-hard-sm has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-daddy-ink',
                error && 'ring-danger/60',
              )}
            >
              <input
                id={inputId}
                type={type}
                name={name}
                value={o.value}
                checked={isChecked(o.value)}
                onChange={() => onChange(o.value)}
                className="mt-1 h-4 w-4 shrink-0 accent-raspberry-ink"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-copy text-copy font-bold leading-snug text-cocoa">{o.label}</span>
                {o.meta ? <span className="mt-0.5 font-copy text-small text-cocoa-soft">{o.meta}</span> : null}
              </span>
            </label>
          )
        })}
      </div>
      <FieldHint id={id} hint={hint} />
      <FieldError id={id} error={error} />
    </fieldset>
  )
}

/** Jedno zaškrtávátko (Hledám prostor, souhlas). */
export function Checkbox({
  id,
  name,
  checked,
  onChange,
  required,
  error,
  children,
}: {
  id: string
  name: string
  checked: boolean
  onChange: (checked: boolean) => void
  required?: boolean
  error?: string | null
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <input
          id={id}
          name={name}
          type="checkbox"
          checked={checked}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, null, error)}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 accent-raspberry-ink"
        />
        <label htmlFor={id} className="font-copy text-copy text-cocoa">
          {children}
          {required ? <RequiredMark /> : null}
        </label>
      </div>
      <FieldError id={id} error={error} />
    </div>
  )
}
