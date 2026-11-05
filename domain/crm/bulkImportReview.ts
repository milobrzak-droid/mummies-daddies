// Řádek kontrolní fronty „K potvrzení“ (components/ImportReviewTable.tsx) —
// čistá logika bez I/O: převod výsledku čtení PDF a náhledu tabulky na
// upravitelný řádek, důvody, proč řádek nejde potvrdit, a vstup potvrzení
// pro server (domain/crm/actions/bulkImport.ts). Řádek drží hodnoty jako text
// z políček; server je při potvrzení znovu ověří (applyRowSchema).
import type { InjectionFlag } from '@/core/untrusted'
import {
  IMPORT_STAGE_LABEL, parseImportAmount, type ApplyRowInput, type ClientMatch, type ImportStage, type ParsedCsvRow,
} from '@/domain/crm/bulkImport'

export type ClientChoice =
  | { mode: 'existing'; id: number; name: string }
  /** Nový klient: jen po výslovném potvrzení člověkem. */
  | { mode: 'new' }
  | { mode: 'unset' }

export type ReviewRowState = 'pending' | 'saving' | 'done' | 'rejected' | 'error'

export type ReviewRow = {
  /** ID návrhu (PDF) nebo `csv-<řádek>`. */
  id: string
  source: 'pdf' | 'csv'
  /** Název souboru nebo „řádek 5“. */
  label: string
  /** Klient tak, jak ho uvádí zdroj (z něj se počítá klíč idempotence). */
  clientText: string
  clientIco: string | null
  match: ClientMatch
  choice: ClientChoice
  /** Název nového klienta a IČO, které si člověk může před založením upravit. */
  newName: string
  newIco: string
  title: string
  amount: string
  currency: 'CZK' | 'EUR'
  stage: ImportStage
  startedOn: string
  dueOn: string
  /** '' = vlastníkem je ten, kdo importuje. */
  ownerId: string
  invoiced: string
  received: string
  /** Typ příjmu z tabulky; u PDF ho drží server. */
  revenueLine: string | null
  proposalId: string | null
  /** Chyby ze čtení tabulky: řádek nejde potvrdit, dokud se nespraví zdroj. */
  errors: string[]
  warnings: string[]
  flags: InjectionFlag[]
  alreadyImported: boolean
  sameTitleDeal: { id: number; title: string } | null
  /** Člověk výslovně chce založit i zakázku, kterou už klient má pod stejným názvem. */
  allowSameTitle: boolean
  state: ReviewRowState
  message: string | null
  result: { dealId: number; accountId: number } | null
}

export function choiceFromMatch(match: ClientMatch): ClientChoice {
  return match.kind === 'matched' ? { mode: 'existing', id: match.accountId, name: match.name } : { mode: 'unset' }
}

const numText = (n: number | null | undefined) => (n == null ? '' : String(n))

/** Řádek z náhledu tabulky (výsledek previewCsvImport). */
export function rowFromCsv(p: {
  row: ParsedCsvRow
  match: ClientMatch
  alreadyImported: boolean
  sameTitleDeal: { id: number; title: string } | null
}): ReviewRow {
  const r = p.row
  return {
    id: `csv-${r.line}`,
    source: 'csv',
    label: `řádek ${r.line}`,
    clientText: r.clientName,
    clientIco: r.ico,
    match: p.match,
    choice: choiceFromMatch(p.match),
    newName: r.clientName,
    newIco: r.ico ?? '',
    title: r.title,
    amount: numText(r.amount),
    currency: r.currency,
    stage: r.stage ?? 'draft',
    startedOn: r.startedOn ?? '',
    dueOn: r.dueOn ?? '',
    ownerId: r.ownerId ?? '',
    invoiced: numText(r.invoiced),
    received: numText(r.received),
    revenueLine: r.revenueLine,
    proposalId: null,
    errors: r.errors,
    warnings: r.warnings,
    flags: [],
    alreadyImported: p.alreadyImported,
    sameTitleDeal: p.sameTitleDeal,
    allowSameTitle: false,
    state: 'pending',
    message: null,
    result: null,
  }
}

