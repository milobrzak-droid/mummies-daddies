'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { submitOrder, type CheesecakeOrder, type FieldErrors, type OrderField, type SubmitOrderResult } from '@/lib/web/api'
import { clearCart, removeLine, setDate, toOrderItems, updateCart, updateLine, type CartLine } from '@/lib/web/eshop/cart'
import { fill, flavorCounts, isMini, allowsInscription } from '@/lib/web/eshop/catalog'
import type { CartLabels, ProductSummary } from '@/lib/web/eshop/types'
import { formatCzk, formatDate, formatNumber } from '@/lib/web/format'
import { hasClientPlaceholder } from '@/lib/web/placeholders'
import type { CheesecakeSlug, DeliveryMethod, PaymentMethod } from '@/lib/web/options'
import { INSCRIPTION_MAX } from '@/lib/web/options'
import { computeOrderTotals, earliestOrderDate, hasErrors, validateOrder } from '@/lib/web/validation'
import { Button } from '../Button'
import { IconArrowRight, IconClose } from '../icons'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { PriceTag } from '../PriceTag'
import { cx } from '../cx'
import { CHOICE_CLASS, ChoiceGroup, FIELD_CLASS, Field, RADIO_CLASS, StepHeading, describedBy } from './fields'
import { Stepper } from './Stepper'
import { useCart } from './useCart'

/**
 * Košík a objednávka (/kosik). Položky z localStorage → doručení a termín →
 * kontakt a fakturace → platba → souhlas a odeslání přes submitOrder (lib/web/api).
 * Validace na klientu = stejná pravidla jako „server“ (validateOrder), cenu
 * přepočítá mock. Po úspěchu se košík vyprázdní a ukáže potvrzení s číslem
 * objednávky (u převodu i platební údaje).
 */

const ID = {
  items: 'kosik-polozky',
  method: 'kosik-doruceni',
  address: 'kosik-adresa',
  date: 'kosik-termin',
  name: 'kosik-jmeno',
  email: 'kosik-email',
  phone: 'kosik-telefon',
  company: 'kosik-firma',
  companyName: 'kosik-firma-nazev',
  ico: 'kosik-ico',
  payment: 'kosik-platba',
  consent: 'kosik-souhlas',
} as const

/** Pořadí polí pro přesun fokusu na první chybu. */
const FIELD_ORDER: [OrderField | 'items.*', string][] = [
  ['items', ID.items],
  ['items.*', ID.items],
  ['fulfillment.method', ID.method],
  ['fulfillment.address', ID.address],
  ['fulfillment.date', ID.date],
  ['customer.name', ID.name],
  ['customer.email', ID.email],
  ['customer.phone', ID.phone],
  ['company.name', ID.companyName],
  ['company.ico', ID.ico],
  ['payment', ID.payment],
  ['consent', ID.consent],
]

function firstErrorId(errors: FieldErrors<OrderField>): string | null {
  const keys = Object.keys(errors)
  for (const [key, id] of FIELD_ORDER) {
    if (key === 'items.*' ? keys.some((k) => k.startsWith('items.')) : key in errors) return id
  }
  return null
}

type Success = Extract<SubmitOrderResult, { ok: true }> & { email: string }

