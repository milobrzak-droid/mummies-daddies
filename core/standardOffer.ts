// Schopnost „standardní nabídka z mapy" (Loop Core). Čistý výpočet bez
// sítě, databáze a modelu: vstup jsou parametry poptávky (OfferInquiry —
// vytáhne je model z e-mailu, ale tady jsou to jen data ověřená schématem)
// a schválená mapa firmy (PriceMapConfig z @/config). Výstup je jeden ze
// tří výsledků:
//
//   standard   — poptávka spadá celá do mapy; nabídku smí agent odeslat sám
//   needs_info — chybí údaje; agent se smí zákazníka doptat (nic nenabízí)
//   escalate   — výjimka mimo mapu; rozhodne člověk (uzel escalationNode).
//                Pokud jde nabídku spočítat, přiloží se jako koncept.
//
// Zásada: model cenu nikdy nepočítá ani neupravuje. Co mapa neumí, je
// výjimka — nikdy odhad. Všechny částky jsou celé Kč bez DPH; DPH se
// počítá po sazbách podle druhu plnění (jídlo, obsluha, doprava, pronájem,
// alkohol) ze součtu základů každé sazby. Spotřebitelům (segment
// s pricesIncludeVat) text nabídky ukazuje ceny včetně DPH.
import { z } from 'zod'
import type { PriceMapConfig, PriceMapPackage, StandardOfferConfig, VatClass } from './tenant'

// --- Vstup ----------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum ve tvaru YYYY-MM-DD.')
const key = z.string().trim().min(1).max(40)

/** Parametry poptávky. Chybějící údaj je null (nikdy odhad). */
export const offerInquirySchema = z.object({
  segment: key.nullable(),
  eventType: key.nullable(),
  eventDate: isoDate.nullable(),
  guests: z.number().int().positive().max(100_000).nullable(),
  packageKey: key.nullable().default(null),
  durationHours: z.number().positive().max(24).nullable().default(null),
  /** Vzdálenost místa akce od provozovny (jedna cesta, km). Doplní ji geokódování, ne model. */
  distanceKm: z.number().min(0).max(10_000).nullable().default(null),
  extras: z.array(key).max(30).default([]),
  dietary: z.array(z.object({ key, guests: z.number().int().positive() })).max(20).default([]),
  /** Přání, která mapa nepokrývá (volný text z poptávky). Neprázdné = výjimka. */
  specialRequests: z.string().trim().max(2000).nullable().default(null),
  /** Kontakt označený v CRM jako citlivý / VIP (z CRM, ne od modelu). */
  vipContact: z.boolean().default(false),
})

export type OfferInquiry = z.infer<typeof offerInquirySchema>
export type OfferInquiryInput = z.input<typeof offerInquirySchema>

// --- Výstup ---------------------------------------------------------------

export type MissingField = 'segment' | 'eventType' | 'eventDate' | 'guests' | 'distanceKm'

export type EscalationCode =
  | 'map_expired'
  | 'unknown_segment'
  | 'unknown_event_type'
  | 'non_standard_package'
  | 'guests_out_of_range'
  | 'date_in_past'
  | 'date_too_soon'
  | 'date_too_far'
  | 'distance_over_limit'
  | 'unknown_extra'
  | 'unsupported_diet'
  | 'dietary_exceeds_guests'
  | 'special_request'
  | 'vip_contact'
  | 'over_auto_send_limit'
  | 'extraction_failed'

export type EscalationReason = { code: EscalationCode; message: string }

export type OfferLine = {
  key: string
  label: string
  quantity: number
  unit: 'host' | 'akce' | 'hod.' | 'km' | 'číšník·hod.' | '%'
  unitPrice: number
  total: number
  /** Druh plnění a sazba DPH řádku. */
  vatClass: VatClass
  vatRate: number
}

/** DPH za jednu sazbu: základ (součet řádků bez DPH) a daň zaokrouhlená na Kč. */
export type VatBreakdown = { rate: number; base: number; vat: number }

export type OfferQuote = {
  mapVersion: string
  segment: string
  eventType: string
  eventTypeLabel: string
  package: PriceMapPackage
  eventDate: string
  guests: number
  lines: OfferLine[]
  subtotal: number
  vat: number
  /** DPH po sazbách (vzestupně podle sazby); součet `vat` = `vat` nabídky. */
  vatBreakdown: VatBreakdown[]
  total: number
  /** Text nabídky ukazuje ceny včetně DPH (spotřebitel). */
  pricesIncludeVat: boolean
  currency: 'CZK'
  issuedAt: string
  validUntil: string
}

