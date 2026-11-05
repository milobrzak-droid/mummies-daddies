import { logError } from './log'

// Společný návratový tvar formulářových Server Actions (useActionState).
export type ActionResult = { success: boolean; error?: string; fieldErrors?: Record<string, string> }

export const GENERIC_ACTION_ERROR = 'Operace se nezdařila. Zkuste to prosím znovu.'
export const DUPLICATE_ACTION_ERROR = 'Záznam se stejnými údaji už existuje.'
export const REFERENCE_ACTION_ERROR = 'Záznam nelze uložit ani smazat, protože souvisí s jinými daty.'

/**
 * Převede chybu z databáze na hlášku pro uživatele. Surové `error.message`
 * ze Supabase prozrazuje názvy tabulek a constraintů, proto detail jen
 * zalogujeme a klientovi vrátíme obecnou českou větu.
 */
export function dbErrorMessage(scope: string, error: unknown): string {
  logError(scope, error)
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === '23505') return DUPLICATE_ACTION_ERROR
  if (code === '23503') return REFERENCE_ACTION_ERROR
  return GENERIC_ACTION_ERROR
}
