/**
 * Tvary dat, která serverové stránky poptávky předávají klientským
 * komponentám (hotové řetězce z copy.json). Jen typy → bezpečné pro klienta.
 */
import type { InquiryOutcome, PriceEstimate } from '../api'

export interface WizardStepLabels {
  /** Krátký název do navigace kroků. */
  name: string
  /** Nadpis kroku (h2). */
  title: string
}

/** Všechny texty průvodce (mikrotexty POPTÁVKA — …, CHYBA — …, copy /poptavka). */
export interface WizardLabels {
  steps: Record<'typ' | 'hoste' | 'datum' | 'misto' | 'styl' | 'kontakt' | 'souhrn', WizardStepLabels>
  /** Text sekce formulář: „Pole s hvězdičkou jsou povinná.“ */
  requiredNote: string
  eventType: string
  segment: string
  date: string
  dateHint: string
  time: string
  place: string
  needsVenue: string
  guests: string
  guestsHint: string
  format: string
  budget: string
  budgetHint: string
  diets: string
  dietsHint: string
  service: string
  drinks: string
  extras: string
  name: string
  email: string
  phone: string
  phoneHint: string
  company: string
  ico: string
  note: string
  /** Souhlas GDPR: text a odkaz na zásady (věta „Více v zásadách …“ je odkaz). */
  consent: { before: string; link: string; href: string }
  assistantNote: string
  submit: string
  submitting: string
  back: string
  next: string
  /** „Máme předvyplněno: {typ akce}, {počet osob} osob. Můžete to změnit.“ */
  prefilled: string
  submitFailed: string
  offline: string
  /** Volba „Jak chcete začít?“ */
  choice: { heading: string; body: string; assistant: string; assistantHint: string; form: string }
  /** ASISTENT — úvodní zpráva */
  assistantGreeting: string
}

/** Co si průvodce uloží po odeslání pro potvrzovací stránku (sessionStorage). */
export interface StoredConfirmation {
  inquiryId: string
  outcome: InquiryOutcome
  email: string
  estimate: PriceEstimate | null
  guests: number
}

/** Potvrzovací stránka po odeslání (?vysledek=standard|na-miru|ceka-na-cenik|konzultace). */
export const CONFIRMATION_PATH = '/poptavka/odeslano'

export const CONFIRMATION_STORAGE_KEY = 'md-poptavka-odeslano'
export const DRAFT_STORAGE_KEY = 'md-poptavka-rozpracovano'
