// Milník dodávky: stavy, přechody a kontrola předávacího balíčku.
//
// Rozhodnutí vlastníka 2026-09-28: Delivery Standard (EDS v1.1) je schválený
// v aktuálním znění (kap. 6 docs/PROVOZ.md). Stavy drží ručně
// synchronně CHECK v migraci 0042_engagement_milestone.sql.
//
// Šest kvalitativních bran (deliveryGates.ts, 0023) hodnotí dodávku jako
// celek, ne milník — proto na milník navázané nejsou (zdůvodnění v hlavičce
// 0042). Milník uzavírá akceptace klientem, dodávku uzavírá šest bran.
//
// Invariant „Odesláno ≠ přijato": do 'prijato' (a tím i 'uzavreno') se nejde
// bez data akceptace a její evidence (0038 — trvalý doklad bez osobních
// údajů). Kontakt klienta je jen informační: při GDPR výmazu kontaktu se
// vynuluje, akceptace ale zůstává doložená evidencí. DB to vynucuje CHECKem; tady to samé platí pro přechod, aby UI/agent dostal
// srozumitelnou chybu dřív, než narazí na constraint.

import { z } from 'zod'
import { SHAREPOINT_URL_RE } from '@/domain/delivery/documents'

export const MILESTONE_STATUSES = [
  'pripraveno',
  'v_praci',
  'ceka_na_vstup',
  'ceka_na_schvaleni',
  'prijato',
  'uzavreno',
] as const

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export const MILESTONE_STATUS_LABEL: Record<MilestoneStatus, string> = {
  pripraveno: 'Připraveno',
  v_praci: 'V práci',
  ceka_na_vstup: 'Čeká na vstup',
  ceka_na_schvaleni: 'Čeká na schválení',
  prijato: 'Přijato',
  uzavreno: 'Uzavřeno',
}

// Povolené přechody. 'ceka_na_schvaleni' = odesláno klientovi; odtud buď
// přijato, nebo zpět do práce (připomínky). Uzavřeno je koncový stav.
const TRANSITIONS: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  pripraveno: ['v_praci', 'ceka_na_vstup'],
  v_praci: ['ceka_na_vstup', 'ceka_na_schvaleni'],
  ceka_na_vstup: ['v_praci'],
  ceka_na_schvaleni: ['v_praci', 'prijato'],
  prijato: ['uzavreno'],
  uzavreno: [],
}

/** Stavy, do kterých smí milník ze stavu `from` přejít (prázdné = koncový). */
export function nextMilestoneStatuses(from: MilestoneStatus): readonly MilestoneStatus[] {
  return TRANSITIONS[from]
}

/**
 * Přijatý (a tím i uzavřený) milník nese doklad akceptace klientem — jeho
 * název, termín ani lidi už neměníme, stejně jako ho nejde smazat.
 */
export function isMilestoneLocked(status: MilestoneStatus): boolean {
  return status === 'prijato' || status === 'uzavreno'
}

/**
 * Nepřijaté milníky bez termínu — ty, u kterých Cockpit nepozná „po termínu".
 * Typicky milníky, které po vyhraném obchodu založil Cockpit sám (0080).
 */
export function milestonesWithoutDue<T extends { status: MilestoneStatus; due_on: string | null }>(milestones: readonly T[]): T[] {
  return milestones.filter((m) => !isMilestoneLocked(m.status) && m.due_on === null)
}

/** „1 milník nemá termín." / „2 milníky nemají termín." / „5 milníků nemá termín." */
export function missingDueHeadline(n: number): string {
  if (n === 1) return '1 milník nemá termín.'
  if (n >= 2 && n <= 4) return `${n} milníky nemají termín.`
  return `${n} milníků nemá termín.`
}

export function isMilestoneStatus(v: unknown): v is MilestoneStatus {
  return typeof v === 'string' && (MILESTONE_STATUSES as readonly string[]).includes(v)
}

