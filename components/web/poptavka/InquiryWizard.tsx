'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { estimatePrice, submitInquiry, type FieldErrors, type InquiryField, type PriceEstimate, type WebInquiry } from '@/lib/web/api'
import { formatCzk, formatDate, isoDate, plural } from '@/lib/web/format'
import {
  CUSTOMER_KINDS, DIETS, DRINKS, EVENT_TYPE_OPTIONS, EXTRAS, SERVICE_FORMATS, SERVICE_LEVELS,
  eventTypeOf, minimumGuests, type EventType,
} from '@/lib/web/options'
import {
  FIELD_DOM_ID, STEP_IDS, draftFromPrefill, emptyDraft, guestsOf, initialStep, isBusiness, stepOfField, toWebInquiry, toggleValue,
  type InquiryDraft, type StepId,
} from '@/lib/web/poptavka/draft'
import { firstStepWithError, validateDraft } from '@/lib/web/poptavka/schema'
import {
  CONFIRMATION_PATH, CONFIRMATION_STORAGE_KEY, DRAFT_STORAGE_KEY,
  type StoredConfirmation, type WizardLabels,
} from '@/lib/web/poptavka/types'
import { UI_TEXT, fillText } from '@/lib/web/poptavka/ui-text'
import { MESSAGES, guestsBelowMinimum } from '@/lib/web/validation'
import { buttonClasses } from '../Button'
import { IconArrowRight } from '../icons'
import { cx } from '../cx'
import { EstimateCard } from './EstimateCard'
import { Checkbox, ChoiceGroup, FIELD_CLASS, Field, describedBy, type ChoiceOption } from './fields'
import { AccentTitle } from '@/components/web/AccentTitle'

/**
 * Průvodce poptávkou krok za krokem: typ akce → hosté → datum → místo →
 * styl a dieta → kontakt a segment → souhrn. Živá ORIENTAČNÍ cena přes
 * estimatePrice, validace zod (lib/web/poptavka/schema), honeypot proti
 * spamu, odeslání přes submitInquiry (kontrakt lib/web/api.ts) a pak
 * potvrzovací stránka /poptavka/odeslano.
 *
 * Rozpracovaná poptávka se drží v sessionStorage („Vaše údaje jsme si uložili“
 * z mikrotextu výpadku spojení), takže obnovení stránky nic nesmaže.
 * `aside` = serverový obsah vedle průvodce (Co bude dál, Raději s člověkem).
 */
export type WizardPrefill = Partial<WebInquiry> & { prefilled: string[] }

type Mode = 'formular' | 'asistent'

/** Klíč stavu → pole kontraktu (mazání chyby při úpravě). */
const DRAFT_FIELD: Partial<Record<keyof InquiryDraft, InquiryField>> = {
  eventType: 'eventType',
  guests: 'guests',
  eventDate: 'eventDate',
  address: 'venue.address',
  needsVenue: 'venue.address',
  serviceFormat: 'serviceFormat',
  budget: 'budgetPerPerson',
  customerKind: 'customerKind',
  companyName: 'company.name',
  companyIco: 'company.ico',
  name: 'contact.name',
  email: 'contact.email',
  phone: 'contact.phone',
  consent: 'consent',
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* soukromý režim / zakázané úložiště: průvodce funguje i bez něj */
  }
}

const labelOf = (list: readonly { value: string; label: string }[], v: string | null) => list.find((o) => o.value === v)?.label ?? null

