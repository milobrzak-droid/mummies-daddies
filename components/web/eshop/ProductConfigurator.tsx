'use client'

import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { addItem, setDate, updateCart, getCartSnapshot } from '@/lib/web/eshop/cart'
import { allowsInscription, fill, flavorCounts, flavorsFromCounts, isMini } from '@/lib/web/eshop/catalog'
import type { ConfiguratorLabels } from '@/lib/web/eshop/types'
import { formatDate } from '@/lib/web/format'
import { INSCRIPTION_MAX, MINI_PIECES, type CheesecakeSlug, type MiniFlavor } from '@/lib/web/options'
import { earliestOrderDate } from '@/lib/web/validation'
import { Button } from '../Button'
import { IconBag } from '../icons'
import { PriceTag } from '../PriceTag'
import { cx } from '../cx'
import { FIELD_CLASS, Field, describedBy } from './fields'
import { MiniFlavorPicker } from './MiniFlavorPicker'
import { Stepper } from './Stepper'

type Errors = Partial<Record<'inscription' | 'flavors' | 'date', string>>

/**
 * Konfigurátor na detailu cheesecaku: počet kusů, nápis (jen Daddy vanilkový,
 * max. 25 znaků s počítadlem), 10 příchutí (jen mini) a preferovaný termín
 * (nejdřív earliestOrderDate – zítřek, dokud klient nedodá objednací lhůtu).
 * „Přidat do košíku“ uloží položku do localStorage a ukáže potvrzení s odkazy.
 * Velikost/průměr se nevybírá: klient ji zatím nedodal (parametry = [DOPLNÍ KLIENT]).
 */
export function ProductConfigurator({
  slug,
  price,
  labels,
  className,
}: {
  slug: CheesecakeSlug
  price: number
  labels: ConfiguratorLabels
  className?: string
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const id = (k: string) => `konfigurator-${uid}-${k}`
  const mini = isMini(slug)
  const withInscription = allowsInscription(slug)

  const [quantity, setQuantity] = useState(1)
  const [inscription, setInscription] = useState('')
  const [counts, setCounts] = useState<Record<MiniFlavor, number>>(() => flavorCounts([]))
  const [date, setDateValue] = useState('')
  const [earliest, setEarliest] = useState<string | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [added, setAdded] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)

  // Datum počítáme až v prohlížeči (stránka je předrenderovaná při buildu).
  useEffect(() => {
    setEarliest(earliestOrderDate())
    const saved = getCartSnapshot().date
    if (saved) setDateValue(saved)
  }, [])

  const flavorsTotal = Object.values(counts).reduce((a, b) => a + b, 0)

  function validate(): Errors {
    const e: Errors = {}
    if (withInscription && inscription.length > INSCRIPTION_MAX) e.inscription = labels.inscriptionError
    if (mini && flavorsTotal !== MINI_PIECES) e.flavors = labels.flavorsError
    const min = earliest ?? earliestOrderDate()
    if (date && date < min) e.date = fill(labels.dateError, { datum: formatDate(min) })
    return e
  }

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault()
    const e = validate()
    setErrors(e)
    if (Object.keys(e).length) {
      setAdded(false)
      const first = e.inscription ? id('napis') : e.flavors ? id('prichute') : id('termin')
      document.getElementById(first)?.focus()
      return
    }
    updateCart((s) => {
      const next = addItem(s, {
        slug,
        quantity,
        inscription: withInscription && inscription.trim() ? inscription.trim() : null,
        miniFlavors: mini ? flavorsFromCounts(counts) : null,
      })
      return date ? setDate(next, date) : next
    })
    setAdded(true)
    setQuantity(1)
    requestAnimationFrame(() => statusRef.current?.focus())
  }

  return (
    <form noValidate onSubmit={onSubmit} className={cx('grid gap-6', className)} aria-label={labels.add}>
      {withInscription ? (
        <Field
          id={id('napis')}
          label={labels.inscription}
          hint={fill(labels.inscriptionCounter, { n: inscription.length })}
          error={errors.inscription}
        >
          <input
            id={id('napis')}
            name="napis"
            type="text"
            maxLength={INSCRIPTION_MAX}
            autoComplete="off"
            value={inscription}
            aria-describedby={describedBy(id('napis'), true, errors.inscription)}
            aria-invalid={errors.inscription ? true : undefined}
            onChange={(e) => {
              setInscription(e.currentTarget.value.slice(0, INSCRIPTION_MAX))
              setAdded(false)
            }}
            className={FIELD_CLASS}
          />
        </Field>
      ) : null}

      {mini ? (
        <MiniFlavorPicker
          id={id('prichute')}
          legend={labels.optionsHeading ?? ''}
          hint={labels.optionsBody}
          flavors={labels.flavors}
          counts={counts}
          onChange={(c) => {
            setCounts(c)
            setAdded(false)
            if (errors.flavors) setErrors((e) => ({ ...e, flavors: undefined }))
          }}
          remainingTemplate={labels.flavorsRemaining}
          error={errors.flavors}
        />
      ) : null}

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor={id('pocet')} className="mb-2 block font-copy text-small font-semibold text-cocoa">
            {labels.quantity}
          </label>
          <Stepper id={id('pocet')} name="pocet" value={quantity} onChange={(n) => { setQuantity(n); setAdded(false) }} />
        </div>
        <Field id={id('termin')} label={labels.date} error={errors.date}>
          <input
            id={id('termin')}
            name="termin"
            type="date"
            min={earliest ?? undefined}
            value={date}
            aria-describedby={describedBy(id('termin'), null, errors.date)}
            aria-invalid={errors.date ? true : undefined}
            onChange={(e) => {
              setDateValue(e.currentTarget.value)
              if (errors.date) setErrors((x) => ({ ...x, date: undefined }))
            }}
            className={FIELD_CLASS}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-4 border-t border-hairline pt-6 sm:flex-row sm:items-center sm:justify-between">
        <PriceTag size="lg" amount={price * quantity} />
        <Button type="submit" variant="primary" size="lg" icon={<IconBag size={20} />}>
          {labels.add}
        </Button>
      </div>

      <div ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="outline-none">
        {added ? (
          <div className="rounded-soft bg-pistachio-soft p-5 ring-1 ring-inset ring-cocoa/10 motion-safe:animate-fade">
            <p className="font-copy text-copy font-semibold text-cocoa">{labels.added}</p>
            <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
              <Button href={labels.goToCart.href} variant="primary" size="md" arrow>
                {labels.goToCart.label}
              </Button>
              <Button href={labels.continueShopping.href} variant="ghost" size="md">
                {labels.continueShopping.label}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </form>
  )
}

