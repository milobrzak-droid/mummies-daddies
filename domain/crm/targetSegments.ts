// Pravidla segmentů cílových seznamů — čistá logika bez DB.
//
// Na detailu cílového seznamu tlačítko „Navrhnout firmy podle segmentu"
// projde firmy v CRM a ty, které odpovídají pravidlu segmentu seznamu
// (COMPANY.targetSegments v config/mummiesDaddies.ts, klíč = target_list.segment),
// vloží jako položky ve stavu „navrzeno" s důvodem z tohohle modulu.
// Člověk pak návrh potvrdí (osloveno) nebo vyřadí — automat nikoho
// neoslovuje a na obchody nesahá.
//
// Porovnání oboru a regionu je bez ohledu na velikost písmen a diakritiku
// („VYROBA – telekom" = „Výroba – telekom"). Obor: prefix celého textu
// (kategorie před pomlčkou, i část slova) NEBO klíčové slovo = začátek
// kteréhokoli slova v textu. Region: shoda s hodnotou pravidla (celý název
// nebo upřesnění za mezerou/pomlčkou: „Praha 4", „Praha-východ"), nebo kraj
// poznaný z názvu kraje či okresního města („Kladno" → Středočeský kraj).
// Vyřadí se jen firma, jejíž region JISTĚ leží v jiném kraji. Bez regionu
// nebo s obcí, kterou neumíme zařadit, firma projde a důvod nese „region
// neověřen" — rozhodne člověk (podrobnosti u krajOf níž).
import { COMPANY } from '@/config'
import type { TargetAccountStatus, TargetSegmentRule } from '@/core/tenant'
import type { ActionResult } from '@/lib/actionResult'
import { OPEN_DEAL_STAGE_KEYS } from '@/lib/domain'
import { normalizeDealStage } from '@/lib/dealStageLegacy'

export type { TargetAccountStatus, TargetSegmentRule }
export type TargetSegmentRules = Readonly<Record<string, TargetSegmentRule>>

/** Kolik návrhů nejvýš vloží jedno kliknutí (zbytek při dalším). */
export const SUGGEST_CAP = 300

/** Výsledek akce „Navrhnout firmy podle segmentu" — souhrn do UI. */
export type SuggestResult = ActionResult & { message?: string }

// --- normalizace --------------------------------------------------------------

/** Malá písmena bez diakritiky; vše kromě písmen a číslic → jedna mezera. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function industryMatch(industry: string, rule: TargetSegmentRule): boolean {
  const hay = foldText(industry)
  if (!hay) return false
  for (const p of rule.industryPrefixes) {
    const needle = foldText(p)
    if (needle && hay.startsWith(needle)) return true
  }
  const words = ` ${hay}`
  for (const k of rule.industryKeywords ?? []) {
    const needle = foldText(k)
    if (needle && words.includes(` ${needle}`)) return true
  }
  return false
}

// --- region ------------------------------------------------------------------
//
// account.region je volný text „Region / sídlo" a plní se různě: kraj
// z ARESu (sidlo.nazevKraje) píše jen doplnění IČO a prospekt ze schůzky;
// formulář firmy (ARES lookup), import nabídky, plánování schůzky
// a importní skripty píšou OBEC (sidlo.nazevObce: „Kladno", „Praha");
// ručně kdokoli cokoli. Obec proto nesmí firmu vyřadit jen proto, že není
// v pravidle — vyřadí ji jen kraj, který poznáme jistě.

/** Kraje přesně v podobě, jak je vrací ARES (sidlo.nazevKraje). */
export const KRAJE = [
  'Hlavní město Praha', 'Středočeský kraj', 'Jihočeský kraj', 'Plzeňský kraj',
  'Karlovarský kraj', 'Ústecký kraj', 'Liberecký kraj', 'Královéhradecký kraj',
  'Pardubický kraj', 'Kraj Vysočina', 'Jihomoravský kraj', 'Olomoucký kraj',
  'Zlínský kraj', 'Moravskoslezský kraj',
] as const
export type Kraj = (typeof KRAJE)[number]

