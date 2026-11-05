// Čtení řádku člena týmu pro rozhodování o oprávnění, s kontrolou deaktivace.
//
// Deaktivovaný člen (deactivated_at IS NOT NULL) je zabanovaný v Auth, ale už
// vydaný access JWT platí do expirace. RLS ho od 0082 nechává číst vlastní
// řádek team_member (team_self_read), takže samotná existence řádku nestačí:
// každé místo, které z řádku odvozuje identitu, roli nebo právo, musí
// deaktivaci vyloučit. Akce se servisním klíčem RLS neplatí vůbec.
//
// Sloupec deactivated_at se čte spolu s ostatními a vyhodnocuje se v kódu
// (ne filtrem), takže dotaz zůstává stejného tvaru. Když sloupec chybí
// (starší schéma před 0069), dotaz se zopakuje bez něj a kontrola se přeskočí.

type MemberReader = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>
      }
    }
  }
}

export function isMissingColumnError(e: { code?: string } | null | undefined): boolean {
  return e?.code === '42703' || e?.code === 'PGRST204'
}

export type ActiveMemberResult<T> = {
  /** Řádek člena; null = řádek neexistuje NEBO je člen deaktivovaný. */
  row: T | null
  /** true = řádek existuje, ale člen je deaktivovaný. */
  deactivated: boolean
  error: { code?: string; message?: string } | null
}

export async function readActiveMember<T extends Record<string, unknown>>(
  client: unknown,
  userId: string,
  columns: string,
): Promise<ActiveMemberResult<T>> {
  const c = client as MemberReader
  const query = (cols: string) => c.from('team_member').select(cols).eq('id', userId).maybeSingle()
  let res = await query(`${columns}, deactivated_at`)
  if (res.error && isMissingColumnError(res.error)) res = await query(columns)
  if (res.error) return { row: null, deactivated: false, error: res.error }
  const data = res.data as (T & { deactivated_at?: string | null }) | null
  if (!data) return { row: null, deactivated: false, error: null }
  if (data.deactivated_at) return { row: null, deactivated: true, error: null }
  return { row: data, deactivated: false, error: null }
}
