import { describe, expect, it } from 'vitest'
import type { IdokladInvoice, IdokladPayment } from '@/connectors/idoklad'
import {
  amountMatchesInvoice,
  dedupeKey,
  firstOfNextMonth,
  matchAccount,
  buildAccountIndex,
  netPaymentAmount,
  planSync,
  reconcileQueue,
  syncDaysFromEnv,
  type DiscrepancyDraft,
  type ExistingDiscrepancy,
  type PlanInput,
  type SyncAccount,
  type SyncRecord,
} from '@/domain/finance/idoklad'

// Párování faktur a úhrad z iDokladu se záznamy Cockpitu — čistá logika.

const SINCE = '2026-07-02'

let nextInv = 100
const inv = (o: Partial<IdokladInvoice> = {}): IdokladInvoice => ({
  id: nextInv++, documentNumber: `2026${nextInv}`, variableSymbol: null, issuedOn: '2026-09-16', dueOn: '2026-09-30', paidOn: null,
  currencyId: 1, currency: 'CZK', totalNet: 10000, totalGross: 12100, totalPaid: 0, paymentStatus: 'unpaid',
  partnerId: 5, partnerIco: '12345678', partnerName: 'Alfa s.r.o.', ...o,
})
let nextPay = 500
const pay = (o: Partial<IdokladPayment> = {}): IdokladPayment => ({
  id: nextPay++, invoiceId: 100, documentNumber: null, paidOn: '2026-09-20', amount: 12100, currencyId: 1, ...o,
})
let nextRec = 1
const rec = (o: Partial<SyncRecord> = {}): SyncRecord => ({
  id: nextRec++, account_id: 1, kind: 'invoiced', amount: 10000, currency: 'CZK', period_month: '2026-09-01', status: 'draft',
  source: 'milnik', external_ref: null, idoklad_kind: null, idoklad_id: null, idoklad_due_on: null, ...o,
})
const ACCOUNTS: SyncAccount[] = [
  { id: 1, name: 'Alfa s.r.o.', ico: '12345678' },
  { id: 2, name: 'Beta a.s.', ico: '87654321' },
  { id: 3, name: 'Gama Bez Ico s.r.o.', ico: null },
]

function plan(o: Partial<PlanInput>) {
  return planSync({ invoices: [], payments: [], extraInvoices: [], accounts: ACCOUNTS, records: [], since: SINCE, paymentsComplete: true, ...o })
}

describe('firma k faktuře', () => {
  const idx = buildAccountIndex(ACCOUNTS)
  it('podle IČO, i s CZ a bez nul', () => {
    expect(matchAccount({ partnerIco: 'CZ12345678', partnerName: null }, idx)).toMatchObject({ ok: true, how: 'ico', account: { id: 1 } })
    expect(matchAccount({ partnerIco: '1234 5678', partnerName: null }, idx)).toMatchObject({ ok: true, account: { id: 1 } })
  })
  it('podle názvu jen u firmy bez IČO; firma s jiným IČO se názvem nespáruje', () => {
    expect(matchAccount({ partnerIco: null, partnerName: 'GAMA bez ičo, s.r.o.' }, idx)).toMatchObject({ ok: true, how: 'nazev', account: { id: 3 } })
    // Alfa má IČO → jiný subjekt se stejným názvem se přes název nepřiřadí.
    expect(matchAccount({ partnerIco: '99999999', partnerName: 'Alfa s.r.o.' }, idx)).toMatchObject({ ok: false })
  })
  it('víc firem se stejným IČO nebo názvem = nejednoznačné', () => {
    const dup = buildAccountIndex([...ACCOUNTS, { id: 9, name: 'Alfa jiná', ico: '12345678' }, { id: 10, name: 'Gama bez ICO', ico: null }])
    expect(matchAccount({ partnerIco: '12345678', partnerName: null }, dup)).toMatchObject({ ok: false, reason: expect.stringContaining('víc firmám') })
    expect(matchAccount({ partnerIco: null, partnerName: 'Gama bez ico' }, dup)).toMatchObject({ ok: false })
  })
})