export type Acceptance = {
  acceptedAt: string | null
  acceptedByContactId: number | null
  acceptanceEvidenceId: number | null
}

export function hasAcceptance(a: Acceptance): boolean {
  return a.acceptedAt !== null && a.acceptanceEvidenceId !== null
}

export type TransitionResult =
  | { ok: true; status: MilestoneStatus }
  | { ok: false; reason: string }

export function transitionMilestone(
  from: MilestoneStatus,
  to: MilestoneStatus,
  acceptance: Acceptance,
): TransitionResult {
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: `Přechod ${MILESTONE_STATUS_LABEL[from]} → ${MILESTONE_STATUS_LABEL[to]} není povolený.`,
    }
  }
  if ((to === 'prijato' || to === 'uzavreno') && !hasAcceptance(acceptance)) {
    return {
      ok: false,
      reason: 'Odesláno není přijato: chybí datum akceptace nebo evidence, čím ji klient potvrdil.',
    }
  }
  return { ok: true, status: to }
}

// Předávací balíček obchod → realizace (kap. 6). Odkud se položky berou:
//   engagement (0054): cíl, rozsah, klientský sponzor, finanční rámec, rizika
//   engagement: nabídka (deal_id → obchod „vyhráno" podle deal_public), termíny (started_on + due_on)
//   výchozí metrika (0088): výchozí měření hlavní metriky v metric_observation,
//     nebo doložené „zatím nelze měřit" — počítá baselineMetricOk
//     (domain/delivery/impactMetric.ts), sem přijde už jen ano/ne
//   engagement_document (0051): podklady (aspoň jeden odkaz do SharePointu)
//   engagement_milestone (0042): vlastník (aspoň jeden milník s vlastníkem)
// Skládá to buildHandoffPackage; chybějící = null/prázdné.
export const HANDOFF_ITEMS = [
  { key: 'goal', label: 'Cíl' },
  { key: 'scope', label: 'Rozsah' },
  { key: 'approvedOffer', label: 'Schválená nabídka' },
  { key: 'clientSponsor', label: 'Klientský sponzor' },
  { key: 'dates', label: 'Termíny' },
  { key: 'baselineMetric', label: 'Výchozí metrika' },
  { key: 'financialFrame', label: 'Finanční rámec' },
  { key: 'materials', label: 'Podklady' },
  { key: 'risks', label: 'Rizika' },
  { key: 'owner', label: 'Vlastník' },
] as const

export type HandoffKey = (typeof HANDOFF_ITEMS)[number]['key']

export type HandoffPackage = Partial<Record<HandoffKey, unknown>>

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

// „Rizika" smí být vědomě prázdná (žádná nevyřešená) — pak je potřeba poslat
// prázdné pole explicitně; chybějící klíč znamená „nevyplněno".
export function validateHandoff(pkg: HandoffPackage): { ok: boolean; missing: HandoffKey[] } {
  const missing = HANDOFF_ITEMS.map((i) => i.key).filter((key) => {
    const v = pkg[key]
    if (key === 'risks') return !Array.isArray(v) && !isPresent(v)
    return !isPresent(v)
  })
  return { ok: missing.length === 0, missing }
}

// Kde položku doplnit — nápověda v kontrolním seznamu na stránce dodávky
// (karta na Přehledu i záložka Předání, proto záložkou, ne „níže").
export const HANDOFF_HINT: Record<HandoffKey, string> = {
  goal: 'Vyplň Cíl v záložce Předání.',
  scope: 'Vyplň Rozsah v záložce Předání.',
  approvedOffer: 'V záložce Předání vyber obchod této firmy ve fázi Vyhráno.',
  clientSponsor: 'V záložce Předání vyber Klientského sponzora.',
  dates: 'V záložce Údaje doplň Zahájeno i Termín (konec dodávky).',
  baselineMetric: 'V záložce Dopad zapiš výchozí stav hlavní metriky, nebo dolož, proč zatím měřit nejde.',
  financialFrame: 'Vyplň Finanční rámec v záložce Předání.',
  materials: 'V záložce Dokumenty přidej aspoň jeden odkaz do SharePointu.',
  risks: 'V záložce Předání vypiš rizika, nebo zaškrtni „Žádná nevyřešená rizika".',
  owner: 'V záložce Milníky přiřaď vlastníka aspoň jednomu milníku (Upravit).',
}

