// Společný tvar exportu přehledu (Excel i PDF). Čistá data bez I/O:
// doména (domain/*/exports) z řádků stránky sestaví ExportDocument
// a lib/export/xlsx.ts nebo lib/export/pdf.ts ho vykreslí. Hodnoty v buňkách
// jsou surové (číslo, ISO datum, text); formát (Kč, datum cs-CZ) přidává až
// výstup — Excel číselným formátem buňky, PDF textem.
import { PRAGUE_TZ } from '@/lib/pragueDate'

/** Druh sloupce: určuje formát v Excelu i v PDF a zarovnání. */
export type ExportCellType = 'text' | 'number' | 'czk' | 'date' | 'datetime' | 'percent'

/** Surová hodnota buňky. Datum je 'YYYY-MM-DD', okamžik ISO řetězec (UTC). */
export type ExportValue = string | number | boolean | null | undefined

export interface ExportColumnSpec {
  header: string
  type?: ExportCellType
  /** Sečíst sloupec do řádku „Celkem" (jen number / czk). */
  total?: boolean
}

export interface ExportTable {
  /** Název tabulky = název listu v Excelu a nadpis oddílu v PDF. */
  title: string
  columns: readonly ExportColumnSpec[]
  rows: readonly (readonly ExportValue[])[]
  /** Krátká věta pod nadpisem oddílu (např. „Otevřené obchody k 5. 11. 2026"). */
  note?: string
  /** Text prázdné tabulky. */
  emptyText?: string
}

export interface ExportFilter {
  label: string
  value: string
}

export interface ExportDocument {
  /** Název přehledu („Obchody", „Klienti a kontakty"). */
  title: string
  /** Jméno firmy do hlavičky a patičky. */
  companyName: string
  /** Použité filtry v lidské podobě; prázdné = bez filtru. */
  filters: readonly ExportFilter[]
  generatedAt: Date
  /** Kdo export stáhl (jméno do hlavičky PDF a listu Informace); volitelné. */
  generatedBy?: string | null
  tables: readonly ExportTable[]
  /** Základ názvu souboru bez přípony a data („obchody"). */
  fileBase: string
}

/** Sloupec s accessorem — pohodlnější zápis v doméně. */
export interface ExportColumn<R> extends ExportColumnSpec {
  value: (row: R) => ExportValue
}

/** Řádky domény → tabulka exportu. */
export function toExportTable<R>(
  title: string,
  columns: readonly ExportColumn<R>[],
  rows: readonly R[],
  extra: Pick<ExportTable, 'note' | 'emptyText'> = {},
): ExportTable {
  return {
    title,
    columns: columns.map((c) => {
      const spec: ExportColumnSpec = { header: c.header }
      if (c.type) spec.type = c.type
      if (c.total) spec.total = c.total
      return spec
    }),
    rows: rows.map((row) => columns.map((c) => c.value(row))),
    ...extra,
  }
}

// --- Formát hodnot (text do PDF; Excel dostává číslo/datum s formátem) ---

const NBSP_RE = /[  ]/g
const intFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 })
const numFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 })
const dateTimeFmt = new Intl.DateTimeFormat('cs-CZ', {
  timeZone: PRAGUE_TZ, day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
})
const localPartsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRAGUE_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Číslo z buňky (PostgREST vrací numeric jako řetězec); jinak null. */
export function toNumber(v: ExportValue): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 1 234 567 Kč (obyčejné mezery, ať se v PDF ani v testech neliší ICU). */
export function formatCzkText(n: number): string {
  return `${intFmt.format(Math.round(n)).replace(NBSP_RE, ' ')} Kč`
}

/** 'YYYY-MM-DD' → „5. 11. 2026" (kalendářní den, bez posunu pásma). */
export function formatDayText(day: string): string {
  const m = ISO_DAY.exec(day)
  if (!m) return day
  return `${Number(m[3])}. ${Number(m[2])}. ${m[1]}`
}

