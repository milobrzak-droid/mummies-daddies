// Hromadný import běžících zakázek (migrace 0098, docs/PROVOZ.md) —
// čistá logika bez I/O: tabulka CSV (parsování, šablona, validace po řádcích),
// párování klientů, klíče idempotence, vstup potvrzení a překlad chyb databáze.
//
// Dva zdroje, jedna kontrolní fronta:
//   A) více PDF najednou — každé projde krokem „PDF → návrh AI“
//      (domain/crm/actions/offers.ts, offer-extract.ts), tady se jen páruje
//      klient a skládá řádek k potvrzení;
//   B) tabulka CSV — sloupce klient, IČO, název zakázky, cena, měna, stav,
//      začátek, termín, vlastník, fakturováno, přijato (+ volitelně typ).
//
// Nic se nezakládá, dokud člověk řádek nepotvrdí. Zápis jednoho řádku dělá
// databázová funkce import_apply_row atomicky (klient, obchod, přijatá verze
// nabídky, dodávka, finance); tenhle modul jí jen připraví vstup a klíče.
// Modul nesahá na `node:` ani na síť, takže ho smí importovat i klientská
// komponenta.
import { z } from 'zod'
import { defaultProbabilityForStage } from '@/lib/domain'
import { cleanCompanyName, normalizeCompanyName } from '@/connectors/ares'
import { canonicalIco, isValidIco } from '@/domain/crm/meetingIntake'
import { isRealDate } from '@/domain/crm/offerProposal'
import { REVENUE_LINES } from '@/domain/crm/offer-extract'
import type { RevenueLine } from '@/lib/types'

// ---------------------------------------------------------------------------
// Limity

/** Kolik PDF jde nahrát najednou. */
export const BULK_MAX_PDFS = 30
/** Nejvíc řádků v tabulce (víc = rozdělit na víc souborů). */
export const BULK_MAX_CSV_ROWS = 500
/** Největší tabulka v bajtech (CSV je text, 1 MB je hodně přes 500 řádků). */
export const BULK_MAX_CSV_BYTES = 1024 * 1024
/**
 * Největší PDF. Strop dává platforma: tělo požadavku na Vercelu smí mít 4,5 MB
 * (next.config.ts nastavuje serverActions.bodySizeLimit na 4 MB, výchozí je 1 MB).
 */
export const BULK_MAX_PDF_BYTES = 4 * 1024 * 1024
/** Nejvyšší částka (stejný strop jako u návrhu z PDF). */
export const BULK_AMOUNT_MAX = 1_000_000_000
/** Nový PDF návrh, který nikdo nepotvrdil, se ukládá nejvýš tuhle dobu (dny). */
export const BULK_PROPOSAL_RETENTION_DAYS = 7

// ---------------------------------------------------------------------------
// Stavy zakázky

export const IMPORT_STAGES = ['won', 'sent', 'draft'] as const
export type ImportStage = (typeof IMPORT_STAGES)[number]

export const IMPORT_STAGE_LABEL: Record<ImportStage, string> = {
  won: 'Vyhráno a běží',
  sent: 'Nabídka odeslána',
  draft: 'Rozjednáno',
}

/** Fáze obchodu v Cockpitu (lib/domain DEAL_STAGES), kterou import zapíše. */
export const IMPORT_STAGE_DEAL = {
  won: 'vyhráno',
  sent: 'rozsah_nabidka',
  draft: 'diagnostika',
} as const

export function importStageProbability(stage: ImportStage): number {
  return defaultProbabilityForStage(IMPORT_STAGE_DEAL[stage])
}

