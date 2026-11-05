// Exporty přehledů Cockpitu do Excelu a PDF — čistá část (bez I/O).
// Pro každý přehled: sloupce, převod řádků stránky na tabulku exportu
// a popis filtrů v lidské řeči. Data načítá domain/crm/queries/exports.ts
// stejnými dotazy jako stránka (RLS přihlášeného uživatele).
//
// Do auditu jde jen to, CO se exportovalo (přehled, formát, počet řádků,
// názvy filtrů) — nikdy hodnoty filtrů ani obsah (exportAuditPayload).
import { COMPANY } from '@/config'
import { dealKindLabel, dealStageLabel, pillarLabel } from '@/lib/domain'
import { asciiSlug, toExportTable, type ExportColumn, type ExportDocument, type ExportFilter, type ExportTable } from '@/lib/export/table'
import type { ExportFormat } from '@/lib/export/href'
import type { Contact, Task } from '@/lib/types'
import { OPEN_DEAL_STAGES, type SalesActivityLike, type SalesDealLike } from '@/domain/crm/sales'
import type { PipelineParams } from '@/domain/crm/pipelineFilter'
import { SCOPE_VERSION_STATUS_LABEL, type ScopeVersionRow } from '@/domain/crm/scopeVersion'
import {
  ACCOUNT_SORT_LABELS, ACCOUNT_STATUS_LABELS, NONE_VALUE, accountStatus, lastContactAt,
  type AccountListParams, type StatusSets,
} from '@/domain/crm/accountList'
import type { AccountListRow } from '@/domain/crm/queries/accountList'
import { SHOP_ORDER_STATUS_LABELS, type ShopOrderStatus } from '@/core/cheesecakeOrder'

// --- Přehledy ---------------------------------------------------------------

export const EXPORT_PREHLEDY = [
  'pipeline', 'klienti', 'aktivity', 'ukoly', 'nabidky', 'objednavky', 'tydenni-prehled',
] as const
export type ExportPrehled = (typeof EXPORT_PREHLEDY)[number]

export function isExportPrehled(v: unknown): v is ExportPrehled {
  return typeof v === 'string' && (EXPORT_PREHLEDY as readonly string[]).includes(v)
}

/**
 * Kdo smí přehled exportovat. `sales` = jen obchodní role (vedení, obchodník)
 * — stejně jako stránka (canCurrentUserSeeSales); `team` = každý interní člen
 * (obchodní sloupce se ostatním vynechají). RLS v databázi platí navíc.
 */
export const EXPORT_ACCESS: Readonly<Record<ExportPrehled, 'sales' | 'team'>> = {
  pipeline: 'sales',
  klienti: 'team',
  aktivity: 'sales',
  ukoly: 'team',
  nabidky: 'sales',
  objednavky: 'team',
  'tydenni-prehled': 'sales',
}

export const EXPORT_TITLES: Readonly<Record<ExportPrehled, string>> = {
  pipeline: 'Obchody',
  klienti: 'Klienti a kontakty',
  aktivity: 'Aktivity',
  ukoly: 'Úkoly',
  nabidky: 'Nabídky',
  objednavky: 'Objednávky cheesecaků',
  'tydenni-prehled': 'Týdenní přehled pro vedení',
}

export function exportDocument(
  prehled: ExportPrehled,
  tables: ExportTable[],
  filters: ExportFilter[],
  meta: { generatedAt: Date; generatedBy?: string | null; title?: string; fileBase?: string },
): ExportDocument {
  return {
    title: meta.title ?? EXPORT_TITLES[prehled],
    companyName: COMPANY.name,
    filters,
    generatedAt: meta.generatedAt,
    generatedBy: meta.generatedBy ?? null,
    tables,
    // Název souboru podle názvu přehledu (obchody-2026-11-05.xlsx).
    fileBase: meta.fileBase ?? asciiSlug(EXPORT_TITLES[prehled]),
  }
}

/**
 * Audit exportu: kdo (actor v audit_event) a co — přehled, formát, počet
 * řádků a NÁZVY použitých filtrů. Hodnoty filtrů (hledaný text, jméno) ani
 * obsah souboru do auditu nepatří.
 */
