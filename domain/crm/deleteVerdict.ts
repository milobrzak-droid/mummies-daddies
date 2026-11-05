// Rozhodnutí, jestli DELETE opravdu smazal právě jeden řádek. Čistá funkce
// bez I/O — žije mimo domain/crm/actions/*.ts, protože ty mají 'use server'
// a Next.js by každý jejich export bral jako Server Akci.
//
// Proč to není jen kontrola `error`: PostgREST při zamítnutí přes RLS (nebo
// při AAL1 relaci bez druhého faktoru) NEVRÁTÍ chybu, jen smaže 0 řádků.
// Bez počtu řádků by se po „úspěšném" smazání, které ve skutečnosti nic
// nesmazalo, zapsal audit a nevratně zredigovaly sales_activity.

export type SingleRowDeleteVerdict =
  | { ok: true }
  | { ok: false; reason: 'db_error' | 'not_deleted' | 'unexpected_count' }

export function judgeSingleRowDelete(
  error: unknown,
  deletedRows: ReadonlyArray<unknown> | null | undefined,
): SingleRowDeleteVerdict {
  if (error) return { ok: false, reason: 'db_error' }
  const count = deletedRows?.length ?? 0
  if (count === 0) return { ok: false, reason: 'not_deleted' }
  if (count !== 1) return { ok: false, reason: 'unexpected_count' }
  return { ok: true }
}

export const CONTACT_DELETE_FAILED_MESSAGE =
  'Kontakt se nepodařilo smazat. Nic dalšího se nezměnilo. Zkus to znovu a pokud potíž trvá, ověř přihlášení s druhým faktorem.'

// Mazání kontaktu (spouští nevratnou GDPR redakci sales_activity) je
// admin-only, stejně jako GDPR export — rozhodnutí majitele 2026-09-28.
// Žije mimo domain/crm/actions/contacts.ts ze stejného důvodu jako zbytek
// tohoto souboru: 'use server' moduly smí exportovat jen async funkce.
export const NOT_ADMIN_MESSAGE = 'Nemáš oprávnění.'