export type OfferResult =
  | { kind: 'standard'; quote: OfferQuote }
  | { kind: 'needs_info'; missing: MissingField[] }
  | { kind: 'escalate'; reasons: EscalationReason[]; missing: MissingField[]; draft: OfferQuote | null }

// --- Datumy (bez časového pásma: `today` dodá volající v pásmu firmy) ------

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * 86_400_000).toISOString().slice(0, 10)
}

function isWeekend(iso: string): boolean {
  const dow = new Date(dayNumber(iso) * 86_400_000).getUTCDay()
  return dow === 0 || dow === 6
}

const minIso = (...xs: string[]) => xs.reduce((a, b) => (a < b ? a : b))

// --- Výpočet --------------------------------------------------------------

/**
 * Vyhodnotí poptávku proti mapě. `today` je dnešní den v pásmu firmy
 * (YYYY-MM-DD). Funkce je čistá: stejný vstup = stejný výsledek.
 */
export function evaluateStandardOffer(
  cfg: Pick<StandardOfferConfig, 'priceMap'>,
  rawInquiry: OfferInquiryInput,
  today: string,
): OfferResult {
  const map = cfg.priceMap
  const q = offerInquirySchema.parse(rawInquiry)
  const reasons: EscalationReason[] = []
  const missing: MissingField[] = []
  const esc = (code: EscalationCode, message: string) => reasons.push({ code, message })

  if (today > map.validUntil) {
    esc('map_expired', `Mapa nabídek ${map.version} platila do ${map.validUntil}; je potřeba schválit novou verzi.`)
  }

  // Segment → typ akce → balíček
  const segment = q.segment ? map.segments.find((s) => s.key === q.segment) : undefined
  if (!q.segment) missing.push('segment')
  else if (!segment) esc('unknown_segment', `Segment „${q.segment}" mapa nezná.`)

  const eventType = q.eventType && segment ? segment.eventTypes.find((e) => e.key === q.eventType) : undefined
  if (!q.eventType) missing.push('eventType')
  else if (segment && !eventType) esc('unknown_event_type', `Typ akce „${q.eventType}" není v segmentu ${segment.label} standardní.`)

  let pkg: PriceMapPackage | undefined
  if (eventType) {
    const pkgKey = q.packageKey ?? eventType.defaultPackage
    if (!eventType.packages.includes(pkgKey)) {
      esc('non_standard_package', `Balíček „${pkgKey}" není pro ${eventType.label} ve standardní nabídce.`)
    } else {
      pkg = map.packages.find((p) => p.key === pkgKey)
      if (!pkg) esc('non_standard_package', `Balíček „${pkgKey}" v mapě chybí.`)
    }
  }

  // Hosté
  if (q.guests == null) missing.push('guests')
  else if (pkg && (q.guests < pkg.minGuests || q.guests > pkg.maxGuests)) {
    esc('guests_out_of_range', `${q.guests} hostů je mimo rozsah balíčku ${pkg.label} (${pkg.minGuests}–${pkg.maxGuests}).`)
  }

  // Termín
  if (q.eventDate == null) missing.push('eventDate')
  else if (!isRealDate(q.eventDate)) missing.push('eventDate')
  else {
    const lead = dayNumber(q.eventDate) - dayNumber(today)
    if (lead < 0) esc('date_in_past', `Termín ${q.eventDate} už proběhl.`)
    else if (lead < map.minLeadDays) esc('date_too_soon', `Akce je za ${lead} dní; standardně nejdřív za ${map.minLeadDays} dní.`)
    else if (lead > map.maxLeadDays) esc('date_too_far', `Akce je za ${lead} dní; mapa pokrývá nejvýš ${map.maxLeadDays} dní dopředu.`)
  }

  // Doprava
  if (q.distanceKm == null) missing.push('distanceKm')
  else if (q.distanceKm > map.delivery.maxKm) {
    esc('distance_over_limit', `Místo akce je ${q.distanceKm} km od provozovny; standardně nejvýš ${map.delivery.maxKm} km.`)
  }

  // Doplňky a diety
  const extras = q.extras.map((k) => ({ k, extra: map.extras.find((e) => e.key === k) }))
  for (const { k, extra } of extras) if (!extra) esc('unknown_extra', `Doplněk „${k}" není ve standardní nabídce.`)
  const diets = q.dietary.map((d) => ({ ...d, diet: map.dietary.find((x) => x.key === d.key) }))
  for (const d of diets) if (!d.diet) esc('unsupported_diet', `Dietní varianta „${d.key}" není ve standardní nabídce.`)
  const dietGuests = q.dietary.reduce((s, d) => s + d.guests, 0)
  if (q.guests != null && dietGuests > q.guests) {
    esc('dietary_exceeds_guests', `Dietních porcí (${dietGuests}) je víc než hostů (${q.guests}).`)
  }

  if (q.specialRequests) esc('special_request', `Zvláštní přání mimo mapu: ${q.specialRequests.slice(0, 300)}`)
  if (q.vipContact) esc('vip_contact', 'Kontakt je v CRM označený jako citlivý / VIP.')

  // Spočítat jde jen s kompletními a platnými údaji.
  const draft =
    segment && eventType && pkg && q.guests != null && q.eventDate != null && isRealDate(q.eventDate) &&
    q.distanceKm != null && extras.every((x) => x.extra) && diets.every((d) => d.diet)
      ? priceQuote(map, {
          segment: segment.key, pricesIncludeVat: segment.pricesIncludeVat === true, eventType: eventType.key, eventTypeLabel: eventType.label, pkg,
          guests: q.guests, eventDate: q.eventDate, durationHours: q.durationHours, distanceKm: q.distanceKm,
          extras: extras.map((x) => x.extra!), diets: diets.map((d) => ({ diet: d.diet!, guests: d.guests })),
        }, today)
      : null

  if (draft && draft.subtotal > map.autoSendMaxTotal) {
    esc('over_auto_send_limit', `Nabídka ${formatCzk(draft.subtotal)} bez DPH je nad limitem pro samostatné odeslání (${formatCzk(map.autoSendMaxTotal)}).`)
  }

  if (reasons.length > 0) return { kind: 'escalate', reasons, missing, draft }
  if (missing.length > 0 || !draft) return { kind: 'needs_info', missing }
  return { kind: 'standard', quote: draft }
}

