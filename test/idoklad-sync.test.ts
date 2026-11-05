import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IdokladError, type IdokladInvoice, type IdokladPayment } from '@/connectors/idoklad'
import { dedupeKey, type DiscrepancyDraft, type ExistingDiscrepancy, type RecordInsert, type SyncAccount, type SyncRecord } from '@/domain/finance/idoklad'
import { runIdokladSync, type DiscrepancyPatch, type IdokladSyncDb, type IdokladSyncSource } from '@/domain/finance/idokladSync'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

// Celý běh čtení z iDokladu nad podvrženými odpověďmi API a pamětí místo DB:
// idempotence (druhý běh nic nezapíše), rozdíly, ověření „záznam bez faktury",
// výpadek úhrad, ořez. Žádná síť, žádná databáze.

const TODAY = '2026-09-30'
const inv = (o: Partial<IdokladInvoice>): IdokladInvoice => ({
  id: 1, documentNumber: '20260001', variableSymbol: null, issuedOn: '2026-09-16', dueOn: '2026-09-30', paidOn: null,
  currencyId: 1, currency: 'CZK', totalNet: 10000, totalGross: 12100, totalPaid: 0, paymentStatus: 'unpaid',
  partnerId: 5, partnerIco: '12345678', partnerName: 'Alfa s.r.o.', ...o,
})

class MemDb implements IdokladSyncDb {
  accounts: SyncAccount[] = [{ id: 1, name: 'Alfa s.r.o.', ico: '12345678' }]
  records: (SyncRecord & { note?: string })[] = []
  discrepancies: (ExistingDiscrepancy & DiscrepancyDraft & { last_seen_at?: string; resolved_at?: string | null })[] = []
  writes: string[] = []
  private seq = 1
  async loadAccounts() { return this.accounts }
  async loadRecords() { return this.records.map((r) => ({ ...r })) }
  async loadDiscrepancies() { return this.discrepancies.map((d) => ({ ...d })) }
  async insertRecord(r: RecordInsert) {
    if (this.records.some((x) => x.idoklad_kind === r.idoklad_kind && x.idoklad_id === r.idoklad_id)) return 'conflict' as const
    this.writes.push(`insert:${r.kind}:${r.idoklad_id}`)
    this.records.push({ id: 1000 + this.seq++, ...r })
    return 'created' as const
  }
  async patchRecord(id: number, patch: Record<string, unknown>) {
    const rec = this.records.find((r) => r.id === id)
    if (!rec || rec.status === 'cancelled') return false
    this.writes.push(`patch:${id}`)
    Object.assign(rec, patch)
    return true
  }
  async insertDiscrepancy(d: DiscrepancyDraft) {
    if (this.discrepancies.some((x) => dedupeKey(x) === dedupeKey(d))) return
    this.writes.push(`disc+:${dedupeKey(d)}`)
    this.discrepancies.push({ id: this.seq++, status: 'open', resolution: null, ...d })
  }
  async updateDiscrepancy(id: number, patch: DiscrepancyPatch) {
    const d = this.discrepancies.find((x) => x.id === id)!
    if (patch.status !== undefined && patch.status !== d.status) this.writes.push(`disc:${patch.status}:${id}`)
    Object.assign(d, patch)
  }
}

function source(over: { invoices?: IdokladInvoice[]; payments?: IdokladPayment[]; truncated?: boolean; paymentsFail?: boolean; byNumber?: Record<string, IdokladInvoice>; byIds?: IdokladInvoice[]; verifyFail?: boolean } = {}): IdokladSyncSource & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async invoices(since) { calls.push(`invoices:${since}`); return { items: over.invoices ?? [], truncated: over.truncated ?? false } },
    async payments(since) {
      calls.push(`payments:${since}`)
      if (over.paymentsFail) throw new IdokladError(429, 'http_429', 'limit')
      return { items: over.payments ?? [], truncated: false }
    },
    async invoicesByIds(ids) {
      calls.push(`byIds:${ids.join(',')}`)
      if (over.verifyFail) throw new IdokladError(500, 'http_500', 'x')
      return (over.byIds ?? []).filter((i) => ids.includes(i.id))
    },
    async invoiceByNumber(n) {
      calls.push(`byNumber:${n}`)
      if (over.verifyFail) throw new IdokladError(500, 'http_500', 'x')
      return over.byNumber?.[n] ?? null
    },
  }
}

const run = (db: MemDb, src: IdokladSyncSource, days = 90) => runIdokladSync({ db, source: src, today: TODAY, days, now: () => Date.parse('2026-09-30T04:00:00Z') })

