// Automatické doplňování IČO (a sídla) z ARESu po dávkách.
//
// Proč: po importu 629 prospektů nemá IČO 640 firem. Ručně je to stovky
// kliknutí na /clients/doplnit-ico, a stránka se navíc dřív pokoušela
// zeptat ARESu na všechny najednou. Tady je dávkový běh, který:
//
//   * přiřadí IČO JEN při přesné shodě jména (pickAresMatch → 'přesná
//     shoda') a jen když to IČO nemá jiný klient — duplicitní firmu
//     v CRM nikdy nevyrobí. „Jediný výsledek" zůstává návrhem pro člověka:
//     cizí IČO je horší než prázdné pole (viz komentář u pickAresMatch —
//     „Magna", „K2", „CCH");
//   * při přiřazení doplní jen PRÁZDNÁ pole (sídlo, NACE, datum vzniku),
//     nic nepřepisuje. Obor z NACE záměrně ne — první kód NACE je náhoda
//     (migrace 0030);
//   * u klientů, kteří IČO mají, ale chybí jim sídlo, ho doplní podle IČO;
//   * každého zpracovaného klienta označí (account.ares_checked_at
//     a ares_status, migrace 0065), aby se příště neptal znovu;
//   * drží časový rozpočet (výchozí 50 s — funkce na Vercelu má 60 s)
//     a souběžnost (4 požadavky na ARES najednou).
//
// Spouští se dvěma cestami, obě přes runJob('ares-enrich') se zámkem proti
// překryvu (migrace 0040): tlačítko pro admina na /clients/doplnit-ico
// a denní cron /api/cron/ares-enrich (vypínač ARES_ENRICH_ENABLED).
//
// Každá změna jde do auditu s původem: evidence = URL záznamu v ARESu,
// stav údaje 'source_fact' (strojově převzatý fakt ze zdroje), aktér =
// admin, který dávku spustil, nebo systém 'job:ares-enrich'.
//
// Logika je čistá nad vstříknutými adaptéry (DB, ARES, hodiny), takže se
// testuje bez sítě a bez Supabase (test/ares-enrich.test.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ARES_DEFAULT_TIMEOUT_MS,
  AresUnavailableError,
  aresLookupByIco,
  aresRegionValue,
  aresSearch,
  cleanCompanyName,
  normalizeCompanyName,
  pickAresMatch,
  type AresCompany,
  type AresSearchResult,
} from '@/connectors/ares'
import type { AuditActor } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { recordAuditWithEvidence } from '@/core/evidence'
import { runPool } from '@/lib/concurrency'
import { logError } from '@/lib/log'

// Re-export: sdílené s ruční stránkou /clients/doplnit-ico
// (domain/crm/actions/accounts.ts) — obě cesty musí ze stejného ARES
// záznamu spočítat stejné account.region.
export { aresRegionValue }

// ---------------------------------------------------------------- konstanty

/** Hodnoty account.ares_status — MUSÍ sedět s CHECKem v migraci 0065. */
export const ARES_STATUSES = ['prirazeno', 'nejednoznacne', 'nenalezeno'] as const
export type AresStatus = (typeof ARES_STATUSES)[number]

export const ARES_ENRICH_JOB_NAME = 'ares-enrich'
/** Zámek musí přežít nejdelší běh (rozpočet 50 s + zápisy). */
export const ARES_ENRICH_JOB_TTL_SECONDS = 120
export const ARES_ENRICH_SYSTEM_ACTOR: AuditActor = { type: 'system', id: 'job:ares-enrich' }

export const ARES_ENRICH_DEFAULTS = {
  /** Kolik klientů jedna dávka nejvýš zpracuje. */
  limit: 40,
  /** Kolik požadavků na ARES běží současně. */
  concurrency: 4,
  /** Po tomhle čase od startu už nic nového nezačne (Vercel má 60 s). */
  budgetMs: 50_000,
  /** Timeout jednoho požadavku na ARES. */
  requestTimeoutMs: ARES_DEFAULT_TIMEOUT_MS,
  /** Rezerva na zápisy do DB po posledním požadavku. */
  safetyMs: 2_000,
}