type PricingInput = {
  segment: string
  pricesIncludeVat: boolean
  eventType: string
  eventTypeLabel: string
  pkg: PriceMapPackage
  guests: number
  eventDate: string
  durationHours: number | null
  distanceKm: number
  extras: PriceMapConfig['extras'][number][]
  diets: { diet: PriceMapConfig['dietary'][number]; guests: number }[]
}

function priceQuote(map: PriceMapConfig, x: PricingInput, today: string): OfferQuote {
  const lines: OfferLine[] = []
  const rateOf = (c: VatClass) => map.vatRates?.[c] ?? map.vatRate
  const line = (l: Omit<OfferLine, 'total' | 'vatClass' | 'vatRate'> & { total?: number; vatClass: VatClass }) =>
    lines.push({ ...l, total: l.total ?? Math.round(l.quantity * l.unitPrice), vatRate: rateOf(l.vatClass) })

  const hours = Math.max(map.staff.minHours, Math.ceil(x.durationHours ?? map.staff.defaultHours))

  line({ key: `package:${x.pkg.key}`, label: x.pkg.label, quantity: x.guests, unit: 'host', unitPrice: x.pkg.pricePerGuest, vatClass: 'food' })
  const food = lines[0].total

  for (const d of x.diets) {
    if (d.diet.surchargePerGuest > 0) {
      line({ key: `diet:${d.diet.key}`, label: `Příplatek: ${d.diet.label}`, quantity: d.guests, unit: 'host', unitPrice: d.diet.surchargePerGuest, vatClass: 'food' })
    }
  }

  if (isWeekend(x.eventDate) && map.weekendSurchargePct > 0) {
    line({
      key: 'weekend', label: 'Víkendový příplatek', quantity: map.weekendSurchargePct, unit: '%', unitPrice: food,
      total: Math.round((food * map.weekendSurchargePct) / 100), vatClass: 'food',
    })
  }

  if (x.pkg.service) {
    const waiters = Math.ceil(x.guests / map.staff.guestsPerWaiter)
    line({ key: 'staff', label: `Obsluha (${waiters} × ${hours} h)`, quantity: waiters * hours, unit: 'číšník·hod.', unitPrice: map.staff.pricePerWaiterHour, vatClass: 'service' })
  }

  for (const e of x.extras) {
    const quantity = e.unit === 'guest' ? x.guests : e.unit === 'hour' ? hours : 1
    const unit = e.unit === 'guest' ? 'host' : e.unit === 'hour' ? 'hod.' : 'akce'
    line({ key: `extra:${e.key}`, label: e.label, quantity, unit, unitPrice: e.price, vatClass: e.vatClass ?? 'food' })
  }

  const extraKm = Math.ceil(Math.max(0, x.distanceKm - map.delivery.includedKm))
  if (extraKm > 0) {
    line({ key: 'delivery', label: `Doprava nad ${map.delivery.includedKm} km (tam i zpět)`, quantity: extraKm * 2, unit: 'km', unitPrice: map.delivery.pricePerKm, vatClass: 'delivery' })
  }

  const subtotal = lines.reduce((s, l) => s + l.total, 0)
  const bases = new Map<number, number>()
  for (const l of lines) bases.set(l.vatRate, (bases.get(l.vatRate) ?? 0) + l.total)
  const vatBreakdown = [...bases.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, base]) => ({ rate, base, vat: Math.round(base * rate) }))
  const vat = vatBreakdown.reduce((s, b) => s + b.vat, 0)
  return {
    mapVersion: map.version,
    segment: x.segment,
    pricesIncludeVat: x.pricesIncludeVat,
    eventType: x.eventType,
    eventTypeLabel: x.eventTypeLabel,
    package: x.pkg,
    eventDate: x.eventDate,
    guests: x.guests,
    lines,
    subtotal,
    vat,
    vatBreakdown,
    total: subtotal + vat,
    currency: map.currency,
    issuedAt: today,
    // Nabídka neplatí déle než do dne před akcí ani po konci platnosti mapy.
    validUntil: minIso(addDays(today, map.offerValidityDays), addDays(x.eventDate, -1), map.validUntil),
  }
}

