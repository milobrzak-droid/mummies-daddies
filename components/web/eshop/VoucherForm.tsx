'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { submitVoucherOrder, type FieldErrors, type SubmitVoucherResult, type VoucherField, type VoucherOrder } from '@/lib/web/api'
import { fill } from '@/lib/web/eshop/catalog'
import type { VoucherLabels } from '@/lib/web/eshop/types'
import { validateVoucher } from '@/lib/web/eshop/voucher'
import { formatCzk, formatNumber } from '@/lib/web/format'
import type { PaymentMethod } from '@/lib/web/options'
import { hasErrors } from '@/lib/web/validation'
import { Button } from '../Button'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'
import { CHOICE_CLASS, ChoiceGroup, FIELD_CLASS, Field, RADIO_CLASS, StepHeading, describedBy } from './fields'

/**
 * Nákup dárkového poukazu: hodnota (1 000–5 000 Kč nebo vlastní částka) → pro koho
 * (jméno, vzkaz, e-mail) → platba a souhlas → submitVoucherOrder (lib/web/api).
 * Vedle formuláře živý náhled poukazu v pastelové kartě (dekorativní, aria-hidden).
 */
const ID = {
  amount: 'poukaz-hodnota',
  custom: 'poukaz-vlastni',
  recipient: 'poukaz-pro',
  message: 'poukaz-vzkaz',
  email: 'poukaz-email',
  payment: 'poukaz-platba',
  consent: 'poukaz-souhlas',
} as const

const ORDER: [VoucherField, string][] = [
  ['amount', ID.amount],
  ['recipientName', ID.recipient],
  ['deliveryEmail', ID.email],
  ['payment', ID.payment],
  ['consent', ID.consent],
]

type Success = Extract<SubmitVoucherResult, { ok: true }>