export function exportAuditPayload(
  prehled: ExportPrehled | 'nabidka-pdf',
  format: ExportFormat,
  doc: Pick<ExportDocument, 'tables' | 'filters'> | null,
  extra: Record<string, number | string | null> = {},
): Record<string, unknown> {
  return {
    prehled,
    format,
    rows: doc ? doc.tables.reduce((n, t) => n + t.rows.length, 0) : null,
    filters: doc ? doc.filters.map((f) => f.label) : [],
    ...extra,
  }
}

// --- Společné ---------------------------------------------------------------

const LOST_REASON_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  (COMPANY.lostReasons ?? []).map((r) => [r.key, r.label]),
)

/** Důvod prohry: klíč z číselníku → popisek, jinak volný text, jak je. */
export function lostReasonText(reason: string | null | undefined): string {
  const r = (reason ?? '').trim()
  return LOST_REASON_LABELS[r] ?? r
}

type DealSourceFields = Pick<SalesDealLike, 'sourced_by_partner' | 'source_pdf_path'> & {
  import_batch_id?: number | null
}

/**
 * Odkud obchod přišel. Samostatný sloupec „zdroj" obchod nemá; odvozuje se
 * z toho, čím vznikl: hromadný import (0098), nabídka v PDF (0015) nebo
 * doporučení partnera. Jinak „ručně v Cockpitu".
 */
export function dealSourceLabel(deal: DealSourceFields): string {
  if (deal.import_batch_id != null) return 'Hromadný import'
  if (deal.source_pdf_path) return 'Nabídka v PDF'
  if (deal.sourced_by_partner != null) return 'Doporučení partnera'
  return 'Ručně v Cockpitu'
}

const CLOSED_REASON_STAGES = new Set(['prohráno', 'odloženo', 'vyhráno'])

/** Důvod výhry / prohry: u uzavřeného obchodu důvod z karty, jinak prázdné. */
export function dealOutcomeReason(deal: Pick<SalesDealLike, 'stage' | 'lost_reason'>): string {
  if (!CLOSED_REASON_STAGES.has(deal.stage)) return ''
  return lostReasonText(deal.lost_reason)
}

const memberName = (members: ReadonlyMap<string, string>, id: string | null | undefined) =>
  (id && members.get(id)) || ''

// --- Obchody (pipeline) ---------------------------------------------------------

export const PIPELINE_COLUMNS: ExportColumn<SalesDealLike>[] = [
  { header: 'Obchod', value: (d) => d.title },
  { header: 'Klient', value: (d) => d.account?.name ?? '' },
  { header: 'Segment', value: (d) => (d.pillar ? pillarLabel(d.pillar) : '') },
  { header: 'Typ akce', value: (d) => dealKindLabel(d.deal_kind) ?? '' },
  { header: 'Fáze', value: (d) => dealStageLabel(d.stage) },
  { header: 'Hodnota', type: 'czk', total: true, value: (d) => d.amount_one_time },
  { header: 'Vlastník', value: (d) => d.owner?.full_name ?? '' },
  { header: 'Další krok', value: (d) => d.next_step ?? (d.no_next_step_reason ? `(bez kroku: ${d.no_next_step_reason})` : '') },
  { header: 'Datum follow-upu', type: 'date', value: (d) => d.next_step_due },
  { header: 'Poslední aktivita', type: 'date', value: (d) => d.last_activity_at },
  { header: 'Zdroj', value: (d) => dealSourceLabel(d as SalesDealLike & DealSourceFields) },
  { header: 'Důvod výhry / prohry', value: (d) => dealOutcomeReason(d) },
]

const PIPELINE_STATE_LABEL: Readonly<Record<string, string>> = { open: 'otevřené', all: 'všechny' }

export function pipelineFilters(p: PipelineParams, members: ReadonlyMap<string, string>): ExportFilter[] {
  const out: ExportFilter[] = [{ label: 'Stav', value: PIPELINE_STATE_LABEL[p.state] ?? dealStageLabel(p.state) }]
  if (p.owner !== 'all') out.push({ label: 'Obchodník', value: memberName(members, p.owner) || 'neznámý' })
  if (p.kind !== 'all') out.push({ label: 'Typ', value: p.kind === 'none' ? 'nedoplněný typ' : dealKindLabel(p.kind) ?? p.kind })
  if (p.q) out.push({ label: 'Hledání', value: `„${p.rawQ.trim()}"` })
  return out
}

