// Denní čtení z iDokladu (P2.3, migrace 0092): načte vydané faktury a úhrady
// za posledních N dní, spáruje je (čistá logika v idoklad.ts) a zapíše jen
// jednoznačné shody. Rozdíly jdou do fronty „Rozdíly k vyřešení".
//
// Napojení: cron /api/cron/ares-enrich (denní 04:00 UTC, existující cron —
// nový se nepřidává, Vercel Hobby) spouští tuhle úlohu, když je zapnutý
// přepínač IDOKLAD_SYNC_ENABLED; zámek runJob('idoklad-sync'), aktér zápisů
// system:job:idoklad-sync, stav údaje source_fact (audit 0064/0082).
//
// Do iDokladu se NIKDY nic nezapisuje (konektor umí jen GET). Logika je nad
// vstříknutými adaptéry (zdroj iDokladu, DB, hodiny), takže se testuje bez
// sítě a bez Supabase (test/idoklad-sync.test.ts).
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createIdokladClient,
  fetchInvoiceByDocumentNumber,
  fetchInvoicesByIds,
  fetchIssuedInvoices,
  fetchIssuedPayments,
  IdokladError,
  type IdokladClient,
  type IdokladCredentials,
  type IdokladInvoice,
  type IdokladPayment,
} from '@/connectors/idoklad'
import { logError, logWarn } from '@/lib/log'
import { addDaysToPragueDay } from '@/lib/pragueDate'
import {
  DISCREPANCY_KINDS,
  MAX_VERIFY_LOOKUPS,
  planSync,
  reconcileQueue,
  recordWithoutInvoiceDraft,
  type DiscrepancyDraft,
  type ExistingDiscrepancy,
  type RecordInsert,
  type RecordPatch,
  type SyncAccount,
  type SyncRecord,
  type SyncStats,
} from '@/domain/finance/idoklad'

// ---------------------------------------------------------------- adaptéry

export interface IdokladSyncSource {
  invoices(since: string): Promise<{ items: IdokladInvoice[]; truncated: boolean }>
  payments(since: string): Promise<{ items: IdokladPayment[]; truncated: boolean }>
  invoicesByIds(ids: readonly number[]): Promise<IdokladInvoice[]>
  invoiceByNumber(documentNumber: string): Promise<IdokladInvoice | null>
}

export function liveIdokladSource(creds: IdokladCredentials): IdokladSyncSource {
  const client: IdokladClient = createIdokladClient(creds)
  return {
    invoices: (since) => fetchIssuedInvoices(client, since),
    payments: (since) => fetchIssuedPayments(client, since),
    invoicesByIds: (ids) => fetchInvoicesByIds(client, ids),
    invoiceByNumber: (n) => fetchInvoiceByDocumentNumber(client, n),
  }
}

export type DiscrepancyPatch = Partial<DiscrepancyDraft> & {
  status?: 'open' | 'resolved'
  resolution?: 'auto' | null
  resolved_at?: string | null
  resolved_by?: null
  resolution_note?: null
  last_seen_at?: string
}

export interface IdokladSyncDb {
  loadAccounts(): Promise<SyncAccount[]>
  loadRecords(): Promise<SyncRecord[]>
  loadDiscrepancies(): Promise<ExistingDiscrepancy[]>
  /** 'conflict' = záznam už existuje (UNIQUE), ne chyba. */
  insertRecord(r: RecordInsert): Promise<'created' | 'conflict'>
  /** false = řádek se nezměnil (zrušený, mezitím smazaný). */
  patchRecord(id: number, patch: RecordPatch['patch']): Promise<boolean>
  insertDiscrepancy(d: DiscrepancyDraft): Promise<void>
  updateDiscrepancy(id: number, patch: DiscrepancyPatch): Promise<void>
}

export type IdokladSyncOptions = {
  db: IdokladSyncDb
  source: IdokladSyncSource
  /** Pražský dnešek (YYYY-MM-DD). */
  today: string
  /** Kolik dní zpět se čte. */
  days: number
  now?: () => number
  /** Po tomhle čase od startu se ověřovací dotazy přestanou (funkce na Vercelu má 60 s, sdílená s ARESem). */
  budgetMs?: number
}

/** Ověřovací dotazy se po tomhle čase přestanou; zbytek minuty patří ARESu ve stejném cronu. */
export const IDOKLAD_BUDGET_MS = 25_000

export type IdokladRunStats = SyncStats & {
  verified: number
  paymentsUnavailable: boolean
  since: string
  [k: string]: unknown
}

const NO_PAYMENTS_KINDS = DISCREPANCY_KINDS.filter((k) => k === 'payment_mismatch')