export function CartView({ labels, products }: { labels: CartLabels; products: Record<CheesecakeSlug, ProductSummary> }) {
  const { cart, ready } = useCart()
  const [method, setMethod] = useState<DeliveryMethod | ''>('')
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [isCompany, setIsCompany] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [ico, setIco] = useState('')
  const [payment, setPayment] = useState<PaymentMethod | ''>('')
  const [consent, setConsent] = useState(false)
  const [errors, setErrors] = useState<FieldErrors<OrderField>>({})
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [success, setSuccess] = useState<Success | null>(null)
  const [earliest, setEarliest] = useState<string | null>(null)
  const doneRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => setEarliest(earliestOrderDate()), [])
  useEffect(() => {
    if (success) doneRef.current?.focus()
  }, [success])

  const items = toOrderItems(cart)
  const totals = computeOrderTotals(items, method || null)
  const err = (k: OrderField) => errors[k] ?? null
  const clearError = (...keys: OrderField[]) => {
    if (keys.some((k) => k in errors)) {
      setErrors((e) => {
        const next = { ...e }
        for (const k of keys) delete next[k]
        return next
      })
    }
  }

  function buildOrder(): CheesecakeOrder {
    return {
      items,
      fulfillment: {
        method: method as DeliveryMethod,
        address: method && method !== 'vyzvednuti' ? address.trim() || null : null,
        date: cart.date ?? '',
        note: null,
      },
      customer: { name: name.trim(), email: email.trim(), phone: phone.trim() },
      company: isCompany ? { name: companyName.trim(), ico: ico.replace(/\s/g, ''), dic: null } : null,
      payment: payment as PaymentMethod,
      note: null,
      consent,
    }
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault()
    if (sending) return
    setFailure(null)
    const order = buildOrder()
    const local = validateOrder(order)
    if (hasErrors(local)) {
      setErrors(local)
      const id = firstErrorId(local)
      if (id) document.getElementById(id)?.focus()
      return
    }
    setErrors({})
    setSending(true)
    try {
      const res = await submitOrder(order)
      if (res.ok) {
        clearCart()
        setSuccess({ ...res, email: order.customer.email })
      } else if (res.reason === 'validation') {
        setErrors(res.fieldErrors)
        const id = firstErrorId(res.fieldErrors)
        if (id) document.getElementById(id)?.focus()
      } else {
        setFailure(labels.offline)
      }
    } catch {
      setFailure(labels.offline)
    } finally {
      setSending(false)
    }
  }

  // ── potvrzení ──
  if (success) {
    return (
      <div className="mx-auto max-w-web-prose py-6 text-center motion-safe:animate-rise">
        <h1 ref={doneRef} tabIndex={-1} className="md-caps text-h1 text-cocoa outline-none">
          {labels.confirmationHeading}
        </h1>
        <p className="md-pretty mt-6 text-lead text-cocoa">
          {fill(labels.confirmationText, { číslo: success.orderNumber, 'e-mail': success.email, datum: formatDate(success.bakeDate) })}
        </p>
        {success.payment.method === 'prevod' ? (
          <p className="md-pretty mt-5 rounded-soft bg-vanilla p-5 text-copy text-cocoa">
            <PlaceholderText
              text={fill(labels.transferText, { částka: formatNumber(success.payment.amount), číslo: success.payment.variableSymbol })}
            />
          </p>
        ) : null}
        <dl className="mx-auto mt-8 grid max-w-sm gap-2 text-left font-copy text-copy text-cocoa">
          <SummaryRow label={labels.subtotal} value={formatCzk(success.subtotal)} />
          <SummaryRow label={labels.delivery} value={formatCzk(success.delivery)} />
          <SummaryRow label={labels.total} value={formatCzk(success.total)} strong />
        </dl>
        <p className="mt-10">
          <Link href={labels.upsell.href} className="md-link font-semibold">
            {labels.upsell.label}
          </Link>
        </p>
      </div>
    )
  }

  const header = (
    <div className="mb-10 max-w-3xl motion-safe:animate-lift sm:mb-12">
      <h1 id="kosik-title" className="md-caps text-h1 text-cocoa">
        {labels.heading}
      </h1>
      {ready && cart.lines.length ? <p className="md-pretty mt-5 text-lead text-cocoa-soft">{labels.lead}</p> : null}
    </div>
  )

  // ── načítání z localStorage ──
  if (!ready) {
    return (
      <div aria-busy="true">
        {header}
        <div className="h-48 rounded-soft bg-paper/60 ring-1 ring-inset ring-hairline motion-safe:animate-pulse" />
      </div>
    )
  }

  // ── prázdný košík ──
  if (!cart.lines.length) {
    return (
      <div>
        {header}
        <div className="flex flex-col items-start gap-6 rounded-soft bg-blush-soft p-6 sm:p-10">
          <p className="md-pretty text-lead text-cocoa">{labels.empty}</p>
          <Button href={labels.emptyCta.href} variant="primary" size="lg" arrow>
            {labels.emptyCta.label}
          </Button>
          <Link href={labels.upsell.href} className="md-link text-copy">
            {labels.upsell.label}
          </Link>
        </div>
      </div>
    )
  }

  const delivery = labels.deliveryOptions.find((d) => d.value === method)

  return (
    <div>
      {header}
      <form noValidate onSubmit={onSubmit} aria-labelledby="kosik-title" className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:gap-14">
        <div className="grid gap-10">
          {/* 1. Položky */}
          <section aria-label={labels.heading}>
            <div id={ID.items} tabIndex={-1} className="outline-none">
              <ul role="list" className="divide-y divide-hairline rounded-soft bg-paper px-4 ring-1 ring-inset ring-hairline sm:px-6">
                {cart.lines.map((line, i) => (
                  <CartLineRow
                    key={line.id}
                    index={i}
                    line={line}
                    product={products[line.slug]}
                    labels={labels}
                    errors={errors}
                    onChange={() => clearError('items', `items.${i}`, `items.${i}.inscription`, `items.${i}.miniFlavors`)}
                  />
                ))}
              </ul>
              {err('items') ? <p className="mt-3 font-copy text-small font-semibold text-danger">{err('items')}</p> : null}
            </div>
          </section>

          {/* 2. Doručení */}
          <section aria-labelledby="kosik-krok-doruceni" className="rounded-soft bg-sage-soft p-5 sm:p-8">
            <StepHeading id="kosik-krok-doruceni" number={1} title={labels.deliveryHeading} body={labels.deliveryBody} />
            <ChoiceGroup id={ID.method} legend={labels.deliveryLegend} error={err('fulfillment.method')}>
              <div className="grid gap-3 sm:grid-cols-2">
                {labels.deliveryOptions.map((d) => (
                  <label key={d.value} className={CHOICE_CLASS}>
                    <input
                      type="radio"
                      name="doruceni"
                      value={d.value}
                      checked={method === d.value}
                      onChange={() => {
                        setMethod(d.value)
                        clearError('fulfillment.method', 'fulfillment.address')
                      }}
                      className={RADIO_CLASS}
                    />
                    <span className="font-copy text-copy text-cocoa">
                      <span className="block font-semibold">{d.label}</span>
                      {d.note ? (
                        <span className="mt-1 block text-small text-cocoa-soft">
                          <PlaceholderText text={d.note} />
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </ChoiceGroup>
            <div className="mt-6 grid gap-6 sm:grid-cols-2">
              {method && method !== 'vyzvednuti' ? (
                <Field id={ID.address} label={labels.address} error={err('fulfillment.address')} className="sm:col-span-2">
                  <input
                    id={ID.address}
                    name="adresa"
                    type="text"
                    autoComplete="street-address"
                    value={address}
                    aria-describedby={describedBy(ID.address, null, err('fulfillment.address'))}
                    aria-invalid={err('fulfillment.address') ? true : undefined}
                    onChange={(e) => {
                      setAddress(e.currentTarget.value)
                      clearError('fulfillment.address')
                    }}
                    className={FIELD_CLASS}
                  />
                </Field>
              ) : null}
              <Field id={ID.date} label={labels.date} error={err('fulfillment.date')}>
                <input
                  id={ID.date}
                  name="termin"
                  type="date"
                  min={earliest ?? undefined}
                  value={cart.date ?? ''}
                  aria-describedby={describedBy(ID.date, null, err('fulfillment.date'))}
                  aria-invalid={err('fulfillment.date') ? true : undefined}
                  onChange={(e) => {
                    const v = e.currentTarget.value
                    updateCart((s) => setDate(s, v || null))
                    clearError('fulfillment.date')
                  }}
                  className={FIELD_CLASS}
                />
              </Field>
            </div>
          </section>

          {/* 3. Kontakt a fakturace */}
          <section aria-labelledby="kosik-krok-kontakt" className="rounded-soft bg-vanilla-soft p-5 sm:p-8">
            <StepHeading id="kosik-krok-kontakt" number={2} title={labels.contactHeading} body={labels.contactBody} />
            <div className="grid gap-6 sm:grid-cols-2">
              <Field id={ID.name} label={labels.name} error={err('customer.name')} className="sm:col-span-2">
                <input
                  id={ID.name}
                  name="jmeno"
                  type="text"
                  autoComplete="name"
                  value={name}
                  aria-describedby={describedBy(ID.name, null, err('customer.name'))}
                  aria-invalid={err('customer.name') ? true : undefined}
                  onChange={(e) => {
                    setName(e.currentTarget.value)
                    clearError('customer.name')
                  }}
                  className={FIELD_CLASS}
                />
              </Field>
              <Field id={ID.email} label={labels.email} error={err('customer.email')}>
                <input
                  id={ID.email}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  aria-describedby={describedBy(ID.email, null, err('customer.email'))}
                  aria-invalid={err('customer.email') ? true : undefined}
                  onChange={(e) => {
                    setEmail(e.currentTarget.value)
                    clearError('customer.email')
                  }}
                  className={FIELD_CLASS}
                />
              </Field>
              <Field id={ID.phone} label={labels.phone} hint={labels.phoneHint} error={err('customer.phone')}>
                <input
                  id={ID.phone}
                  name="telefon"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  aria-describedby={describedBy(ID.phone, labels.phoneHint, err('customer.phone'))}
                  aria-invalid={err('customer.phone') ? true : undefined}
                  onChange={(e) => {
                    setPhone(e.currentTarget.value)
                    clearError('customer.phone')
                  }}
                  className={FIELD_CLASS}
                />
              </Field>
              <div className="sm:col-span-2">
                <label htmlFor={ID.company} className="inline-flex min-h-11 cursor-pointer items-center gap-3 font-copy text-copy font-semibold text-cocoa">
                  <input
                    id={ID.company}
                    name="firma"
                    type="checkbox"
                    checked={isCompany}
                    onChange={(e) => {
                      setIsCompany(e.currentTarget.checked)
                      clearError('company.name', 'company.ico')
                    }}
                    className="h-5 w-5 shrink-0 accent-raspberry-ink"
                  />
                  {labels.company}
                </label>
              </div>
              {isCompany ? (
                <>
                  <Field id={ID.companyName} label={labels.companyName} error={err('company.name')}>
                    <input
                      id={ID.companyName}
                      name="firma-nazev"
                      type="text"
                      autoComplete="organization"
                      value={companyName}
                      aria-describedby={describedBy(ID.companyName, null, err('company.name'))}
                      aria-invalid={err('company.name') ? true : undefined}
                      onChange={(e) => {
                        setCompanyName(e.currentTarget.value)
                        clearError('company.name')
                      }}
                      className={FIELD_CLASS}
                    />
                  </Field>
                  <Field id={ID.ico} label={labels.ico} error={err('company.ico')}>
                    <input
                      id={ID.ico}
                      name="ico"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={10}
                      value={ico}
                      aria-describedby={describedBy(ID.ico, null, err('company.ico'))}
                      aria-invalid={err('company.ico') ? true : undefined}
                      onChange={(e) => {
                        setIco(e.currentTarget.value)
                        clearError('company.ico')
                      }}
                      className={FIELD_CLASS}
                    />
                  </Field>
                </>
              ) : null}
            </div>
          </section>

          {/* 4. Platba */}
          <section aria-labelledby="kosik-krok-platba" className="rounded-soft bg-blush-soft p-5 sm:p-8">
            <StepHeading id="kosik-krok-platba" number={3} title={labels.paymentHeading} body={labels.paymentBody} />
            <ChoiceGroup id={ID.payment} legend={labels.paymentLegend} error={err('payment')}>
              <div className="grid gap-3 sm:grid-cols-2">
                {labels.paymentOptions.map((p) => (
                  <label key={p.value} className={CHOICE_CLASS}>
                    <input
                      type="radio"
                      name="platba"
                      value={p.value}
                      checked={payment === p.value}
                      onChange={() => {
                        setPayment(p.value)
                        clearError('payment')
                      }}
                      className={RADIO_CLASS}
                    />
                    <span className="font-copy text-copy font-semibold text-cocoa">{p.label}</span>
                  </label>
                ))}
              </div>
            </ChoiceGroup>
          </section>
        </div>

        {/* Shrnutí, souhlas, odeslání */}
        <aside aria-labelledby="kosik-krok-souhlas" className="lg:sticky lg:top-[calc(theme(spacing.header)+1.5rem)] lg:self-start">
          <div className="rounded-soft bg-paper p-5 shadow-float ring-1 ring-inset ring-hairline sm:p-7">
            <dl className="grid gap-2 font-copy text-copy text-cocoa">
              <SummaryRow label={labels.subtotal} value={formatCzk(totals.subtotal)} />
              <SummaryRow label={labels.delivery} value={delivery ? formatCzk(delivery.price) : '—'} />
              <div className="mt-2 border-t border-hairline pt-3">
                <SummaryRow label={labels.total} value={formatCzk(totals.total)} strong />
              </div>
            </dl>

            <div className="mt-6 border-t border-hairline pt-6">
              <h2 id="kosik-krok-souhlas" className="md-caps text-h3 text-cocoa">
                {labels.consentHeading}
              </h2>
              <p className="md-pretty mt-3 text-small text-cocoa-soft">{labels.consentBody}</p>
              <div className="mt-4">
                <label htmlFor={ID.consent} className="flex cursor-pointer items-start gap-3 font-copy text-small text-cocoa">
                  <input
                    id={ID.consent}
                    name="souhlas"
                    type="checkbox"
                    checked={consent}
                    aria-describedby={describedBy(ID.consent, null, err('consent'))}
                    aria-invalid={err('consent') ? true : undefined}
                    onChange={(e) => {
                      setConsent(e.currentTarget.checked)
                      clearError('consent')
                    }}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-raspberry-ink"
                  />
                  <span>{labels.consent}</span>
                </label>
                {err('consent') ? (
                  <p id={`${ID.consent}-chyba`} className="mt-2 font-copy text-small font-semibold text-danger">
                    {err('consent')}
                  </p>
                ) : null}
                {labels.legal.length ? (
                  <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-small">
                    {labels.legal.map((l) => (
                      <Link key={l.href} href={l.href} className="md-link">
                        {l.label}
                      </Link>
                    ))}
                  </p>
                ) : null}
              </div>
            </div>

            <Button type="submit" variant="primary" size="lg" fullWidth className="mt-6" disabled={sending} aria-disabled={sending || undefined}>
              {sending ? labels.sending : labels.submit}
            </Button>
            <div role="alert" className="empty:hidden">
              {failure ? <p className="mt-4 font-copy text-small font-semibold text-danger">{failure}</p> : null}
            </div>
          </div>
          <p className="mt-6 text-small text-cocoa-soft">
            <Link href={labels.upsell.href} className="md-link inline-flex items-center gap-1">
              {labels.upsell.label}
              <IconArrowRight size={16} />
            </Link>
          </p>
        </aside>
      </form>
    </div>
  )
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cx(strong ? 'font-semibold text-cocoa' : 'text-cocoa-soft')}>{label}</dt>
      <dd className={cx('tabular-nums', strong ? 'text-[1.25rem] font-bold text-raspberry-ink' : 'font-semibold text-cocoa')}>{value}</dd>
    </div>
  )
}

function CartLineRow({
  index,
  line,
  product,
  labels,
  errors,
  onChange,
}: {
  index: number
  line: CartLine
  product: ProductSummary | undefined
  labels: CartLabels
  errors: FieldErrors<OrderField>
  onChange: () => void
}) {
  if (!product) return null
  const base = `kosik-polozka-${line.id}`
  const lineError = errors[`items.${index}`]
  const inscriptionError = errors[`items.${index}.inscription`]
  const flavorsError = errors[`items.${index}.miniFlavors`]
  const counts = isMini(line.slug) ? flavorCounts(line.miniFlavors) : null
  const unconfirmed = hasClientPlaceholder(product.priceText)
  return (
    <li className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-4 py-5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-6">
      <PhotoFrame photo={product.photo} aspect="square" sizes="96px" tone={product.tone} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <h3 className="font-display text-[1.375rem] font-semibold leading-tight text-cocoa">
            <Link href={product.href} className="hover:text-raspberry-ink">
              {product.name}
            </Link>
          </h3>
          <PriceTag amount={product.price * line.quantity} size="md" />
        </div>
        <p className="mt-1 text-small text-cocoa-soft">
          {unconfirmed ? <PlaceholderText text={product.priceText} /> : <PriceTag amount={product.price} unit="ks" size="sm" />}
        </p>

        {counts ? (
          <p className="mt-3 text-small text-cocoa">
            {labels.flavors
              .filter((f) => counts[f.value] > 0)
              .map((f) => `${counts[f.value]}× ${f.label}`)
              .join(', ')}
          </p>
        ) : null}
        {flavorsError ? <p className="mt-2 font-copy text-small font-semibold text-danger">{flavorsError}</p> : null}

        {allowsInscription(line.slug) ? (
          <Field
            id={`${base}-napis`}
            label={labels.inscription}
            hint={fill(labels.inscriptionCounter, { n: (line.inscription ?? '').length })}
            error={inscriptionError}
            className="mt-4 max-w-md"
          >
            <input
              id={`${base}-napis`}
              type="text"
              maxLength={INSCRIPTION_MAX}
              autoComplete="off"
              value={line.inscription ?? ''}
              aria-describedby={describedBy(`${base}-napis`, true, inscriptionError)}
              aria-invalid={inscriptionError ? true : undefined}
              onChange={(e) => {
                const v = e.currentTarget.value
                updateCart((s) => updateLine(s, line.id, { inscription: v }))
                onChange()
              }}
              className={FIELD_CLASS}
            />
          </Field>
        ) : null}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <label htmlFor={`${base}-pocet`} className="mb-2 block font-copy text-small font-semibold text-cocoa">
              {labels.quantity}
            </label>
            <Stepper
              id={`${base}-pocet`}
              value={line.quantity}
              invalid={!!lineError}
              onChange={(n) => {
                updateCart((s) => updateLine(s, line.id, { quantity: n }))
                onChange()
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => updateCart((s) => removeLine(s, line.id))}
            className="inline-flex min-h-11 items-center gap-2 rounded-pill px-3 font-copy text-small font-semibold text-cocoa underline decoration-raspberry underline-offset-[0.3em] hover:text-raspberry-ink"
          >
            <IconClose size={16} />
            {labels.remove}
            <span className="sr-only">: {product.name}</span>
          </button>
        </div>
        {lineError ? <p className="mt-2 font-copy text-small font-semibold text-danger">{lineError}</p> : null}
      </div>
    </li>
  )
}