export function pipelineTable(deals: readonly SalesDealLike[]): ExportTable {
  return toExportTable('Obchody', PIPELINE_COLUMNS, deals, { emptyText: 'Žádné obchody pro zvolené filtry.' })
}

// --- Klienti a kontakty -----------------------------------------------------------

export type ClientExportRow = AccountListRow & {
  status: string
  openDeals: number
  openAmount: number
  nextStep: string | null
  nextStepDue: string | null
}

export function clientRows(
  accounts: readonly AccountListRow[],
  deals: readonly SalesDealLike[],
  sets: StatusSets,
): ClientExportRow[] {
  const open = new Map<number, SalesDealLike[]>()
  for (const d of deals) {
    if (!OPEN_DEAL_STAGES.includes(d.stage)) continue
    const bucket = open.get(d.account_id) ?? []
    bucket.push(d)
    open.set(d.account_id, bucket)
  }
  return accounts.map((a) => {
    const mine = open.get(a.id) ?? []
    const next = mine.filter((d) => d.next_step_due)
      .sort((x, y) => (x.next_step_due ?? '').localeCompare(y.next_step_due ?? ''))[0]
    return {
      ...a,
      status: ACCOUNT_STATUS_LABELS[accountStatus(a, sets)],
      openDeals: mine.length,
      openAmount: mine.reduce((s, d) => s + Number(d.amount_one_time ?? 0), 0),
      nextStep: next?.next_step ?? null,
      nextStepDue: next?.next_step_due ?? null,
    }
  })
}

export function clientColumns(canSeeSales: boolean): ExportColumn<ClientExportRow>[] {
  return [
    { header: 'Firma', value: (a) => a.name },
    { header: 'IČO', value: (a) => a.ico },
    { header: 'Stav', value: (a) => a.status },
    { header: 'Obor', value: (a) => a.industry },
    { header: 'Region', value: (a) => a.region },
    { header: 'Vlastník', value: (a) => a.owner?.full_name ?? '' },
    { header: 'Klientem od', type: 'date', value: (a) => a.client_since },
    { header: 'Poslední kontakt', type: 'date', value: (a) => lastContactAt(a) },
    ...(canSeeSales ? [
      { header: 'Otevřené obchody', type: 'number', total: true, value: (a) => a.openDeals },
      { header: 'Hodnota otevřených', type: 'czk', total: true, value: (a) => a.openAmount },
      { header: 'Další krok', value: (a) => a.nextStep },
      { header: 'Termín kroku', type: 'date', value: (a) => a.nextStepDue },
    ] satisfies ExportColumn<ClientExportRow>[] : []),
    { header: 'Doporučil', value: (a) => a.referred_by?.name ?? '' },
  ]
}

export const CONTACT_COLUMNS: ExportColumn<Contact & { accountName: string }>[] = [
  { header: 'Jméno', value: (c) => c.full_name },
  { header: 'Firma', value: (c) => c.accountName },
  { header: 'Pozice', value: (c) => c.role },
  { header: 'E-mail', value: (c) => c.email },
  { header: 'Telefon', value: (c) => c.phone },
  { header: 'Hlavní kontakt', value: (c) => c.is_champion },
  { header: 'Nesouhlasí s oslovením', value: (c) => c.do_not_contact ?? false },
  { header: 'Založeno', type: 'date', value: (c) => c.created_at },
]

/** Kontakty jen u exportovaných firem, seřazené podle firmy a jména. */
export function contactRows(contacts: readonly Contact[], accounts: readonly Pick<AccountListRow, 'id' | 'name'>[]): (Contact & { accountName: string })[] {
  const names = new Map(accounts.map((a) => [a.id, a.name]))
  return contacts
    .filter((c) => c.account_id != null && names.has(c.account_id))
    .map((c) => ({ ...c, accountName: names.get(c.account_id!) ?? '' }))
    .sort((a, b) => a.accountName.localeCompare(b.accountName, 'cs') || a.full_name.localeCompare(b.full_name, 'cs'))
}