/** Fold pro porovnání textu: malá písmena bez diakritiky, jen alfanumerika. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const STAGE_ALIASES: Record<string, ImportStage> = {
  'vyhrano a bezi': 'won', vyhrano: 'won', bezi: 'won', bezici: 'won', realizace: 'won', won: 'won',
  'nabidka odeslana': 'sent', nabidka: 'sent', odeslano: 'sent', odeslana: 'sent', sent: 'sent',
  rozjednano: 'draft', rozjednana: 'draft', rozpracovano: 'draft', jednani: 'draft', draft: 'draft',
}

export function parseImportStage(raw: string): ImportStage | null {
  return STAGE_ALIASES[fold(raw)] ?? null
}

// Typ příjmu (volitelný sloupec „typ“): jak Cockpit pozná druh dodávky a šablonu milníků.
const TYPE_ALIASES: Record<string, RevenueLine> = {
  firemni: 'catering_firemni', 'firemni akce': 'catering_firemni', catering: 'catering_firemni',
  oslava: 'oslava_soukroma', 'soukroma oslava': 'oslava_soukroma', narozeniny: 'oslava_soukroma',
  svatba: 'svatebni_hostina', 'svatebni hostina': 'svatebni_hostina',
  cheesecake: 'cheesecaky_eshop', cheesecaky: 'cheesecaky_eshop', eshop: 'cheesecaky_eshop',
  pravidelny: 'firemni_pravidelny', 'pravidelny catering': 'firemni_pravidelny',
  pronajem: 'pronajem_prostor', prostory: 'pronajem_prostor',
}
export const DEFAULT_IMPORT_REVENUE_LINE: RevenueLine = 'catering_firemni'

export function parseImportRevenueLine(raw: string): RevenueLine | null {
  const f = fold(raw)
  if ((REVENUE_LINES as string[]).includes(raw.trim())) return raw.trim() as RevenueLine
  return TYPE_ALIASES[f] ?? null
}

export function revenueCategoryFor(line: RevenueLine): 'one_time' | 'recurring' | 'royalty' {
  if (line === 'firemni_pravidelny') return 'recurring'
  if (line === 'provize') return 'royalty'
  return 'one_time'
}

// ---------------------------------------------------------------------------
// CSV: parsování

/**
 * RFC 4180 (uvozovky, zdvojené uvozovky, zalomení v buňce), oddělovač se pozná
 * z hlavičky (; , tabulátor — český Excel ukládá středník). BOM se ořízne.
 */
export function parseCsv(input: string): { rows: string[][]; delimiter: string } {
  const text = input.replace(/^﻿/, '')
  const firstLine = (() => {
    let inQ = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (c === '"') inQ = !inQ
      else if (!inQ && (c === '\n' || c === '\r')) return text.slice(0, i)
    }
    return text
  })()
  const count = (d: string) => {
    let n = 0
    let inQ = false
    for (const c of firstLine) {
      if (c === '"') inQ = !inQ
      else if (!inQ && c === d) n++
    }
    return n
  }
  const best = [';', '\t', ','].map((d) => ({ d, n: count(d) })).sort((a, b) => b.n - a.n)[0]
  const delimiter = best.n > 0 ? best.d : ';'

  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQ = false
  const endCell = () => { row.push(cell); cell = '' }
  const endRow = () => { endCell(); rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else inQ = false
      } else cell += c
    } else if (c === '"' && cell === '') inQ = true
    else if (c === delimiter) endCell()
    else if (c === '\n') endRow()
    else if (c === '\r') { if (text[i + 1] === '\n') i++; endRow() }
    else cell += c
  }
  if (cell !== '' || row.length > 0) endRow()
  return { rows, delimiter }
}

// ---------------------------------------------------------------------------
// CSV: sloupce a šablona

export type CsvColumnKey =
  | 'client' | 'ico' | 'title' | 'price' | 'currency' | 'stage' | 'start' | 'due' | 'owner' | 'invoiced' | 'received' | 'type'