export const ARES_MIGRATION_MISSING_MESSAGE =
  'Automatické doplňování IČO čeká na migraci 0065 (account.ares_checked_at / ares_status).'

// PostgREST: tabulka/sloupec ve schema cache není (PGRST205/PGRST204),
// Postgres: undefined_table / undefined_column.
const MISSING_SCHEMA_CODES = new Set(['42P01', 'PGRST205', '42703', 'PGRST204'])

export function isMissingSchemaError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return MISSING_SCHEMA_CODES.has(String(code))
}

export class AresMigrationMissingError extends Error {
  constructor() {
    super(ARES_MIGRATION_MISSING_MESSAGE)
    this.name = 'AresMigrationMissingError'
  }
}

// ---------------------------------------------------------------- IČO

/** IČO bez mezer a doplněné nulami na 8 číslic (ARES ho tak vrací). */
export function canonicalIco(ico: string): string {
  const clean = ico.replace(/\s/g, '').replace(/^CZ/i, '')
  return /^\d{1,8}$/.test(clean) ? clean.padStart(8, '0') : clean
}

/** Varianty, pod kterými může stejné IČO ležet v DB („00537837" i „537837"). */
export function icoVariants(ico: string): string[] {
  const canon = canonicalIco(ico)
  const short = canon.replace(/^0+(?=\d)/, '')
  const out = [canon, short, ico.trim()]
  // Ručně psané tvary z formuláře klienta (pole je volný text):
  // „CZ00537837", „005 37 837", „00537 837".
  if (/^\d{8}$/.test(canon)) {
    out.push(`CZ${canon}`, `CZ${short}`, `${canon.slice(0, 3)} ${canon.slice(3, 5)} ${canon.slice(5)}`,
      `${canon.slice(0, 5)} ${canon.slice(5)}`)
  }
  return [...new Set(out.filter(Boolean))]
}

export function aresSourceUrl(ico: string): string {
  return `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${canonicalIco(ico)}`
}

// ---------------------------------------------------------------- rozhodnutí

// Právní forma v kanonickém tvaru. Pořadí je důležité: „spol. s r.o." dřív
// než „s.r.o.", „s.r.o." dřív než „SE" (jinak by „SE Services s.r.o." byla
// evropská společnost).
const LEGAL_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bspol\s*\.?\s*s\s*r\s*\.?\s*o\b/, 'sro'],
  [/\bs\s*\.?\s*r\s*\.?\s*o\b/, 'sro'],
  [/\bv\s*\.?\s*o\s*\.?\s*s\b/, 'vos'],
  [/\ba\s*\.?\s*s\b/, 'as'],
  [/\bk\s*\.?\s*s\b/, 'ks'],
  [/\bz\s*\.?\s*s\b/, 'zs'],
  [/\bse\b/, 'se'],
  [/\bltd\b/, 'ltd'],
  [/\bgmbh\b/, 'gmbh'],
  [/\binc\b/, 'inc'],
]

/** Kanonická právní forma v názvu („s.r.o." i „spol. s r. o." → 'sro'), nebo null. */
export function legalFormOf(name: string): string | null {
  const s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  for (const [re, form] of LEGAL_FORMS) if (re.test(s)) return form
  return null
}

export type AresAmbiguityReason =
  | 'otazník v názvu'
  | 'žádná přesná shoda'
  | 'jediný výsledek — jen návrh'
  | 'víc firem stejného jména'
  | 'jiná právní forma'
  | 'IČO už má jiný klient'
  | 'příliš mnoho shod'
  | 'neúplný seznam kandidátů'

export type AresDecision =
  | { status: 'prirazeno'; company: AresCompany; reason: 'přesná shoda' }
  | { status: 'nejednoznacne'; company: AresCompany | null; reason: AresAmbiguityReason }
  | { status: 'nenalezeno'; company: null; reason: 'ARES nic nenašel' }