const PRAHA = 'Hlavní město Praha' satisfies Kraj

/**
 * Okresní města a názvy okresů (všech 76 okresů) podle kraje. Praha okresy
 * nemá a pozná se zvlášť („Praha", „Praha 4"); Praha-východ a Praha-západ
 * jsou okresy Středočeského kraje. Menší obce tu nejsou — ty zůstanou
 * „region neověřen", nikdy „mimo region".
 */
export const OKRESY: Readonly<Record<Exclude<Kraj, typeof PRAHA>, readonly string[]>> = {
  'Středočeský kraj': ['Benešov', 'Beroun', 'Kladno', 'Kolín', 'Kutná Hora', 'Mělník', 'Mladá Boleslav',
    'Nymburk', 'Praha-východ', 'Praha-západ', 'Příbram', 'Rakovník'],
  'Jihočeský kraj': ['České Budějovice', 'Český Krumlov', 'Jindřichův Hradec', 'Písek', 'Prachatice',
    'Strakonice', 'Tábor'],
  'Plzeňský kraj': ['Domažlice', 'Klatovy', 'Plzeň', 'Plzeň-město', 'Plzeň-jih', 'Plzeň-sever', 'Rokycany', 'Tachov'],
  'Karlovarský kraj': ['Cheb', 'Karlovy Vary', 'Sokolov'],
  'Ústecký kraj': ['Děčín', 'Chomutov', 'Litoměřice', 'Louny', 'Most', 'Teplice', 'Ústí nad Labem'],
  'Liberecký kraj': ['Česká Lípa', 'Jablonec nad Nisou', 'Liberec', 'Semily'],
  'Královéhradecký kraj': ['Hradec Králové', 'Jičín', 'Náchod', 'Rychnov nad Kněžnou', 'Trutnov'],
  'Pardubický kraj': ['Chrudim', 'Pardubice', 'Svitavy', 'Ústí nad Orlicí'],
  'Kraj Vysočina': ['Havlíčkův Brod', 'Jihlava', 'Pelhřimov', 'Třebíč', 'Žďár nad Sázavou'],
  'Jihomoravský kraj': ['Blansko', 'Brno', 'Brno-město', 'Brno-venkov', 'Břeclav', 'Hodonín', 'Vyškov', 'Znojmo'],
  'Olomoucký kraj': ['Jeseník', 'Olomouc', 'Prostějov', 'Přerov', 'Šumperk'],
  'Zlínský kraj': ['Kroměříž', 'Uherské Hradiště', 'Vsetín', 'Zlín'],
  'Moravskoslezský kraj': ['Bruntál', 'Frýdek-Místek', 'Karviná', 'Nový Jičín', 'Opava', 'Ostrava', 'Ostrava-město'],
}

const KRAJ_BY_NAME = new Map<string, Kraj>(KRAJE.map((k) => [foldText(k), k]))
const KRAJ_BY_PLACE = new Map<string, Kraj>(
  (Object.entries(OKRESY) as [Kraj, readonly string[]][]).flatMap(([kraj, places]) =>
    places.map((place) => [foldText(place), kraj] as const)),
)

/**
 * Kraj, ve kterém region jistě leží, jinak null. Pozná název kraje (i uvnitř
 * delšího textu: „Kladno, Středočeský kraj"), Prahu a její obvody („Praha",
 * „Praha 4 – Chodov") a okresní město nebo okres jen jako celý text
 * („Kladno", „Brno-venkov"; „Benešov nad Ploučnicí" okres Benešov není).
 * Dva různé kraje v jednom textu nebo neznámý „… kraj" = nevíme (null).
 */
export function krajOf(region: string): Kraj | null {
  const r = foldText(region)
  if (!r) return null
  const place = KRAJ_BY_PLACE.get(r)
  if (place) return place
  if (r === 'praha' || /^praha \d{1,2}( |$)/.test(r)) return PRAHA
  const padded = ` ${r} `
  const named = new Set<Kraj>()
  for (const [name, kraj] of KRAJ_BY_NAME) if (padded.includes(` ${name} `)) named.add(kraj)
  return named.size === 1 ? [...named][0] : null
}