export const CSV_COLUMNS: readonly { key: CsvColumnKey; header: string; required: boolean; aliases: readonly string[]; hint: string }[] = [
  { key: 'client', header: 'klient', required: true, aliases: ['klient', 'firma', 'zakaznik', 'nazev klienta', 'nazev firmy'], hint: 'název firmy' },
  { key: 'ico', header: 'IČO', required: false, aliases: ['ico', 'ic'], hint: '8 číslic; pomůže spárovat klienta' },
  { key: 'title', header: 'název zakázky', required: true, aliases: ['nazev zakazky', 'zakazka', 'nazev', 'projekt', 'nazev projektu'], hint: 'jak se zakázka jmenuje' },
  { key: 'price', header: 'cena', required: true, aliases: ['cena', 'cena bez dph', 'castka', 'cena zakazky'], hint: 'naše cena bez DPH, celé číslo nebo s čárkou' },
  { key: 'currency', header: 'měna', required: false, aliases: ['mena'], hint: 'CZK (výchozí) nebo EUR' },
  { key: 'stage', header: 'stav', required: true, aliases: ['stav', 'faze'], hint: 'vyhráno a běží | nabídka odeslána | rozjednáno' },
  { key: 'start', header: 'začátek', required: false, aliases: ['zacatek', 'zacatek zakazky', 'start', 'od'], hint: 'kdy zakázka začala (2026-03-01 nebo 1. 3. 2026)' },
  { key: 'due', header: 'termín', required: false, aliases: ['termin', 'konec', 'do', 'termin dodani', 'termin zakazky'], hint: 'kdy má skončit' },
  { key: 'owner', header: 'vlastník', required: false, aliases: ['vlastnik', 'vlastnik e mail', 'vlastnik email', 'e mail vlastnika', 'email vlastnika', 'vlastnik zakazky'], hint: 'e-mail člena týmu; prázdné = ty' },
  { key: 'invoiced', header: 'fakturováno', required: false, aliases: ['fakturovano', 'vyfakturovano'], hint: 'kolik už je vyfakturováno (jen u „vyhráno a běží“)' },
  { key: 'received', header: 'přijato', required: false, aliases: ['prijato', 'zaplaceno', 'uhrazeno'], hint: 'kolik už klient zaplatil (jen u „vyhráno a běží“)' },
  { key: 'type', header: 'typ', required: false, aliases: ['typ', 'typ zakazky', 'druh'], hint: 'firemni | oslava | svatba | cheesecaky | pravidelny | pronajem; prázdné = firemni' },
]

/** Šablona ke stažení (středník, jako český Excel). Příklady jsou vymyšlené. */
export const CSV_TEMPLATE = [
  CSV_COLUMNS.map((c) => c.header).join(';'),
  'Ukázková firma s.r.o.;27082440;Vánoční večírek;180000;CZK;vyhráno a běží;1. 12. 2026;12. 12. 2026;jmeno.prijmeni@mummiesdaddies.com;90000;50000;firemni',
  'Vzorový klient a.s.;;Svatba v zámecké zahradě;145000;CZK;nabídka odeslána;;;;;;svatba',
  'Třetí firma;;Coffee break na konferenci;;EUR;rozjednáno;;;;;;',
].join('\r\n') + '\r\n'

export const CSV_TEMPLATE_FILENAME = 'sablona-import-zakazek.csv'

// ---------------------------------------------------------------------------
// CSV: hodnoty

/** Částka z buňky: '580 000', '580000,50', '1 234 567 Kč', '€ 1200'. Neplatné = null. */
export function parseImportAmount(raw: string): number | null {
  let t = raw.replace(/[\s ]/g, '').replace(/kč|czk|eur|€|,-$/gi, '')
  if (!t || /[^0-9.,]/.test(t)) return null
  const dots = (t.match(/\./g) ?? []).length
  const commas = (t.match(/,/g) ?? []).length
  if (dots > 0 && commas > 0) {
    // Poslední oddělovač je desetinný, druhý tisícový.
    const dec = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.'
    const thousands = dec === ',' ? '.' : ','
    t = t.split(thousands).join('').replace(dec, '.')
  } else if (dots + commas > 1) {
    // Víc stejných oddělovačů = tisícové (1.234.567).
    t = t.replace(/[.,]/g, '')
  } else if (dots + commas === 1) {
    const [intPart, frac] = t.split(/[.,]/)
    // „580.000“ / „1,234“ = tisícový oddělovač; „0,500“ a „12,5“ = desetinný.
    t = frac.length === 3 && intPart.length >= 1 && intPart.length <= 3 && intPart !== '0' ? intPart + frac : `${intPart}.${frac}`
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= BULK_AMOUNT_MAX ? Math.round(n * 100) / 100 : null
}

/** Měna z buňky: prázdné = CZK. Neznámé = null. */
export function parseImportCurrency(raw: string): 'CZK' | 'EUR' | null {
  const f = raw.trim().toLowerCase()
  if (f === '' || f === 'czk' || f === 'kč' || f === 'kc') return 'CZK'
  if (f === 'eur' || f === '€') return 'EUR'
  return null
}

/** Měna naznačená symbolem v částce („580 000 Kč“, „€ 1200“); jinak null. */
function currencyHint(raw: string): 'CZK' | 'EUR' | null {
  if (/€|eur/i.test(raw)) return 'EUR'
  if (/kč|czk/i.test(raw)) return 'CZK'
  return null
}

/** Datum z buňky: 2026-03-01, 1. 3. 2026, 01.03.2026, 1/3/2026 (den/měsíc). Neplatné = null. */
export function parseImportDate(raw: string): string | null {
  const t = raw.trim()
  let y: string, m: string, d: string
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (match) [, y, m, d] = match
  else if ((match = /^(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4})$/.exec(t))) [, d, m, y] = match
  else return null
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  return isRealDate(iso) && Number(y) >= 2000 && Number(y) <= 2100 ? iso : null
}