function ambiguous(company: AresCompany | null, reason: AresAmbiguityReason): AresDecision {
  return { status: 'nejednoznacne', company, reason }
}

/**
 * Smí automat klientovi přiřadit IČO? Čistá funkce, bez sítě a DB.
 *
 * Přiřadí se JEN když:
 *   1) pickAresMatch vrátí 'přesná shoda' (normalizované jméno bez právní
 *      formy a závorek je stejné) — 'jediný výsledek' je jen návrh;
 *   2) ARES vrátil VŠECHNY shody (total ≤ počet kandidátů) a mezi nimi
 *      není jiná firma se stejným normalizovaným jménem;
 *   3) nese-li jméno klienta právní formu, kandidát má stejnou
 *      („Alfatech a.s." není „ALFATECH s.r.o.");
 *   4) IČO nemá jiný klient (`takenIcos`, kanonický tvar) — duplicitu
 *      firmy automat nikdy nevyrobí.
 * Jinak 'nejednoznacne' (ARES něco vrátil, rozhodne člověk), nebo
 * 'nenalezeno' (ARES nevrátil nic).
 */
export function decideAresMatch(
  accountName: string,
  search: AresSearchResult,
  takenIcos: ReadonlySet<string>,
): AresDecision {
  // Otazník = nejistý byl už ten, kdo klienta zakládal. Rozhodne člověk,
  // i kdyby ARES nic nevrátil (automat se na takové jméno ARESu ani neptá).
  if (accountName.includes('?')) return ambiguous(null, 'otazník v názvu')
  // ARES odmítl hledat (>1000 shod) — to není „nenalezeno", jen obecné jméno.
  if (search.tooMany) return ambiguous(null, 'příliš mnoho shod')
  if (search.candidates.length === 0) return { status: 'nenalezeno', company: null, reason: 'ARES nic nenašel' }

  const pick = pickAresMatch(accountName, search.candidates, search.total)
  if (!pick) return ambiguous(null, 'žádná přesná shoda')
  if (pick.how !== 'přesná shoda') return ambiguous(pick.company, 'jediný výsledek — jen návrh')
  // Pravidlo 2 platí jen nad CELÝM seznamem: ARES řadí podle IČO, ne podle
  // relevance, takže firma stejného jména může ležet za oříznutím
  // („Presto": 39 shod, tři různé „PRESTO" na pozicích 0, 25 a 36).
  if (search.total > search.candidates.length) return ambiguous(pick.company, 'neúplný seznam kandidátů')

  const wantedName = normalizeCompanyName(cleanCompanyName(accountName))
  const sameName = search.candidates.filter((c) => normalizeCompanyName(c.legalName) === wantedName)
  if (new Set(sameName.map((c) => canonicalIco(c.ico))).size > 1) return ambiguous(null, 'víc firem stejného jména')

  const wantedForm = legalFormOf(cleanCompanyName(accountName))
  if (wantedForm && legalFormOf(pick.company.legalName) !== wantedForm) {
    return ambiguous(pick.company, 'jiná právní forma')
  }

  if (takenIcos.has(canonicalIco(pick.company.ico))) return ambiguous(pick.company, 'IČO už má jiný klient')

  return { status: 'prirazeno', company: pick.company, reason: 'přesná shoda' }
}

// ---------------------------------------------------------------- doplnění

/** Pole karty klienta, která automat smí doplnit (jen když jsou prázdná). */
export type AresFillable = { region: string | null; nace: string[] | null; founded_on: string | null }
export type AresFillPatch = Partial<AresFillable>

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === ''
}

/**
 * Co z ARESu doplnit — jen do prázdných polí, nikdy nepřepisuje. Obor
 * (industry) záměrně ne: první kód NACE je náhoda (migrace 0030). NACE
 * a datum vzniku jsou fakta z rejstříku (0030: „žádná interpretace").
 */