export function handoffLabel(key: HandoffKey): string {
  return HANDOFF_ITEMS.find((i) => i.key === key)?.label ?? key
}

// Vstup pro buildHandoffPackage — řádek engagement (sloupce z 0001/0054)
// a počty z navázaných tabulek.
export type HandoffSource = {
  goal: string | null
  scope: string | null
  deal_id: number | null
  /**
   * Je navázaný obchod „vyhráno"? Schválená nabídka = vyhraný obchod. Bere se
   * z deal_public (0058), které dodávkovým rolím dává jen tenhle příznak.
   */
  deal_is_won: boolean
  client_sponsor_contact_id: number | null
  started_on: string | null
  due_on: string | null
  /** Výchozí metrika je v pořádku (baselineMetricOk z impactMetric.ts). */
  baseline_ok: boolean
  financial_frame: string | null
  risks: string[] | null
  documentCount: number
  milestoneOwnerCount: number
}

export function buildHandoffPackage(src: HandoffSource): HandoffPackage {
  return {
    goal: src.goal,
    scope: src.scope,
    approvedOffer: src.deal_id !== null && src.deal_is_won ? src.deal_id : null,
    clientSponsor: src.client_sponsor_contact_id,
    // Termíny = začátek i konec; jeden bez druhého není plán.
    dates: src.started_on && src.due_on ? `${src.started_on}–${src.due_on}` : null,
    baselineMetric: src.baseline_ok ? true : null,
    financialFrame: src.financial_frame,
    materials: src.documentCount > 0 ? src.documentCount : null,
    // null = nevyplněno; [] = vědomě žádná (validateHandoff to rozlišuje).
    risks: src.risks ?? undefined,
    owner: src.milestoneOwnerCount > 0 ? src.milestoneOwnerCount : null,
  }
}

// ---------------------------------------------------------------------------
// Vstupy formulářů (zod). Sdílí je server akce (domain/delivery/actions/
// milestones.ts) i testy.

const entityId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const optionalId = z.preprocess((v) => (v === '' || v == null ? null : v), entityId.nullable())
const optionalUuid = z.preprocess((v) => (v === '' || v == null ? null : v), z.uuid('Neplatný člen týmu.').nullable())

// Skutečný kalendářní den v rozumném rozsahu: 31. 2. nebo rok 20266 by jinak
// prošly až do databáze a skončily obecnou chybou.
function isRealDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return y >= 2000 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Neplatné datum.').refine(isRealDate, 'Neplatné datum.')
const optionalDate = z.preprocess((v) => (v === '' || v == null ? null : v), isoDate.nullable())
const optionalText = (max: number, msg: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v ?? null),
    z.string().trim().max(max, msg).nullable(),
  )

export const milestoneCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Vyplň název milníku.').max(300, 'Nejvýš 300 znaků.'),
    owner_id: optionalUuid,
    deputy_id: optionalUuid,
    due_on: optionalDate,
  })
  .refine((m) => !m.owner_id || !m.deputy_id || m.owner_id !== m.deputy_id, {
    path: ['deputy_id'],
    message: 'Zástupce musí být jiný člověk než vlastník.',
  })

// Úprava existujícího milníku: stejná pole a pravidla jako při založení
// (prázdný termín = bez termínu, prázdný vlastník = nepřiřazen).
export const milestoneUpdateSchema = milestoneCreateSchema