// ---------------------------------------------------------------------------
// CSV: řádky s validací

export type ImportMember = { id: string; email: string; name: string | null }

export type ParsedCsvRow = {
  /** Číslo řádku v souboru (hlavička je 1). */
  line: number
  clientName: string
  ico: string | null
  title: string
  amount: number | null
  currency: 'CZK' | 'EUR'
  stage: ImportStage | null
  revenueLine: RevenueLine
  startedOn: string | null
  dueOn: string | null
  ownerEmail: string | null
  ownerId: string | null
  invoiced: number | null
  received: number | null
  errors: string[]
  warnings: string[]
}

export type CsvParseResult =
  | { ok: false; error: string }
  | { ok: true; rows: ParsedCsvRow[]; ignoredColumns: string[]; delimiter: string }

/**
 * Tabulka → řádky s chybami a varováními. Chyba řádku ho z importu vyřadí
 * (ostatní řádky nezastaví). Chyby souboru (chybí sloupec, moc řádků) vrací
 * `ok: false`.
 */
export function parseImportCsv(text: string, members: readonly ImportMember[]): CsvParseResult {
  if (text.length > BULK_MAX_CSV_BYTES) {
    return { ok: false, error: `Soubor je moc velký (nejvýš ${BULK_MAX_CSV_BYTES / 1024 / 1024} MB).` }
  }
  const { rows: all, delimiter } = parseCsv(text)
  const table = all.filter((r) => r.some((c) => c.trim() !== ''))
  if (table.length === 0) return { ok: false, error: 'Soubor je prázdný.' }

  const header = table[0].map((h) => fold(h))
  const colIndex = new Map<CsvColumnKey, number>()
  const ignoredColumns: string[] = []
  header.forEach((h, i) => {
    const col = CSV_COLUMNS.find((c) => c.aliases.includes(h) && !colIndex.has(c.key))
    if (col) colIndex.set(col.key, i)
    else if (h) ignoredColumns.push(table[0][i].trim())
  })
  const missing = CSV_COLUMNS.filter((c) => c.required && !colIndex.has(c.key)).map((c) => c.header)
  if (missing.length > 0) {
    return { ok: false, error: `V hlavičce chybí sloupec: ${missing.join(', ')}. Vezmi šablonu ke stažení a nech v ní názvy sloupců.` }
  }
  const data = table.slice(1)
  if (data.length === 0) return { ok: false, error: 'V tabulce je jen hlavička, žádné řádky zakázek.' }
  if (data.length > BULK_MAX_CSV_ROWS) {
    return { ok: false, error: `V tabulce je ${data.length} řádků, najednou jde nejvýš ${BULK_MAX_CSV_ROWS}. Rozděl ji na víc souborů.` }
  }

  const byEmail = new Map(members.map((m) => [m.email.trim().toLowerCase(), m]))
  const cell = (r: string[], key: CsvColumnKey) => {
    const i = colIndex.get(key)
    return i === undefined ? '' : (r[i] ?? '').trim()
  }

  const rows: ParsedCsvRow[] = data.map((r, idx) => {
    const errors: string[] = []
    const warnings: string[] = []
    const line = idx + 2

    const clientName = cell(r, 'client')
    if (!clientName) errors.push('chybí klient')
    else if (clientName.length > 200) errors.push('název klienta má víc než 200 znaků')

    const icoRaw = cell(r, 'ico')
    let ico: string | null = null
    if (icoRaw) {
      const c = canonicalIco(icoRaw)
      if (!c || !isValidIco(c)) errors.push(`IČO „${icoRaw.slice(0, 20)}“ není platné (8 číslic a kontrolní součet)`)
      else ico = c
    }

    const title = cell(r, 'title')
    if (!title) errors.push('chybí název zakázky')
    else if (title.length > 300) errors.push('název zakázky má víc než 300 znaků')

    const stageRaw = cell(r, 'stage')
    const stage = stageRaw ? parseImportStage(stageRaw) : null
    if (!stageRaw) errors.push('chybí stav')
    else if (!stage) errors.push(`stav „${stageRaw.slice(0, 30)}“ neznám (použij: vyhráno a běží, nabídka odeslána, rozjednáno)`)

    const currencyRaw = cell(r, 'currency')
    const priceRaw = cell(r, 'price')
    let currency = parseImportCurrency(currencyRaw)
    if (currency === null) {
      errors.push(`měna „${currencyRaw.slice(0, 10)}“ není CZK ani EUR`)
      currency = 'CZK'
    }
    const hinted = currencyHint(priceRaw)
    if (hinted && currencyRaw && hinted !== currency) errors.push('měna ve sloupci měna a u ceny se liší')
    else if (hinted && !currencyRaw) currency = hinted

    let amount: number | null = null
    if (priceRaw) {
      amount = parseImportAmount(priceRaw)
      if (amount === null) errors.push(`cenu „${priceRaw.slice(0, 20)}“ nepoznávám (zapiš číslo, např. 580000)`)
    }
    if (stage === 'won' || stage === 'sent') {
      if (priceRaw === '') errors.push('u této zakázky chybí cena')
      else if (amount === 0) errors.push('cena je nula')
    }
    if (stage === 'draft' && amount === null) warnings.push('bez ceny (rozjednáno)')

    const startRaw = cell(r, 'start')
    const startedOn = startRaw ? parseImportDate(startRaw) : null
    if (startRaw && !startedOn) errors.push(`začátek „${startRaw.slice(0, 20)}“ není datum`)
    const dueRaw = cell(r, 'due')
    const dueOn = dueRaw ? parseImportDate(dueRaw) : null
    if (dueRaw && !dueOn) errors.push(`termín „${dueRaw.slice(0, 20)}“ není datum`)
    if (startedOn && dueOn && dueOn < startedOn) errors.push('termín je dřív než začátek')

    const ownerRaw = cell(r, 'owner').toLowerCase()
    let ownerId: string | null = null
    if (ownerRaw) {
      const m = byEmail.get(ownerRaw)
      if (!m) errors.push(`člen týmu s e-mailem „${ownerRaw.slice(0, 60)}“ neexistuje`)
      else ownerId = m.id
    }

    const invRaw = cell(r, 'invoiced')
    const recRaw = cell(r, 'received')
    const invoiced = invRaw ? parseImportAmount(invRaw) : null
    const received = recRaw ? parseImportAmount(recRaw) : null
    if (invRaw && invoiced === null) errors.push(`fakturováno „${invRaw.slice(0, 20)}“ není částka`)
    if (recRaw && received === null) errors.push(`přijato „${recRaw.slice(0, 20)}“ není částka`)
    if ((invoiced || received) && stage && stage !== 'won') errors.push('fakturováno a přijato jde uvést jen u „vyhráno a běží“')
    if (invoiced !== null && received !== null && received > invoiced) errors.push('přijato je víc než fakturováno')
    if (amount && invoiced && invoiced > amount) warnings.push('fakturováno je víc než cena zakázky')

    const typeRaw = cell(r, 'type')
    let revenueLine = DEFAULT_IMPORT_REVENUE_LINE
    if (typeRaw) {
      const rl = parseImportRevenueLine(typeRaw)
      if (!rl) errors.push(`typ „${typeRaw.slice(0, 20)}“ neznám (workshop, implementace, sw, platforma)`)
      else revenueLine = rl
    }

    return {
      line, clientName, ico, title, amount, currency, stage, revenueLine, startedOn, dueOn,
      ownerEmail: ownerRaw || null, ownerId, invoiced, received, errors, warnings,
    }
  })

  // Stejná zakázka v souboru dvakrát: druhý výskyt se vyřadí.
  const seen = new Map<string, number>()
  for (const row of rows) {
    if (row.errors.length > 0) continue
    const k = importRowKeyText(row)
    const first = seen.get(k)
    if (first !== undefined) row.errors.push(`stejná zakázka je už na řádku ${first}`)
    else seen.set(k, row.line)
  }

  return { ok: true, rows, ignoredColumns, delimiter }
}

