// Finanční záznamy (kap. 10, část 2; migrace 0063) — čistá logika.
//
// Čtyři druhy peněz: potenciál, nasmlouváno, vyfakturováno, přijato. Plán
// říká, že se NIKDY nesčítají do jednoho „obratu". Proto tu žádná funkce
// nevrací jedno číslo přes víc druhů: součty jsou vždy po DRUHU a MĚNĚ
// (a měsíci). Typ KindTotals<K> nese druh v typu, sčítat jde jen dva součty
// stejného druhu (addKindTotals<K>) — pokus sečíst potenciál s přijatým je
// chyba překladu (test/finance-records.test.ts to hlídá přes @ts-expect-error).
// Měny se nepřevádějí: kurz by byl odhad, ne záznam.
//
// Faktura ani úhrada se neodvozují z pošty — mezi zdroji pošta není.
// Seznamy druhů, stavů, zdrojů a přechodů MUSÍ odpovídat CHECKům a triggeru
// v supabase/migrations/0063_financial_record.sql (test je porovnává).
import { daysBetweenPragueDays, pragueDayOf } from '@/lib/pragueDate'
import { z } from 'zod'
import { COMPANY } from '@/config'
import { isRealDay } from '@/lib/validation/schemas'

export const FINANCIAL_KINDS = ['potential', 'contracted', 'invoiced', 'received'] as const
export type FinancialKind = (typeof FINANCIAL_KINDS)[number]

export const FINANCIAL_KIND_LABEL: Record<FinancialKind, string> = {
  potential: 'Potenciál',
  contracted: 'Nasmlouváno',
  invoiced: 'Vyfakturováno',
  received: 'Přijato',
}

export const FINANCIAL_STATUSES = ['draft', 'confirmed', 'cancelled'] as const
export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number]

export const FINANCIAL_STATUS_LABEL: Record<FinancialStatus, string> = {
  draft: 'Návrh',
  confirmed: 'Potvrzeno',
  cancelled: 'Zrušeno',
}

/** Povolené přechody stavu — zrcadlo triggeru financial_record_guard (0063). */
export const FINANCIAL_STATUS_TRANSITIONS: Record<FinancialStatus, readonly FinancialStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['cancelled'],
  cancelled: [],
}

// 'idoklad' (0092): záznam, který Cockpit sám načetl z iDokladu (denní čtení,
// domain/finance/idokladSync.ts). Ručně ho zvolit nejde (MANUAL_SOURCES).
// 'import' (0098): záznam z hromadného importu běžících zakázek (docs/PROVOZ.md);
// zapisuje ho jen funkce import_apply_row, ručně ho zvolit nejde.
export const FINANCIAL_SOURCES = ['rucne', 'nabidka', 'milnik', 'ucetnictvi', 'idoklad', 'import'] as const
export type FinancialSource = (typeof FINANCIAL_SOURCES)[number]

export const FINANCIAL_SOURCE_LABEL: Record<FinancialSource, string> = {
  rucne: 'Ručně',
  nabidka: 'Nabídka',
  milnik: 'Milník',
  ucetnictvi: COMPANY.accountingSystem,
  idoklad: 'iDoklad (automaticky)',
  import: 'Import zakázek',
}

/** Zdroje, které smí člověk zvolit ve formuláři ('milnik' vzniká jen z milníku). */
export const MANUAL_SOURCES = ['rucne', 'nabidka', 'ucetnictvi'] as const

export const CURRENCIES = ['CZK', 'EUR'] as const
export type Currency = (typeof CURRENCIES)[number]

export function isFinancialKind(v: unknown): v is FinancialKind {
  return typeof v === 'string' && (FINANCIAL_KINDS as readonly string[]).includes(v)
}
export function isFinancialStatus(v: unknown): v is FinancialStatus {
  return typeof v === 'string' && (FINANCIAL_STATUSES as readonly string[]).includes(v)
}

export function canTransition(from: FinancialStatus, to: FinancialStatus): boolean {
  return FINANCIAL_STATUS_TRANSITIONS[from].includes(to)
}

/** Potvrzená faktura nebo úhrada se musí opírat o doklad v účetnictví. */
export function needsExternalRef(kind: FinancialKind, status: FinancialStatus): boolean {
  return status === 'confirmed' && (kind === 'invoiced' || kind === 'received')
}

