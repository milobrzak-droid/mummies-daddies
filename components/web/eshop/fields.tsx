import type { ReactNode } from 'react'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'

/**
 * Formulářové prvky e-shopu (košík, konfigurátor, poukaz). Bez stavu → použitelné
 * v serverových i klientských komponentách. Vzhled jako rychlý start na úvodu:
 * bílé pole, jemný rámeček, malinový focus. Chyba = text v barvě danger + aria-invalid.
 */
export const FIELD_CLASS =
  'block min-h-12 w-full rounded-soft bg-paper px-4 font-copy text-copy text-cocoa ring-2 ring-inset ring-cocoa ' +
  'transition-shadow duration-quick ease-md-out placeholder:text-cocoa-soft hover:bg-cream focus:outline-none focus:ring-[3px] focus:ring-daddy-ink ' +
  'aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger'

export const LABEL_CLASS = 'mb-2 block font-copy text-small font-bold text-cocoa'

export const CHOICE_CLASS =
  'relative flex min-h-12 cursor-pointer items-start gap-3 rounded-soft bg-paper px-4 py-3 ring-2 ring-inset ring-cocoa ' +
  'transition-shadow duration-quick ease-md-out hover:bg-cream has-[:checked]:bg-raspberry-tint has-[:checked]:shadow-hard-sm has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-daddy-ink'

export const RADIO_CLASS = 'mt-1 h-4 w-4 shrink-0 accent-raspberry-ink'

export function fieldIds(id: string) {
  return { hint: `${id}-napoveda`, error: `${id}-chyba` }
}

/** aria-describedby z nápovědy a chyby (jen existující). */
export function describedBy(id: string, hint?: ReactNode, error?: string | null): string | undefined {
  const ids = fieldIds(id)
  const out = [hint ? ids.hint : null, error ? ids.error : null].filter(Boolean)
  return out.length ? out.join(' ') : undefined
}

export function FieldError({ id, error }: { id: string; error?: string | null }) {
  if (!error) return null
  return (
    <p id={fieldIds(id).error} className="mt-2 font-copy text-small font-bold text-danger">
      <PlaceholderText text={error} />
    </p>
  )
}

export function FieldHint({ id, hint }: { id: string; hint?: ReactNode }) {
  if (!hint) return null
  return (
    <p id={fieldIds(id).hint} className="mt-2 font-copy text-small text-cocoa-soft">
      {typeof hint === 'string' ? <PlaceholderText text={hint} /> : hint}
    </p>
  )
}

/** Popisek + pole + nápověda + chyba. `children` je samotné <input>/<select>/<textarea>. */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  id: string
  label: ReactNode
  /** Povinné pole: hvězdička za popiskem (stejný vzor jako poptávka). */
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
        {required ? (
          <span aria-hidden="true" className="ml-0.5 text-raspberry-ink">
            *
          </span>
        ) : null}
      </label>
      {children}
      <FieldHint id={id} hint={hint} />
      <FieldError id={id} error={error} />
    </div>
  )
}

/** Skupina voleb (radio/checkbox) s legendou. */
export function ChoiceGroup({
  id,
  legend,
  hint,
  error,
  className,
  children,
}: {
  id: string
  legend: ReactNode
  hint?: ReactNode
  error?: string | null
  className?: string
  children: ReactNode
}) {
  return (
    <fieldset
      id={id}
      tabIndex={-1}
      aria-describedby={describedBy(id, hint, error)}
      aria-invalid={error ? true : undefined}
      className={cx('min-w-0 outline-none', className)}
    >
      <legend className={cx(LABEL_CLASS, 'mb-3')}>{legend}</legend>
      {children}
      <FieldHint id={id} hint={hint} />
      <FieldError id={id} error={error} />
    </fieldset>
  )
}

/** Malý nadpis kroku formuláře (h2) s textem z copy. */
export function StepHeading({ id, number, title, body }: { id: string; number?: number; title: string; body?: string | null }) {
  return (
    <div className="mb-6">
      <h2 id={id} className="md-caps flex items-baseline gap-3 text-h3 text-cocoa">
        {number ? (
          <span aria-hidden="true" className="font-display text-[0.9em] italic normal-case tracking-normal text-cocoa-soft">
            {number}.
          </span>
        ) : null}
        <span>{title}</span>
      </h2>
      {body ? (
        <p className="md-pretty mt-3 text-copy text-cocoa-soft">
          <PlaceholderText text={body} />
        </p>
      ) : null}
    </div>
  )
}