export function aresFillPatch(current: AresFillable, company: AresCompany): AresFillPatch {
  const patch: AresFillPatch = {}
  const region = aresRegionValue(company)
  if (isBlank(current.region) && region) patch.region = region
  if ((!current.nace || current.nace.length === 0) && company.nace.length > 0) patch.nace = [...company.nace]
  if (isBlank(current.founded_on) && company.founded && /^\d{4}-\d{2}-\d{2}$/.test(company.founded)) {
    patch.founded_on = company.founded
  }
  return patch
}

// ---------------------------------------------------------------- běh

export type AresEnrichAccount = AresFillable & { id: number; name: string; ico: string | null }

export type AresAuditEntry = {
  accountId: number
  action: 'account.ares_ico_assigned' | 'account.ares_backfilled'
  /** IČO z ARESu — z něj je odkaz na zdroj (evidence). */
  ico: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export interface AresEnrichDb {
  /** Klienti bez IČO a bez výsledku (ares_status NULL), nikdy neověření první. */
  loadMissingIco(limit: number): Promise<AresEnrichAccount[]>
  /** Klienti s IČO, prázdným sídlem a bez ověření (ares_checked_at NULL). */
  loadRegionBackfill(limit: number): Promise<AresEnrichAccount[]>
  /** Která z IČO (kanonicky) už má jiný klient než `exceptAccountId`. */
  findTakenIcos(icos: string[], exceptAccountId: number): Promise<Set<string>>
  /**
   * Zapíše IČO jen tam, kde pořád chybí a kde jsou pole z `fillKeys` pořád
   * prázdná (souběh s člověkem); true = zapsáno.
   */
  assignIco(accountId: number, patch: Record<string, unknown>, fillKeys: string[]): Promise<boolean>
  /**
   * Doplnění podle IČO: zapíše jen, když má klient pořád stejné IČO a pole
   * z `fillKeys` jsou pořád prázdná (snímek z začátku dávky); true = zapsáno.
   */
  backfillAccount(accountId: number, ico: string, patch: Record<string, unknown>, fillKeys: string[]): Promise<boolean>
  updateAccount(accountId: number, patch: Record<string, unknown>): Promise<void>
  logAresAudit(entry: AresAuditEntry): Promise<void>
}

export interface AresEnrichSource {
  search(name: string, timeoutMs: number): Promise<AresSearchResult>
  byIco(ico: string, timeoutMs: number): Promise<AresCompany | null>
}

export type AresEnrichOptions = Partial<typeof ARES_ENRICH_DEFAULTS> & { now?: () => number }

export type AresEnrichStats = {
  /** Kolik klientů dávka začala zpracovávat. */
  processed: number
  assigned: number
  ambiguous: number
  notFound: number
  /** ARES neodpověděl / chyba zápisu — zkusí se příště. */
  errors: number
  /** IČO mezitím doplnil člověk — nic se nepřepsalo. */
  skipped: number
  /** Klienti s IČO ověření kvůli sídlu. */
  backfillChecked: number
  /** U kolika klientů (přiřazení i ověření podle IČO) se doplnilo sídlo. */
  regionFilled: number
  /** Klienti, na které už nezbyl čas. */
  notStarted: number
  budgetExhausted: boolean
  durationMs: number
}

type WorkItem = { kind: 'match' | 'backfill'; account: AresEnrichAccount }

function pickFields(account: AresEnrichAccount, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = (account as unknown as Record<string, unknown>)[k] ?? null
  return out
}

/**
 * Jedna dávka. Nikdy nevyhazuje kvůli jednomu klientovi (chyba = +1
 * `errors`, pokračuje se); vyhodí jen, když nejde načíst frontu (bez
 * migrace 0065 → AresMigrationMissingError).
 */
export async function runAresEnrichment(
  db: AresEnrichDb,
  ares: AresEnrichSource,
  options: AresEnrichOptions = {},
): Promise<AresEnrichStats> {
  const { now = Date.now, ...rest } = options
  const o = { ...ARES_ENRICH_DEFAULTS, ...rest }
  const start = now()
  const stats: AresEnrichStats = {
    processed: 0, assigned: 0, ambiguous: 0, notFound: 0, errors: 0, skipped: 0,
    backfillChecked: 0, regionFilled: 0, notStarted: 0, budgetExhausted: false, durationMs: 0,
  }
  const stamp = () => new Date(now()).toISOString()

  const missing = await db.loadMissingIco(o.limit)
  const backfill = missing.length < o.limit ? await db.loadRegionBackfill(o.limit - missing.length) : []
  const items: WorkItem[] = [
    ...missing.map((account) => ({ kind: 'match' as const, account })),
    ...backfill.map((account) => ({ kind: 'backfill' as const, account })),
  ]

  // IČO přiřazená v tomhle běhu — dva klienti stejného jména ve stejné
  // dávce nesmí dostat stejné IČO, i když DB o prvním zápisu ještě neví.
  const reserved = new Set<string>()

  async function matchByName(account: AresEnrichAccount): Promise<void> {
    const query = cleanCompanyName(account.name)
    let search: AresSearchResult = { candidates: [], total: 0 }
    if (!account.name.includes('?') && query) {
      try {
        search = await ares.search(query, o.requestTimeoutMs)
      } catch (e) {
        if (!(e instanceof AresUnavailableError)) throw e
        // Jen čas pokusu, bez výsledku: klient zůstane ve frontě, ale za
        // těmi, kdo ještě na řadě nebyli.
        await db.updateAccount(account.id, { ares_checked_at: stamp() })
        stats.errors++
        return
      }
    }

    const taken = search.candidates.length
      ? await db.findTakenIcos(search.candidates.map((c) => c.ico), account.id)
      : new Set<string>()
    for (const ico of reserved) taken.add(ico)
    // Od tohohle místa po reserved.add níž není žádný await — rezervace je
    // atomická vůči ostatním souběžným klientům v dávce.
    const decision = decideAresMatch(account.name, search, taken)

    if (decision.status !== 'prirazeno') {
      await db.updateAccount(account.id, { ares_status: decision.status, ares_checked_at: stamp() })
      if (decision.status === 'nejednoznacne') stats.ambiguous++
      else stats.notFound++
      return
    }

    const company = decision.company
    reserved.add(canonicalIco(company.ico))
    const fill = aresFillPatch(account, company)
    const applied = await db.assignIco(account.id, {
      ico: company.ico,
      ...fill,
      ares_status: 'prirazeno',
      ares_checked_at: stamp(),
    }, Object.keys(fill))
    if (!applied) {
      stats.skipped++
      return
    }
    stats.assigned++
    if (fill.region) stats.regionFilled++
    const keys = Object.keys(fill)
    await db.logAresAudit({
      accountId: account.id,
      action: 'account.ares_ico_assigned',
      ico: company.ico,
      before: { ico: null, ...pickFields(account, keys) },
      after: { ico: company.ico, ...fill, zdroj: 'ARES', shoda: decision.reason },
    })
  }

  async function backfillByIco(account: AresEnrichAccount): Promise<void> {
    let company: AresCompany | null
    try {
      company = await ares.byIco(account.ico ?? '', o.requestTimeoutMs)
    } catch (e) {
      if (!(e instanceof AresUnavailableError)) throw e
      // Bez značky — příští běh to zkusí znovu (výpadek ARESu není výsledek).
      stats.errors++
      return
    }
    const fill = company ? aresFillPatch(account, company) : {}
    const keys = Object.keys(fill)
    // Podmíněně vůči snímku: když člověk mezitím změnil IČO nebo vyplnil
    // pole, nic se nezapíše a ares_checked_at zůstane NULL — příští běh to
    // vezme znovu s čerstvými daty.
    const applied = await db.backfillAccount(account.id, account.ico ?? '', { ...fill, ares_checked_at: stamp() }, keys)
    if (!applied) {
      stats.skipped++
      return
    }
    stats.backfillChecked++
    if (fill.region) stats.regionFilled++
    if (company && keys.length > 0) {
      await db.logAresAudit({
        accountId: account.id,
        action: 'account.ares_backfilled',
        ico: company.ico,
        before: pickFields(account, keys),
        after: { ...fill, zdroj: 'ARES' },
      })
    }
  }

  // Nový klient začne, jen když se do rozpočtu vejde celý jeho požadavek
  // (timeout) i rezerva na zápis — běh tak skončí PŘED budgetMs.
  const canStart = () => now() - start + o.requestTimeoutMs + o.safetyMs <= o.budgetMs

  const { started } = await runPool(
    items,
    o.concurrency,
    async (item) => {
      try {
        if (item.kind === 'match') await matchByName(item.account)
        else await backfillByIco(item.account)
      } catch (e) {
        stats.errors++
        // Jen id — jméno firmy do logu nepatří.
        logError('aresEnrich', e, { accountId: item.account.id, kind: item.kind })
      }
    },
    canStart,
  )

  stats.processed = started
  stats.notStarted = items.length - started
  stats.budgetExhausted = stats.notStarted > 0
  stats.durationMs = now() - start
  return stats
}

// ---------------------------------------------------------------- adaptéry

export type AresEnrichClient = Pick<SupabaseClient, 'from'>

const ACCOUNT_COLUMNS = 'id, name, ico, region, nace, founded_on'

function dbError(what: string, error: { message?: string } & object): Error {
  if (isMissingSchemaError(error)) return new AresMigrationMissingError()
  return new Error(`${what}: ${error.message ?? 'neznámá chyba'}`)
}

// Podmínka „pole je pořád prázdné" — stejná definice prázdna jako
// aresFillPatch (NULL / '' u textu, NULL / {} u pole). Víc .or() se v
// PostgRESTu skládá přes AND.
function onlyIfBlank<Q extends { or(f: string): Q; is(c: string, v: null): Q }>(q: Q, keys: string[]): Q {
  let out = q
  for (const k of keys) {
    if (k === 'region') out = out.or('region.is.null,region.eq.')
    else if (k === 'nace') out = out.or('nace.is.null,nace.eq.{}')
    else out = out.is(k, null)
  }
  return out
}

/**
 * Adaptér nad Supabase klientem se SERVICE ROLÍ (createAdminClient) —
 * evidence (odkaz na ARES) smí zapisovat jen service role (core/evidence).
 * Volat jen ze serveru za bránou: admin akce (AAL2 + is_admin z DB) nebo
 * cron za CRON_SECRET.
 */
export function supabaseAresEnrichDb(
  client: AresEnrichClient,
  actor: AuditActor,
  /**
   * `onlyAccountIds`: dávka se zúží na tyhle klienty (právě založení z e-mailu,
   * domain/crm/autoIntakeService.ts). Pravidla přiřazení zůstávají stejná; doplnění
   * sídla u klientů s IČO se v zúžené dávce nedělá.
   */
  opts: { onlyAccountIds?: readonly number[] } = {},
): AresEnrichDb {
  const only = opts.onlyAccountIds
  return {
    async loadMissingIco(limit) {
      if (limit <= 0) return []
      if (only && only.length === 0) return []
      let q = client
        .from('account')
        .select(ACCOUNT_COLUMNS)
        .is('ico', null)
        .is('ares_status', null)
      if (only) q = q.in('id', [...only])
      const { data, error } = await q
        .order('ares_checked_at', { ascending: true, nullsFirst: true })
        .order('name')
        .order('id')
        .limit(limit)
      if (error) throw dbError('account (fronta bez IČO)', error)
      return (data ?? []) as AresEnrichAccount[]
    },
    async loadRegionBackfill(limit) {
      if (limit <= 0 || only) return []
      const { data, error } = await client
        .from('account')
        .select(ACCOUNT_COLUMNS)
        .not('ico', 'is', null)
        .is('region', null)
        .is('ares_checked_at', null)
        .order('id')
        .limit(limit)
      if (error) throw dbError('account (doplnění sídla)', error)
      return (data ?? []) as AresEnrichAccount[]
    },
    async findTakenIcos(icos, exceptAccountId) {
      const variants = [...new Set(icos.flatMap(icoVariants))]
      if (variants.length === 0) return new Set()
      const { data, error } = await client.from('account').select('id, ico').in('ico', variants)
      if (error) throw dbError('account (obsazená IČO)', error)
      return new Set(
        ((data ?? []) as { id: number; ico: string | null }[])
          .filter((r) => r.id !== exceptAccountId && r.ico)
          .map((r) => canonicalIco(r.ico as string)),
      )
    },
    async assignIco(accountId, patch, fillKeys) {
      const q = onlyIfBlank(client.from('account').update(patch).eq('id', accountId).is('ico', null), fillKeys)
      const { data, error } = await q.select('id')
      if (error) throw dbError('account (zápis IČO)', error)
      return ((data ?? []) as unknown[]).length > 0
    },
    async backfillAccount(accountId, ico, patch, fillKeys) {
      const q = onlyIfBlank(client.from('account').update(patch).eq('id', accountId).eq('ico', ico), fillKeys)
      const { data, error } = await q.select('id')
      if (error) throw dbError('account (doplnění podle IČO)', error)
      return ((data ?? []) as unknown[]).length > 0
    },
    async updateAccount(accountId, patch) {
      const { error } = await client.from('account').update(patch).eq('id', accountId)
      if (error) throw dbError('account (značka ověření)', error)
    },
    async logAresAudit(entry) {
      // account je od 0064 krytá triggerem (INSERT/UPDATE/DELETE) — appkový
      // zápis smí být jen záloha, dokud migrace neběží, jinak by šlo dvakrát.
      if (await dbAuditActive()) return
      // Nikdy nevyhazuje (core/evidence) — audit nesmí strhnout zápis.
      const url = aresSourceUrl(entry.ico)
      await recordAuditWithEvidence(client, { kind: 'url', sourceId: url, webLink: url }, 'source_fact', {
        entityTable: 'account',
        entityId: entry.accountId,
        action: entry.action,
        before: entry.before,
        after: entry.after,
        actor,
      })
    },
  }
}

/** Skutečný ARES (connectors/ares) s timeoutem na požadavek. */
export const liveAresSource: AresEnrichSource = {
  search: (name, timeoutMs) => aresSearch(name, { count: 100, timeoutMs }),
  byIco: (ico, timeoutMs) => aresLookupByIco(ico, { timeoutMs }),
}

// ---------------------------------------------------------------- souhrn

/** Věta pro člověka: „Přiřazeno 3 · nejednoznačné 10 · nenalezeno 25 · chyby 2." */
export function formatAresEnrichSummary(s: AresEnrichStats): string {
  if (s.processed === 0 && s.notStarted === 0) return 'Nebylo co ověřovat — fronta automatu je prázdná.'
  const parts = [
    `Přiřazeno ${s.assigned}`,
    `nejednoznačné ${s.ambiguous}`,
    `nenalezeno ${s.notFound}`,
    `chyby ${s.errors}`,
  ]
  if (s.backfillChecked > 0 || s.regionFilled > 0) parts.push(`doplněné sídlo ${s.regionFilled}`)
  if (s.skipped > 0) parts.push(`přeskočeno ${s.skipped}`)
  const head = parts.join(' · ')
  return s.budgetExhausted
    ? `${head}. Na ${s.notStarted} ${s.notStarted === 1 ? 'klienta' : s.notStarted <= 4 ? 'klienty' : 'klientů'} nezbyl čas — přijdou na řadu příště.`
    : `${head}.`
}