describe('částky', () => {
  it('shoda se základem i s částkou s DPH, s tolerancí haléře', () => {
    const i = inv()
    expect(amountMatchesInvoice(10000, i)).toBe(true)
    expect(amountMatchesInvoice('12100.00', i)).toBe(true)
    expect(amountMatchesInvoice(10000.01, i)).toBe(true)
    expect(amountMatchesInvoice(10001, i)).toBe(false)
  })
  it('úhrada se přepočte na základ bez DPH; u neplátce zůstává', () => {
    expect(netPaymentAmount({ amount: 12100 }, { totalNet: 10000, totalGross: 12100 })).toBe(10000)
    expect(netPaymentAmount({ amount: 6050 }, { totalNet: 10000, totalGross: 12100 })).toBe(5000)
    expect(netPaymentAmount({ amount: 500 }, { totalNet: 500, totalGross: 500 })).toBe(500)
  })
  it('okno ve dnech: výchozí 90, meze 1–365', () => {
    expect(syncDaysFromEnv({})).toBe(90)
    expect(syncDaysFromEnv({ IDOKLAD_SYNC_DAYS: '30' })).toBe(30)
    expect(syncDaysFromEnv({ IDOKLAD_SYNC_DAYS: '0' })).toBe(90)
    expect(syncDaysFromEnv({ IDOKLAD_SYNC_DAYS: '999' })).toBe(90)
    expect(syncDaysFromEnv({ IDOKLAD_SYNC_DAYS: 'x' })).toBe(90)
  })
  it('první den příštího měsíce', () => {
    expect(firstOfNextMonth('2026-07-02')).toBe('2026-08-01')
    expect(firstOfNextMonth('2026-12-31')).toBe('2027-01-01')
  })
})