// ---------------------------------------------------------------------------
// Období

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** '2026-09' (input type="month") → '2026-09-01'; neplatné → null. */
export function periodFromMonth(v: string): string | null {
  const m = MONTH_RE.exec(v.trim())
  return m ? `${m[1]}-${m[2]}-01` : null
}

/** '2026-09-01' / '2026-09-17T…' → '2026-09'. */
export function monthOf(date: string): string {
  return date.slice(0, 7)
}

/**
 * První den pražského měsíce k datu. Timestamp (timestamptz z PostgRESTu je
 * v UTC) se převede do Europe/Prague — 1. 10. 00:30 SELČ je 30. 9. 22:30 UTC.
 * Holé datum YYYY-MM-DD se bere tak, jak je.
 */
export function periodOfDate(date: string): string {
  const month = date.length > 10 ? monthOf(pragueDayOf(date)) : monthOf(date)
  return `${month}-01`
}

const MONTH_NAMES = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec']
export function monthLabel(month: string): string {
  const m = MONTH_RE.exec(month)
  if (!m) return month
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}`
}

/** Posun měsíce 'YYYY-MM' o n (i záporně). */
export function addMonths(month: string, n: number): string {
  const m = MONTH_RE.exec(month)
  if (!m) return month
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + n
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Částky — v haléřích/centech (celá čísla), ať se sčítání nerozjede na floatech.

export function toMinor(amount: number | string): number {
  return Math.round(Number(amount) * 100)
}
export function fromMinor(minor: number): number {
  return minor / 100
}

/** '12 500,50' / '12500.5' → 12500.5; neplatné nebo ≤ 0 → null. */
export function parseAmount(v: string): number | null {
  const t = v.replace(/[\s ]/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const n = Number(t)
  return n > 0 && n < 1e12 ? n : null
}

export function formatMoney(amount: number, currency: Currency): string {
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount)
}

// ---------------------------------------------------------------------------
// Agregace — vždy po druhu, měně a měsíci. Žádný součet přes druhy.

export type FinancialRecordRow = {
  id: number
  account_id: number
  deal_id: number | null
  engagement_id: number | null
  milestone_id: number | null
  kind: FinancialKind
  amount: number | string
  currency: Currency
  period_month: string
  status: FinancialStatus
  source: FinancialSource
  evidence_id: number | null
  external_ref: string | null
  note: string | null
  created_at: string
  /** Splatnost faktury (0090, jen druh Vyfakturováno); chybí před migrací. */
  due_on?: string | null
  /** Odkaz na doklad v iDokladu (0092); bez migrace nebo u ručního záznamu chybí. */
  idoklad_kind?: 'invoice' | 'payment' | null
  idoklad_id?: number | null
  /**
   * Splatnost faktury z iDokladu (0092, zapisuje ji jen denní úloha). Čtení ji
   * používá jako záložní hodnotu, když chybí ruční splatnost `due_on` (0090) —
   * viz withEffectiveDue.
   */
  idoklad_due_on?: string | null
}

/** Částky jedné měny, rozdělené na potvrzené a návrhy (v hlavních jednotkách). */
export type CurrencyAmounts = { confirmed: number; draft: number; count: number }

/** Součet JEDNOHO druhu. Druh je součástí typu — jiný druh se nepřičte. */
export type KindTotals<K extends FinancialKind> = {
  readonly kind: K
  readonly byCurrency: Readonly<Partial<Record<Currency, CurrencyAmounts>>>
}

export type KindMonth<K extends FinancialKind> = KindTotals<K> & { readonly month: string }

export type KindColumn<K extends FinancialKind> = {
  readonly kind: K
  readonly label: string
  /** Měsíce sestupně (nejnovější nahoře). */
  readonly months: readonly KindMonth<K>[]
  readonly total: KindTotals<K>
}

/** Čtyři oddělené sloupce. Záměrně bez pole „celkem". */
export type FinanceBoard = { readonly [K in FinancialKind]: KindColumn<K> }

export function emptyKindTotals<K extends FinancialKind>(kind: K): KindTotals<K> {
  return { kind, byCurrency: {} }
}

type MinorAcc = Partial<Record<Currency, { confirmed: number; draft: number; count: number }>>

function toTotals<K extends FinancialKind>(kind: K, acc: MinorAcc): KindTotals<K> {
  const byCurrency: Partial<Record<Currency, CurrencyAmounts>> = {}
  for (const c of CURRENCIES) {
    const v = acc[c]
    if (v) byCurrency[c] = { confirmed: fromMinor(v.confirmed), draft: fromMinor(v.draft), count: v.count }
  }
  return { kind, byCurrency }
}

function addTo(acc: MinorAcc, r: Pick<FinancialRecordRow, 'currency' | 'status' | 'amount'>): void {
  const slot = (acc[r.currency] ??= { confirmed: 0, draft: 0, count: 0 })
  if (r.status === 'confirmed') slot.confirmed += toMinor(r.amount)
  else slot.draft += toMinor(r.amount)
  slot.count += 1
}

/**
 * Sečte dva součty STEJNÉHO druhu. Různé druhy odmítne překladač i běh.
 */
export function addKindTotals<K extends FinancialKind>(a: KindTotals<K>, b: KindTotals<NoInfer<K>>): KindTotals<K> {
  if (a.kind !== b.kind) throw new Error('Různé druhy finančních záznamů se nesčítají.')
  const acc: MinorAcc = {}
  for (const t of [a, b]) {
    for (const c of CURRENCIES) {
      const v = t.byCurrency[c]
      if (!v) continue
      const slot = (acc[c] ??= { confirmed: 0, draft: 0, count: 0 })
      slot.confirmed += toMinor(v.confirmed)
      slot.draft += toMinor(v.draft)
      slot.count += v.count
    }
  }
  return toTotals(a.kind, acc)
}

function buildColumn<K extends FinancialKind>(kind: K, rows: readonly FinancialRecordRow[]): KindColumn<K> {
  const perMonth = new Map<string, MinorAcc>()
  const total: MinorAcc = {}
  for (const r of rows) {
    if (r.kind !== kind || r.status === 'cancelled') continue
    const month = monthOf(r.period_month)
    const acc = perMonth.get(month) ?? {}
    perMonth.set(month, acc)
    addTo(acc, r)
    addTo(total, r)
  }
  const months = [...perMonth.keys()]
    .sort((a, b) => b.localeCompare(a))
    .map((month) => ({ month, ...toTotals(kind, perMonth.get(month)!) }))
  return { kind, label: FINANCIAL_KIND_LABEL[kind], months, total: toTotals(kind, total) }
}

/** Rozdělí záznamy do čtyř oddělených sloupců. Zrušené se nepočítají. */
export function buildFinanceBoard(rows: readonly FinancialRecordRow[]): FinanceBoard {
  return {
    potential: buildColumn('potential', rows),
    contracted: buildColumn('contracted', rows),
    invoiced: buildColumn('invoiced', rows),
    received: buildColumn('received', rows),
  }
}

/** Souhrn jedné firmy — tytéž čtyři oddělené součty bez rozpadu na měsíce. */
export function summarizeByKind(rows: readonly FinancialRecordRow[]): { readonly [K in FinancialKind]: KindTotals<K> } {
  const b = buildFinanceBoard(rows)
  return {
    potential: b.potential.total,
    contracted: b.contracted.total,
    invoiced: b.invoiced.total,
    received: b.received.total,
  }
}

// ---------------------------------------------------------------------------
// Splatnost faktur (0090)
//
// „Po splatnosti a nezaplaceno" = potvrzená vyfakturovaná položka (má číslo
// dokladu), jejíž splatnost je před dnešním pražským dnem a ke které neexistuje
// potvrzený záznam Přijato od stejné firmy se stejným číslem dokladu. Zrušená
// a rozepsaná (návrh) faktura se nehlídá. Částečná úhrada se neeviduje: platba
// buď je, nebo není. Součty jsou dál po měně (přes měny se nesčítá).

export type InvoiceDueRow = Pick<FinancialRecordRow, 'account_id' | 'kind' | 'status' | 'external_ref' | 'amount' | 'currency'> & {
  due_on?: string | null
}

/** Klíč pro spárování faktury s úhradou: firma + číslo dokladu (stejné znaky, bez okrajových mezer). */
export function paymentKey(accountId: number, ref: string | null | undefined): string | null {
  const r = (ref ?? '').trim()
  return r ? `${accountId}|${r}` : null
}

/** Klíče zaplacených faktur: potvrzené záznamy Přijato s číslem dokladu. */
export function paidKeys(received: readonly Pick<FinancialRecordRow, 'account_id' | 'kind' | 'status' | 'external_ref'>[]): Set<string> {
  const out = new Set<string>()
  for (const r of received) {
    if (r.kind !== 'received' || r.status !== 'confirmed') continue
    const k = paymentKey(r.account_id, r.external_ref)
    if (k) out.add(k)
  }
  return out
}

/**
 * Jedna splatnost pro celý kód: ručně zadaná `due_on` (0090) má přednost,
 * jinak splatnost načtená z iDokladu (`idoklad_due_on`, 0092). Sloupce se v DB
 * nesloučily (žádná další migrace), sjednocení drží čtení.
 */
export function effectiveDueOn(r: { due_on?: string | null; idoklad_due_on?: string | null }): string | null {
  return r.due_on ?? r.idoklad_due_on ?? null
}

/** Vrátí řádek s `due_on` = effectiveDueOn (jen u vyfakturovaných; jinak beze změny). */
export function withEffectiveDue<R extends { kind: string; due_on?: string | null; idoklad_due_on?: string | null }>(r: R): R {
  if (r.kind !== 'invoiced') return r
  const due = effectiveDueOn(r)
  return due === (r.due_on ?? null) ? r : { ...r, due_on: due }
}

/** Dny po splatnosti (kladné) vůči pražskému dnešku; bez splatnosti nebo ještě ne = 0. */
export function daysPastDue(dueOn: string | null | undefined, today: string): number {
  if (!dueOn || !isRealDay(dueOn) || dueOn >= today) return 0
  return daysBetweenPragueDays(dueOn, today)
}

/**
 * Nezaplacené potvrzené faktury po splatnosti, nejdéle po splatnosti nahoře.
 * `paid` jsou klíče z paidKeys() – úhrady se čtou zvlášť, ať nezávisí na
 * období filtru.
 */
export function overdueInvoices<R extends InvoiceDueRow>(
  rows: readonly R[],
  paid: ReadonlySet<string>,
  today: string,
): (R & { daysLate: number })[] {
  return rows
    .filter((r) => r.kind === 'invoiced' && r.status === 'confirmed' && daysPastDue(r.due_on, today) > 0)
    .filter((r) => {
      const k = paymentKey(r.account_id, r.external_ref)
      return !(k && paid.has(k))
    })
    .map((r) => ({ ...r, daysLate: daysPastDue(r.due_on, today) }))
    .sort((a, b) => b.daysLate - a.daysLate || (a.due_on ?? '').localeCompare(b.due_on ?? ''))
}

/** Součet po splatnosti po měnách (druh Vyfakturováno, jen potvrzené = jen potvrzená část). */
export function totalOverdue(rows: readonly (InvoiceDueRow & { id?: number })[]): KindTotals<'invoiced'> {
  let acc: KindTotals<'invoiced'> = emptyKindTotals('invoiced')
  for (const r of rows) {
    const one: MinorAcc = {}
    addTo(one, { currency: r.currency, status: 'confirmed', amount: r.amount })
    acc = addKindTotals(acc, toTotals('invoiced', one))
  }
  return acc
}

// ---------------------------------------------------------------------------
// Filtry /finance (searchParams → čisté hodnoty)

export type FinanceFilters = {
  from: string // 'YYYY-MM'
  to: string
  accountId: number | null
  currency: Currency | null
  showDrafts: boolean
}

export function parseFinanceFilters(
  sp: Record<string, string | string[] | undefined>,
  currentMonth: string,
): FinanceFilters {
  const one = (k: string) => {
    const v = sp[k]
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? '' : ''
  }
  const okMonth = (v: string) => (MONTH_RE.test(v) ? v : null)
  let from = okMonth(one('od')) ?? addMonths(currentMonth, -11)
  let to = okMonth(one('do')) ?? addMonths(currentMonth, 12)
  if (from > to) [from, to] = [to, from]
  const acc = Number(one('firma'))
  const cur = one('mena')
  return {
    from,
    to,
    accountId: Number.isInteger(acc) && acc > 0 ? acc : null,
    currency: (CURRENCIES as readonly string[]).includes(cur) ? (cur as Currency) : null,
    showDrafts: one('navrhy') !== '0',
  }
}

// ---------------------------------------------------------------------------
// Formuláře

const optId = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? null : Number(v)),
  z.number().int().positive().nullable(),
)
const optText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
    z.string().max(max, `Nejvýš ${max} znaků.`).nullable(),
  )
const amountField = z.preprocess(
  (v) => (typeof v === 'string' ? parseAmount(v) : v),
  z.number({ message: 'Zadejte kladnou částku (nejvýš 2 desetinná místa).' }).positive('Částka musí být kladná.'),
)
const periodField = z.preprocess(
  (v) => (typeof v === 'string' ? periodFromMonth(v) : v),
  z.string({ message: 'Zvolte měsíc.' }),
)

// Splatnost: prázdné = bez splatnosti; jinak skutečný kalendářní den.
const optDay = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null),
  z.string().refine(isRealDay, 'Zadej platné datum splatnosti.').nullable(),
)
export const DUE_ONLY_INVOICED = 'Splatnost jde zadat jen u druhu Vyfakturováno.'

const refRule = (d: { kind: FinancialKind; status: FinancialStatus; external_ref: string | null }) =>
  !needsExternalRef(d.kind, d.status) || !!d.external_ref
const REF_MESSAGE = `Potvrzená faktura nebo úhrada potřebuje číslo dokladu (${COMPANY.accountingSystem}).`

export const financialRecordCreateSchema = z
  .object({
    account_id: z.coerce.number({ message: 'Zvolte firmu.' }).int().positive('Zvolte firmu.'),
    kind: z.enum(FINANCIAL_KINDS, { message: 'Zvolte druh.' }),
    amount: amountField,
    currency: z.enum(CURRENCIES, { message: 'Zvolte měnu.' }),
    period_month: periodField,
    status: z.enum(['draft', 'confirmed'], { message: 'Zvolte stav.' }),
    source: z.enum(MANUAL_SOURCES, { message: 'Zvolte zdroj.' }),
    deal_id: optId,
    engagement_id: optId,
    external_ref: optText(200),
    due_on: optDay,
    note: optText(2000),
  })
  .refine(refRule, { message: REF_MESSAGE, path: ['external_ref'] })
  .refine((d) => d.due_on === null || d.kind === 'invoiced', { message: DUE_ONLY_INVOICED, path: ['due_on'] })

export type FinancialRecordCreate = z.infer<typeof financialRecordCreateSchema>

/** Úprava: firma, druh a zdroj se nemění (trigger 0063); stav jen po grafu. */
export const financialRecordUpdateSchema = z.object({
  amount: amountField,
  currency: z.enum(CURRENCIES, { message: 'Zvolte měnu.' }),
  period_month: periodField,
  status: z.enum(['draft', 'confirmed'], { message: 'Zvolte stav.' }),
  external_ref: optText(200),
  due_on: optDay,
  note: optText(2000),
})

export type FinancialRecordUpdate = z.infer<typeof financialRecordUpdateSchema>

export const milestoneInvoiceSchema = z.object({
  amount: amountField,
  currency: z.enum(CURRENCIES, { message: 'Zvolte měnu.' }),
  note: optText(2000),
})

/**
 * Úprava existujícího záznamu: ověří přechod stavu a doklad. Vrací chybu
 * v češtině, nebo null.
 */
export function checkUpdate(
  current: { kind: FinancialKind; status: FinancialStatus },
  next: { status: FinancialStatus; external_ref: string | null; due_on?: string | null },
): string | null {
  if (current.status === 'cancelled') return 'Zrušený záznam se už nemění.'
  if (next.due_on && current.kind !== 'invoiced') return DUE_ONLY_INVOICED
  if (next.status !== current.status && !canTransition(current.status, next.status)) {
    return `Stav nelze změnit z „${FINANCIAL_STATUS_LABEL[current.status]}“ na „${FINANCIAL_STATUS_LABEL[next.status]}“.`
  }
  if (needsExternalRef(current.kind, next.status) && !next.external_ref) return REF_MESSAGE
  return null
}
