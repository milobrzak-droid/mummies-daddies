'use server'
// Čtecí akce pro výběr firmy ve formulářích (components/AccountPicker.tsx).
// Po importu radaru je firem ~663 — místo celého seznamu v každém
// formuláři se hledá na serveru po ACCOUNT_OPTION_LIMIT kusech. Akce jsou
// globálně volatelné POSTem, proto i čtení hlídá přihlášení s AAL2
// (test/auth-actions-guard.test.ts); data jdou přes RLS klienta uživatele.
import { z } from 'zod'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { dbErrorMessage } from '@/lib/actionResult'
import { entityId } from '@/lib/validation/schemas'
import { ACCOUNT_QUERY_MAX_LENGTH } from '@/domain/crm/accountList'
import {
  listContactOptionsForAccount, searchAccountOptions, type AccountOption,
} from '@/domain/crm/queries/accounts'

type OptionsResult<T> = { ok: true; options: T[] } | { ok: false; error: string }

const searchInput = z.object({
  query: z.string().max(ACCOUNT_QUERY_MAX_LENGTH * 2),
  excludeId: entityId.nullable(),
})

export async function findAccountOptions(query: unknown, excludeId: unknown = null): Promise<OptionsResult<AccountOption>> {
  if (!await tryRequireUser({ aal2: true })) return { ok: false, error: AUTH_ERROR_MESSAGE }
  const parsed = searchInput.safeParse({ query, excludeId: excludeId ?? null })
  if (!parsed.success) return { ok: false, error: 'Neplatný dotaz.' }
  const q = parsed.data.query.trim().slice(0, ACCOUNT_QUERY_MAX_LENGTH)
  try {
    return { ok: true, options: await searchAccountOptions(q, { excludeId: parsed.data.excludeId }) }
  } catch (error) {
    return { ok: false, error: dbErrorMessage('action.accountPicker', error) }
  }
}

export async function findContactOptionsForAccount(accountId: unknown): Promise<OptionsResult<{ id: number; full_name: string }>> {
  if (!await tryRequireUser({ aal2: true })) return { ok: false, error: AUTH_ERROR_MESSAGE }
  const parsed = entityId.safeParse(accountId)
  if (!parsed.success) return { ok: false, error: 'Neplatné ID.' }
  try {
    return { ok: true, options: await listContactOptionsForAccount(parsed.data) }
  } catch (error) {
    return { ok: false, error: dbErrorMessage('action.accountPicker', error) }
  }
}