export function VoucherForm({ labels }: { labels: VoucherLabels }) {
  const firstPreset = labels.presets.find((p) => p.amount !== null)?.amount ?? null
  const [preset, setPreset] = useState<number | 'vlastni'>(firstPreset ?? 'vlastni')
  const [custom, setCustom] = useState('')
  const [recipient, setRecipient] = useState('')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [payment, setPayment] = useState<PaymentMethod | ''>('')
  const [consent, setConsent] = useState(false)
  const [errors, setErrors] = useState<FieldErrors<VoucherField>>({})
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [success, setSuccess] = useState<Success | null>(null)
  const doneRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (success) doneRef.current?.focus()
  }, [success])

  const amount = preset === 'vlastni' ? (custom.trim() ? Number(custom.replace(/\s/g, '')) : NaN) : preset
  const err = (k: VoucherField) => errors[k] ?? null
  const clear = (k: VoucherField) => {
    if (k in errors) setErrors((e) => ({ ...e, [k]: undefined }))
  }

  async function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault()
    if (sending) return
    setFailure(null)
    const order: VoucherOrder = {
      amount,
      recipientName: recipient.trim(),
      message: message.trim() || null,
      deliveryEmail: email.trim(),
      payment: payment as PaymentMethod,
      consent,
    }
    const local = validateVoucher(order)
    if (local.amount) local.amount = labels.amountError
    if (hasErrors(local)) {
      setErrors(local)
      focusFirst(local)
      return
    }
    setErrors({})
    setSending(true)
    try {
      const res = await submitVoucherOrder(order)
      if (res.ok) setSuccess(res)
      else if (res.reason === 'validation') {
        setErrors(res.fieldErrors)
        focusFirst(res.fieldErrors)
      } else setFailure(labels.offline)
    } catch {
      setFailure(labels.offline)
    } finally {
      setSending(false)
    }
  }

  function focusFirst(e: FieldErrors<VoucherField>) {
    const hit = ORDER.find(([k]) => k in e && e[k])
    if (!hit) return
    const id = hit[0] === 'amount' && preset === 'vlastni' ? ID.custom : hit[1]
    document.getElementById(id)?.focus()
  }

  if (success) {
    return (
      <div className="rounded-soft bg-paper p-6 text-center shadow-float sm:p-10 motion-safe:animate-rise ring-2 ring-inset ring-cocoa">
        <h2 ref={doneRef} tabIndex={-1} className="md-caps text-h2 text-cocoa outline-none">
          {fill(labels.confirmation, { 'e-mail': success.deliveryEmail })}
        </h2>
        {success.payment.method === 'prevod' ? (
          <p className="md-pretty mx-auto mt-6 max-w-web-prose rounded-soft bg-vanilla p-5 text-copy text-cocoa ring-2 ring-inset ring-cocoa">
            <PlaceholderText text={fill(labels.transferText, { částka: formatNumber(success.payment.amount), číslo: success.payment.variableSymbol })} />
          </p>
        ) : null}
      </div>
    )
  }

  const previewAmount = Number.isFinite(amount) && amount > 0 ? formatCzk(amount) : '—'

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-14">
      <form noValidate onSubmit={onSubmit} aria-label={labels.submit} className="order-2 grid gap-8 lg:order-1">
        {/* hodnota */}
        <section aria-labelledby="poukaz-krok-hodnota" className="rounded-soft bg-blush-soft p-5 sm:p-8 ring-2 ring-inset ring-cocoa">
          <StepHeading id="poukaz-krok-hodnota" number={1} title={labels.valuesHeading} />
          <ChoiceGroup id={ID.amount} legend={labels.valuesLegend} error={preset === 'vlastni' ? null : err('amount')}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {labels.presets.map((p) => {
                const value = p.amount ?? 'vlastni'
                return (
                  <label key={p.label} className={cx(CHOICE_CLASS, 'items-center')}>
                    <input
                      type="radio"
                      name="hodnota"
                      value={String(value)}
                      checked={preset === value}
                      onChange={() => {
                        setPreset(value)
                        clear('amount')
                      }}
                      className={cx(RADIO_CLASS, 'mt-0')}
                    />
                    <span className={cx('font-copy font-bold', p.amount ? 'text-[1.0625rem] tabular-nums text-raspberry-ink' : 'text-copy text-cocoa')}>
                      {p.label}
                    </span>
                  </label>
                )
              })}
            </div>
          </ChoiceGroup>
          {preset === 'vlastni' ? (
            <Field id={ID.custom} label={labels.custom} error={err('amount')} className="mt-6 max-w-xs">
              <input
                id={ID.custom}
                name="vlastni-castka"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={custom}
                aria-describedby={describedBy(ID.custom, null, err('amount'))}
                aria-invalid={err('amount') ? true : undefined}
                onChange={(e) => {
                  setCustom(e.currentTarget.value)
                  clear('amount')
                }}
                className={FIELD_CLASS}
              />
            </Field>
          ) : null}
        </section>

        {/* pro koho */}
        <section aria-labelledby="poukaz-krok-pro-koho" className="rounded-soft bg-vanilla-soft p-5 sm:p-8 ring-2 ring-inset ring-cocoa">
          <StepHeading id="poukaz-krok-pro-koho" number={2} title={labels.personalHeading} body={labels.personalBody} />
          <div className="grid gap-6">
            <Field id={ID.recipient} label={labels.recipient} error={err('recipientName')}>
              <input
                id={ID.recipient}
                name="pro-koho"
                type="text"
                autoComplete="off"
                maxLength={80}
                value={recipient}
                aria-describedby={describedBy(ID.recipient, null, err('recipientName'))}
                aria-invalid={err('recipientName') ? true : undefined}
                onChange={(e) => {
                  setRecipient(e.currentTarget.value)
                  clear('recipientName')
                }}
                className={FIELD_CLASS}
              />
            </Field>
            <Field id={ID.message} label={labels.message}>
              <textarea
                id={ID.message}
                name="vzkaz"
                rows={3}
                maxLength={300}
                value={message}
                onChange={(e) => setMessage(e.currentTarget.value)}
                className={cx(FIELD_CLASS, 'py-3')}
              />
            </Field>
            <Field id={ID.email} label={labels.email} error={err('deliveryEmail')}>
              <input
                id={ID.email}
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                aria-describedby={describedBy(ID.email, null, err('deliveryEmail'))}
                aria-invalid={err('deliveryEmail') ? true : undefined}
                onChange={(e) => {
                  setEmail(e.currentTarget.value)
                  clear('deliveryEmail')
                }}
                className={FIELD_CLASS}
              />
            </Field>
          </div>
        </section>

        {/* platba a souhlas */}
        <section aria-labelledby="poukaz-krok-platba" className="rounded-soft bg-sage-soft p-5 sm:p-8 ring-2 ring-inset ring-cocoa">
          <StepHeading id="poukaz-krok-platba" number={3} title={labels.paymentLegend} body={labels.paymentBody} />
          <ChoiceGroup id={ID.payment} legend={labels.paymentLegend} error={err('payment')} className="[&>legend]:sr-only">
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
                      clear('payment')
                    }}
                    className={RADIO_CLASS}
                  />
                  <span className="font-copy text-copy font-bold text-cocoa">{p.label}</span>
                </label>
              ))}
            </div>
          </ChoiceGroup>
          <div className="mt-6">
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
                  clear('consent')
                }}
                className="mt-0.5 h-5 w-5 shrink-0 accent-raspberry-ink"
              />
              <span>{labels.consent}</span>
            </label>
            {err('consent') ? (
              <p id={`${ID.consent}-chyba`} className="mt-2 font-copy text-small font-bold text-danger">
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
        </section>

        <div>
          <Button type="submit" variant="primary" size="lg" disabled={sending} className="w-full sm:w-auto">
            {sending ? labels.sending : labels.submit}
          </Button>
          <div role="alert" className="empty:hidden">
            {failure ? <p className="mt-4 font-copy text-small font-bold text-danger">{failure}</p> : null}
          </div>
        </div>
      </form>

      {/* náhled poukazu */}
      <div className="order-1 lg:order-2">
        <div aria-hidden="true" className="lg:sticky lg:top-[calc(theme(spacing.header)+1.5rem)]">
          <div className="relative overflow-hidden rounded-frame bg-blush p-3 shadow-float sm:p-4">
            <div className="relative flex aspect-[3/2] flex-col justify-between rounded-frame border border-cocoa/15 bg-paper/70 p-6 sm:p-8">
              <div className="flex items-start justify-between gap-4">
                <p className="font-display text-[1.125rem] font-bold uppercase tracking-[0.08em] text-cocoa">{labels.brand}</p>
                <p className="font-copy text-eyebrow uppercase text-cocoa-soft">{labels.previewTitle}</p>
              </div>
              <div>
                <p className="font-copy text-[2rem] font-bold tabular-nums text-raspberry-ink sm:text-[2.5rem]">{previewAmount}</p>
                <p className="mt-2 min-h-[1.5em] font-display text-[1.375rem] italic text-cocoa">{recipient.trim()}</p>
                {message.trim() ? <p className="md-pretty mt-2 line-clamp-3 text-small text-cocoa-soft">{message.trim()}</p> : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