export function InquiryWizard({
  labels,
  prefill,
  today: todayProp,
  aside,
  className,
}: {
  labels: WizardLabels
  prefill: WizardPrefill
  /** Dnešek YYYY-MM-DD ze serveru (min. datum v kalendáři). */
  today?: string
  aside?: ReactNode
  className?: string
}) {
  const router = useRouter()
  const today = todayProp ?? isoDate()
  const [draft, setDraft] = useState<InquiryDraft>(() => draftFromPrefill(prefill))
  const [step, setStep] = useState<StepId>(() => initialStep(prefill.prefilled))
  const [maxStep, setMaxStep] = useState(() => STEP_IDS.indexOf(initialStep(prefill.prefilled)))
  const [mode, setMode] = useState<Mode>('formular')
  const [errors, setErrors] = useState<FieldErrors<InquiryField>>({})
  const [sending, setSending] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<PriceEstimate | null>(null)
  const [focusTarget, setFocusTarget] = useState<string | null>(null)
  const restored = useRef(false)
  const honeypot = useRef<HTMLInputElement>(null)

  const index = STEP_IDS.indexOf(step)
  const total = STEP_IDS.length
  const isLast = step === 'souhrn'
  const guests = guestsOf(draft)
  const consultation = draft.eventType === 'konzultace'

  // Obnovení rozpracované poptávky (jen bez předvyplnění z odkazu) a #asistent.
  useEffect(() => {
    if (window.location.hash === '#asistent') setMode('asistent')
    if (!prefill.prefilled.length) {
      const saved = readStorage<{ draft: InquiryDraft; step: StepId; maxStep: number }>(DRAFT_STORAGE_KEY)
      if (saved?.draft && STEP_IDS.includes(saved.step)) {
        setDraft({ ...emptyDraft(prefill.source), ...saved.draft, source: prefill.source ?? saved.draft.source })
        setStep(saved.step)
        setMaxStep(Math.max(0, Math.min(saved.maxStep ?? 0, total - 1)))
      }
    }
    restored.current = true
    // Předvyplnění z odkazu (rychlý formulář na úvodu): rovnou ukázat průvodce na kroku,
    // kde zákazník pokračuje (jinak by zůstal nahoře na úvodu a „nic by se nestalo“).
    if (prefill.prefilled.length) {
      requestAnimationFrame(() => {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        document.getElementById('pop-formular')?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
        document.getElementById(`pop-krok-${initialStep(prefill.prefilled)}`)?.focus({ preventScroll: true })
      })
    }
    // jen při prvním vykreslení
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (restored.current) writeStorage(DRAFT_STORAGE_KEY, { draft, step, maxStep })
  }, [draft, step, maxStep])

  // Živý orientační odhad (rozpětí), s malým zpožděním při psaní počtu osob.
  useEffect(() => {
    if (!draft.eventType) {
      setEstimate(null)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      estimatePrice({ eventType: draft.eventType!, guests, serviceFormat: draft.serviceFormat, customerKind: draft.customerKind })
        .then((e) => alive && setEstimate(e))
        .catch(() => alive && setEstimate(null))
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [draft.eventType, guests, draft.serviceFormat, draft.customerKind])

  // Fokus po změně kroku nebo chybě (nikdy při prvním načtení).
  useEffect(() => {
    if (!focusTarget) return
    const el = document.getElementById(focusTarget)
    if (el) {
      el.focus({ preventScroll: true })
      // Začátek prvku (nadpis skupiny, legenda i chyba nad volbami), ne střed: vysoká skupina
      // by jinak schovala chybu pod spodní okraj a nadpis pod sticky hlavičku (scroll-margin-top).
      el.scrollIntoView?.({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
    setFocusTarget(null)
  }, [focusTarget, step])

  function update<K extends keyof InquiryDraft>(key: K, value: InquiryDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    const field = DRAFT_FIELD[key]
    if (field && errors[field]) {
      setErrors((prev) => {
        const rest = { ...prev }
        delete rest[field]
        return rest
      })
    }
    if (submitError) setSubmitError(null)
  }

  function goTo(target: StepId, focusField?: string) {
    setStep(target)
    setMaxStep((m) => Math.max(m, STEP_IDS.indexOf(target)))
    setFocusTarget(focusField ?? `pop-krok-${target}`)
  }

  function showErrors(found: FieldErrors<InquiryField>) {
    setErrors(found)
    const at = firstStepWithError(found) ?? step
    const first = (Object.keys(found) as InquiryField[]).find((f) => stepOfField(f) === at)
    goTo(at, first ? FIELD_DOM_ID[first] : undefined)
  }

  function chooseFromAssistant(type: EventType) {
    update('eventType', type)
    setMode('formular')
    goTo('hoste')
  }

  async function send() {
    const all = validateDraft(draft, undefined, today)
    if (Object.keys(all).length) return showErrors(all)
    // Honeypot: robot vyplnil skryté pole → tváříme se, že je hotovo, nic neodesíláme.
    if (honeypot.current?.value) {
      router.push(`${CONFIRMATION_PATH}?vysledek=ceka-na-cenik`)
      return
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSubmitError(labels.offline)
      return
    }
    setSending(true)
    setSubmitError(null)
    try {
      const inquiry = toWebInquiry(draft)
      const res = await submitInquiry(inquiry)
      if (res.ok) {
        const stored: StoredConfirmation = { inquiryId: res.inquiryId, outcome: res.outcome, email: inquiry.contact.email, estimate: res.estimate, guests: inquiry.guests }
        writeStorage(CONFIRMATION_STORAGE_KEY, stored)
        writeStorage(DRAFT_STORAGE_KEY, null)
        restored.current = false
        router.push(`${CONFIRMATION_PATH}?vysledek=${res.outcome}`)
        return
      }
      if (res.reason === 'validation') showErrors(res.fieldErrors)
      else setSubmitError(res.reason === 'network' ? labels.offline : labels.submitFailed)
    } catch {
      setSubmitError(typeof navigator !== 'undefined' && navigator.onLine === false ? labels.offline : labels.submitFailed)
    }
    setSending(false)
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (sending) return
    if (isLast) {
      void send()
      return
    }
    const found = validateDraft(draft, step, today)
    if (Object.keys(found).length) return showErrors(found)
    setErrors({})
    goTo(STEP_IDS[index + 1])
  }

  const eventOptions: ChoiceOption[] = useMemo(() => {
    const list: { value: string; label: string; minGuests: number | null }[] = [...EVENT_TYPE_OPTIONS]
    const hidden = eventTypeOf(draft.eventType)
    if (hidden && !list.some((o) => o.value === hidden.value)) list.push(hidden)
    return list.map((o) => ({ value: o.value, label: o.label, meta: o.minGuests ? fillText(UI_TEXT.minGuests, { n: o.minGuests }) : null }))
  }, [draft.eventType])

  const prefilledNotice = useMemo(() => {
    if (!prefill.prefilled.includes('eventType') || !prefill.eventType) return null
    const type = eventTypeOf(prefill.eventType)?.label ?? ''
    const n = prefill.prefilled.includes('guests') ? prefill.guests ?? null : null
    const template = n ? labels.prefilled.replace('{počet osob} osob', `${n} ${plural(n, ['osoba', 'osoby', 'osob'])}`) : labels.prefilled.replace(/,\s*\{počet osob\} osob/, '')
    return fillText(template, { 'typ akce': type })
  }, [prefill, labels.prefilled])

  const err = (f: InquiryField) => errors[f] ?? null
  const stepLabel = labels.steps[step]
  const stepOf = fillText(UI_TEXT.stepOf, { n: index + 1, total })
  const min = draft.eventType ? minimumGuests(draft.eventType) : null
  const belowMin = guestsBelowMinimum(draft.eventType, guests)
  const minNotice = belowMin ? (
    <div role="status" className="rounded-soft bg-butter px-4 py-3 font-copy text-small text-cocoa ring-2 ring-inset ring-cocoa">
      <p className="font-bold">{MESSAGES.belowMinimum(belowMin)}</p>
      <p className="mt-2 flex flex-wrap gap-x-5">
        <button type="button" onClick={() => update('eventType', 'konzultace')} className="md-link inline-flex min-h-11 items-center font-bold">
          {UI_TEXT.switchToConsultation}
        </button>
        <button type="button" onClick={() => setMode('asistent')} className="md-link inline-flex min-h-11 items-center font-bold">
          {labels.choice.assistant}
        </button>
      </p>
    </div>
  ) : null

  return (
    <div className={cx('grid gap-10 lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:gap-12', className)}>
      <div className="min-w-0">
        {/* Jak chcete začít? */}
        <section aria-labelledby="pop-volba-title" className="mb-6 sm:mb-8">
          <h2 id="pop-volba-title" className="md-caps text-h3 text-cocoa">
            {labels.choice.heading}
          </h2>
          <p className="md-pretty mt-2 text-copy text-cocoa-soft max-sm:hidden">{labels.choice.body}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-5 sm:gap-3">
            {(
              [
                ['asistent', labels.choice.assistant, labels.choice.assistantHint],
                ['formular', labels.choice.form, UI_TEXT.formHint],
              ] as const
            ).map(([value, title, hint]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                // aria-controls jen na panel, který je v DOM (vykreslený je jen ten vybraný).
                aria-controls={mode === value ? (value === 'asistent' ? 'pop-asistent' : 'pop-formular') : undefined}
                onClick={() => setMode(value)}
                className={cx(
                  'flex min-h-12 items-center gap-3 rounded-soft px-4 py-3 text-left text-cocoa sm:min-h-14 sm:px-5 sm:py-4',
                  'transition-[background-color,box-shadow] duration-quick ease-md-out focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-daddy-ink',
                  mode === value ? 'bg-raspberry-tint shadow-hard-sm ring-[3px] ring-inset ring-cocoa' : 'bg-paper ring-2 ring-inset ring-cocoa hover:bg-cream',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-pill border-2 border-cocoa text-[0.8125rem] font-bold', mode === value ? 'bg-cocoa text-cream' : 'bg-paper')}
                >
                  {mode === value ? '✓' : ''}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-copy text-small font-bold leading-snug sm:text-copy">{title}</span>
                  {hint ? <span className="mt-0.5 font-copy text-small text-cocoa-soft max-sm:hidden">{hint}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </section>

        {mode === 'asistent' ? (
          <section id="pop-asistent" aria-label={labels.choice.assistant} className="rounded-soft bg-paper shadow-float ring-2 ring-cocoa motion-safe:animate-fade">
            <div className="flex items-center gap-3 border-b border-hairline px-5 py-4 sm:px-6">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-pill bg-success" />
              <p className="font-copy text-copy font-bold text-cocoa">{labels.choice.assistant}</p>
            </div>
            <div className="space-y-5 px-5 py-6 sm:px-6">
              <p className="max-w-[30rem] rounded-soft rounded-tl-frame bg-sage-soft px-4 py-3 text-copy text-cocoa ring-2 ring-inset ring-cocoa">{labels.assistantGreeting}</p>
              <ul role="list" aria-label={labels.eventType} className="flex flex-wrap gap-2">
                {EVENT_TYPE_OPTIONS.map((o) => (
                  <li key={o.value}>
                    <button
                      type="button"
                      onClick={() => chooseFromAssistant(o.value)}
                      className={cx(
                        'inline-flex min-h-11 items-center rounded-pill bg-paper px-4 font-copy text-small font-bold text-cocoa ring-2 ring-inset ring-cocoa',
                        'transition-colors duration-quick ease-md-out hover:bg-raspberry-ink hover:text-paper hover:ring-transparent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-daddy-ink',
                      )}
                    >
                      {o.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <p className="border-t border-hairline px-5 py-4 text-small text-cocoa-soft sm:px-6">{labels.assistantNote}</p>
          </section>
        ) : (
          <div id="pop-formular" className="rounded-soft bg-paper p-5 shadow-float ring-2 ring-cocoa sm:p-8">
            <Progress labels={labels} step={step} maxStep={maxStep} onJump={(s) => goTo(s)} stepOf={stepOf} />

            <p role="status" aria-live="polite" className="sr-only">
              {`${stepOf}: ${stepLabel.title}`}
            </p>

            {prefilledNotice ? (
              <p className="mb-6 rounded-soft bg-pistachio-soft px-4 py-3 font-copy text-small text-cocoa ring-2 ring-inset ring-cocoa">{prefilledNotice}</p>
            ) : null}
            {/* Počet pod minimem z odkazu: stejné upozornění jako při ručním zadání (krok Počet osob ho má u pole). */}
            {minNotice && step !== 'hoste' && step !== 'typ' ? <div className="mb-6">{minNotice}</div> : null}

            <form noValidate onSubmit={onSubmit} aria-labelledby={`pop-krok-${step}`}>
              <div key={step} className="motion-safe:animate-fade">
                <p className="hidden font-copy text-eyebrow uppercase text-cocoa-soft sm:block">{stepOf}</p>
                <h2 id={`pop-krok-${step}`} tabIndex={-1} className="md-caps mt-2 text-h2 text-cocoa outline-none"><AccentTitle title={stepLabel.title} /></h2>
                {step !== 'souhrn' && step !== 'styl' ? <p className="mt-2 text-small text-cocoa-soft">{labels.requiredNote}</p> : null}
                {step === 'styl' ? <p className="mt-2 text-small font-bold text-cocoa-soft">{UI_TEXT.optionalStep}</p> : null}

                <div className="mt-8 space-y-8">
                  {step === 'typ' ? (
                    <ChoiceGroup
                      id="pop-typ"
                      name="typ"
                      type="radio"
                      legend={labels.eventType}
                      required
                      options={eventOptions}
                      value={draft.eventType}
                      onChange={(v) => update('eventType', v as EventType)}
                      error={err('eventType')}
                    />
                  ) : null}

                  {step === 'hoste' ? (
                    <>
                      <Field id="pop-osob" label={labels.guests} required={!consultation} hint={labels.guestsHint} error={err('guests')}>
                        <input
                          id="pop-osob"
                          name="osob"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={5000}
                          step={1}
                          autoComplete="off"
                          value={draft.guests}
                          onChange={(e) => update('guests', e.target.value)}
                          aria-invalid={err('guests') ? true : undefined}
                          aria-describedby={describedBy('pop-osob', labels.guestsHint, err('guests'))}
                          className={cx(FIELD_CLASS, 'max-w-[12rem]')}
                        />
                      </Field>
                      {minNotice ??
                        (min ? (
                          <p className="font-copy text-small text-cocoa-soft">
                            {eventTypeOf(draft.eventType)?.label}: <span className="font-bold text-cocoa">{fillText(UI_TEXT.minGuests, { n: min })}</span>
                          </p>
                        ) : null)}
                      <EstimateCard estimate={estimate} guests={guests} className="lg:hidden" />
                    </>
                  ) : null}

                  {step === 'datum' ? (
                    <>
                      <Field id="pop-datum" label={labels.date} hint={labels.dateHint} error={err('eventDate')}>
                        <input
                          id="pop-datum"
                          name="datum"
                          type="date"
                          min={today}
                          value={draft.eventDate}
                          onChange={(e) => update('eventDate', e.target.value)}
                          aria-invalid={err('eventDate') ? true : undefined}
                          aria-describedby={describedBy('pop-datum', labels.dateHint, err('eventDate'))}
                          className={cx(FIELD_CLASS, 'max-w-[16rem]')}
                        />
                      </Field>
                      <fieldset className="min-w-0">
                        <legend className="mb-3 block font-copy text-small font-bold text-cocoa">{labels.time}</legend>
                        <div className="flex flex-wrap gap-4">
                          {(
                            [
                              ['pop-cas-od', 'timeFrom', UI_TEXT.timeFrom],
                              ['pop-cas-do', 'timeTo', UI_TEXT.timeTo],
                            ] as const
                          ).map(([id, key, label]) => (
                            <div key={id}>
                              <label htmlFor={id} className="mb-1 block font-copy text-small text-cocoa-soft">
                                {label}
                              </label>
                              <input id={id} name={key} type="time" step={900} value={draft[key]} onChange={(e) => update(key, e.target.value)} className={cx(FIELD_CLASS, 'w-[9rem]')} />
                            </div>
                          ))}
                        </div>
                      </fieldset>
                    </>
                  ) : null}

                  {step === 'misto' ? (
                    <>
                      <Field id="pop-adresa" label={labels.place} required={!consultation && !draft.needsVenue} error={err('venue.address')}>
                        <input
                          id="pop-adresa"
                          name="misto"
                          type="text"
                          autoComplete="street-address"
                          value={draft.address}
                          onChange={(e) => update('address', e.target.value)}
                          aria-invalid={err('venue.address') ? true : undefined}
                          aria-describedby={describedBy('pop-adresa', null, err('venue.address'))}
                          className={FIELD_CLASS}
                        />
                      </Field>
                      <Checkbox id="pop-prostor" name="hledam-prostor" checked={draft.needsVenue} onChange={(v) => update('needsVenue', v)}>
                        {labels.needsVenue}
                      </Checkbox>
                    </>
                  ) : null}

                  {step === 'styl' ? (
                    <>
                      <ChoiceGroup id="pop-format" name="format" type="radio" legend={labels.format} options={SERVICE_FORMATS} value={draft.serviceFormat} onChange={(v) => update('serviceFormat', v as InquiryDraft['serviceFormat'])} />
                      <Field id="pop-rozpocet" label={labels.budget} hint={labels.budgetHint}>
                        <div className="relative max-w-[14rem]">
                          <input
                            id="pop-rozpocet"
                            name="rozpocet"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step={50}
                            value={draft.budget}
                            onChange={(e) => update('budget', e.target.value)}
                            aria-describedby={describedBy('pop-rozpocet', labels.budgetHint)}
                            className={cx(FIELD_CLASS, 'pr-14')}
                          />
                          <span aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-copy text-small text-cocoa-soft">
                            Kč
                          </span>
                        </div>
                      </Field>
                      <div>
                        <ChoiceGroup id="pop-diety" name="diety" type="checkbox" legend={labels.diets} options={DIETS} value={draft.diets} onChange={(v) => update('diets', toggleValue(draft.diets, v as InquiryDraft['diets'][number]))} />
                        <label htmlFor="pop-diety-pocty" className="sr-only">
                          {labels.diets}
                        </label>
                        <input
                          id="pop-diety-pocty"
                          name="diety-pocty"
                          type="text"
                          placeholder={labels.dietsHint}
                          value={draft.dietNote}
                          onChange={(e) => update('dietNote', e.target.value)}
                          className={cx(FIELD_CLASS, 'mt-3')}
                        />
                      </div>
                      <ChoiceGroup id="pop-obsluha" name="obsluha" type="radio" legend={labels.service} options={SERVICE_LEVELS} value={draft.serviceLevel} onChange={(v) => update('serviceLevel', v as InquiryDraft['serviceLevel'])} />
                      <ChoiceGroup id="pop-napoje" name="napoje" type="checkbox" legend={labels.drinks} options={DRINKS} value={draft.drinks} onChange={(v) => update('drinks', toggleValue(draft.drinks, v as InquiryDraft['drinks'][number]))} />
                      <ChoiceGroup id="pop-doplnky" name="doplnky" type="checkbox" legend={labels.extras} options={EXTRAS} value={draft.extras} onChange={(v) => update('extras', toggleValue(draft.extras, v as InquiryDraft['extras'][number]))} />
                    </>
                  ) : null}

                  {step === 'kontakt' ? (
                    <>
                      <ChoiceGroup
                        id="pop-segment"
                        name="segment"
                        type="radio"
                        legend={labels.segment}
                        required
                        columns={3}
                        options={CUSTOMER_KINDS}
                        value={draft.customerKind}
                        onChange={(v) => update('customerKind', v as InquiryDraft['customerKind'])}
                        error={err('customerKind')}
                      />
                      {isBusiness(draft.customerKind) ? (
                        <div className="grid gap-6 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                          <Field id="pop-firma" label={labels.company} error={err('company.name')}>
                            <input id="pop-firma" name="firma" type="text" autoComplete="organization" value={draft.companyName} onChange={(e) => update('companyName', e.target.value)} className={FIELD_CLASS} />
                          </Field>
                          <Field id="pop-ico" label={labels.ico} error={err('company.ico')}>
                            <input
                              id="pop-ico"
                              name="ico"
                              type="text"
                              inputMode="numeric"
                              maxLength={10}
                              value={draft.companyIco}
                              onChange={(e) => update('companyIco', e.target.value)}
                              aria-invalid={err('company.ico') ? true : undefined}
                              aria-describedby={describedBy('pop-ico', null, err('company.ico'))}
                              className={FIELD_CLASS}
                            />
                          </Field>
                        </div>
                      ) : null}
                      <Field id="pop-jmeno" label={labels.name} required error={err('contact.name')}>
                        <input
                          id="pop-jmeno"
                          name="jmeno"
                          type="text"
                          autoComplete="name"
                          required
                          value={draft.name}
                          onChange={(e) => update('name', e.target.value)}
                          aria-invalid={err('contact.name') ? true : undefined}
                          aria-describedby={describedBy('pop-jmeno', null, err('contact.name'))}
                          className={FIELD_CLASS}
                        />
                      </Field>
                      <div className="grid gap-6 sm:grid-cols-2">
                        <Field id="pop-email" label={labels.email} required error={err('contact.email')}>
                          <input
                            id="pop-email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            required
                            value={draft.email}
                            onChange={(e) => update('email', e.target.value)}
                            aria-invalid={err('contact.email') ? true : undefined}
                            aria-describedby={describedBy('pop-email', null, err('contact.email'))}
                            className={FIELD_CLASS}
                          />
                        </Field>
                        <Field id="pop-telefon" label={labels.phone} required hint={labels.phoneHint} error={err('contact.phone')}>
                          <input
                            id="pop-telefon"
                            name="telefon"
                            type="tel"
                            autoComplete="tel"
                            required
                            value={draft.phone}
                            onChange={(e) => update('phone', e.target.value)}
                            aria-invalid={err('contact.phone') ? true : undefined}
                            aria-describedby={describedBy('pop-telefon', labels.phoneHint, err('contact.phone'))}
                            className={FIELD_CLASS}
                          />
                        </Field>
                      </div>
                      <Field id="pop-poznamka" label={labels.note}>
                        <textarea id="pop-poznamka" name="poznamka" rows={4} value={draft.note} onChange={(e) => update('note', e.target.value)} className={cx(FIELD_CLASS, 'py-3')} />
                      </Field>
                    </>
                  ) : null}

                  {step === 'souhrn' ? (
                    <>
                      <Summary labels={labels} draft={draft} onEdit={(s) => goTo(s)} />
                      <EstimateCard estimate={estimate} guests={guests} />
                      <Checkbox id="pop-souhlas" name="souhlas" checked={draft.consent} required onChange={(v) => update('consent', v)} error={err('consent')}>
                        {labels.consent.before}{' '}
                        {labels.consent.link ? (
                          <Link href={labels.consent.href} className="md-link">
                            {labels.consent.link}
                          </Link>
                        ) : null}
                      </Checkbox>
                      <p className="text-small text-cocoa-soft">{labels.assistantNote}</p>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Honeypot: skryté pole, které člověk nevidí a čtečka nepřečte. */}
              <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
                <label htmlFor="pop-web">{UI_TEXT.honeypot}</label>
                <input ref={honeypot} id="pop-web" name="web" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
              </div>

              {submitError ? (
                <p role="alert" className="mt-8 rounded-soft bg-blush-soft px-4 py-3 font-copy text-small font-bold text-danger ring-2 ring-inset ring-danger/30">
                  {submitError}
                </p>
              ) : null}

              <div className="mt-10 flex flex-col-reverse gap-3 border-t border-hairline pt-6 sm:flex-row sm:items-center sm:justify-between">
                {index > 0 ? (
                  <button type="button" onClick={() => goTo(STEP_IDS[index - 1])} className={buttonClasses({ variant: 'outline', size: 'md' })}>
                    {labels.back}
                  </button>
                ) : (
                  <span />
                )}
                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
                  {step === 'styl' ? (
                    <button type="button" onClick={() => goTo(STEP_IDS[index + 1])} className={buttonClasses({ variant: 'ghost', size: 'md', className: 'self-center' })}>
                      {UI_TEXT.skip}
                    </button>
                  ) : null}
                  <button type="submit" disabled={sending} aria-busy={sending || undefined} className={buttonClasses({ variant: 'primary', size: 'lg', className: 'group' })}>
                    <span>{isLast ? (sending ? labels.submitting : labels.submit) : labels.next}</span>
                    {!sending ? <IconArrowRight size={18} className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" /> : null}
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}
      </div>

      <aside className="min-w-0 space-y-5 lg:sticky lg:top-[calc(theme(spacing.header)+1.5rem)] lg:self-start">
        <EstimateCard estimate={estimate} guests={guests} live className={cx(step === 'hoste' && 'hidden lg:block')} />
        {aside}
      </aside>
    </div>
  )
}

/** Navigace kroků: hotové kroky jdou otevřít, budoucí ne. */
function Progress({ labels, step, maxStep, onJump, stepOf }: { labels: WizardLabels; step: StepId; maxStep: number; onJump: (s: StepId) => void; stepOf: string }) {
  const index = STEP_IDS.indexOf(step)
  return (
    <nav aria-label={UI_TEXT.stepsNav} className="mb-8">
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-pill bg-hairline sm:hidden">
        <div className="h-full rounded-pill bg-raspberry-ink motion-safe:transition-[width] motion-safe:duration-base" style={{ width: `${((index + 1) / STEP_IDS.length) * 100}%` }} />
      </div>
      <p className="mt-2 font-copy text-small text-cocoa-soft sm:hidden">
        {stepOf} · <span className="font-bold text-cocoa">{labels.steps[step].name}</span>
      </p>
      <ol className="hidden flex-wrap gap-2 sm:flex">
        {STEP_IDS.map((id, i) => {
          const current = id === step
          const reachable = i <= maxStep && !current
          const inner = (
            <>
              <span
                aria-hidden="true"
                className={cx(
                  'grid h-6 w-6 place-items-center rounded-pill text-[0.75rem] font-bold',
                  current ? 'bg-cream text-cocoa' : i < index || reachable ? 'bg-daddy-tint text-cocoa ring-2 ring-cocoa' : 'bg-cream text-cocoa ring-2 ring-cocoa',
                )}
              >
                {i + 1}
              </span>
              <span>{labels.steps[id].name}</span>
            </>
          )
          const cls = cx(
            'inline-flex min-h-10 items-center gap-2 rounded-pill px-3 pr-4 font-copy text-small font-bold',
            current ? 'bg-cocoa text-cream' : reachable ? 'bg-paper text-cocoa ring-2 ring-inset ring-cocoa hover:bg-cream' : 'text-cocoa',
          )
          return (
            <li key={id}>
              {reachable ? (
                <button type="button" onClick={() => onJump(id)} className={cx(cls, 'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-daddy-ink')}>
                  {inner}
                </button>
              ) : (
                <span aria-current={current ? 'step' : undefined} className={cls}>
                  {inner}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Souhrn poptávky před odesláním, s odkazem „Upravit“ na každý krok. */
function Summary({ labels, draft, onEdit }: { labels: WizardLabels; draft: InquiryDraft; onEdit: (s: StepId) => void }) {
  const guests = guestsOf(draft)
  const list = (vals: string[]) => (vals.length ? vals.join(', ') : null)
  const time = draft.timeFrom || draft.timeTo ? `${draft.timeFrom || '…'}–${draft.timeTo || '…'}` : null
  const rows: { step: StepId; label: string; value: string | null }[] = [
    { step: 'typ', label: labels.steps.typ.name, value: eventTypeOf(draft.eventType)?.label ?? null },
    { step: 'hoste', label: labels.steps.hoste.name, value: guests ? String(guests) : null },
    { step: 'datum', label: labels.date, value: draft.eventDate ? formatDate(draft.eventDate) : null },
    { step: 'datum', label: labels.time, value: time },
    { step: 'misto', label: labels.steps.misto.name, value: [draft.address.trim() || null, draft.needsVenue ? labels.needsVenue : null].filter(Boolean).join(' · ') || null },
    { step: 'styl', label: labels.format, value: labelOf(SERVICE_FORMATS, draft.serviceFormat) },
    { step: 'styl', label: labels.budget, value: Number(draft.budget) > 0 ? formatCzk(Number(draft.budget)) : null },
    { step: 'styl', label: labels.diets, value: [list(draft.diets.map((d) => labelOf(DIETS, d)!)), draft.dietNote.trim() || null].filter(Boolean).join(' · ') || null },
    { step: 'styl', label: labels.service, value: labelOf(SERVICE_LEVELS, draft.serviceLevel) },
    { step: 'styl', label: labels.drinks, value: list(draft.drinks.map((d) => labelOf(DRINKS, d)!)) },
    { step: 'styl', label: labels.extras, value: list(draft.extras.map((d) => labelOf(EXTRAS, d)!)) },
    { step: 'kontakt', label: labels.segment, value: labelOf(CUSTOMER_KINDS, draft.customerKind) },
    ...(isBusiness(draft.customerKind)
      ? [{ step: 'kontakt' as const, label: labels.company, value: [draft.companyName.trim(), draft.companyIco.trim()].filter(Boolean).join(' · ') || null }]
      : []),
    { step: 'kontakt', label: labels.name, value: draft.name.trim() || null },
    { step: 'kontakt', label: labels.email, value: draft.email.trim() || null },
    { step: 'kontakt', label: labels.phone, value: draft.phone.trim() || null },
    { step: 'kontakt', label: labels.note, value: draft.note.trim() || null },
  ]
  return (
    <dl className="divide-y divide-hairline border-y border-hairline">
      {rows.map((r, i) => (
        <div key={`${r.step}-${i}`} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-baseline sm:gap-4">
          <dt className="font-copy text-small text-cocoa-soft">{r.label}</dt>
          <dd className="md-pretty break-words font-copy text-copy font-bold text-cocoa">{r.value ?? <span className="font-normal text-cocoa-soft">{UI_TEXT.empty}</span>}</dd>
          {i === 0 || rows[i - 1].step !== r.step ? (
            <dd className="sm:text-right">
              <button type="button" onClick={() => onEdit(r.step)} className="md-link inline-flex min-h-11 items-center font-copy text-small font-bold">
                {UI_TEXT.edit}
                <span className="sr-only">: {labels.steps[r.step].name}</span>
              </button>
            </dd>
          ) : (
            <dd aria-hidden="true" />
          )}
        </div>
      ))}
    </dl>
  )
}