/** Přímá shoda s hodnotou pravidla: celý název nebo upřesnění za mezerou/pomlčkou. */
function regionMatch(region: string, regions: readonly string[]): boolean {
  const r = foldText(region)
  return regions.some((allowed) => {
    const a = foldText(allowed)
    return a !== '' && (r === a || r.startsWith(`${a} `))
  })
}

/** Kraj, který hodnota pravidla zahrnuje CELÝ („Středočeský kraj", „Praha"); obec nebo okres ne. */
function wholeKraj(allowed: string): Kraj | null {
  const a = foldText(allowed)
  return KRAJ_BY_NAME.get(a) ?? (a === 'praha' ? PRAHA : null)
}

type RegionCheck =
  | { verdict: 'ok'; kraj: Kraj | null } // kraj: přes který se region ověřil (do důvodu)
  | { verdict: 'mimo' }
  | { verdict: 'neznamy' }

function checkRegion(region: string, regions: readonly string[]): RegionCheck {
  if (regionMatch(region, regions)) return { verdict: 'ok', kraj: null }
  const kraj = krajOf(region)
  if (!kraj) return { verdict: 'neznamy' }
  if (regions.some((a) => wholeKraj(a) === kraj)) return { verdict: 'ok', kraj }
  // Pravidlo do kraje sahá jen obcí nebo okresem („Kladno") — firma
  // s regionem „Středočeský kraj" tam být může, jen to nevíme.
  if (regions.some((a) => krajOf(a) === kraj)) return { verdict: 'neznamy' }
  return { verdict: 'mimo' }
}

/** „Kladno (Středočeský kraj)"; kraj se nepřidá, když už v textu je. */
function regionLabel(region: string, kraj: Kraj | null): string {
  if (!kraj || ` ${foldText(region)} `.includes(` ${foldText(kraj)} `)) return region
  return `${region} (${kraj})`
}

// --- vztah firmy ----------------------------------------------------------------

export type RelationshipFacts = {
  client_since?: string | null
  is_reference?: boolean | null
  /** Fáze všech obchodů firmy (i staré hodnoty před 0050). */
  dealStages: readonly (string | null)[]
  hasEngagement: boolean
  hasRunningSubscription: boolean
}

const OPEN_STAGES: readonly string[] = OPEN_DEAL_STAGE_KEYS

/**
 * Klient = vyhraný obchod, dodávka, běžící předplatné, „klient od" nebo
 * reference. Rozjednaný = otevřený obchod v pipeline. Jinak prospekt.
 * Stejné dělení jako sloupec „Stav" na /clients, jen přísnější k
 * bývalým klientům (dodávka nebo vyhraný obchod z nich prospekt nedělá).
 */
export function accountRelationship(f: RelationshipFacts): TargetAccountStatus {
  const stages = f.dealStages.map((s) => normalizeDealStage(s))
  if (f.client_since || f.is_reference || f.hasEngagement || f.hasRunningSubscription || stages.includes('vyhráno')) {
    return 'klient'
  }
  if (stages.some((s) => s !== null && OPEN_STAGES.includes(s))) return 'aktivni_obchod'
  return 'prospekt'
}

// --- shoda firmy s pravidlem ---------------------------------------------------

export type SegmentAccount = {
  industry: string | null
  region: string | null
  status: TargetAccountStatus
}

export type SegmentVerdict =
  | { ok: true; reason: string; regionVerified: boolean | null }
  | { ok: false; why: 'obor' | 'vztah' | 'region' }

const REASON_MAX = 2000 // CHECK target_list_item.reason (0048)

/**
 * Projde firmu přes jedno pravidlo. Pořadí kontrol: obor → vztah → region.
 * regionVerified: null = pravidlo region nefiltruje, false = firma region
 * nemá nebo ho neumíme zařadit (projde s poznámkou), true = region odpovídá.
 */
