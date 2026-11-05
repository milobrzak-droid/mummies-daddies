// Čtení, které potřebuje hromadný import (domain/crm/actions/bulkImport.ts):
// účty k párování, už importované klíče, obchody stejného jména u klienta,
// aktivní členové týmu a úklid nepotvrzených návrhů z PDF. Vše přes klienta
// s právy přihlášeného člověka (RLS: tým, AAL2, obchodní role), jen úklid
// úložiště jede přes servisní klíč. Nic tu nezapisuje do tabulek.
import type { SupabaseClient } from '@supabase/supabase-js'
import { logError, logWarn } from '@/lib/log'
import { fold, type AccountIndex, type ImportMember, BULK_PROPOSAL_RETENTION_DAYS } from '@/domain/crm/bulkImport'
import { OFFER_BUCKET } from '@/domain/crm/offerProposal'

type Db = Pick<SupabaseClient, 'from'>

const PAGE = 1000
const KEY_CHUNK = 40
const ID_CHUNK = 100

/** Všichni klienti (id, název, IČO) a jejich aliasy podle názvu — podklad pro párování. */
export async function loadAccountIndex(db: Db): Promise<AccountIndex> {
  const accounts: AccountIndex['accounts'][number][] = []
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data, error } = await db.from('account').select('id, name, ico').order('id').range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as { id: number; name: string; ico: string | null }[]
    accounts.push(...rows)
    if (rows.length < PAGE) break
  }
  const aliases: AccountIndex['aliases'][number][] = []
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data, error } = await db.from('company_alias').select('account_id, alias_name')
      .not('alias_name', 'is', null).order('id').range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as { account_id: number; alias_name: string | null }[]
    aliases.push(...rows)
    if (rows.length < PAGE) break
  }
  return { accounts, aliases }
}

/** Které z klíčů už jsou v Cockpitu importované (zakázka z dávky, kterou nikdo nevrátil). */
export async function findImportedKeys(db: Db, keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  const unique = [...new Set(keys)]
  for (let i = 0; i < unique.length; i += KEY_CHUNK) {
    const chunk = unique.slice(i, i + KEY_CHUNK)
    const { data, error } = await db.from('import_batch_item').select('import_key').in('import_key', chunk)
    if (error) throw error
    for (const r of (data ?? []) as { import_key: string | null }[]) if (r.import_key) found.add(r.import_key)
  }
  return found
}

export type ExistingDeal = { id: number; account_id: number; title: string }

/** Obchody vybraných klientů (kvůli varování „zakázka téhož jména už existuje“). */
export async function findDealsOfAccounts(db: Db, accountIds: readonly number[]): Promise<ExistingDeal[]> {
  const out: ExistingDeal[] = []
  const ids = [...new Set(accountIds)]
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db.from('deal').select('id, account_id, title').in('account_id', ids.slice(i, i + ID_CHUNK))
    if (error) throw error
    out.push(...((data ?? []) as ExistingDeal[]))
  }
  return out
}

/** Obchod stejného jména u téhož klienta (bez ohledu na velikost písmen a diakritiku). */
export function findSameTitleDeal(deals: readonly ExistingDeal[], accountId: number, title: string): ExistingDeal | null {
  const want = fold(title)
  if (!want) return null
  return deals.find((d) => d.account_id === accountId && fold(d.title) === want) ?? null
}

/** Aktivní členové týmu s e-mailem (vlastník zakázky). */
export async function listImportMembers(db: Db): Promise<ImportMember[]> {
  const { data, error } = await db.from('team_member').select('id, email, full_name')
    .is('deactivated_at', null).in('role', ['vedeni', 'obchodnik', 'projektak', 'lektor'])
  if (error) throw error
  return ((data ?? []) as { id: string; email: string | null; full_name: string | null }[])
    .filter((m) => !!m.email)
    .map((m) => ({ id: m.id, email: m.email as string, name: m.full_name }))
}

// ---------------------------------------------------------------------------
// Úklid nepotvrzených návrhů