/** Okamžik → „5. 11. 2026 14:03" v pásmu firmy. */
export function formatDateTimeText(d: Date): string {
  return dateTimeFmt.format(d).replace(NBSP_RE, ' ')
}

/**
 * Hodnota typu date/datetime jako „místní" Date pro Excel: Excel nezná
 * pásma, buňka nese čas, jak ho čte člověk v Praze. Proto se pražské
 * složky zapíšou jako UTC (exceljs převádí Date přes UTC).
 */
export function toExcelDate(v: ExportValue, type: 'date' | 'datetime'): Date | null {
  if (typeof v !== 'string' || v === '') return null
  const day = ISO_DAY.exec(v)
  if (day) return new Date(Date.UTC(+day[1], +day[2] - 1, +day[3]))
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  const p: Record<string, string> = {}
  for (const part of localPartsFmt.formatToParts(d)) p[part.type] = part.value
  if (type === 'date') return new Date(Date.UTC(+p.year, +p.month - 1, +p.day))
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute))
}

/** Text buňky pro PDF (a pro odhad šířky sloupce v Excelu). Prázdná hodnota = ''. */
export function formatCell(v: ExportValue, type: ExportCellType = 'text'): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'boolean') return v ? 'ano' : 'ne'
  switch (type) {
    case 'czk': {
      const n = toNumber(v)
      return n === null ? String(v) : formatCzkText(n)
    }
    case 'number': {
      const n = toNumber(v)
      return n === null ? String(v) : numFmt.format(n).replace(NBSP_RE, ' ')
    }
    case 'percent': {
      const n = toNumber(v)
      return n === null ? String(v) : `${numFmt.format(n).replace(NBSP_RE, ' ')} %`
    }
    case 'date': {
      if (typeof v !== 'string') return String(v)
      if (ISO_DAY.test(v)) return formatDayText(v)
      const d = new Date(v)
      if (Number.isNaN(d.getTime())) return v
      const local = toExcelDate(v, 'date')!
      return formatDayText(local.toISOString().slice(0, 10))
    }
    case 'datetime': {
      if (typeof v !== 'string') return String(v)
      if (ISO_DAY.test(v)) return formatDayText(v)
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? v : formatDateTimeText(d)
    }
    default:
      return String(v)
  }
}

export function isNumericType(type: ExportCellType | undefined): boolean {
  return type === 'number' || type === 'czk' || type === 'percent'
}

/** Součty sloupců s `total: true`; null u ostatních. */
export function columnTotals(table: ExportTable): (number | null)[] {
  return table.columns.map((c, i) => {
    if (!c.total || !isNumericType(c.type)) return null
    return table.rows.reduce((sum, row) => sum + (toNumber(row[i]) ?? 0), 0)
  })
}

export function hasTotals(table: ExportTable): boolean {
  return table.rows.length > 0 && table.columns.some((c) => c.total && isNumericType(c.type))
}

/** Název souboru: „obchody-2026-11-05.xlsx" (jen ASCII, den v pásmu firmy). */
export function exportFileName(doc: Pick<ExportDocument, 'fileBase' | 'generatedAt'>, ext: 'xlsx' | 'pdf'): string {
  const base = asciiSlug(doc.fileBase) || 'export'
  const day = (toExcelDate(doc.generatedAt.toISOString(), 'date') ?? doc.generatedAt).toISOString().slice(0, 10)
  return `${base}-${day}.${ext}`
}

/** Bez diakritiky, malá písmena, pomlčky. */
export function asciiSlug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** Popis filtrů do hlavičky („Vlastník: Jana · Stav: otevřené" / „bez filtru"). */
export function filtersLine(filters: readonly ExportFilter[]): string {
  if (filters.length === 0) return 'Filtry: bez filtru (vše, co vidíte)'
  return `Filtry: ${filters.map((f) => `${f.label}: ${f.value}`).join(' · ')}`
}
