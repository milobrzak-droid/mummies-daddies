// „Není poptávka" — čisté pomocné funkce: tvar výsledku, vstup a český
// překlad chyb z RPC auto_intake_undo (Zpět, migrace 0081 a 0086)
// a auto_intake_dismiss (uzavřít bez mazání, 0086). Žije mimo
// domain/crm/actions/autoIntake.ts, protože 'use server' modul smí exportovat
// jen async funkce (stejný důvod jako deleteVerdict.ts).
import { formatDate } from '@/lib/format'

export type UndoResult = {
  success: boolean
  error?: string
  note?: string
  /**
   * Vrátit nejde, protože u klienta už je lidská práce. UI místo „Není
   * poptávka" nabídne „Uzavřít jako Není poptávka" (auto_intake_dismiss).
   */
  canDismiss?: boolean
}

export const UNDO_DONE_NOTE = 'Vráceno. Co vzniklo z e-mailu, je smazané, a tuhle doménu už Cockpit sám zakládat nebude.'
export const UNDO_CALENDAR_NOTE = 'Úkol „Odpovědět na poptávku" byl i v kalendáři v Outlooku — tam ho smaž sám.'
export const UNDO_MIGRATION_PENDING = 'Vrácení poptávky čeká na migraci 0081.'
export const UNDO_NOT_FOUND = 'Záznam nebyl nalezen. Obnov stránku.'
export const UNDO_ALREADY = 'Tohle už bylo vráceno. Obnov stránku.'
export const UNDO_ALREADY_DISMISSED = 'Tahle poptávka už je uzavřená jako Není poptávka. Obnov stránku.'
export const UNDO_FORBIDDEN = 'Vrátit poptávku smí obchodní role s druhým faktorem.'
export const UNDO_BAD_INPUT = 'Neplatný požadavek. Obnov stránku.'

export const DISMISS_FORBIDDEN = 'Uzavřít poptávku smí obchodní role s druhým faktorem.'
export const DISMISS_MIGRATION_PENDING = 'Uzavření poptávky čeká na migraci 0086.'
/** 0095: obchod má práci (jiná fáze nebo částka), uzavření jako Není poptávka ho nepřepíše. */
export const DISMISS_WORKED = 'S obchodem se už pracuje (jiná fáze nebo částka), proto ho nejde uzavřít jako Není poptávka. Nic se nezměnilo. Uprav nebo uzavři obchod přímo v Obchodech.'
export const DISMISS_WON = 'Obchod je už vyhraný, poptávka to tedy byla. Nic se nezměnilo.'
/** Důvod prohry, který zapisuje auto_intake_dismiss (0086). */
export const NOT_INQUIRY_LOST_REASON = 'Nebyla to poptávka'

type DbErr = { code?: string | null; message?: string | null; details?: string | null } | null | undefined

/** id automatického založení z formuláře nebo bind(); jen kladné celé číslo. */
export function parseIntakeId(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null
}

// Co brání vrácení (DETAIL výjimky AI001 z 0086) → věta pro člověka. Klíč je
// buď značka (task_started, deal_moved), nebo název tabulky z katalogu FK.
const BLOCKERS: Readonly<Record<string, string>> = {
  task_started: 'úkol „Odpovědět na poptávku" už někdo řeší',
  deal_moved: 's obchodem se už pracuje (jiná fáze nebo částka)',
  sales_activity: 'u firmy je zapsaná aktivita od člověka',
  task: 'u firmy je další úkol',
  deal: 'u firmy je další obchod',
  contact: 'u firmy je další kontakt',
  company_alias: 'firma má další alias domény',
  engagement: 'u firmy je dodávka',
  work_case: 'u firmy je pracovní případ, na kterém se pracuje',
  case_proposal: 'u firmy je rozhodnutý návrh',
  deal_partner: 'u obchodu je partner',
  deal_scope_version: 'u obchodu je verze nabídky',
  meeting_note_intake: 'u firmy je zápis ze schůzky',
  target_list_item: 'firma je v seznamu k oslovení',
  financial_record: 'u firmy je finanční záznam',
  subscription: 'u firmy je předplatné',
  relationship: 'firma je propojená s jinou firmou',
  reference_card: 'u firmy je referenční karta',
}

/**
 * Co brání vrácení. 0086 to posílá v DETAIL; starší 0081 jen v textu
 * („… další práce (tabulka) …", „Úkol …", „S obchodem …").
 */
export function undoBlocker(err: DbErr): string {
  const detail = err?.details?.trim()
  if (detail) return detail
  const msg = err?.message ?? ''
  const table = /\(([a-z_]+)\)/.exec(msg)?.[1]
  if (table) return table
  if (/^Úkol/i.test(msg)) return 'task_started'
  if (/obchodem/i.test(msg)) return 'deal_moved'
  return 'other'
}

export function undoBlockerText(blocker: string): string {
  return BLOCKERS[blocker] ?? 'u firmy je další práce'
}