let db: MemDb
beforeEach(() => { db = new MemDb() })

describe('runIdokladSync', () => {
  it('okno: dnešek minus N dní', async () => {
    const s = source()
    const stats = await run(db, s, 30)
    expect(s.calls).toContain('invoices:2026-08-31')
    expect(s.calls).toContain('payments:2026-08-31')
    expect(stats.since).toBe('2026-08-31')
  })

  it('faktura + úhrada se zapíšou; DRUHÝ BĚH nezapíše nic (idempotence podle id dokladu)', async () => {
    const i = inv({ id: 1, totalPaid: 12100, paymentStatus: 'paid' })
    const p: IdokladPayment = { id: 50, invoiceId: 1, documentNumber: '20260001', paidOn: '2026-09-20', amount: 12100, currencyId: 1 }
    const s = source({ invoices: [i], payments: [p] })
    const first = await run(db, s)
    expect(first).toMatchObject({ invoicesRead: 1, paymentsRead: 1, recordsCreated: 2, discrepanciesOpen: 0 })
    expect(db.records.map((r) => [r.kind, r.amount, r.status, r.source, r.external_ref])).toEqual([
      ['invoiced', 10000, 'confirmed', 'idoklad', '20260001'],
      ['received', 10000, 'confirmed', 'idoklad', '20260001'],
    ])
    db.writes.length = 0
    const second = await run(db, s)
    expect(second.recordsCreated).toBe(0)
    expect(db.writes).toEqual([])
    expect(db.records).toHaveLength(2)
  })

  it('souběh: záznam, který mezitím vznikl (UNIQUE), se počítá jako konflikt, ne jako chyba', async () => {
    const s = source({ invoices: [inv({ id: 1 })] })
    const racing = new MemDb()
    racing.loadRecords = async () => [] // běh nevidí záznam, který vznikne těsně před zápisem
    racing.records.push({ id: 5, account_id: 1, kind: 'invoiced', amount: 10000, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'idoklad', external_ref: '20260001', idoklad_kind: 'invoice', idoklad_id: 1, idoklad_due_on: null })
    const stats = await run(racing, s)
    expect(stats.recordsCreated).toBe(0)
    expect(stats.conflicts).toBe(1)
  })

  it('rozdíl se založí jednou; zopakovaný běh ho jen obnoví; po opravě záznamu sám zmizí', async () => {
    db.records.push({ id: 1, account_id: 1, kind: 'invoiced', amount: 9000, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'ucetnictvi', external_ref: '20260001', idoklad_kind: null, idoklad_id: null, idoklad_due_on: null })
    const s = source({ invoices: [inv({ id: 1 })] })
    const a = await run(db, s)
    expect(db.discrepancies).toHaveLength(1)
    expect(db.discrepancies[0]).toMatchObject({ kind: 'amount_mismatch', status: 'open', record_id: 1, idoklad_amount: 10000, record_amount: 9000 })
    expect(a.discrepanciesOpen).toBe(1)
    await run(db, s)
    expect(db.discrepancies).toHaveLength(1)
    // Člověk opraví částku → další běh záznam spáruje a rozdíl uzavře sám.
    db.records[0].amount = 10000
    const c = await run(db, s)
    expect(db.discrepancies[0]).toMatchObject({ status: 'resolved', resolution: 'auto' })
    expect(c.discrepanciesResolvedAuto).toBe(1)
    expect(db.records[0]).toMatchObject({ idoklad_kind: 'invoice', idoklad_id: 1, status: 'confirmed' })
  })

  it('odložený rozdíl se druhý den nevrací; při změně částky v iDokladu se otevře znovu', async () => {
    db.records.push({ id: 1, account_id: 1, kind: 'invoiced', amount: 9000, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'ucetnictvi', external_ref: '20260001', idoklad_kind: null, idoklad_id: null, idoklad_due_on: null })
    await run(db, source({ invoices: [inv({ id: 1 })] }))
    Object.assign(db.discrepancies[0], { status: 'dismissed', resolution: 'dismissed' })
    await run(db, source({ invoices: [inv({ id: 1 })] }))
    expect(db.discrepancies[0].status).toBe('dismissed')
    await run(db, source({ invoices: [inv({ id: 1, totalNet: 9500, totalGross: 11495 })] }))
    expect(db.discrepancies[0]).toMatchObject({ status: 'open', resolution: null })
  })

  it('záznam bez faktury: ověří se dotazem podle čísla; nalezená (starší) faktura rozdíl nevyrobí', async () => {
    db.records.push(
      { id: 1, account_id: 1, kind: 'invoiced', amount: 500, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'ucetnictvi', external_ref: 'ZTRACENA', idoklad_kind: null, idoklad_id: null, idoklad_due_on: null },
      { id: 2, account_id: 1, kind: 'invoiced', amount: 700, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'ucetnictvi', external_ref: 'STARSI', idoklad_kind: null, idoklad_id: null, idoklad_due_on: null },
    )
    const s = source({ byNumber: { STARSI: inv({ id: 77, documentNumber: 'STARSI', issuedOn: '2026-05-01' }) } })
    const stats = await run(db, s)
    expect(s.calls).toEqual(expect.arrayContaining(['byNumber:ZTRACENA', 'byNumber:STARSI']))
    expect(db.discrepancies.map((d) => [d.kind, d.record_id])).toEqual([['record_without_invoice', 1]])
    expect(stats.verified).toBe(2)
  })

  it('selhání ověření nevyrobí falešný rozdíl a nic existujícího neuzavře', async () => {
    db.records.push({ id: 1, account_id: 1, kind: 'invoiced', amount: 500, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'ucetnictvi', external_ref: 'ZTRACENA', idoklad_kind: null, idoklad_id: null, idoklad_due_on: null })
    db.discrepancies.push({ id: 9, status: 'open', resolution: null, ...{ kind: 'record_without_invoice', reason: 'r', idoklad_kind: null, idoklad_id: null, document_number: 'ZTRACENA', account_id: 1, record_id: 1, currency: 'CZK', idoklad_amount: null, record_amount: 500, fingerprint: 'no-invoice|500|CZK|ZTRACENA' } })
    await run(db, source({ verifyFail: true }))
    expect(db.discrepancies).toHaveLength(1)
    expect(db.discrepancies[0].status).toBe('open')
  })

  it('výpadek úhrad: faktury se zpracují, úhrady se nezapíší a rozdíly úhrad sám nezmizí', async () => {
    db.discrepancies.push({ id: 9, status: 'open', resolution: null, ...{ kind: 'payment_mismatch', reason: 'r', idoklad_kind: 'invoice', idoklad_id: 1, document_number: 'X', account_id: 1, record_id: null, currency: 'CZK', idoklad_amount: 1, record_amount: 0, fingerprint: 'p' } })
    const stats = await run(db, source({ invoices: [inv({ id: 1, totalPaid: 12100, paymentStatus: 'paid' })], paymentsFail: true }))
    expect(stats.paymentsUnavailable).toBe(true)
    expect(db.records.map((r) => r.kind)).toEqual(['invoiced'])
    expect(db.discrepancies[0].status).toBe('open')
  })

  it('ořezaný seznam faktur: nic sám nezmizí a záznamy bez faktury se nehodnotí', async () => {
    db.records.push({ id: 1, account_id: 1, kind: 'invoiced', amount: 500, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'ucetnictvi', external_ref: 'ZTRACENA', idoklad_kind: null, idoklad_id: null, idoklad_due_on: null })
    db.discrepancies.push({ id: 9, status: 'open', resolution: null, ...{ kind: 'amount_mismatch', reason: 'r', idoklad_kind: 'invoice', idoklad_id: 1, document_number: 'X', account_id: 1, record_id: null, currency: 'CZK', idoklad_amount: 1, record_amount: 0, fingerprint: 'p' } })
    const s = source({ invoices: [inv({ id: 1 })], truncated: true })
    const stats = await run(db, s)
    expect(stats.truncated).toBe(true)
    expect(s.calls.some((c) => c.startsWith('byNumber'))).toBe(false)
    expect(db.discrepancies[0].status).toBe('open')
  })

  it('úhrada starší faktury se doplní dotazem na faktury podle id', async () => {
    const old = inv({ id: 40, documentNumber: 'OLD', issuedOn: '2026-05-01', totalPaid: 12100 })
    const s = source({ payments: [{ id: 90, invoiceId: 40, documentNumber: 'OLD', paidOn: '2026-09-10', amount: 12100, currencyId: 1 }], byIds: [old] })
    await run(db, s)
    expect(s.calls).toContain('byIds:40')
    expect(db.records.find((r) => r.kind === 'received')).toMatchObject({ external_ref: 'OLD', amount: 10000 })
  })

  it('zrušený záznam z iDokladu se nevrací', async () => {
    const s = source({ invoices: [inv({ id: 1 })] })
    await run(db, s)
    db.records[0].status = 'cancelled'
    db.writes.length = 0
    await run(db, s)
    expect(db.writes).toEqual([])
    expect(db.records).toHaveLength(1)
  })
})
