import { createAdminClient } from '@/lib/supabase/admin'
import { matchClient, type AccountIndex, type MatchAccount } from '@/domain/crm/bulkImport'
import { loadAccountIndex } from '@/domain/crm/bulkImportService'
import { canonicalIco } from '@/domain/crm/meetingIntake'
import { cleanCompanyName, normalizeCompanyName } from '@/connectors/ares'

// Ke kterému klientovi patří zápis přes API/MCP (create_contact; návrhy zakázek
// propose_deal(s) párují přes matchClient a nejistotu nechají v návrhu).
// Klient jde zadat id, nebo názvem (a volitelně IČO). Párování podle názvu
// je stejné jako u hromadného importu (matchClient: IČO přesně, pak název bez
// právní formy, diakritiky a velikosti písmen, pak aliasy). Nejistota =
// chyba se seznamem kandidátů; nikdy se nehádá a nový klient se tudy
// nezakládá. Názvy kandidátů jsou data z Cockpitu, ne pokyny.

/** Kolik podobných klientů se nejvýš vypíše v chybě. */
export const ACCOUNT_CANDIDATES_MAX = 5

export type AccountRef = {
  account_id?: number | null
  account_name?: string | null
  account_ico?: string | null
}

export type ResolvedAccount = { id: number; name: string; owner_id: string | null }

export type AccountResolution =
  | { ok: true; account: ResolvedAccount; by: 'id' | 'ico' | 'name' | 'alias' }
  | { ok: false; status: number; error: string }

export type AccountCandidate = { id: number; name: string }

export const ACCOUNT_REF_REQUIRED = 'Vyplň klienta: account_id, nebo account_name (případně s account_ico).'
export const ACCOUNT_REF_BOTH = 'Vyplň jen jedno: account_id, nebo account_name. Obojí najednou nejde.'
export const ACCOUNT_NOT_FOUND_BY_ID = 'Klient s tímto id v Cockpitu není.'
export const ACCOUNT_ICO_INVALID = 'account_ico není platné IČO (8 číslic).'

const key = (name: string) => normalizeCompanyName(cleanCompanyName(name))

export function formatCandidates(list: readonly AccountCandidate[]): string {
  return list.map((c) => `„${c.name}" (id ${c.id})`).join('; ')
}

/**
 * Podobní klienti pro chybu „nenalezeno": normalizovaný název jednoho obsahuje
 * druhý, nebo sdílí slovo aspoň o 3 znacích. Jen nápověda pro člověka/model,
 * NIKDY se z ní nevybírá automaticky.
 */
export function similarAccounts(
  name: string,
  accounts: readonly MatchAccount[],
  max: number = ACCOUNT_CANDIDATES_MAX,
): AccountCandidate[] {
  const wanted = key(name)
  if (!wanted) return []
  const words = new Set(wanted.split(' ').filter((w) => w.length >= 3))
  const scored: { a: MatchAccount; score: number }[] = []
  for (const a of accounts) {
    const k = key(a.name)
    if (!k) continue
    let score = 0
    if (wanted.length >= 3 && (k.includes(wanted) || (k.length >= 3 && wanted.includes(k)))) score = 2
    else if (k.split(' ').some((w) => words.has(w))) score = 1
    if (score > 0) scored.push({ a, score })
  }
  return scored
    .sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name, 'cs') || x.a.id - y.a.id)
    .slice(0, max)
    .map(({ a }) => ({ id: a.id, name: a.name }))
}

/** Čisté párování nad načteným seznamem klientů (testovatelné bez DB). */
export function resolveAccountInIndex(
  name: string,
  ico: string | null,
  index: AccountIndex,
): { ok: true; id: number; by: 'ico' | 'name' | 'alias' } | { ok: false; status: number; error: string } {
  const m = matchClient({ name, ico }, index)
  if (m.kind === 'matched') return { ok: true, id: m.accountId, by: m.by }
  if (m.kind === 'ambiguous') {
    const why = m.reason === 'ico_conflict'
      ? `Klient „${m.candidates[0]?.name ?? name}" má jiné IČO, než jsi poslal.`
      : `Názvu „${name}" odpovídá víc klientů.`
    return {
      ok: false,
      status: 409,
      error: `${why} Kandidáti: ${formatCandidates(m.candidates)}. Nehádám — zeptej se uživatele a zavolej znovu s account_id.`,
    }
  }
  const similar = similarAccounts(name, index.accounts)
  const hint = similar.length > 0 ? ` Podobní: ${formatCandidates(similar)}.` : ''
  return {
    ok: false,
    status: 404,
    error: `Klient „${name}" v Cockpitu není.${hint} Přes konektor se nový klient nezakládá: `
      + 'když je to jeden z podobných, ověř to s uživatelem a pošli jeho account_id; jinak ať ho uživatel založí v Cockpitu.',
  }
}

/** Klient podle id, nebo bezpečně podle názvu / IČO. */
export async function resolveAccountForApi(ref: AccountRef): Promise<AccountResolution> {
  const name = ref.account_name?.trim() || null
  const icoRaw = ref.account_ico?.trim() || null
  const admin = createAdminClient()

  const byId = async (id: number) => {
    const { data, error } = await admin.from('account').select('id, name, owner_id').eq('id', id).maybeSingle()
    if (error) throw error
    return (data as ResolvedAccount | null) ?? null
  }

  if (ref.account_id != null) {
    if (name || icoRaw) return { ok: false, status: 400, error: ACCOUNT_REF_BOTH }
    const account = await byId(ref.account_id)
    return account ? { ok: true, account, by: 'id' } : { ok: false, status: 404, error: ACCOUNT_NOT_FOUND_BY_ID }
  }
  if (!name) return { ok: false, status: 400, error: ACCOUNT_REF_REQUIRED }
  let ico: string | null = null
  if (icoRaw) {
    ico = canonicalIco(icoRaw)
    if (!ico) return { ok: false, status: 400, error: ACCOUNT_ICO_INVALID }
  }

  const index = await loadAccountIndex(admin)
  const res = resolveAccountInIndex(name, ico, index)
  if (!res.ok) return res
  const account = await byId(res.id)
  // Mezi načtením seznamu a dotazem klient zmizel (souběžné smazání).
  if (!account) return { ok: false, status: 404, error: ACCOUNT_NOT_FOUND_BY_ID }
  return { ok: true, account, by: res.by }
}