export function evaluateSegment(account: SegmentAccount, rule: TargetSegmentRule): SegmentVerdict {
  const industry = account.industry?.trim() ?? ''
  if (!industry || !industryMatch(industry, rule)) return { ok: false, why: 'obor' }
  if (rule.excludeStatuses.includes(account.status)) return { ok: false, why: 'vztah' }
  let regionVerified: boolean | null = null
  let regionNote = ''
  const region = account.region?.trim() ?? ''
  if (rule.regions?.length) {
    const check: RegionCheck = region ? checkRegion(region, rule.regions) : { verdict: 'neznamy' }
    if (check.verdict === 'mimo') return { ok: false, why: 'region' }
    regionVerified = check.verdict === 'ok'
    if (check.verdict === 'ok') regionNote = `; region: ${regionLabel(region, check.kraj)}`
    else regionNote = region ? `; region neověřen (${region})` : '; region neověřen'
  }
  const reason = `Obor: ${industry}${regionNote}`
  return { ok: true, reason: reason.slice(0, REASON_MAX), regionVerified }
}

export type SegmentMatch = { segment: string; label: string; reason: string; regionVerified: boolean | null }

/** Všechny segmenty, do kterých firma patří (s důvodem pro položku seznamu). */
export function matchAccountToSegments(account: SegmentAccount, rules: TargetSegmentRules): SegmentMatch[] {
  const out: SegmentMatch[] = []
  for (const [segment, rule] of Object.entries(rules)) {
    const v = evaluateSegment(account, rule)
    if (v.ok) out.push({ segment, label: rule.label, reason: v.reason, regionVerified: v.regionVerified })
  }
  return out
}

/**
 * Pravidlo pro segment seznamu. Segment se do seznamu píše ručně, proto
 * shoda bez ohledu na velikost písmen, diakritiku a oddělovače
 * („Vyroba Praha" = „vyroba-praha"). Bez pravidla null.
 */
export function segmentRuleFor(
  segment: string | null | undefined,
  rules: TargetSegmentRules = COMPANY.targetSegments,
): { key: string; rule: TargetSegmentRule } | null {
  const wanted = foldText(segment ?? '')
  if (!wanted) return null
  for (const [key, rule] of Object.entries(rules)) {
    if (foldText(key) === wanted) return { key, rule }
  }
  return null
}

// --- plán vložení --------------------------------------------------------------

export type SuggestCandidate = SegmentAccount & { id: number; name: string }

export type SuggestPlan = {
  /** Co vložit (nejvýš cap), ověřený region napřed, pak podle názvu. */
  rows: { account_id: number; reason: string }[]
  /** Firmy, které pravidlu odpovídají (obor, vztah i region). */
  matched: number
  /** Z odpovídajících už v seznamu (v jakémkoli stavu — ty se nemění). */
  alreadyInList: number
  /** Nové nad limit — přijdou na řadu dalším kliknutím. */
  remaining: number
  /** Obor sedí, ale jde o klienta / rozjednaný obchod. */
  excludedStatus: number
  /** Obor sedí, region jistě leží v kraji, který pravidlo nezahrnuje. */
  outsideRegion: number
  /** Z `rows`: bez regionu nebo s regionem, který neumíme zařadit („region neověřen"). */
  unverifiedRegion: number
}

const collator = new Intl.Collator('cs')

export function planSegmentSuggestions(
  accounts: readonly SuggestCandidate[],
  rule: TargetSegmentRule,
  existingAccountIds: ReadonlySet<number>,
  cap: number = SUGGEST_CAP,
): SuggestPlan {
  const fresh: { id: number; name: string; reason: string; regionVerified: boolean | null }[] = []
  let matched = 0
  let alreadyInList = 0
  let excludedStatus = 0
  let outsideRegion = 0
  const seen = new Set<number>()
  for (const a of accounts) {
    if (seen.has(a.id)) continue
    seen.add(a.id)
    const v = evaluateSegment(a, rule)
    if (!v.ok) {
      if (v.why === 'vztah') excludedStatus += 1
      if (v.why === 'region') outsideRegion += 1
      continue
    }
    matched += 1
    if (existingAccountIds.has(a.id)) {
      alreadyInList += 1
      continue
    }
    fresh.push({ id: a.id, name: a.name, reason: v.reason, regionVerified: v.regionVerified })
  }
  fresh.sort((x, y) =>
    Number(y.regionVerified === true) - Number(x.regionVerified === true)
    || collator.compare(x.name, y.name)
    || x.id - y.id)
  const take = fresh.slice(0, Math.max(0, cap))
  return {
    rows: take.map((f) => ({ account_id: f.id, reason: f.reason })),
    matched,
    alreadyInList,
    remaining: fresh.length - take.length,
    excludedStatus,
    outsideRegion,
    unverifiedRegion: take.filter((f) => f.regionVerified === false).length,
  }
}