// ---------------------------------------------------------------------------
// Klíče idempotence

type KeyFields = { clientName: string; ico: string | null; title: string; amount: number | null; currency: string }

/** Text, ze kterého se počítá klíč řádku: klient (IČO má přednost) + název + cena + měna. */
export function importRowKeyText(f: KeyFields): string {
  const who = f.ico ? `ico:${f.ico}` : `name:${normalizeCompanyName(cleanCompanyName(f.clientName)) || fold(f.clientName)}`
  return `${who}|${fold(f.title)}|${(f.amount ?? 0).toFixed(2)}|${f.currency}`
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Klíč zakázky podle obsahu: stejný klient + název + cena + měna = stejná zakázka. */
export async function importRowKey(f: KeyFields): Promise<string> {
  return `row:${await sha256Hex(importRowKeyText(f))}`
}

/** Klíč PDF podle obsahu souboru: stejný soubor (i pod jiným názvem) = stejná zakázka. */
export async function importPdfKey(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return `pdf:${await sha256Hex(bytes)}`
}

// ---------------------------------------------------------------------------
// Párování klienta

export type MatchAccount = { id: number; name: string; ico: string | null }
export type MatchAlias = { account_id: number; alias_name: string | null }
export type AccountIndex = { accounts: readonly MatchAccount[]; aliases: readonly MatchAlias[] }

export type ClientMatch =
  | { kind: 'matched'; accountId: number; name: string; by: 'ico' | 'name' | 'alias' }
  /** Víc kandidátů nebo rozpor (jiné IČO u téhož názvu): rozhodne člověk. */
  | { kind: 'ambiguous'; candidates: { id: number; name: string }[]; reason: 'name' | 'ico_conflict' }
  /** Klient v Cockpitu není; nový vznikne jen po potvrzení. */
  | { kind: 'none' }

function key(name: string): string {
  return normalizeCompanyName(cleanCompanyName(name))
}

/**
 * Klient podle IČO (přesně), potom podle názvu (bez právní formy, diakritiky
 * a velikosti písmen) a aliasů. Nejistota = výběr člověkem; nikdy se klient
 * nepřiřadí naslepo a nikdy se nezaloží bez potvrzení.
 */
export function matchClient(hint: { name: string; ico: string | null }, index: AccountIndex): ClientMatch {
  if (hint.ico) {
    const byIco = index.accounts.find((a) => a.ico && canonicalIco(a.ico) === hint.ico)
    if (byIco) return { kind: 'matched', accountId: byIco.id, name: byIco.name, by: 'ico' }
  }
  const wanted = key(hint.name)
  if (!wanted) return { kind: 'none' }

  const byName = index.accounts.filter((a) => key(a.name) === wanted)
  const aliasHits = index.aliases
    .filter((al) => al.alias_name && key(al.alias_name) === wanted)
    .map((al) => index.accounts.find((a) => a.id === al.account_id))
    .filter((a): a is MatchAccount => a !== undefined && !byName.some((b) => b.id === a.id))
  const candidates = [...byName, ...aliasHits]

  if (candidates.length === 0) return { kind: 'none' }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', reason: 'name', candidates: candidates.map((a) => ({ id: a.id, name: a.name })) }
  }
  const only = candidates[0]
  // Stejný název, ale firma má jiné IČO, než uvádí import: dvě různé firmy.
  if (hint.ico && only.ico && canonicalIco(only.ico) !== hint.ico) {
    return { kind: 'ambiguous', reason: 'ico_conflict', candidates: [{ id: only.id, name: only.name }] }
  }
  return { kind: 'matched', accountId: only.id, name: only.name, by: byName.length > 0 ? 'name' : 'alias' }
}