// ---------------------------------------------------------------- běh

export async function runIdokladSync(opts: IdokladSyncOptions): Promise<IdokladRunStats> {
  const { db, source } = opts
  const now = opts.now ?? Date.now
  const started = now()
  const budget = opts.budgetMs ?? IDOKLAD_BUDGET_MS
  const since = addDaysToPragueDay(opts.today, -opts.days)

  const invoices = await source.invoices(since)

  // Úhrady jsou druhý zdroj: když selžou, faktury se přesto zpracují, jen se
  // nehodnotí a nezapisují úhrady.
  let payments: IdokladPayment[] = []
  let paymentsComplete = true
  try {
    const p = await source.payments(since)
    payments = p.items
    paymentsComplete = !p.truncated
  } catch (e) {
    paymentsComplete = false
    logWarn('idoklad.payments', 'Úhrady se nepodařilo načíst, běh pokračuje jen s fakturami.', { status: e instanceof IdokladError ? e.status : 0 })
  }

  // Faktury k úhradám starších faktur.
  const known = new Set(invoices.items.map((i) => i.id))
  const missingIds = [...new Set(payments.map((p) => p.invoiceId))].filter((id) => !known.has(id))
  let extraInvoices: IdokladInvoice[] = []
  if (missingIds.length > 0) {
    try {
      extraInvoices = await source.invoicesByIds(missingIds)
    } catch (e) {
      logWarn('idoklad.extraInvoices', 'Starší faktury k úhradám se nepodařilo načíst.', { status: e instanceof IdokladError ? e.status : 0 })
    }
  }

  const [accounts, records, existing] = await Promise.all([db.loadAccounts(), db.loadRecords(), db.loadDiscrepancies()])
  const plan = planSync({ invoices: invoices.items, payments, extraInvoices, accounts, records, since, paymentsComplete })

  // Záznam bez faktury: ověřit, že faktura opravdu není (může být starší než okno).
  const drafts: DiscrepancyDraft[] = [...plan.discrepancies]
  let verified = 0
  const unverified = new Set<number>()
  const candidates = invoices.truncated ? [] : plan.verifyCandidates
  for (const rec of candidates) {
    if (verified >= MAX_VERIFY_LOOKUPS || now() - started > budget) {
      unverified.add(rec.id)
      continue
    }
    try {
      const found = rec.idoklad_kind === 'invoice' && rec.idoklad_id
        ? (await source.invoicesByIds([rec.idoklad_id])).length > 0
        : rec.external_ref ? (await source.invoiceByNumber(rec.external_ref)) !== null : true
      verified++
      if (!found) drafts.push(recordWithoutInvoiceDraft(rec))
    } catch (e) {
      unverified.add(rec.id)
      logWarn('idoklad.verify', 'Ověření faktury se nepodařilo.', { status: e instanceof IdokladError ? e.status : 0 })
    }
  }
  for (const id of unverified) plan.evaluatedDocs.delete(`record:${id}`)
  if (invoices.truncated) for (const r of plan.verifyCandidates) plan.evaluatedDocs.delete(`record:${r.id}`)

  // ---- zápis záznamů ---------------------------------------------------------
  const stats: IdokladRunStats = {
    invoicesRead: invoices.items.length,
    paymentsRead: payments.length,
    recordsCreated: 0,
    recordsLinked: 0,
    dueDatesUpdated: 0,
    discrepanciesOpen: 0,
    discrepanciesReopened: 0,
    discrepanciesResolvedAuto: 0,
    conflicts: 0,
    truncated: invoices.truncated || !paymentsComplete,
    verified,
    paymentsUnavailable: !paymentsComplete,
    since,
  }

  for (const patch of plan.patches) {
    try {
      if (await db.patchRecord(patch.id, patch.patch)) {
        if (patch.patch.idoklad_id !== undefined) stats.recordsLinked++
        else stats.dueDatesUpdated++
      } else stats.conflicts++
    } catch (e) {
      stats.conflicts++
      logError('idoklad.patchRecord', e, { recordId: patch.id })
    }
  }
  for (const ins of plan.inserts) {
    try {
      if ((await db.insertRecord(ins)) === 'created') stats.recordsCreated++
      else stats.conflicts++
    } catch (e) {
      stats.conflicts++
      logError('idoklad.insertRecord', e, { idokladKind: ins.idoklad_kind, idokladId: ins.idoklad_id })
    }
  }

  // ---- fronta rozdílů --------------------------------------------------------
  // Ořezaný seznam faktur = neúplné okno: nic sám nezmizí. Chybějící úhrady:
  // sám nezmizí jen druh „úhrada".
  const skipKinds = invoices.truncated ? DISCREPANCY_KINDS : paymentsComplete ? [] : NO_PAYMENTS_KINDS
  const ops = reconcileQueue(existing, drafts, plan.evaluatedDocs, skipKinds)
  const stamp = new Date(now()).toISOString()
  for (const d of ops.inserts) {
    try {
      await db.insertDiscrepancy(d)
    } catch (e) {
      logError('idoklad.insertDiscrepancy', e)
    }
  }
  for (const u of ops.updates) {
    try {
      await db.updateDiscrepancy(u.id, {
        ...u.draft, last_seen_at: stamp,
        ...(u.reopen ? { status: 'open' as const, resolution: null, resolved_at: null, resolved_by: null, resolution_note: null } : {}),
      })
      if (u.reopen) stats.discrepanciesReopened++
    } catch (e) {
      logError('idoklad.updateDiscrepancy', e)
    }
  }
  for (const id of ops.autoResolve) {
    try {
      await db.updateDiscrepancy(id, { status: 'resolved', resolution: 'auto', resolved_at: stamp })
      stats.discrepanciesResolvedAuto++
    } catch (e) {
      logError('idoklad.autoResolve', e)
    }
  }
  stats.discrepanciesOpen = existing.filter((e) => e.status === 'open').length + ops.inserts.length + stats.discrepanciesReopened - stats.discrepanciesResolvedAuto
  return stats
}