// --- texty do UI ---------------------------------------------------------------

/** 1 firma, 2–4 firmy, 0 a 5+ firem. */
export function firmy(n: number): string {
  if (n === 1) return 'firma'
  if (n >= 2 && n <= 4) return 'firmy'
  return 'firem'
}

/** Souhrn po kliknutí. `inserted` = kolik řádků DB skutečně vložila. */
export function suggestSummary(plan: SuggestPlan, inserted: number, cap: number = SUGGEST_CAP): string {
  const skipped: string[] = []
  if (plan.excludedStatus > 0) skipped.push(`klienti a rozjednané obchody ${plan.excludedStatus}`)
  if (plan.outsideRegion > 0) skipped.push(`mimo region ${plan.outsideRegion}`)
  const skippedText = skipped.length ? ` Vynecháno: ${skipped.join(', ')}.` : ''

  if (plan.matched === 0) return `Pravidlu segmentu teď neodpovídá žádná firma.${skippedText}`
  if (plan.rows.length === 0) {
    return `Nic nového — všechny odpovídající firmy (${plan.matched}) už v seznamu jsou.${skippedText}`
  }
  const parts = [`Přidáno do návrhů: ${inserted} ${firmy(inserted)}`
    + (plan.unverifiedRegion > 0 ? ` (z toho bez ověřeného regionu ${plan.unverifiedRegion})` : '') + '.']
  const raced = plan.rows.length - inserted
  if (raced > 0) parts.push(`Mezitím je do seznamu přidal někdo jiný: ${raced}.`)
  if (plan.alreadyInList > 0) parts.push(`Už v seznamu: ${plan.alreadyInList}.`)
  if (plan.remaining > 0) parts.push(`Limit je ${cap} na jedno kliknutí — zbývá ${plan.remaining}, klikni znovu.`)
  return parts.join(' ') + skippedText
}

const STATUS_LABEL: Record<TargetAccountStatus, string> = {
  prospekt: 'prospekty',
  aktivni_obchod: 'firmy s otevřeným obchodem',
  klient: 'klienty',
}

/** Pravidlo lidsky, řádek po řádku („Pravidlo segmentu: …" na detailu seznamu). */
export function describeSegmentRule(key: string, rule: TargetSegmentRule): { term: string; value: string }[] {
  const stem = (xs: readonly string[]) => xs.map((x) => `${x}…`).join(', ')
  const lines = [
    { term: 'Pravidlo segmentu', value: `${rule.label} (${key})` },
    { term: 'Obor začíná na', value: stem(rule.industryPrefixes) },
  ]
  if (rule.industryKeywords?.length) lines.push({ term: 'Nebo obor obsahuje slovo', value: stem(rule.industryKeywords) })
  lines.push({
    term: 'Region',
    value: rule.regions?.length
      ? `${rule.regions.join(', ')} — firmu z jiného kraje (podle názvu kraje nebo okresního města) vynechá; `
        + 'bez regionu nebo s obcí, kterou neumíme zařadit, projde s poznámkou „region neověřen"'
      : 'libovolný',
  })
  lines.push({
    term: 'Vynechá',
    value: rule.excludeStatuses.length ? rule.excludeStatuses.map((s) => STATUS_LABEL[s]).join(', ') : 'nikoho',
  })
  lines.push({ term: 'Na jedno kliknutí', value: `nejvýš ${SUGGEST_CAP} firem; firmy už v seznamu se nemění` })
  return lines
}
