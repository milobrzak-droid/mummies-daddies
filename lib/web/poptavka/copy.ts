/**
 * Texty stránek poptávky, častých dotazů, právních stránek a 404 z copy.json
 * (doslova). SERVER-ONLY (přes lib/web/content importuje JSON) – klientským
 * komponentám se předávají hotové řetězce (types.ts).
 */
import type { InquiryOutcome } from '../api'
import { getPage, getSection, microcopy, microcopyList, parseItem, type SectionCopy } from '../content'
import { UI_TEXT } from './ui-text'
import type { WizardLabels } from './types'

export const INQUIRY_PAGE = '/poptavka'
export { CONFIRMATION_PATH } from './types'

const mc = (key: string) => microcopy(`POPTÁVKA — ${key}`)
/** „Typ akce*“ → „Typ akce“, „Místo — adresa…*“ → „Místo“, „Formát servisu (bufet…)“ → „Formát servisu“. */
const shortName = (raw: string) => raw.replace(/\*$/, '').split(/\s+—\s+|\s+\(/)[0].trim()

export function wizardLabels(): WizardLabels {
  const form = getSection(INQUIRY_PAGE, 'formular')
  const choice = getSection(INQUIRY_PAGE, 'volba')
  const items = (form.items ?? []).map(shortName)
  const pick = (start: string) => items.find((i) => i.startsWith(start)) ?? start
  const contactTitle = mc('nadpis kroku Kontakt')
  const consent = mc('souhlas GDPR')
  const split = consent.indexOf('Více v ')
  const [assistant, assistantHint] = (choice.items?.[0] ?? '').split(/\s+—\s+/)
  return {
    steps: {
      typ: { name: pick('Typ akce'), title: mc('nadpis kroku 1') },
      hoste: { name: pick('Počet osob'), title: pick('Počet osob') },
      datum: { name: pick('Datum a čas'), title: pick('Datum a čas') },
      misto: { name: pick('Místo'), title: pick('Místo') },
      styl: { name: pick('Formát servisu'), title: pick('Formát servisu') },
      // „nadpis kroku Kontakt“ → v navigaci „Kontakt“ (název kroku z klíče mikrotextu)
      kontakt: { name: 'Kontakt', title: contactTitle },
      souhrn: { name: UI_TEXT.summary, title: UI_TEXT.summary },
    },
    requiredNote: form.body,
    eventType: mc('pole Typ akce'),
    segment: mc('pole Segment'),
    date: mc('pole Datum'),
    dateHint: mc('nápověda k datu'),
    time: mc('pole Čas'),
    place: mc('pole Místo'),
    needsVenue: mc('zaškrtávátko'),
    guests: mc('pole Počet osob'),
    guestsHint: mc('nápověda k počtu osob'),
    format: mc('pole Formát servisu'),
    budget: mc('pole Rozpočet'),
    budgetHint: mc('nápověda k rozpočtu'),
    diets: mc('pole Diety'),
    dietsHint: mc('nápověda k dietám'),
    service: mc('pole Obsluha'),
    drinks: mc('pole Nápoje'),
    extras: mc('pole Doplňky'),
    name: mc('pole Jméno'),
    email: mc('pole E-mail'),
    phone: mc('pole Telefon'),
    phoneHint: mc('nápověda k telefonu'),
    company: mc('pole Firma'),
    ico: mc('pole IČO'),
    note: mc('pole Poznámka'),
    consent: split > 0
      ? { before: consent.slice(0, split).trim(), link: consent.slice(split).trim(), href: '/ochrana-osobnich-udaju' }
      : { before: consent, link: '', href: '/ochrana-osobnich-udaju' },
    assistantNote: mc('informace o asistentovi'),
    submit: form.cta ?? mc('tlačítko odeslat'),
    submitting: mc('tlačítko během odesílání'),
    back: mc('tlačítko zpět'),
    next: mc('tlačítko další'),
    prefilled: mc('předvyplnění z odkazu'),
    submitFailed: microcopy('CHYBA — odeslání selhalo'),
    offline: microcopy('CHYBA — výpadek spojení'),
    choice: {
      heading: choice.heading,
      body: choice.body,
      assistant: assistant?.trim() ?? '',
      assistantHint: assistantHint?.trim() ?? '',
      form: choice.items?.[1] ?? '',
    },
    assistantGreeting: microcopy('ASISTENT — úvodní zpráva'),
  }
}

/** Úvod, „Co bude dál“, „Raději s člověkem?“ a „Vařili jsme pro…“ z /poptavka. */
export function inquiryPageCopy() {
  const uvod = getSection(INQUIRY_PAGE, 'uvod')
  const next = getSection(INQUIRY_PAGE, 'co-bude-dal')
  const human = getSection(INQUIRY_PAGE, 'clovek')
  const trust = getSection(INQUIRY_PAGE, 'duvera')
  return {
    uvod,
    next: { heading: next.heading, body: next.body, items: (next.items ?? []).map(parseItem) },
    human,
    trust,
  }
}

// ── potvrzení ───────────────────────────────────────────────────────────────

export const OUTCOMES: readonly InquiryOutcome[] = ['standard', 'na-miru', 'ceka-na-cenik', 'konzultace']

export function isOutcome(v: unknown): v is InquiryOutcome {
  return typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v)
}