describe('faktury → záznamy „vyfakturováno"', () => {
  it('faktura bez záznamu u známé firmy = nový potvrzený záznam ze zdroje iDoklad (základ bez DPH, splatnost)', () => {
    const i = inv({ id: 1, documentNumber: '20260001' })
    const p = plan({ invoices: [i] })
    expect(p.inserts).toEqual([{
      account_id: 1, kind: 'invoiced', amount: 10000, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed',
      source: 'idoklad', external_ref: '20260001', idoklad_kind: 'invoice', idoklad_id: 1, idoklad_due_on: '2026-09-30',
    }])
    expect(p.discrepancies).toEqual([])
  })

  it('shoda podle čísla dokladu: záznam se potvrdí a spáruje, splatnost se uloží', () => {
    const r = rec({ external_ref: '20260002', status: 'draft', source: 'rucne' })
    const p = plan({ invoices: [inv({ id: 2, documentNumber: '20260002' })], records: [r] })
    expect(p.patches).toEqual([{ id: r.id, patch: { status: 'confirmed', idoklad_kind: 'invoice', idoklad_id: 2, idoklad_due_on: '2026-09-30' } }])
    expect(p.inserts).toEqual([])
  })

  it('shoda podle variabilního symbolu a bez ohledu na mezery a velikost písmen', () => {
    const r = rec({ external_ref: 'fv 2026 0003', status: 'confirmed', source: 'ucetnictvi' })
    const p = plan({ invoices: [inv({ id: 3, documentNumber: 'X-1', variableSymbol: 'FV20260003' })], records: [r] })
    expect(p.patches).toEqual([{ id: r.id, patch: { idoklad_kind: 'invoice', idoklad_id: 3, idoklad_due_on: '2026-09-30' } }])
  })

  it('shoda částkou s DPH (doklad opsán celý) projde', () => {
    const r = rec({ external_ref: '20260004', amount: 12100 })
    const p = plan({ invoices: [inv({ id: 4, documentNumber: '20260004' })], records: [r] })
    expect(p.patches).toHaveLength(1)
    expect(p.discrepancies).toEqual([])
  })

  it('stejné číslo, jiná částka = rozdíl „jiná částka", záznam se nemění', () => {
    const r = rec({ external_ref: '20260005', amount: 9000 })
    const p = plan({ invoices: [inv({ id: 5, documentNumber: '20260005' })], records: [r] })
    expect(p.patches).toEqual([])
    expect(p.inserts).toEqual([])
    expect(p.discrepancies).toHaveLength(1)
    expect(p.discrepancies[0]).toMatchObject({ kind: 'amount_mismatch', idoklad_id: 5, record_id: r.id, record_amount: 9000, idoklad_amount: 10000 })
  })

  it('stejné číslo, jiná měna = rozdíl', () => {
    const r = rec({ external_ref: '20260006', currency: 'EUR' })
    const p = plan({ invoices: [inv({ id: 6, documentNumber: '20260006' })], records: [r] })
    expect(p.discrepancies[0]).toMatchObject({ kind: 'amount_mismatch', record_id: r.id })
  })

  it('číslo dokladu sedí se záznamem u JINÉ firmy = rozdíl, nic se nespáruje', () => {
    const r = rec({ external_ref: '20260007', account_id: 2 })
    const p = plan({ invoices: [inv({ id: 7, documentNumber: '20260007' })], records: [r] })
    expect(p.patches).toEqual([])
    expect(p.discrepancies[0]).toMatchObject({ kind: 'invoice_without_record', record_id: r.id })
  })

  it('číslu odpovídá víc záznamů = rozdíl, nic se nezapíše', () => {
    const p = plan({ invoices: [inv({ id: 8, documentNumber: '20260008' })], records: [rec({ external_ref: '20260008' }), rec({ external_ref: '20260008' })] })
    expect(p.patches).toEqual([])
    expect(p.inserts).toEqual([])
    expect(p.discrepancies[0]).toMatchObject({ kind: 'invoice_without_record' })
  })

  it('podklad z milníku bez čísla: shoda firmou, měnou a částkou → potvrdit a doplnit číslo', () => {
    const draft = rec({ external_ref: null, status: 'draft', source: 'milnik', account_id: 1 })
    const p = plan({ invoices: [inv({ id: 9, documentNumber: '20260009' })], records: [draft] })
    expect(p.inserts).toEqual([])
    expect(p.patches).toEqual([{ id: draft.id, patch: { status: 'confirmed', external_ref: '20260009', idoklad_kind: 'invoice', idoklad_id: 9, idoklad_due_on: '2026-09-30' } }])
  })

  it('podklad se shodnou částkou, ale jiná firma → nový záznam, cizí podklad se nedotkne', () => {
    const cizi = rec({ account_id: 2, source: 'milnik' })
    const p = plan({ invoices: [inv({ id: 10, documentNumber: '20260010' })], records: [cizi] })
    expect(p.patches).toEqual([])
    expect(p.inserts).toHaveLength(1)
  })

  it('dva stejné podklady u firmy = nejednoznačné, nic se nezapíše', () => {
    const p = plan({ invoices: [inv({ id: 11 })], records: [rec({ source: 'milnik' }), rec({ source: 'milnik' })] })
    expect(p.patches).toEqual([])
    expect(p.inserts).toEqual([])
    expect(p.discrepancies[0]).toMatchObject({ kind: 'invoice_without_record', account_id: 1 })
  })

  it('jediný otevřený podklad s jinou částkou = „jiná částka" (nejspíš ten samý), nic se nezapíše', () => {
    const draft = rec({ amount: 8000 })
    const p = plan({ invoices: [inv({ id: 12 })], records: [draft] })
    expect(p.inserts).toEqual([])
    expect(p.discrepancies[0]).toMatchObject({ kind: 'amount_mismatch', record_id: draft.id })
  })

  it('faktura odběratele, kterého Cockpit nezná = rozdíl „faktura bez záznamu", nic se nezapíše', () => {
    const p = plan({ invoices: [inv({ id: 13, partnerIco: '11111111', partnerName: 'Neznámá firma' })] })
    expect(p.inserts).toEqual([])
    expect(p.discrepancies[0]).toMatchObject({ kind: 'invoice_without_record', account_id: null, idoklad_id: 13 })
  })

  it('měna mimo CZK a EUR se nezapíše, ale hlásí', () => {
    const p = plan({ invoices: [inv({ id: 14, currency: 'USD' })] })
    expect(p.inserts).toEqual([])
    expect(p.discrepancies[0]).toMatchObject({ kind: 'invoice_without_record', reason: expect.stringContaining('USD') })
  })

  it('nulová faktura se nezapisuje (částka musí být kladná)', () => {
    expect(plan({ invoices: [inv({ id: 15, totalNet: 0, totalGross: 0 })] }).inserts).toEqual([])
  })

  it('IDEMPOTENCE: už spárovaná faktura nevytvoří nic nového; změna splatnosti se propíše', () => {
    const linked = rec({ kind: 'invoiced', status: 'confirmed', source: 'idoklad', external_ref: '20260016', idoklad_kind: 'invoice', idoklad_id: 16, idoklad_due_on: '2026-09-25' })
    const p = plan({ invoices: [inv({ id: 16, documentNumber: '20260016', dueOn: '2026-09-30' })], records: [linked] })
    expect(p.inserts).toEqual([])
    expect(p.patches).toEqual([{ id: linked.id, patch: { idoklad_due_on: '2026-09-30' } }])
    const same = plan({ invoices: [inv({ id: 16, documentNumber: '20260016', dueOn: '2026-09-25' })], records: [linked] })
    expect(same.patches).toEqual([])
    expect(same.discrepancies).toEqual([])
  })

  it('spárovaný záznam s upravenou částkou = rozdíl (iDoklad je zdroj pravdy, ale rozhoduje člověk)', () => {
    const linked = rec({ kind: 'invoiced', status: 'confirmed', source: 'idoklad', external_ref: 'X', idoklad_kind: 'invoice', idoklad_id: 17, amount: 7000 })
    const p = plan({ invoices: [inv({ id: 17 })], records: [linked] })
    expect(p.discrepancies[0]).toMatchObject({ kind: 'amount_mismatch', record_id: linked.id })
  })

  it('zrušený spárovaný záznam se nevytvoří znovu a nehlásí (člověk ho zrušil vědomě)', () => {
    const cancelled = rec({ kind: 'invoiced', status: 'cancelled', source: 'idoklad', external_ref: 'X', idoklad_kind: 'invoice', idoklad_id: 18 })
    const p = plan({ invoices: [inv({ id: 18 })], records: [cancelled] })
    expect(p.inserts).toEqual([])
    expect(p.patches).toEqual([])
    expect(p.discrepancies).toEqual([])
  })

  it('zrušený ruční záznam se stejným číslem faktuře nebrání (párují se jen nezrušené)', () => {
    const cancelled = rec({ status: 'cancelled', external_ref: '20260019' })
    const p = plan({ invoices: [inv({ id: 19, documentNumber: '20260019' })], records: [cancelled] })
    expect(p.inserts).toHaveLength(1)
  })

  it('jedna faktura nezabere dva záznamy a jeden záznam nepatří dvěma fakturám', () => {
    const r = rec({ source: 'milnik' })
    const p = plan({ invoices: [inv({ id: 20, documentNumber: 'A' }), inv({ id: 21, documentNumber: 'B' })], records: [r] })
    expect(p.patches).toHaveLength(1)
    expect(p.inserts).toHaveLength(1)
  })
})

