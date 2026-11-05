// Úzké okno na obchody pro dodávkové role (migrace 0058, rozhodnutí majitele
// 2026-09-28): jen id, firma, název a příznak „vyhráno" — žádné částky,
// pravděpodobnost, fáze ani vlastník.
//
// Od 0058 je tabulka deal pod RESTRICTIVE can_see_sales(); projekťák, lektor
// ani partner z ní přes PostgREST nic nepřečtou. Dodávka (předávací balíček,
// výběr schválené nabídky, název obchodu u případu Loop Core) proto čte přes
// SECURITY DEFINER rpc deal_public(p_account_id), které vrací jen tyhle čtyři
// sloupce každému AAL2 členovi týmu.
//
// Pořadí nasazení je jedno: dokud 0058 neběží, funkce neexistuje (PostgREST
// PGRST202, Postgres 42883) a čte se postaru přímo z deal — tabulka je do té
// doby permisivní pro celý tým, takže výsledek je stejný. Z řádku deal se
// i ve fallbacku vezmou jen tytéž čtyři údaje.
import { createClient } from '@/lib/supabase/server'

type Db = Awaited<ReturnType<typeof createClient>>

/** Fáze obchodu, která znamená schválenou nabídku (0001 enum deal_stage). */
export const WON_DEAL_STAGE = 'vyhráno'

export type DealPublicRow = { id: number; account_id: number; title: string; is_won: boolean }

export type DealPublicResult =
  | { ok: true; rows: DealPublicRow[] }
  | { ok: false; error: { code?: string; message?: string } }

/** RPC funkce ve schématu není — migrace 0058 ještě nenasazená. */
export function isMissingFunction(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  if (err.code === 'PGRST202' || err.code === '42883') return true
  return /could not find the function|function .* does not exist/i.test(err.message ?? '')
}

function toRow(r: Record<string, unknown>): DealPublicRow {
  return {
    id: Number(r.id),
    account_id: Number(r.account_id),
    title: String(r.title ?? ''),
    is_won: typeof r.is_won === 'boolean' ? r.is_won : r.stage === WON_DEAL_STAGE,
  }
}

/**
 * Obchody firmy (nebo všech firem při accountId null) jako id + název +
 * „vyhráno". Klienta předává volající — server akce tak čtou pod stejným
 * klientem (a v testech stejným fake), jaký používají pro zbytek zápisu.
 */
export async function listDealPublic(s: Db, accountId: number | null): Promise<DealPublicResult> {
  const rpc = await s.rpc('deal_public', { p_account_id: accountId })
  if (!rpc.error) {
    return { ok: true, rows: ((rpc.data ?? []) as Record<string, unknown>[]).map(toRow) }
  }
  if (!isMissingFunction(rpc.error)) return { ok: false, error: rpc.error }

  // Před 0058: přímé čtení (tabulka je ještě permisivní pro tým).
  return listDealPublicFromTable(s, accountId)
}

/**
 * Tytéž čtyři údaje přímo z tabulky deal, bez rpc. Pro fallback před 0058
 * a pro servisní klient (API/MCP): deal_public bez přihlášeného uživatele
 * odmítne (auth.uid() je null), servisní klient RLS obchází a o přístupu
 * rozhoduje volající. Částky ani fáze se ani tady nečtou.
 */
export async function listDealPublicFromTable(s: Db, accountId: number | null): Promise<DealPublicResult> {
  let q = s.from('deal').select('id, account_id, title, stage')
  if (accountId !== null) q = q.eq('account_id', accountId)
  const { data, error } = await q.order('title').order('id')
  if (error) return { ok: false, error }
  return { ok: true, rows: ((data ?? []) as Record<string, unknown>[]).map(toRow) }
}

/** Jeden obchod dané firmy, nebo null, když k ní nepatří / neexistuje. */
export async function findDealPublic(
  s: Db,
  accountId: number | null,
  dealId: number,
): Promise<{ ok: true; row: DealPublicRow | null } | { ok: false; error: { code?: string; message?: string } }> {
  const res = await listDealPublic(s, accountId)
  if (!res.ok) return res
  return { ok: true, row: res.rows.find((d) => d.id === dealId) ?? null }
}

/** Pro stránky (server komponenty): vlastní klient, chyba se vyhodí. */
export async function getDealPublic(accountId: number | null): Promise<DealPublicRow[]> {
  const res = await listDealPublic(await createClient(), accountId)
  if (!res.ok) throw res.error
  return res.rows
}