/** Uzavření jako Není poptávka (0095) obchod s rozdělanou prací nepřepíše, tak ho nenabízíme. */
export function canOfferDismiss(err: DbErr): boolean {
  return undoBlocker(err) !== 'deal_moved'
}

/** Věta pro odmítnuté vrácení: proč, že se nic nesmazalo a co udělat místo toho. */
export function undoRefusedMessage(err: DbErr): string {
  const blocker = undoBlocker(err)
  const head = `Vrátit to nejde: ${undoBlockerText(blocker)}. Nic se nesmazalo. `
  if (blocker === 'deal_moved') return `${head}Obchod, na kterém se pracuje, uzavři nebo uprav přímo v Obchodech.`
  return `${head}Místo toho poptávku uzavři: obchod půjde do Prohráno s důvodem „${NOT_INQUIRY_LOST_REASON}" a firma se odloží.`
}

/** Odmítnutí kvůli lidské práci (AI001) — UI pak nabídne uzavření bez mazání. */
export function isUndoRefused(err: DbErr): boolean {
  return err?.code === 'AI001'
}

function isMissingFunction(err: DbErr): boolean {
  const msg = err?.message ?? ''
  return err?.code === '42883' || err?.code === 'PGRST202' || /could not find the function/i.test(msg)
}

/** Chyba RPC Zpět → česká věta; null = neznámá (volající ji zaloguje a řekne obecně). */
export function undoErrorMessage(err: DbErr): string | null {
  if (!err) return null
  const msg = err.message ?? ''
  if (isUndoRefused(err)) return undoRefusedMessage(err)
  if (err.code === 'P0002') return UNDO_NOT_FOUND
  if (err.code === '22023' && /uzavřen/i.test(msg)) return UNDO_ALREADY_DISMISSED
  if (err.code === '22023' && /Už bylo vráceno/i.test(msg)) return UNDO_ALREADY
  if (err.code === '42501') return UNDO_FORBIDDEN
  if (isMissingFunction(err)) return UNDO_MIGRATION_PENDING
  return null
}

/** Chyba RPC „Uzavřít jako Není poptávka" → česká věta; null = neznámá. */
export function dismissErrorMessage(err: DbErr): string | null {
  if (!err) return null
  const msg = err.message ?? ''
  if (err.code === 'AI002') return DISMISS_WON
  if (err.code === 'AI003') return DISMISS_WORKED
  if (err.code === 'P0002') return UNDO_NOT_FOUND
  if (err.code === '22023' && /uzavřen/i.test(msg)) return UNDO_ALREADY_DISMISSED
  if (err.code === '22023' && /vráceno/i.test(msg)) return UNDO_ALREADY
  if (err.code === '42501') return DISMISS_FORBIDDEN
  if (isMissingFunction(err)) return DISMISS_MIGRATION_PENDING
  return null
}

export type DismissOutcome = {
  deal: 'lost' | 'already_lost' | 'none'
  /** kept = úkol už někdo řeší (0096), zůstal beze změny. */
  task: 'done' | 'kept' | 'none'
  snoozeUntil: string | null
  /** true = firma se neodložila, protože u ní je jiný obchod nebo dodávka (0096). */
  accountKept?: boolean
}

/** Výstup RPC auto_intake_dismiss; null = nečekaný tvar. */
export function parseDismissResult(data: unknown): DismissOutcome | null {
  const d = data as { status?: unknown; deal?: unknown; task?: unknown; snooze_until?: unknown; account?: unknown } | null
  if (!d || d.status !== 'dismissed') return null
  const deal = d.deal === 'lost' || d.deal === 'already_lost' ? d.deal : 'none'
  const task = d.task === 'done' || d.task === 'kept' ? d.task : 'none'
  const snoozeUntil = typeof d.snooze_until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.snooze_until) ? d.snooze_until : null
  return { deal, task, snoozeUntil, ...(d.account === 'kept' ? { accountKept: true } : {}) }
}

/** Potvrzení po uzavření: co se stalo, nic se nesmazalo. */
export function dismissDoneNote(o: DismissOutcome): string {
  const parts = ['Uzavřeno jako Není poptávka.']
  if (o.deal === 'lost') parts.push(`Obchod je v Prohráno s důvodem „${NOT_INQUIRY_LOST_REASON}".`)
  if (o.deal === 'already_lost') parts.push('Obchod už byl v Prohráno.')
  if (o.task === 'done') parts.push('Úkol „Odpovědět na poptávku" je uzavřený.')
  if (o.task === 'kept') parts.push('Úkol „Odpovědět na poptávku" už někdo řeší, zůstal beze změny.')
  if (o.snoozeUntil) parts.push(`Firma je odložená do ${formatDate(o.snoozeUntil)} a nebude se nabízet k oslovení.`)
  if (o.accountKept) parts.push('Firma zůstala beze změny, protože u ní je další obchod nebo dodávka.')
  parts.push('Nic se nesmazalo.')
  return parts.join(' ')
}