describe('úhrady → záznamy „přijato"', () => {
  const invoice = inv({ id: 100, documentNumber: '20260100', totalPaid: 12100, paymentStatus: 'paid', issuedOn: '2026-09-01' })

  it('úhrada bez záznamu = nový potvrzený záznam „přijato" bez DPH, měsíc podle data úhrady, číslo faktury', () => {
    const invRec = rec({ kind: 'invoiced', status: 'confirmed', source: 'idoklad', external_ref: '20260100', idoklad_kind: 'invoice', idoklad_id: 100 })
    const p = plan({ invoices: [invoice], payments: [pay({ id: 600, invoiceId: 100, paidOn: '2026-10-02' })], records: [invRec] })
    expect(p.inserts).toEqual([{
      account_id: 1, kind: 'received', amount: 10000, currency: 'CZK', period_month: '2026-10-01', status: 'confirmed',
      source: 'idoklad', external_ref: '20260100', idoklad_kind: 'payment', idoklad_id: 600, idoklad_due_on: null,
    }])
    expect(p.discrepancies).toEqual([])
  })

  it('IDEMPOTENCE: úhrada už zapsaná se nezapíše znovu', () => {
    const invRec = rec({ kind: 'invoiced', status: 'confirmed', source: 'idoklad', external_ref: '20260100', idoklad_kind: 'invoice', idoklad_id: 100, idoklad_due_on: '2026-09-30' })
    const got = rec({ kind: 'received', status: 'confirmed', source: 'idoklad', external_ref: '20260100', idoklad_kind: 'payment', idoklad_id: 601, amount: 10000 })
    const p = plan({ invoices: [invoice], payments: [pay({ id: 601, invoiceId: 100 })], records: [invRec, got] })
    expect(p.inserts).toEqual([])
    expect(p.patches).toEqual([])
    expect(p.discrepancies).toEqual([])
  })

  it('ruční záznam „přijato" se stejnou částkou k téže faktuře = ta samá úhrada → spáruje se, nezdvojí', () => {
    const manual = rec({ kind: 'received', status: 'confirmed', source: 'ucetnictvi', external_ref: '20260100', amount: 10000 })
    const p = plan({ invoices: [invoice], payments: [pay({ id: 602, invoiceId: 100 })], records: [manual] })
    expect(p.inserts.filter((i) => i.kind === 'received')).toEqual([])
    expect(p.patches).toContainEqual({ id: manual.id, patch: { idoklad_kind: 'payment', idoklad_id: 602 } })
  })

  it('ruční záznam „přijato" s jinou částkou = rozdíl a nové úhrady se NEZAPÍŠOU (žádné zdvojení)', () => {
    const manual = rec({ kind: 'received', status: 'confirmed', source: 'ucetnictvi', external_ref: '20260100', amount: 5000 })
    const p = plan({ invoices: [invoice], payments: [pay({ id: 603, invoiceId: 100 })], records: [manual] })
    expect(p.inserts.filter((i) => i.kind === 'received')).toEqual([])
    expect(p.discrepancies).toHaveLength(1)
    expect(p.discrepancies[0]).toMatchObject({ kind: 'payment_mismatch', record_id: manual.id, idoklad_id: 100 })
  })

  it('úhrada faktury neznámé firmy se nezapíše, hlásí se', () => {
    const cizi = inv({ id: 101, documentNumber: 'C', partnerIco: '11111111', partnerName: 'Nikdo', totalPaid: 12100, issuedOn: '2026-09-01' })
    const p = plan({ invoices: [cizi], payments: [pay({ id: 604, invoiceId: 101 })] })
    expect(p.inserts.filter((i) => i.kind === 'received')).toEqual([])
    expect(p.discrepancies.some((d) => d.kind === 'payment_mismatch')).toBe(true)
  })

  it('úhrada starší faktury (mimo okno) se přiřadí přes doplněné faktury', () => {
    const old = inv({ id: 102, documentNumber: 'OLD', issuedOn: '2026-05-01', totalPaid: 12100 })
    const p = plan({ invoices: [], extraInvoices: [old], payments: [pay({ id: 605, invoiceId: 102 })] })
    expect(p.inserts).toHaveLength(1)
    expect(p.inserts[0]).toMatchObject({ kind: 'received', external_ref: 'OLD', account_id: 1 })
  })

  it('úhrada bez načtené faktury se přeskočí (příští běh to zkusí znovu)', () => {
    const p = plan({ payments: [pay({ id: 606, invoiceId: 9999 })] })
    expect(p.inserts).toEqual([])
    expect(p.discrepancies).toEqual([])
  })

  it('stav úhrady: v iDokladu neuhrazeno, v Cockpitu ruční úhrada → rozdíl', () => {
    const unpaid = inv({ id: 103, documentNumber: 'U1', totalPaid: 0, paymentStatus: 'unpaid', issuedOn: '2026-09-01' })
    const manual = rec({ kind: 'received', status: 'confirmed', source: 'ucetnictvi', external_ref: 'U1', amount: 10000 })
    const p = plan({ invoices: [unpaid], records: [manual] })
    expect(p.discrepancies).toHaveLength(1)
    expect(p.discrepancies[0]).toMatchObject({ kind: 'payment_mismatch', idoklad_id: 103, record_amount: 10000, idoklad_amount: 0 })
  })

  it('stav úhrady: částečná úhrada zapsaná stejně na obou stranách rozdíl nemá; nezaplacená faktura bez úhrad také ne', () => {
    const partial = inv({ id: 104, documentNumber: 'P1', totalPaid: 6050, paymentStatus: 'partial', issuedOn: '2026-09-01' })
    const p = plan({ invoices: [partial, inv({ id: 105, documentNumber: 'N1', issuedOn: '2026-09-01' })], payments: [pay({ id: 607, invoiceId: 104, amount: 6050 })] })
    expect(p.inserts.find((i) => i.kind === 'received')).toMatchObject({ amount: 5000 })
    expect(p.discrepancies).toEqual([])
  })

  it('bez úplných úhrad se stav úhrady nehodnotí (žádný falešný poplach)', () => {
    const paid = inv({ id: 106, documentNumber: 'Z1', totalPaid: 12100, paymentStatus: 'paid', issuedOn: '2026-09-01' })
    const p = plan({ invoices: [paid], paymentsComplete: false })
    expect(p.discrepancies).toEqual([])
  })

  it('starší faktura (před oknem) změněná v okně: stav úhrady se nehodnotí, chyběly by úhrady před oknem', () => {
    const old = inv({ id: 107, documentNumber: 'O2', issuedOn: '2026-05-01', totalPaid: 12100, paymentStatus: 'paid' })
    const p = plan({ invoices: [old] })
    expect(p.discrepancies.filter((d) => d.kind === 'payment_mismatch')).toEqual([])
  })
})

