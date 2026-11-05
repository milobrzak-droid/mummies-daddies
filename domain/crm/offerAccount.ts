// Ke kterému klientovi by potvrzený návrh nabídky obchod přiřadil. Sdílí ruční
// import z PDF (domain/crm/actions/offers.ts) i fronta „Pošta k zařazení"
// (návrh zakázky z přílohy e-mailu), proto je tady, ne v souboru 'use server'.
import type { SupabaseClient } from '@supabase/supabase-js'
import { escapeLikePattern, sameAccountName } from '@/domain/crm/offerProposal'
import { AresUnavailableError, aresRegionValue, aresSearch, pickAresMatch, type AresSearchResult } from '@/connectors/ares'
import { logError } from '@/lib/log'

export type OfferAccountHint =
  | { kind: 'existing'; id: number; name: string }
  | { kind: 'new' }
  | { kind: 'ambiguous' }
  | { kind: 'unknown' }

export type AccountLookup = OfferAccountHint | { kind: 'error'; message: string }

// Klient podle názvu: ilike s escapovanými zástupnými znaky a pak přesná
// shoda v kódu (PostgREST bere `*` jako `%`, viz escapeLikePattern). Víc
// přesných shod = nejisté → rozhodne člověk, obchod se nepřiřadí naslepo.
export async function findAccountByName(db: Pick<SupabaseClient, 'from'>, name: string): Promise<AccountLookup> {
  const { data, error } = await db
    .from('account')
    .select('id, name')
    .ilike('name', escapeLikePattern(name))
    .limit(20)
  if (error) return { kind: 'error', message: error.message }
  const exact = ((data ?? []) as { id: number; name: string }[]).filter((r) => sameAccountName(r.name, name))
  if (exact.length === 1) return { kind: 'existing', id: exact[0].id, name: exact[0].name }
  if (exact.length > 1) return { kind: 'ambiguous' }
  return { kind: 'new' }
}

// ---------------------------------------------------------------------------
// Nový klient z potvrzeného návrhu nabídky (ruční import PDF i příloha e-mailu)

export type OfferAccountDb = Pick<SupabaseClient, 'from'>

export type NewOfferAccount =
  | { kind: 'created'; id: number }
  | { kind: 'existing'; id: number; name: string }
  | { kind: 'error'; error: string }

/** Lidské věty místo surových chyb databáze (ty jdou jen do logu). */
export const OFFER_ACCOUNT_ERRORS = {
  lookup: 'Klienta se nepodařilo dohledat v Cockpitu. Zkus to prosím znovu.',
  create: 'Klienta se nepodařilo založit. Zkus to prosím znovu, nebo založ obchod ručně u klienta.',
} as const

type AresSearchFn = (name: string) => Promise<AresSearchResult>

const defaultAresSearch: AresSearchFn = (name) => aresSearch(name, { timeoutMs: 6_000, count: 10 })

async function accountByIco(db: OfferAccountDb, ico: string): Promise<{ id: number; name: string } | null | 'error'> {
  const { data, error } = await db.from('account').select('id, name').eq('ico', ico).order('id').limit(1)
  if (error) {
    logError('offers.accountByIco', error)
    return 'error'
  }
  return ((data ?? [])[0] as { id: number; name: string } | undefined) ?? null
}

/**
 * Klient, který v Cockpitu podle jména není. Z ARESu se doplní IČO, obor
 * a sídlo JEN při přesné shodě jména (pickAresMatch) — první výsledek
 * fulltextu („Magna" → vinařský spolek) je horší než prázdné pole. Když už
 * IČO v Cockpitu má jiný klient (jiný zápis jména), obchod se naváže na něj
 * místo pokusu o druhého klienta (unikátní account.ico, 0074). Do `warnings`
 * jde, co se stalo; chyby DB jen jako česká věta.
 */
export async function resolveNewOfferAccount(
  db: OfferAccountDb,
  confirmedName: string,
  warnings: string[],
  search: AresSearchFn = defaultAresSearch,
): Promise<NewOfferAccount> {
  let name = confirmedName
  let ico: string | null = null
  let industry: string | null = null
  let region: string | null = null
  try {
    const res = await search(confirmedName)
    const pick = pickAresMatch(confirmedName, res.candidates, res.total)
    if (pick?.how === 'přesná shoda') {
      const c = pick.company
      name = c.legalName
      ico = c.ico
      industry = c.industry
      region = aresRegionValue(c)
      if (!sameAccountName(name, confirmedName)) warnings.push(`klient založen pod jménem z ARES: ${name}`)
    } else {
      warnings.push('klient nenalezen v ARES jednoznačně (doplň IČO ručně)')
    }
  } catch (e) {
    warnings.push(e instanceof AresUnavailableError ? 'ARES nedostupný (doplň IČO ručně)' : 'ARES se nepodařilo zeptat (doplň IČO ručně)')
  }

  const linkExisting = (found: { id: number; name: string }): NewOfferAccount => {
    warnings.push(`IČO ${ico} už v Cockpitu má klient „${found.name}" — obchod je přiřazený k němu`)
    return { kind: 'existing', id: found.id, name: found.name }
  }

  if (ico) {
    const found = await accountByIco(db, ico)
    if (found === 'error') return { kind: 'error', error: OFFER_ACCOUNT_ERRORS.lookup }
    if (found) return linkExisting(found)
  }

  const { data, error } = await db.from('account').insert({ name, ico, industry, region }).select('id').single()
  if (error || !data) {
    // 23505 = mezitím klienta se stejným IČO založil někdo jiný (unikát 0074).
    if (ico && error?.code === '23505') {
      const found = await accountByIco(db, ico)
      if (found && found !== 'error') return linkExisting(found)
    }
    logError('offers.accountCreate', error ?? new Error('insert bez řádku'))
    return { kind: 'error', error: OFFER_ACCOUNT_ERRORS.create }
  }
  return { kind: 'created', id: (data as { id: number }).id }
}
