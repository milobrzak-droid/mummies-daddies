import { createClient } from '@/lib/supabase/server'

// Globální hledání (/hledat): normalizace dotazu + tvar výsledků jsou čisté
// funkce (žádné I/O), testované samostatně v test/search*.test.ts. Jediná
// I/O funkce (search) je tenký obal nad Supabase klientem uživatele — RLS
// platí stejně jako všude jinde, nic se nečte přes service roli.

export const SEARCH_MIN_LENGTH = 2
export const SEARCH_MAX_LENGTH = 100
export const SEARCH_GROUP_LIMIT = 10

export type SearchResultKind = 'account' | 'contact' | 'deal' | 'partner'

export interface SearchResult {
  kind: SearchResultKind
  id: number
  title: string
  subtitle: string | null
  href: string
}

export interface SearchResults {
  accounts: SearchResult[]
  contacts: SearchResult[]
  deals: SearchResult[]
  partners: SearchResult[]
}

export const EMPTY_SEARCH_RESULTS: SearchResults = {
  accounts: [], contacts: [], deals: [], partners: [],
}

/**
 * Ořeže a ověří dotaz na rozumnou délku (2–100 znaků po ořezání okrajových
 * mezer). Kratší/delší/prázdný dotaz search nespouští — stránka jen ukáže
 * stavovou hlášku, aby jeden znak nerozjel scan přes čtyři tabulky.
 */
export function normalizeSearchQuery(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length < SEARCH_MIN_LENGTH || trimmed.length > SEARCH_MAX_LENGTH) return null
  return trimmed
}

// ILIKE bez zástupných znaků: `%`, `_` a samotné `\` v dotazu se escapují,
// takže hledaný text je vždy substring, ne vzor (stejné pravidlo jako
// domain/crm/actions/prospects.ts#escapeLikePattern — duplikováno místo
// přesunu, protože ten soubor je server-action modul se svým vlastním
// importním okruhem a přesun by riskoval rozbití existujícího chování).
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** `%dotaz%` vzor pro ILIKE, s escapovanými zástupnými znaky uvnitř. */
export function likeContains(query: string): string {
  return `%${escapeLikePattern(query)}%`
}

// `.or()` čte hodnoty z jednoho řetězce odděleného čárkami/závorkami
// (`col.op.value,col2.op.value2`), takže neescapovaná čárka nebo závorka ve
// vyhledávaném textu (např. „Novák, Jan") by potichu přidala/uzavřela další
// podmínku filtru — hodnota z uživatelského vstupu by tak mohla ovlivnit,
// co se vůbec hledá, ne jen co se hledá. PostgREST proto dovoluje hodnotu
// obalit do dvojitých uvozovek: uvnitř nich se čárka i závorka berou
// doslova, stačí escapovat `\` a `"` (https://postgrest.org/en/stable/references/api/tables_views.html#operators).
export function quoteOrValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

type AccountRow = { id: number; name: string; ico: string | null; web: string | null }
// company_alias (0033) nemá sloupec `alias` — nese alias_domain a/nebo
// alias_name (CHECK: aspoň jeden vyplněný).
type AliasRow = {
  account_id: number; alias_domain: string | null; alias_name: string | null
  account: { id: number; name: string } | null
}
type ContactRow = {
  id: number; full_name: string; email: string | null
  account_id: number | null; partner_id: number | null
}
type DealRow = { id: number; title: string; account_id: number; account: { name: string } | null }
type PartnerRow = { id: number; name: string; kind: string | null }

export function shapeAccountResults(rows: AccountRow[]): SearchResult[] {
  return rows.map((r) => ({
    kind: 'account', id: r.id, title: r.name,
    subtitle: r.ico ? `IČO ${r.ico}` : r.web,
    href: `/cockpit/clients/${r.id}`,
  }))
}

/** Aliasy (company_alias) se hledají zvlášť a mapují zpět na mateřský účet. */
export function shapeAliasResults(rows: AliasRow[]): SearchResult[] {
  return rows
    .filter((r) => r.account)
    .map((r) => ({
      kind: 'account' as const, id: r.account!.id, title: r.account!.name,
      subtitle: `alias: ${[r.alias_domain, r.alias_name].filter(Boolean).join(' · ')}`,
      href: `/cockpit/clients/${r.account!.id}`,
    }))
}

export function shapeContactResults(rows: ContactRow[]): SearchResult[] {
  return rows.map((r) => ({
    kind: 'contact', id: r.id, title: r.full_name, subtitle: r.email,
    href: `/cockpit/kontakty/${r.id}/edit`,
  }))
}