// Rychlé doplnění termínu (milník bez termínu, typicky po vyhraném obchodu,
// 0080): jen datum, povinné.
export const milestoneDueSchema = z.object({
  due_on: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : ''),
    z.string().min(1, 'Vyber termín.').regex(/^\d{4}-\d{2}-\d{2}$/, 'Neplatné datum.').refine(isRealDate, 'Neplatné datum.'),
  ),
})

// Akceptace: buď vybraný existující dokument dodávky, nebo nový odkaz do
// SharePointu (název + URL), který se založí jako dokument. Datum akceptace
// nesmí být v budoucnosti (porovnává volající — potřebuje „dnes").
export const milestoneAcceptSchema = z
  .object({
    document_id: optionalId,
    new_title: optionalText(200, 'Nejvýš 200 znaků.'),
    new_url: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v ?? null),
      z
        .string()
        .trim()
        .max(2000, 'Odkaz je moc dlouhý.')
        .regex(SHAREPOINT_URL_RE, 'Odkaz musí vést na SharePoint (https://…sharepoint.com/…).')
        .nullable(),
    ),
    accepted_on: isoDate,
    accepted_by_contact_id: optionalId,
  })
  .superRefine((v, ctx) => {
    const hasNew = v.new_url !== null || v.new_title !== null
    if (v.document_id === null && !hasNew) {
      ctx.addIssue({ code: 'custom', path: ['document_id'], message: 'Vyber dokument, kterým klient akceptaci potvrdil, nebo přidej nový odkaz.' })
    }
    if (v.document_id !== null && hasNew) {
      ctx.addIssue({ code: 'custom', path: ['document_id'], message: 'Vyber buď existující dokument, nebo nový odkaz — ne obojí.' })
    }
    if (v.document_id === null && hasNew) {
      if (v.new_url === null) ctx.addIssue({ code: 'custom', path: ['new_url'], message: 'Vyplň odkaz na SharePoint.' })
      if (v.new_title === null) ctx.addIssue({ code: 'custom', path: ['new_title'], message: 'Vyplň název dokumentu.' })
    }
  })

export const RISK_MAX_LENGTH = 500
export const RISKS_MAX = 30

// Rizika z textarea: jedno na řádek. Zaškrtnuté „žádná nevyřešená rizika"
// = []; prázdná textarea bez zaškrtnutí = null (nevyplněno).
export const handoffSchema = z
  .object({
    goal: optionalText(2000, 'Nejvýš 2000 znaků.'),
    scope: optionalText(4000, 'Nejvýš 4000 znaků.'),
    deal_id: optionalId,
    client_sponsor_contact_id: optionalId,
    financial_frame: optionalText(2000, 'Nejvýš 2000 znaků.'),
    risks_text: z.preprocess((v) => (typeof v === 'string' ? v : ''), z.string()),
    no_risks: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
  })
  .transform((v, ctx) => {
    const lines = v.risks_text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length > 0 && v.no_risks) {
      ctx.addIssue({ code: 'custom', path: ['risks_text'], message: 'Buď vypiš rizika, nebo zaškrtni, že žádná nejsou — ne obojí.' })
      return z.NEVER
    }
    if (lines.length > RISKS_MAX) {
      ctx.addIssue({ code: 'custom', path: ['risks_text'], message: `Nejvýš ${RISKS_MAX} rizik.` })
      return z.NEVER
    }
    if (lines.some((l) => l.length > RISK_MAX_LENGTH)) {
      ctx.addIssue({ code: 'custom', path: ['risks_text'], message: `Jedno riziko má nejvýš ${RISK_MAX_LENGTH} znaků.` })
      return z.NEVER
    }
    const risks: string[] | null = lines.length > 0 ? lines : v.no_risks ? [] : null
    return {
      goal: v.goal,
      scope: v.scope,
      deal_id: v.deal_id,
      client_sponsor_contact_id: v.client_sponsor_contact_id,
      financial_frame: v.financial_frame,
      risks,
    }
  })