/** Řádek z návrhu AI pro jedno PDF (výsledek proposePdfImport). */
export function rowFromProposal(p: {
  proposalId: string
  fileName: string
  fields: { account_name: string; title: string; amount_one_time: number | null; currency: 'CZK' | 'EUR'; revenue_line: string }
  warnings: string[]
  flags: InjectionFlag[]
  match: ClientMatch
  suggestedStage: ImportStage
  sameTitleDeal: { id: number; title: string } | null
}): ReviewRow {
  return {
    id: p.proposalId,
    source: 'pdf',
    label: p.fileName,
    clientText: p.fields.account_name,
    clientIco: null,
    match: p.match,
    choice: choiceFromMatch(p.match),
    newName: p.fields.account_name,
    newIco: '',
    title: p.fields.title,
    amount: numText(p.fields.amount_one_time),
    currency: p.fields.currency,
    stage: p.suggestedStage,
    startedOn: '',
    dueOn: '',
    ownerId: '',
    invoiced: '',
    received: '',
    revenueLine: p.fields.revenue_line,
    proposalId: p.proposalId,
    errors: [],
    warnings: p.warnings,
    flags: p.flags,
    alreadyImported: false,
    sameTitleDeal: p.sameTitleDeal,
    allowSameTitle: false,
    state: 'pending',
    message: null,
    result: null,
  }
}

/** Proč řádek zatím nejde potvrdit (prázdné pole = jde). */
// Chyby z čtení tabulky, které člověk v řádku opravil (cena, měna, stav, název,
// pořadí dat). Platí vždy živá kontrola níž a na serveru, ne text z načtení;
// jinak by řádek po opravě zůstal zamčený.
const FIXABLE_IN_ROW = /^(u této zakázky chybí cena|cena je nula|cenu „|měna|chybí stav|stav „|chybí název zakázky|název zakázky má víc|termín je dřív než začátek|fakturováno a přijato jde uvést jen)/

export function blockers(row: ReviewRow): string[] {
  const out: string[] = row.errors.filter((e) => !FIXABLE_IN_ROW.test(e))
  if (row.startedOn && row.dueOn && row.dueOn < row.startedOn) out.push('Termín je dřív než začátek.')
  if (row.alreadyImported) out.push('Tahle zakázka už je importovaná.')
  if (row.choice.mode === 'unset') out.push('Vyber klienta, nebo potvrď založení nového.')
  if (row.choice.mode === 'new' && !row.newName.trim()) out.push('Doplň název nového klienta.')
  if (!row.title.trim()) out.push('Doplň název zakázky.')
  const amount = row.amount.trim() === '' ? null : parseImportAmount(row.amount)
  if (row.amount.trim() !== '' && amount === null) out.push('Cena není číslo.')
  if ((row.stage === 'won' || row.stage === 'sent') && !(amount && amount > 0)) out.push('U této fáze musí být cena větší než nula.')
  if (row.sameTitleDeal && !row.allowSameTitle) {
    out.push('U klienta už je zakázka se stejným názvem. Zaškrtni, že ji chceš založit i přesto.')
  }
  return out
}

/** Bez varování z pokynů v dokumentu? „Potvrdit vše“ takové řádky přeskočí, člověk je potvrdí sám. */
export function isBulkConfirmable(row: ReviewRow): boolean {
  return row.state === 'pending' && row.flags.length === 0 && blockers(row).length === 0
}

export function isConfirmable(row: ReviewRow): boolean {
  return (row.state === 'pending' || row.state === 'error') && blockers(row).length === 0
}

/** Vstup pro confirmImportRow. */
export function toApplyInput(row: ReviewRow, batchId: number): ApplyRowInput {
  return {
    batch_id: batchId,
    source: row.source,
    proposal_id: row.proposalId,
    account: row.choice.mode === 'existing'
      ? { mode: 'existing', id: row.choice.id }
      : { mode: 'new', name: row.newName, ico: row.newIco.trim() || null },
    key_name: row.clientText,
    key_ico: row.clientIco,
    title: row.title,
    amount: row.amount.trim() === '' ? null : row.amount,
    currency: row.currency,
    stage: row.stage,
    revenue_line: row.revenueLine ?? undefined,
    started_on: row.startedOn || null,
    due_on: row.dueOn || null,
    owner_id: row.ownerId || null,
    invoiced: row.stage === 'won' && row.invoiced.trim() ? row.invoiced : null,
    received: row.stage === 'won' && row.received.trim() ? row.received : null,
  }
}

export type ReviewTally = { pending: number; ready: number; done: number; rejected: number; error: number; blocked: number }

export function tally(rows: readonly ReviewRow[]): ReviewTally {
  const t: ReviewTally = { pending: 0, ready: 0, done: 0, rejected: 0, error: 0, blocked: 0 }
  for (const r of rows) {
    if (r.state === 'done') t.done++
    else if (r.state === 'rejected') t.rejected++
    else if (r.state === 'error') t.error++
    else if (r.state === 'pending' || r.state === 'saving') {
      t.pending++
      if (isBulkConfirmable(r)) t.ready++
      else t.blocked++
    }
  }
  return t
}

export function stageOptions(): { value: ImportStage; label: string }[] {
  return (['won', 'sent', 'draft'] as const).map((value) => ({ value, label: IMPORT_STAGE_LABEL[value] }))
}