describe('záznam bez faktury', () => {
  it('potvrzený záznam s číslem, které mezi fakturami okna není → kandidát k ověření (ne rovnou rozdíl)', () => {
    const r = rec({ kind: 'invoiced', status: 'confirmed', source: 'ucetnictvi', external_ref: 'NIKDE', period_month: '2026-09-01' })
    expect(plan({ invoices: [inv({ id: 30, documentNumber: 'JINA' })], records: [r] }).verifyCandidates.map((x) => x.id)).toEqual([r.id])
  })
  it('kandidáty nejsou: návrhy, podklady z milníku, hraniční měsíc okna, záznam spárovaný v tomto běhu', () => {
    const draft = rec({ status: 'draft', external_ref: 'D' })
    const ms = rec({ status: 'confirmed', source: 'milnik', external_ref: 'M' })
    const border = rec({ status: 'confirmed', source: 'ucetnictvi', external_ref: 'B', period_month: '2026-07-01' })
    const matched = rec({ status: 'confirmed', source: 'ucetnictvi', external_ref: '20260031' })
    const p = plan({ invoices: [inv({ id: 31, documentNumber: '20260031' })], records: [draft, ms, border, matched] })
    expect(p.verifyCandidates).toEqual([])
  })
  it('spárovaný záznam, jehož faktura v okně není, je kandidát (ověří se podle id)', () => {
    const r = rec({ status: 'confirmed', source: 'idoklad', external_ref: 'S', idoklad_kind: 'invoice', idoklad_id: 777, period_month: '2026-09-01' })
    expect(plan({ records: [r] }).verifyCandidates.map((x) => x.id)).toEqual([r.id])
  })
})