export function describeClientMatch(m: ClientMatch): string {
  switch (m.kind) {
    case 'matched':
      return m.by === 'ico' ? 'Spárováno podle IČO.' : m.by === 'alias' ? 'Spárováno podle aliasu.' : 'Spárováno podle názvu.'
    case 'ambiguous':
      return m.reason === 'ico_conflict'
        ? 'Klient se stejným názvem má jiné IČO. Vyber, jestli je to on, nebo nový klient.'
        : 'Víc klientů se stejným názvem. Vyber správného.'
    default:
      return 'V Cockpitu takový klient není. Nový klient se založí jen po tvém potvrzení.'
  }
}

// ---------------------------------------------------------------------------
// Vstup potvrzení jednoho řádku (server action)

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const optDate = z.union([z.literal(''), z.null(), z.undefined(), z.string()])
  .transform((v) => (v === '' || v == null ? null : v))
  .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && isRealDate(v)), 'Zadej platné datum.')
const optAmount = z.union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v === null || v === undefined || v === '') return null
    const n = typeof v === 'number' ? v : parseImportAmount(v)
    if (n === null || !Number.isFinite(n) || n < 0 || n > BULK_AMOUNT_MAX) {
      ctx.addIssue({ code: 'custom', message: 'Zadej částku (číslo od 0).' })
      return z.NEVER
    }
    return Math.round(n * 100) / 100
  })