type StorageApi = {
  list: (path: string, options?: Record<string, unknown>) => Promise<{
    data: { name: string; created_at?: string | null }[] | null
    error: { message: string } | null
  }>
  remove: (paths: string[]) => Promise<{ error: { message: string } | null }>
}

export type PurgeDb = Db & { storage: { from: (bucket: string) => StorageApi } }

const PROPOSAL_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(pdf|navrh\.json)$/

const LIST_PAGE = 200
const REMOVE_CHUNK = 500
/** Úklid běží uvnitř akce importu: výpis úložiště nejvýš tak dlouho, zbytek příště. */
const PURGE_BUDGET_MS = 15_000

/**
 * PDF nabídky a návrh AI, které nikdo nepotvrdil do BULK_PROPOSAL_RETENTION_DAYS
 * dnů, se smažou: PDF se neuchovává déle, než je nutné. Potvrzená nabídka
 * (obchod na ni odkazuje přes source_pdf_path) zůstává jako důkaz. Best-effort,
 * chyba jen do logu. Vrací počet smazaných souborů.
 *
 * Výpis je seřazený od nejstarších, takže stačí číst, dokud soubory nejsou
 * novější než hranice retence — bez pevného stropu (dřív 2 000 souborů: za
 * tisíci potvrzených PDF, které zůstávají jako důkaz, by se staré návrhy
 * nikdy nenašly). Delší výpis omezí jen čas (PURGE_BUDGET_MS), další úklid
 * pokračuje. Mazání až po výpisu, ať posun stránek nic nepřeskočí.
 */
export async function purgeStaleOfferProposals(db: PurgeDb, now: Date = new Date(), clock: () => number = Date.now): Promise<number> {
  try {
    const bucket = db.storage.from(OFFER_BUCKET)
    const cutoff = now.getTime() - BULK_PROPOSAL_RETENTION_DAYS * 86_400_000
    const started = clock()
    const stale = new Map<string, string[]>() // id návrhu → názvy souborů
    listing: for (let offset = 0; clock() - started < PURGE_BUDGET_MS; offset += LIST_PAGE) {
      const { data, error } = await bucket.list('offers', { limit: LIST_PAGE, offset, sortBy: { column: 'created_at', order: 'asc' } })
      if (error) { logWarn('bulkImport.purge', 'výpis úložiště selhal', { message: error.message }); return 0 }
      const items = data ?? []
      for (const it of items) {
        const created = it.created_at ? Date.parse(it.created_at) : NaN
        // Od nejstarších: první soubor mladší než hranice = dál už jsou jen mladší.
        if (Number.isFinite(created) && created > cutoff) break listing
        const m = PROPOSAL_FILE_RE.exec(it.name)
        if (!m || !Number.isFinite(created)) continue
        stale.set(m[1], [...(stale.get(m[1]) ?? []), it.name])
      }
      if (items.length < LIST_PAGE) break
    }
    if (stale.size === 0) return 0

    // Návrhy, ke kterým už obchod existuje, se nemažou (PDF je důkaz).
    const ids = [...stale.keys()]
    const referenced = new Set<string>()
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const paths = ids.slice(i, i + ID_CHUNK).map((id) => `offers/${id}.pdf`)
      const { data, error } = await db.from('deal').select('source_pdf_path').in('source_pdf_path', paths)
      if (error) { logWarn('bulkImport.purge', 'kontrola obchodů selhala', { message: error.message }); return 0 }
      for (const r of (data ?? []) as { source_pdf_path: string | null }[]) if (r.source_pdf_path) referenced.add(r.source_pdf_path)
    }
    const paths = ids
      .filter((id) => !referenced.has(`offers/${id}.pdf`))
      .flatMap((id) => (stale.get(id) ?? []).map((n) => `offers/${n}`))
    let removed = 0
    for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
      const chunk = paths.slice(i, i + REMOVE_CHUNK)
      const { error } = await bucket.remove(chunk)
      if (error) { logWarn('bulkImport.purge', 'smazání souborů selhalo', { message: error.message }); return removed }
      removed += chunk.length
    }
    return removed
  } catch (e) {
    logError('bulkImport.purge', e)
    return 0
  }
}