// --- Kontrola mapy ------------------------------------------------------------

/** Vnitřní rozpory mapy (prázdné pole = v pořádku). Hlídá test pro každou firmu. */
export function priceMapProblems(map: PriceMapConfig): string[] {
  const out: string[] = []
  const keyRe = /^[a-z][a-z0-9_]{0,39}$/
  const pkgKeys = new Set(map.packages.map((p) => p.key))
  const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i)

  if (!/^\d{4}-\d{2}-\d{2}$/.test(map.approvedAt) || !isRealDate(map.approvedAt)) out.push('approvedAt není datum')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(map.validUntil) || !isRealDate(map.validUntil)) out.push('validUntil není datum')
  if (map.validUntil < map.approvedAt) out.push('validUntil je před approvedAt')
  if (!(map.vatRate >= 0 && map.vatRate < 1)) out.push('vatRate mimo 0–1')
  for (const [k, r] of Object.entries(map.vatRates ?? {})) if (!(typeof r === 'number' && r >= 0 && r < 1)) out.push(`vatRates.${k} mimo 0–1`)
  if (map.minLeadDays < 0 || map.maxLeadDays < map.minLeadDays) out.push('minLeadDays/maxLeadDays')
  if (map.offerValidityDays < 1) out.push('offerValidityDays < 1')
  if (map.staff.guestsPerWaiter < 1) out.push('staff.guestsPerWaiter < 1')

  for (const d of dupes(map.packages.map((p) => p.key))) out.push(`duplicitní balíček ${d}`)
  for (const d of dupes(map.extras.map((p) => p.key))) out.push(`duplicitní doplněk ${d}`)
  for (const d of dupes(map.dietary.map((p) => p.key))) out.push(`duplicitní dieta ${d}`)
  for (const d of dupes(map.segments.map((p) => p.key))) out.push(`duplicitní segment ${d}`)

  for (const p of map.packages) {
    if (!keyRe.test(p.key)) out.push(`klíč balíčku ${p.key}`)
    if (!Number.isInteger(p.pricePerGuest) || p.pricePerGuest <= 0) out.push(`cena balíčku ${p.key}`)
    if (p.minGuests < 1 || p.maxGuests < p.minGuests) out.push(`rozsah hostů balíčku ${p.key}`)
  }
  for (const e of map.extras) {
    if (!keyRe.test(e.key)) out.push(`klíč doplňku ${e.key}`)
    if (!Number.isInteger(e.price) || e.price < 0) out.push(`cena doplňku ${e.key}`)
  }
  for (const s of map.segments) {
    for (const d of dupes(s.eventTypes.map((e) => e.key))) out.push(`duplicitní typ akce ${s.key}.${d}`)
    for (const e of s.eventTypes) {
      if (!e.packages.includes(e.defaultPackage)) out.push(`výchozí balíček ${s.key}.${e.key} není mezi balíčky typu`)
      for (const p of e.packages) if (!pkgKeys.has(p)) out.push(`typ ${s.key}.${e.key} odkazuje na neznámý balíček ${p}`)
    }
  }
  return out
}