/** Interní poznámka v hranatých závorkách („[Použít, dokud …]“) na web nepatří. */
const stripNote = (s: string) => s.replace(/\s*\[Použít[^\]]*\]/g, '').trim()

/** Rozdělí „Děkujeme, poptávku máme! Zbytek…“ na nadpis a text. */
function splitHeading(s: string): { heading: string; text: string } {
  const i = s.indexOf('! ')
  return i > 0 ? { heading: s.slice(0, i + 1), text: s.slice(i + 2) } : { heading: s, text: '' }
}

/**
 * Nadpis a text potvrzení podle výsledku (mikrotexty POTVRZENÍ — …).
 * `text` může obsahovat {e-mail} (doplní klientská komponenta) a [DOPLNÍ KLIENT].
 */
export function confirmationCopy(outcome: InquiryOutcome): { heading: string; text: string; nextStep: string } {
  const nextStep = microcopy('POTVRZENÍ — další krok')
  switch (outcome) {
    case 'standard':
      return { heading: microcopy('POTVRZENÍ — standard, nadpis'), text: microcopy('POTVRZENÍ — standard, text'), nextStep }
    case 'na-miru':
      return { heading: microcopy('POTVRZENÍ — na míru, nadpis'), text: microcopy('POTVRZENÍ — na míru, text'), nextStep }
    case 'konzultace':
      return { ...splitHeading(microcopy('POTVRZENÍ — konzultace')), nextStep }
    default:
      return { ...splitHeading(stripNote(microcopy('POTVRZENÍ — varianta do schválení ceníku'))), nextStep }
  }
}

// ── 404 ─────────────────────────────────────────────────────────────────────

export function notFoundCopy() {
  const [home, inquiry] = microcopyList('404 — tlačítka')
  return { heading: microcopy('404 — nadpis'), text: microcopy('404 — text'), home, inquiry }
}

// ── časté dotazy ────────────────────────────────────────────────────────────

export const FAQ_PAGE = '/caste-dotazy'

export interface FaqGroup {
  id: string
  heading: string
  body: string
  /** Položky „Otázka? — Odpověď“. */
  questions: { question: string; answer: string }[]
  /** Ostatní položky „Štítek — hodnota“ (minima, platba, tipy). */
  terms: { term: string; value: string }[]
  /** Položky bez „ — “. */
  notes: string[]
}

/** Sekce /caste-dotazy rozdělené na otázky (FAQ) a řádky „štítek — hodnota“. */
export function faqGroups(): { groups: FaqGroup[]; cta: SectionCopy | null } {
  const page = getPage(FAQ_PAGE)
  const cta = page.sections.find((s) => s.id === 'cta') ?? null
  const groups = page.sections
    .filter((s) => s.id !== 'cta')
    .map((s): FaqGroup => {
      const g: FaqGroup = { id: s.id, heading: s.heading, body: s.body, questions: [], terms: [], notes: [] }
      for (const raw of s.items ?? []) {
        const i = raw.indexOf(' — ')
        if (i < 0) g.notes.push(raw)
        else {
          const left = raw.slice(0, i).trim()
          const right = raw.slice(i + 3).trim()
          if (left.endsWith('?')) g.questions.push({ question: left, answer: right })
          else g.terms.push({ term: left, value: right })
        }
      }
      return g
    })
  return { groups, cta }
}

// ── právní stránky ──────────────────────────────────────────────────────────

export const LEGAL_PAGES = ['/obchodni-podminky', '/ochrana-osobnich-udaju', '/cookies'] as const
export type LegalPath = (typeof LEGAL_PAGES)[number]

/**
 * Právní stránka: titulek z metaTitle (před „ | “), sekce doslova.
 * Když se první sekce jmenuje stejně jako stránka (/cookies), stane se úvodem.
 */
export function legalPageCopy(path: LegalPath) {
  const page = getPage(path)
  const title = page.metaTitle.split(' | ')[0].trim()
  const [first, ...rest] = page.sections
  const intro = first && first.heading === title ? first : null
  return { title, lead: intro?.body ?? null, sections: intro ? rest : page.sections }
}