// ---------------------------------------------------------------- Supabase

type Client = SupabaseClient
const PAGE = 1000

function dbError(what: string, err: { code?: string; message?: string }): Error {
  const e = new Error(`${what}: ${err.message ?? 'chyba databáze'}`) as Error & { code?: string }
  e.code = err.code
  return e
}

async function selectAll<T>(what: string, page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw dbError(what, error)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

const RECORD_COLS =
  'id, account_id, kind, amount, currency, period_month, status, source, external_ref, idoklad_kind, idoklad_id, idoklad_due_on'

/**
 * DB adaptér nad klientem se service role (RLS obchází). Klient MUSÍ nést
 * hlavičky aktéra (createAuditedAdminClient), jinak audit zapíše jen
 * 'db-trigger:service_role'.
 */
export function supabaseIdokladSyncDb(client: Client): IdokladSyncDb {
  return {
    loadAccounts: () =>
      selectAll<SyncAccount>('account', (from, to) => client.from('account').select('id, name, ico').order('id').range(from, to)),
    loadRecords: () =>
      selectAll<SyncRecord>('financial_record (načtení)', (from, to) =>
        client.from('financial_record').select(RECORD_COLS)
          .in('kind', ['invoiced', 'received'])
          .or('status.neq.cancelled,idoklad_id.not.is.null')
          .order('id').range(from, to)),
    loadDiscrepancies: () =>
      selectAll<ExistingDiscrepancy>('idoklad_discrepancy (načtení)', (from, to) =>
        client.from('idoklad_discrepancy')
          .select('id, kind, status, idoklad_kind, idoklad_id, record_id, fingerprint, resolution')
          .order('id').range(from, to)),
    async insertRecord(r) {
      const { error } = await client.from('financial_record').insert(r)
      if (!error) return 'created'
      if (error.code === '23505') return 'conflict'
      throw dbError('financial_record (zápis)', error)
    },
    async patchRecord(id, patch) {
      const { data, error } = await client.from('financial_record').update(patch).eq('id', id).neq('status', 'cancelled').select('id')
      if (error) throw dbError('financial_record (úprava)', error)
      return ((data ?? []) as unknown[]).length > 0
    },
    async insertDiscrepancy(d) {
      const { error } = await client.from('idoklad_discrepancy').insert(d)
      // 23505: souběžný běh už rozdíl založil — ne chyba.
      if (error && error.code !== '23505') throw dbError('idoklad_discrepancy (zápis)', error)
    },
    async updateDiscrepancy(id, patch) {
      const { error } = await client.from('idoklad_discrepancy').update(patch).eq('id', id)
      if (error) throw dbError('idoklad_discrepancy (úprava)', error)
    },
  }
}

/** Do 0092 chybí tabulka i sloupce: 42P01 / 42703 / PostgREST PGRST205 / PGRST204. */
export function isMigration0092Missing(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return ['42P01', '42703', 'PGRST205', 'PGRST204'].includes(String(code))
}

export const IDOKLAD_MIGRATION_MISSING_MESSAGE = 'Čtení z iDokladu čeká na migraci 0092 (idoklad_discrepancy, financial_record.idoklad_id).'