export function clientFilters(p: AccountListParams, members: ReadonlyMap<string, string>): ExportFilter[] {
  const out: ExportFilter[] = []
  if (p.status) out.push({ label: 'Stav', value: ACCOUNT_STATUS_LABELS[p.status] })
  if (p.q) out.push({ label: 'Hledání', value: `„${p.q}"` })
  if (p.obor) out.push({ label: 'Obor', value: p.obor === NONE_VALUE ? 'nevyplněný' : p.obor })
  if (p.region) out.push({ label: 'Region', value: p.region === NONE_VALUE ? 'nevyplněný' : p.region })
  if (p.owner) out.push({ label: 'Vlastník', value: p.owner === NONE_VALUE ? 'bez vlastníka' : memberName(members, p.owner) || 'neznámý' })
  if (p.bezIco) out.push({ label: 'IČO', value: 'jen bez IČO' })
  if (p.sort !== 'nazev') out.push({ label: 'Řazení', value: ACCOUNT_SORT_LABELS[p.sort] })
  return out
}

// --- Aktivity -----------------------------------------------------------------------

export const ACTIVITY_KIND_LABELS: Readonly<Record<string, string>> = {
  call: 'Telefonát', email: 'E-mail', meeting: 'Schůzka', note: 'Poznámka', other: 'Aktivita',
}
export const ACTIVITY_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  completed: 'Dokončeno', no_answer: 'Bez odpovědi', follow_up: 'Navázat', cancelled: 'Zrušeno', planned: 'Naplánováno',
}

/** Excel unese v buňce nejvýš 32 767 znaků; dlouhé texty se zkrátí s poznámkou. */
export const CELL_TEXT_MAX = 30_000
export function cellText(v: string | null | undefined): string {
  if (!v) return ''
  return v.length > CELL_TEXT_MAX ? `${v.slice(0, CELL_TEXT_MAX)}… (zkráceno)` : v
}

export const ACTIVITY_COLUMNS: ExportColumn<SalesActivityLike>[] = [
  { header: 'Kdy', type: 'datetime', value: (a) => a.occurred_at },
  { header: 'Druh', value: (a) => ACTIVITY_KIND_LABELS[a.kind] ?? a.kind },
  { header: 'Výsledek', value: (a) => ACTIVITY_OUTCOME_LABELS[a.outcome] ?? a.outcome },
  { header: 'Předmět', value: (a) => cellText(a.subject) },
  { header: 'Klient', value: (a) => a.account?.name ?? '' },
  { header: 'Obchod', value: (a) => a.deal?.title ?? '' },
  { header: 'Kontakt', value: (a) => a.contact?.full_name ?? '' },
  { header: 'Zapsal/a', value: (a) => a.author?.full_name ?? '' },
  { header: 'Navázat dne', type: 'date', value: (a) => a.follow_up_on },
  { header: 'Poznámka', value: (a) => cellText(a.body) },
]

// --- Úkoly -------------------------------------------------------------------------

export const TASK_STATUS_LABELS: Readonly<Record<string, string>> = {
  todo: 'K udělání', in_progress: 'Dělá se', blocked: 'Blokováno', done: 'Hotovo',
}
export const TASK_PRIORITY_LABELS: Readonly<Record<string, string>> = { high: 'Vysoká', normal: 'Normální', low: 'Nízká' }

export function taskColumns(members: ReadonlyMap<string, string>, canSeeSales: boolean): ExportColumn<Task>[] {
  return [
    { header: 'Úkol', value: (t) => t.title },
    { header: 'Stav', value: (t) => TASK_STATUS_LABELS[t.status] ?? t.status },
    { header: 'Priorita', value: (t) => TASK_PRIORITY_LABELS[t.priority] ?? t.priority },
    { header: 'Řeší', value: (t) => memberName(members, t.assignee_id) },
    { header: 'Termín', type: 'date', value: (t) => t.due_on },
    { header: 'Klient', value: (t) => t.account?.name ?? '' },
    ...(canSeeSales ? [{ header: 'Obchod', value: (t: Task) => t.deal?.title ?? '' }] : []),
    { header: 'Popis', value: (t) => cellText(t.description) },
    { header: 'Založeno', type: 'date', value: (t) => t.created_at },
  ]
}