export function shapeDealResults(rows: DealRow[]): SearchResult[] {
  return rows.map((r) => ({
    kind: 'deal', id: r.id, title: r.title,
    subtitle: r.account?.name ?? null,
    href: `/cockpit/clients/${r.account_id}/deals/${r.id}`,
  }))
}

export function shapePartnerResults(rows: PartnerRow[]): SearchResult[] {
  return rows.map((r) => ({
    kind: 'partner', id: r.id, title: r.name, subtitle: r.kind,
    href: `/cockpit/partners/${r.id}/edit`,
  }))
}

/** Sloučí přímé shody účtu s aliasy, seřadí a ořízne na limit skupiny. */
export function mergeAccountResults(direct: SearchResult[], viaAlias: SearchResult[]): SearchResult[] {
  const seen = new Set<number>()
  const merged: SearchResult[] = []
  for (const r of [...direct, ...viaAlias]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    merged.push(r)
  }
  return merged.slice(0, SEARCH_GROUP_LIMIT)
}

export interface SearchOptions {
  /**
   * Hledat i v obchodech. Jen pro obchodní role (canCurrentUserSeeSales) —
   * ostatním deal od 0058 RLS stejně nevrátí nic, ale dotaz se vůbec
   * nespouští, ať skupina „Obchody" nevzniká ani prázdná.
   */
  includeDeals: boolean
}

/**
 * Globální hledání přes firmy (+ aliasy), kontakty, obchody a partnery.
 * Skupiny běží souběžně, každá max SEARCH_GROUP_LIMIT výsledků. `company_alias`
 * dotaz je izolovaný přes allSettled — chybějící/nedostupná tabulka nesmí
 * shodit zbytek hledání (viz komentář níž).
 */
export async function search(
  query: string,
  { includeDeals }: SearchOptions,
): Promise<SearchResults> {
  const pattern = likeContains(query)
  const quoted = quoteOrValue(pattern)
  const s = await createClient()

  const [accountsRes, aliasesRes, contactsRes, dealsRes, partnersRes] = await Promise.allSettled([
    s.from('account').select('id, name, ico, web')
      .or(`name.ilike.${quoted},ico.ilike.${quoted}`)
      .order('name').limit(SEARCH_GROUP_LIMIT),
    s.from('company_alias')
      .select('account_id, alias_domain, alias_name, account:account!company_alias_account_id_fkey(id, name)')
      .or(`alias_domain.ilike.${quoted},alias_name.ilike.${quoted}`)
      .limit(SEARCH_GROUP_LIMIT),
    s.from('contact').select('id, full_name, email, account_id, partner_id')
      .or(`full_name.ilike.${quoted},email.ilike.${quoted}`)
      .order('full_name').limit(SEARCH_GROUP_LIMIT),
    includeDeals
      ? s.from('deal').select('id, title, account_id, account:account!deal_account_id_fkey(name)')
        .ilike('title', pattern).order('created_at', { ascending: false }).limit(SEARCH_GROUP_LIMIT)
      : Promise.resolve({ data: [] as DealRow[], error: null }),
    s.from('partner').select('id, name, kind')
      .ilike('name', pattern).order('name').limit(SEARCH_GROUP_LIMIT),
  ])

  const accounts = accountsRes.status === 'fulfilled' && !accountsRes.value.error
    ? shapeAccountResults((accountsRes.value.data ?? []) as unknown as AccountRow[])
    : []
  // company_alias tabulka nemusí v prostředí existovat / RLS ji může
  // odmítnout — hledání to nesmí shodit, jen se aliasy nepřidají (viz PR
  // popis úkolu: "handle company_alias missing gracefully").
  const viaAlias = aliasesRes.status === 'fulfilled' && !aliasesRes.value.error
    ? shapeAliasResults((aliasesRes.value.data ?? []) as unknown as AliasRow[])
    : []
  const contacts = contactsRes.status === 'fulfilled' && !contactsRes.value.error
    ? shapeContactResults((contactsRes.value.data ?? []) as unknown as ContactRow[])
    : []
  const deals = dealsRes.status === 'fulfilled' && !dealsRes.value.error
    ? shapeDealResults((dealsRes.value.data ?? []) as unknown as DealRow[])
    : []
  const partners = partnersRes.status === 'fulfilled' && !partnersRes.value.error
    ? shapePartnerResults((partnersRes.value.data ?? []) as unknown as PartnerRow[])
    : []

  return {
    accounts: mergeAccountResults(accounts, viaAlias),
    contacts,
    deals,
    partners,
  }
}