export const applyRowSchema = z.object({
  batch_id: z.number().int().positive(),
  source: z.enum(['pdf', 'csv']),
  proposal_id: z.string().regex(UUID_V4).nullable().optional(),
  account: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), id: z.number().int().positive() }),
    z.object({
      mode: z.literal('new'),
      name: z.string().trim().min(1, 'Název klienta je povinný.').max(200, 'Název klienta může mít nejvýš 200 znaků.'),
      ico: z.string().nullable().optional(),
    }),
  ]),
  // Klient tak, jak ho uvádí zdroj (řádek tabulky, návrh z PDF): z něj se počítá klíč
  // idempotence, takže výběr jiného klienta v kontrole klíč nezmění.
  key_name: z.string().trim().min(1).max(200),
  key_ico: z.string().nullable().optional(),
  title: z.string().trim().min(1, 'Název zakázky je povinný.').max(300, 'Název zakázky může mít nejvýš 300 znaků.'),
  amount: optAmount,
  currency: z.enum(['CZK', 'EUR']),
  stage: z.enum(IMPORT_STAGES),
  revenue_line: z.string().refine((v) => (REVENUE_LINES as string[]).includes(v), 'Neznámý typ příjmu.').optional(),
  pillar: z.string().nullable().optional(),
  phase: z.string().nullable().optional(),
  started_on: optDate,
  due_on: optDate,
  owner_id: z.string().regex(/^[0-9a-f-]{36}$/i, 'Neplatný vlastník.').nullable().optional(),
  invoiced: optAmount,
  received: optAmount,
}).superRefine((v, ctx) => {
  const need = (v.stage === 'won' || v.stage === 'sent') && !(v.amount && v.amount > 0)
  if (need) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'U této fáze musí být cena větší než nula.' })
  if (v.source === 'pdf' && !v.proposal_id) ctx.addIssue({ code: 'custom', path: ['proposal_id'], message: 'Chybí návrh z PDF.' })
  if ((v.invoiced || v.received) && v.stage !== 'won') {
    ctx.addIssue({ code: 'custom', path: ['invoiced'], message: 'Fakturováno a přijato jde uvést jen u „Vyhráno a běží“.' })
  }
  if (v.invoiced != null && v.received != null && v.received > v.invoiced) {
    ctx.addIssue({ code: 'custom', path: ['received'], message: 'Přijato nesmí být víc než fakturováno.' })
  }
  if (v.started_on && v.due_on && v.due_on < v.started_on) {
    ctx.addIssue({ code: 'custom', path: ['due_on'], message: 'Termín je dřív než začátek.' })
  }
  if (v.account.mode === 'new' && v.account.ico) {
    const c = canonicalIco(v.account.ico)
    if (!c || !isValidIco(c)) ctx.addIssue({ code: 'custom', path: ['account'], message: 'IČO není platné.' })
  }
})

export type ApplyRowInput = z.input<typeof applyRowSchema>
export type ApplyRowParsed = z.output<typeof applyRowSchema>

// ---------------------------------------------------------------------------
// Chyby databáze (SQLSTATE z 0098)