// --- Nabídky (verze nabídky obchodu, 0072) ----------------------------------------

export type OfferExportRow = ScopeVersionRow & {
  deal: { id: number; title: string; account: { id: number; name: string } | null } | null
}

export const OFFER_COLUMNS: ExportColumn<OfferExportRow>[] = [
  { header: 'Klient', value: (v) => v.deal?.account?.name ?? '' },
  { header: 'Obchod', value: (v) => v.deal?.title ?? '' },
  { header: 'Verze', type: 'number', value: (v) => v.version },
  { header: 'Stav', value: (v) => SCOPE_VERSION_STATUS_LABEL[v.status] ?? v.status },
  // Bez součtu: verze téhož obchodu (koncept, odeslaná, nahrazená) by se sečetly víckrát.
  { header: 'Částka (Kč)', type: 'czk', value: (v) => (v.currency === 'CZK' ? v.amount_one_time : null) },
  { header: 'Částka v EUR', type: 'number', value: (v) => (v.currency === 'EUR' ? v.amount_one_time : null) },
  { header: 'Odesláno', type: 'date', value: (v) => v.sent_at },
  { header: 'Rozhodnuto', type: 'date', value: (v) => v.decided_at },
  { header: 'Vytvořeno', type: 'date', value: (v) => v.created_at },
  { header: 'Rozsah', value: (v) => cellText(v.scope) },
]

export function offerFilters(status: string | null): ExportFilter[] {
  if (!status) return []
  return [{ label: 'Stav', value: SCOPE_VERSION_STATUS_LABEL[status as keyof typeof SCOPE_VERSION_STATUS_LABEL] ?? status }]
}

// --- Objednávky cheesecaků (shop_order, 0102) --------------------------------------

export type ShopOrderExportRow = {
  id: number
  received_at: string
  status: string
  fulfilment_date: string
  fulfilment: string
  delivery_address: string | null
  dedication: string | null
  note: string | null
  customer_name: string
  email: string
  phone: string
  items: unknown
  delivery_czk: number
  total_czk: number
}

/** Položky objednávky jako text („2× Daddy vanilkový, 1× Mini mix"). */
export function shopOrderItemsText(items: unknown): string {
  if (!Array.isArray(items)) return ''
  return items
    .map((i) => {
      const it = i as { label?: unknown; quantity?: unknown; product_key?: unknown }
      const label = typeof it.label === 'string' ? it.label : typeof it.product_key === 'string' ? it.product_key : '?'
      return `${Number(it.quantity) || 0}× ${label}`
    })
    .join(', ')
}

export const SHOP_ORDER_COLUMNS: ExportColumn<ShopOrderExportRow>[] = [
  { header: 'Číslo', type: 'number', value: (o) => o.id },
  { header: 'Přijato', type: 'datetime', value: (o) => o.received_at },
  { header: 'Stav', value: (o) => SHOP_ORDER_STATUS_LABELS[o.status as ShopOrderStatus] ?? o.status },
  { header: 'Termín', type: 'date', value: (o) => o.fulfilment_date },
  { header: 'Způsob', value: (o) => (o.fulfilment === 'delivery' ? 'Doručení' : 'Vyzvednutí') },
  { header: 'Zákazník', value: (o) => o.customer_name },
  { header: 'E-mail', value: (o) => o.email },
  { header: 'Telefon', value: (o) => o.phone },
  { header: 'Položky', value: (o) => shopOrderItemsText(o.items) },
  { header: 'Věnování', value: (o) => o.dedication },
  { header: 'Poznámka', value: (o) => cellText(o.note) },
  { header: 'Adresa doručení', value: (o) => o.delivery_address },
  { header: 'Doprava', type: 'czk', total: true, value: (o) => o.delivery_czk },
  { header: 'Celkem', type: 'czk', total: true, value: (o) => o.total_czk },
]

export function shopOrderFilters(status: string | null): ExportFilter[] {
  if (!status) return []
  return [{ label: 'Stav', value: SHOP_ORDER_STATUS_LABELS[status as ShopOrderStatus] ?? status }]
}
