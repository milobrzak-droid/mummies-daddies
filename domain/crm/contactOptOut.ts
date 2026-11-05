// Zápis políčka „Nesouhlasí s oslovením" (contact.do_not_contact, 0087) před
// nasazením migrace. Čisté funkce bez I/O; používá je
// domain/crm/actions/contacts.ts.
//
// Bez migrace sloupce chybí a PostgREST zápis odmítne (PGRST204 „Could not
// find the 'do_not_contact' column", nebo Postgres 42703). Pak:
//   * nesouhlas NENÍ zaškrtnutý → kontakt se uloží bez nových polí (úprava
//     telefonu nesmí spadnout jen proto, že migrace ještě neproběhla),
//   * nesouhlas JE zaškrtnutý → srozumitelná chyba. Tiché zahození by
//     znamenalo, že člověk, který nechce být oslovován, oslovován bude.

export const OPT_OUT_FIELDS = ['do_not_contact', 'do_not_contact_reason'] as const

export const OPT_OUT_MISSING_MIGRATION_MESSAGE =
  'Nesouhlas s oslovením zatím nejde uložit — databáze čeká na migraci 0087. '
  + 'Kontakt se neuložil. Do té doby napište do poznámky „nekontaktovat“ (konektor i fronta to respektují).'

/** Chyba zápisu znamená „sloupec do_not_contact* v databázi ještě není"? */
export function isMissingOptOutColumn(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  if (err.code !== 'PGRST204' && err.code !== '42703') return false
  return /do_not_contact/.test(err.message ?? '')
}

/** Data kontaktu bez polí nesouhlasu (zápis před migrací 0087). */
export function withoutOptOutFields<T extends Record<string, unknown>>(data: T): Omit<T, (typeof OPT_OUT_FIELDS)[number]> {
  const out: Record<string, unknown> = { ...data }
  for (const k of OPT_OUT_FIELDS) delete out[k]
  return out as Omit<T, (typeof OPT_OUT_FIELDS)[number]>
}

type WriteResult = { error: { code?: string | null; message?: string | null } | null }

/**
 * Zapíše kontakt; když chybí sloupce nesouhlasu, zkusí to znovu bez nich —
 * ale jen pokud nesouhlas zaškrtnutý není. Jinak vrátí `optOutBlocked`.
 */
export async function writeContactWithOptOut<R extends WriteResult>(
  data: Record<string, unknown> & { do_not_contact?: boolean },
  write: (payload: Record<string, unknown>) => PromiseLike<R>,
): Promise<{ result: R; optOutBlocked: false } | { result: null; optOutBlocked: true }> {
  const first = await write(data)
  if (!isMissingOptOutColumn(first.error)) return { result: first, optOutBlocked: false }
  if (data.do_not_contact === true) return { result: null, optOutBlocked: true }
  return { result: await write(withoutOptOutFields(data)), optOutBlocked: false }
}
