import { createClient } from '@/lib/supabase/server'
import { isMissingSchemaError, type AresStatus } from '@/domain/crm/aresEnrich'

// Stránka /clients/doplnit-ico: klienti bez IČO po stránkách.
//
// Dřív stránka načetla všechny klienty a pro každého bez IČO se zeptala
// ARESu — po importu prospektů 640 požadavků při každém zobrazení (limit
// ARESu, timeout Vercelu). Teď se z DB bere jen jedna stránka (20 firem,
// stabilně podle jména a id) a ARES se ptá jen na ně.
//
// Klienty, u kterých automat zjistil, že je ARES pod tím jménem nezná
// (ares_status = 'nenalezeno', migrace 0065), stránka ve výchozím stavu
// skryje — u zahraniční firmy tam nic nebude a jen by zabírali místo.
// ?vse=1 je ukáže taky.

export const MISSING_ICO_PAGE_SIZE = 20

export type MissingIcoRow = {
  id: number
  name: string
  ares_status: AresStatus | null
  ares_checked_at: string | null
}

export type MissingIcoPage = {
  rows: MissingIcoRow[]
  page: number
  totalPages: number
  /** Všichni klienti bez IČO. */
  totalMissing: number
  /** Z nich ty, které ARES pod jménem nezná (ověřeno automatem). */
  notFound: number
  /** Kolik jich seznam ukazuje (bez ?vse=1 = totalMissing − notFound). */
  shown: number
  /** Migrace 0065 ještě není — seznam jde, stav ověření ne. */
  migrationPending: boolean
}

/** ?strana=N → celé číslo ≥ 1 (cokoli jiného = 1). */
export function parsePageParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/** Okno stránky; příliš vysoké číslo stránky se srazí na poslední. */
export function pageWindow(total: number, requested: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, Math.floor(requested) || 1), totalPages)
  const from = (page - 1) * pageSize
  return { page, totalPages, from, to: from + pageSize - 1 }
}

export async function listMissingIcoPage(opts: { page: number; includeNotFound: boolean }): Promise<MissingIcoPage> {
  const s = await createClient()
  const [all, notFoundRes] = await Promise.all([
    s.from('account').select('id', { count: 'exact', head: true }).is('ico', null),
    // GET, ne HEAD: odpověď na HEAD nemá tělo, takže chybějící sloupec
    // (migrace 0065) by přišel bez kódu 42703 a stránka by spadla.
    s.from('account').select('id', { count: 'exact' }).is('ico', null).eq('ares_status', 'nenalezeno').limit(1),
  ])
  if (all.error) throw all.error

  let migrationPending = false
  let notFound = 0
  if (notFoundRes.error) {
    if (!isMissingSchemaError(notFoundRes.error)) throw notFoundRes.error
    migrationPending = true
  } else {
    notFound = notFoundRes.count ?? 0
  }

  const totalMissing = all.count ?? 0
  const shown = opts.includeNotFound || migrationPending ? totalMissing : totalMissing - notFound
  const w = pageWindow(shown, opts.page, MISSING_ICO_PAGE_SIZE)
  const base: Omit<MissingIcoPage, 'rows'> = {
    page: w.page, totalPages: w.totalPages, totalMissing, notFound, shown, migrationPending,
  }
  if (shown === 0) return { ...base, rows: [] }

  if (migrationPending) {
    const { data, error } = await s.from('account').select('id, name')
      .is('ico', null).order('name').order('id').range(w.from, w.to)
    if (error) throw error
    const rows = ((data ?? []) as { id: number; name: string }[])
      .map((r) => ({ ...r, ares_status: null, ares_checked_at: null }))
    return { ...base, rows }
  }

  let q = s.from('account').select('id, name, ares_status, ares_checked_at').is('ico', null)
  // NULL projde přes is.null — samotné neq by ho v SQL vyřadilo.
  if (!opts.includeNotFound) q = q.or('ares_status.is.null,ares_status.neq.nenalezeno')
  const { data, error } = await q.order('name').order('id').range(w.from, w.to)
  if (error) throw error
  return { ...base, rows: (data ?? []) as MissingIcoRow[] }
}