describe('fronta rozdílů', () => {
  const draft = (o: Partial<DiscrepancyDraft> = {}): DiscrepancyDraft => ({
    kind: 'amount_mismatch', reason: 'r', idoklad_kind: 'invoice', idoklad_id: 5, document_number: 'X', account_id: 1, record_id: 9,
    currency: 'CZK', idoklad_amount: 1, record_amount: 2, fingerprint: 'f1', ...o,
  })
  const existing = (o: Partial<ExistingDiscrepancy> = {}): ExistingDiscrepancy => ({
    id: 1, kind: 'amount_mismatch', status: 'open', idoklad_kind: 'invoice', idoklad_id: 5, record_id: 9, fingerprint: 'f1', resolution: null, ...o,
  })
  const docs = (...k: string[]) => new Set(k)

  it('klíč rozdílu sedí s vygenerovaným sloupcem v migraci', () => {
    expect(dedupeKey(draft())).toBe('amount_mismatch:invoice:5:9')
    expect(dedupeKey(draft({ kind: 'record_without_invoice', idoklad_kind: null, idoklad_id: null }))).toBe('record_without_invoice:-:-:9')
    expect(dedupeKey(draft({ record_id: null }))).toBe('amount_mismatch:invoice:5:-')
  })
  it('nový rozdíl se založí, otevřený viděný znovu se jen obnoví (žádný duplikát)', () => {
    expect(reconcileQueue([], [draft()], docs()).inserts).toHaveLength(1)
    const again = reconcileQueue([existing()], [draft()], docs('invoice:5'))
    expect(again.inserts).toEqual([])
    expect(again.updates).toEqual([{ id: 1, draft: draft(), reopen: false }])
    expect(again.autoResolve).toEqual([])
  })
  it('odložený rozdíl se stejným otiskem se nevrací; se změněným otiskem se otevře znovu', () => {
    const dismissed = existing({ status: 'dismissed', resolution: 'dismissed' })
    expect(reconcileQueue([dismissed], [draft()], docs()).updates).toEqual([])
    expect(reconcileQueue([dismissed], [draft({ fingerprint: 'f2' })], docs()).updates).toEqual([{ id: 1, draft: draft({ fingerprint: 'f2' }), reopen: true }])
  })
  it('vyřešený rozdíl, který se objevil znovu, se otevře znovu', () => {
    const resolved = existing({ status: 'resolved', resolution: 'applied' })
    expect(reconcileQueue([resolved], [draft()], docs()).updates).toEqual([{ id: 1, draft: draft(), reopen: true }])
  })
  it('rozdíl, který už není a jehož doklad se vyhodnotil, zmizí sám; doklad mimo okno se nedotkne', () => {
    expect(reconcileQueue([existing()], [], docs('invoice:5')).autoResolve).toEqual([1])
    expect(reconcileQueue([existing()], [], docs('invoice:6')).autoResolve).toEqual([])
    expect(reconcileQueue([existing()], [], docs()).autoResolve).toEqual([])
  })
  it('„záznam bez faktury" zmizí sám po ověření záznamu; vynechané druhy sám nezmizí', () => {
    const e = existing({ kind: 'record_without_invoice', idoklad_kind: null, idoklad_id: null, record_id: 9 })
    expect(reconcileQueue([e], [], docs('record:9')).autoResolve).toEqual([1])
    expect(reconcileQueue([existing({ kind: 'payment_mismatch' })], [], docs('invoice:5'), ['payment_mismatch']).autoResolve).toEqual([])
  })
})