export const IMPORT_DB_MESSAGES: Record<string, string> = {
  IM001: 'Údaje zakázky nejsou v pořádku.',
  IM002: 'Neznámý druh dávky.',
  IM003: 'Import smí jen člen s obchodní rolí.',
  IM004: 'Dávka importu neexistuje. Začni znovu.',
  IM005: 'Dávka už je uzavřená nebo vrácená. Začni novým nahráním.',
  IM006: 'Dávka patří jinému člověku.',
  IM007: 'Vybraný klient už v Cockpitu není.',
  IM008: 'Vlastník musí být aktivní člen týmu.',
  IM009: 'Dodávku k zakázce se nepodařilo založit. Zakázka se nezapsala.',
  IM010: 'Dávku smí vrátit jen ten, kdo ji nahrál, nebo správce týmu.',
  IM011: 'Tuhle hodnotu smí zapsat jen hromadný import.',
}

type DbError = { code?: string | null; message?: string | null } | null | undefined

/** Funkce nebo tabulka z 0098 ještě v databázi není (42883/42P01, PostgREST PGRST202/PGRST205). */
export function isImportMissing(error: DbError): boolean {
  if (!error) return false
  if (error.code === '42883' || error.code === '42P01' || error.code === 'PGRST202' || error.code === 'PGRST205') return true
  return /import_(apply_row|open_batch|revert_batch|batch)/i.test(error.message ?? '') && /could not find|does not exist/i.test(error.message ?? '')
}

// Lidská věta pro uživatele; technicky chybí migrace 0098 (funkce import_*).
export const IMPORT_MISSING_MESSAGE = 'Hromadný import se připravuje. Zatím nic nezapisuje.'

/** Česká věta pro známou chybu databáze, jinak null (volající použije obecnou hlášku). */
export function importDbMessage(error: DbError): string | null {
  if (!error) return null
  if (isImportMissing(error)) return IMPORT_MISSING_MESSAGE
  if (error.code && IMPORT_DB_MESSAGES[error.code]) return IMPORT_DB_MESSAGES[error.code]
  return null
}

// ---------------------------------------------------------------------------
// Vrácení dávky

export const REVERT_REASON_LABEL: Record<string, string> = {
  changed: 'po importu se na zakázce něco změnilo',
  linked_work: 'k zakázce je navázaná práce (úkol, aktivita, dokument, alokace…)',
  other_delivery: 'k zakázce je jiná dodávka, než jakou založil import',
  other_offer_version: 'zakázka má další verzi nabídky',
  finance_changed: 'finanční záznamy zakázky se po importu změnily nebo přibyly další',
}

export type RevertResult = {
  deals_reverted: number
  deals_kept: { deal_id: number; reason: string }[]
  accounts_deleted: number
  accounts_kept: number
  records_deleted: number
  status: 'partial' | 'reverted'
}

export function parseRevertResult(data: unknown): RevertResult | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const kept = Array.isArray(d.deals_kept) ? d.deals_kept : null
  if (num(d.deals_reverted) === null || !kept || (d.status !== 'partial' && d.status !== 'reverted')) return null
  return {
    deals_reverted: d.deals_reverted as number,
    deals_kept: kept
      .filter((k): k is { deal_id: number; reason: string } => !!k && typeof (k as { deal_id?: unknown }).deal_id === 'number')
      .map((k) => ({ deal_id: k.deal_id, reason: String(k.reason ?? '') })),
    accounts_deleted: num(d.accounts_deleted) ?? 0,
    accounts_kept: num(d.accounts_kept) ?? 0,
    records_deleted: num(d.records_deleted) ?? 0,
    status: d.status,
  }
}

/** Souhrn vrácení jednou větou pro toast/stránku. */
export function describeRevert(r: RevertResult): string {
  const parts = [`Vráceno zakázek: ${r.deals_reverted}.`]
  if (r.deals_kept.length > 0) parts.push(`Ponecháno ${r.deals_kept.length}, protože se na nich už pracovalo.`)
  if (r.accounts_deleted > 0) parts.push(`Smazaní klienti založení importem: ${r.accounts_deleted}.`)
  if (r.accounts_kept > 0) parts.push(`Klienti ponecháni: ${r.accounts_kept}.`)
  return parts.join(' ')
}