// --- Texty pro zákazníka ------------------------------------------------------

const czk = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 })
export const formatCzk = (n: number) => `${czk.format(n)} Kč`

function czDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d}. ${m}. ${y}`
}

const czkDec = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const formatCzkDec = (n: number) => `${czkDec.format(Math.round(n * 100) / 100)} Kč`
const pct = (rate: number) => `${czk.format(Math.round(rate * 1000) / 10)} %`

/**
 * Text e-mailu se standardní nabídkou. Neobsahuje nic, co nespočítal kód.
 * Nabídka je NEZÁVAZNÁ kalkulace: smlouva vzniká až písemným potvrzením
 * firmy (patičku s údaji firmy, obchodními a storno podmínkami připojí
 * odchozí fronta, core/agents/outboxPolicy.ts#customerText).
 */
export function renderOfferEmail(
  quote: OfferQuote,
  ctx: { companyName: string; signature: string; customerName?: string | null },
): { subject: string; body: string } {
  const greeting = ctx.customerName ? `Dobrý den, ${ctx.customerName},` : 'Dobrý den,'
  const gross = quote.pricesIncludeVat
  const rows = quote.lines.map((l) => {
    const k = gross ? 1 + l.vatRate : 1
    const total = gross ? formatCzkDec(l.total * k) : formatCzk(l.total)
    return l.unit === '%'
      ? `- ${l.label} (${l.quantity} %): ${total}`
      : `- ${l.label}: ${czk.format(l.quantity)} ${l.unit} × ${gross ? formatCzkDec(l.unitPrice * k) : formatCzk(l.unitPrice)} = ${total}`
  })
  const vatRows = quote.vatBreakdown.map((b) => `DPH ${pct(b.rate)} ze základu ${formatCzk(b.base)}: ${formatCzk(b.vat)}`)
  const totals = gross
    ? [`Celkem včetně DPH: ${formatCzk(quote.total)}`, 'z toho:', ...vatRows.map((r) => `- ${r}`), `Cena bez DPH: ${formatCzk(quote.subtotal)}`]
    : [`Celkem bez DPH: ${formatCzk(quote.subtotal)}`, ...vatRows, `Celkem s DPH: ${formatCzk(quote.total)}`]
  const body = [
    greeting,
    '',
    `děkujeme za poptávku. Posíláme nabídku na ${quote.eventTypeLabel.toLowerCase()} dne ${czDate(quote.eventDate)} pro ${quote.guests} hostů.`,
    '',
    `Balíček ${quote.package.label} obsahuje:`,
    ...quote.package.includes.map((i) => `- ${i}`),
    '',
    gross ? 'Cena (včetně DPH):' : 'Cena (bez DPH):',
    ...rows,
    '',
    ...totals,
    '',
    `Kalkulace je nezávazná a platí do ${czDate(quote.validUntil)}. Termín i objednávka jsou závazné až po písemném potvrzení z naší strany.`,
    'Pokud chcete cokoli upravit, stačí odpovědět na tento e-mail.',
    '',
    'S pozdravem',
    ctx.signature,
  ].join('\n')
  return { subject: `Nabídka cateringu – ${czDate(quote.eventDate)}, ${quote.guests} hostů (${ctx.companyName})`, body }
}

const QUESTIONS: Record<MissingField, string> = {
  segment: 'Jde o firemní akci, nebo soukromou oslavu?',
  eventType: 'O jaký typ akce jde (např. raut, coffee break, oslava, svatba)?',
  eventDate: 'Na jaký den je akce plánovaná?',
  guests: 'Kolik hostů očekáváte?',
  distanceKm: 'Na jaké přesné adrese se akce bude konat (ulice, číslo, obec)?',
}

/** E-mail s doptáním chybějících údajů. Nic nenabízí ani neslibuje. */
export function renderInfoRequest(missing: readonly MissingField[], ctx: { signature: string; customerName?: string | null }): string {
  const greeting = ctx.customerName ? `Dobrý den, ${ctx.customerName},` : 'Dobrý den,'
  return [
    greeting,
    '',
    'děkujeme za poptávku. Abychom Vám mohli rovnou poslat nabídku, potřebujeme ještě doplnit:',
    ...missing.map((m) => `- ${QUESTIONS[m]}`),
    '',
    'S pozdravem',
    ctx.signature,
  ].join('\n')
}
