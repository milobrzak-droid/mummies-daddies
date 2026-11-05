// Hromadný import zakázek: čistá logika (domain/crm/bulkImport.ts,
// bulkImportReview.ts, bulkImportService.ts) — parsování CSV, validace po
// řádcích, párování klientů, klíče idempotence, vstup potvrzení, řádek fronty
// a úklid nepotvrzených návrhů.
import { describe, expect, test, vi } from 'vitest'
import {
  BULK_MAX_CSV_ROWS, CSV_COLUMNS, CSV_TEMPLATE, IMPORT_STAGE_DEAL, applyRowSchema, importDbMessage, importPdfKey, importRowKey,
  importRowKeyText, importStageProbability, isImportMissing, matchClient, parseCsv, parseImportAmount, parseImportCsv,
  parseImportCurrency, parseImportDate, parseImportRevenueLine, parseImportStage, parseRevertResult, describeRevert,
  type ImportMember,
} from '@/domain/crm/bulkImport'
import {
  blockers, isBulkConfirmable, isConfirmable, rowFromCsv, rowFromProposal, tally, toApplyInput, type ReviewRow,
} from '@/domain/crm/bulkImportReview'
import { findSameTitleDeal, purgeStaleOfferProposals, type PurgeDb } from '@/domain/crm/bulkImportService'
import { DEAL_STAGES } from '@/lib/domain'

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const MEMBERS: ImportMember[] = [
  { id: ME, email: 'Viktor@mummiesdaddies.com', name: 'Viktor' },
  { id: OTHER, email: 'jmeno.prijmeni@mummiesdaddies.com', name: 'Jmeno' },
]
const HEADER = 'klient;IČO;název zakázky;cena;měna;stav;začátek;termín;vlastník;fakturováno;přijato'

describe('parseCsv', () => {
  test('rozpozná středník, čárku i tabulátor a ořízne BOM', () => {
    expect(parseCsv('﻿a;b;c\r\n1;2;3\r\n').rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
    expect(parseCsv('a,b\n1,2').delimiter).toBe(',')
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['a', 'b'], ['1', '2']])
  })

  test('uvozovky: oddělovač i zalomení řádku uvnitř buňky, zdvojené uvozovky', () => {
    const { rows } = parseCsv('a;b\n"x;y";"řádek 1\nřádek 2"\n"řekl ""ano""";z')
    expect(rows).toEqual([['a', 'b'], ['x;y', 'řádek 1\nřádek 2'], ['řekl "ano"', 'z']])
  })

  test('poslední řádek bez zalomení a prázdné buňky', () => {
    expect(parseCsv('a;b;c\n1;;3').rows).toEqual([['a', 'b', 'c'], ['1', '', '3']])
  })
})

describe('hodnoty buněk', () => {
  test.each([
    ['580000', 580000], ['580 000', 580000], ['580 000 Kč', 580000], ['580000,50', 580000.5], ['580000.5', 580000.5],
    ['1 234 567,89', 1234567.89], ['1.234.567', 1234567], ['1,234,567.5', 1234567.5], ['1.234,50', 1234.5],
    ['580.000', 580000], ['0,500', 0.5], ['12,5', 12.5], ['€ 1200', 1200], ['1200 EUR', 1200], ['0', 0],
  ])('částka %s = %s', (raw, expected) => {
    expect(parseImportAmount(raw)).toBe(expected)
  })

  test.each(['', 'abc', '-5', '12x', '1e5', '1 000 000 001'])('neplatná částka „%s“', (raw) => {
    expect(parseImportAmount(raw)).toBeNull()
  })

  test('měna a datum', () => {
    expect(parseImportCurrency('')).toBe('CZK')
    expect(parseImportCurrency('Kč')).toBe('CZK')
    expect(parseImportCurrency('eur')).toBe('EUR')
    expect(parseImportCurrency('USD')).toBeNull()
    expect(parseImportDate('2026-03-01')).toBe('2026-03-01')
    expect(parseImportDate('1. 3. 2026')).toBe('2026-03-01')
    expect(parseImportDate('01.03.2026')).toBe('2026-03-01')
    expect(parseImportDate('1/3/2026')).toBe('2026-03-01')
    expect(parseImportDate('30. 2. 2026')).toBeNull()
    expect(parseImportDate('1. 3. 1999')).toBeNull()
    expect(parseImportDate('zítra')).toBeNull()
  })

  test('stav a typ z volného textu', () => {
    expect(parseImportStage('Vyhráno a běží')).toBe('won')
    expect(parseImportStage(' nabídka odeslána ')).toBe('sent')
    expect(parseImportStage('Rozjednáno')).toBe('draft')
    expect(parseImportStage('prohráno')).toBeNull()
    expect(parseImportRevenueLine('Svatba')).toBe('svatebni_hostina')
    expect(parseImportRevenueLine('svatebni_hostina')).toBe('svatebni_hostina')
    expect(parseImportRevenueLine('kavárna')).toBeNull()
  })

  test('stavy importu se mapují na existující fáze obchodu a jejich pravděpodobnost', () => {
    const keys = DEAL_STAGES.map((s) => s.key) as readonly string[]
    for (const stage of Object.values(IMPORT_STAGE_DEAL)) expect(keys).toContain(stage)
    expect(importStageProbability('won')).toBe(100)
    expect(importStageProbability('sent')).toBe(DEAL_STAGES.find((s) => s.key === 'rozsah_nabidka')!.probability)
    expect(importStageProbability('draft')).toBe(DEAL_STAGES.find((s) => s.key === 'diagnostika')!.probability)
  })
})

describe('parseImportCsv', () => {
  const ok = (text: string) => {
    const r = parseImportCsv(text, MEMBERS)
    if (!r.ok) throw new Error(r.error)
    return r
  }

  test('šablona se načte bez chyb (a vlastník ze šablony musí existovat)', () => {
    const r = ok(CSV_TEMPLATE)
    expect(r.rows).toHaveLength(3)
    expect(r.rows.map((x) => x.errors)).toEqual([[], [], []])
    expect(r.ignoredColumns).toEqual([])
    expect(r.rows[0]).toMatchObject({
      clientName: 'Ukázková firma s.r.o.', ico: '27082440', amount: 180000, currency: 'CZK', stage: 'won',
      startedOn: '2026-12-01', dueOn: '2026-12-12', ownerId: OTHER, invoiced: 90000, received: 50000, revenueLine: 'catering_firemni',
    })
    expect(r.rows[1]).toMatchObject({ stage: 'sent', revenueLine: 'svatebni_hostina', amount: 145000 })
    expect(r.rows[2]).toMatchObject({ stage: 'draft', currency: 'EUR', amount: null })
    expect(r.rows[2].warnings).toEqual(['bez ceny (rozjednáno)'])
  })

  test('hlavička je v šabloně stejná jako CSV_COLUMNS', () => {
    expect(CSV_TEMPLATE.split('\r\n')[0]).toBe(CSV_COLUMNS.map((c) => c.header).join(';'))
  })

  test('aliasy hlaviček bez diakritiky a jiné pořadí', () => {
    const r = ok('Firma;Zakazka;Castka;Stav;Mena\nACME;Web;1000;bezi;EUR')
    expect(r.rows[0]).toMatchObject({ clientName: 'ACME', title: 'Web', amount: 1000, stage: 'won', currency: 'EUR', errors: [] })
  })

  test('chybějící povinný sloupec = chyba souboru se jmény sloupců', () => {
    const r = parseImportCsv('klient;cena\nACME;1', MEMBERS)
    expect(r).toEqual({ ok: false, error: expect.stringContaining('název zakázky, stav') })
  })

  test('prázdný soubor, jen hlavička, moc řádků, moc velký soubor', () => {
    expect(parseImportCsv('', MEMBERS)).toMatchObject({ ok: false })
    expect(parseImportCsv(HEADER, MEMBERS)).toMatchObject({ ok: false, error: expect.stringContaining('jen hlavička') })
    const many = [HEADER, ...Array.from({ length: BULK_MAX_CSV_ROWS + 1 }, (_, i) => `F${i};;Z${i};1;CZK;rozjednáno;;;;;`)].join('\n')
    expect(parseImportCsv(many, MEMBERS)).toMatchObject({ ok: false, error: expect.stringContaining('nejvýš 500') })
    expect(parseImportCsv('a'.repeat(1024 * 1024 + 1), MEMBERS)).toMatchObject({ ok: false, error: expect.stringContaining('moc velký') })
  })

  test('neznámé sloupce se ohlásí a nepoužijí', () => {
    expect(ok(`${HEADER};poznámka\nACME;;Web;1;CZK;rozjednáno;;;;;;tajné`).ignoredColumns).toEqual(['poznámka'])
  })

  test('validace po řádcích: každá chyba jen u svého řádku', () => {
    const r = ok([
      HEADER,
      'Dobrá;;Zakázka A;1000;CZK;vyhráno a běží;1. 3. 2026;31. 12. 2026;;;',
      ';;Bez klienta;1000;CZK;rozjednáno;;;;;',
      'Firma;12345678;Špatné IČO;1000;CZK;rozjednáno;;;;;',
      'Firma;;Bez ceny;;CZK;vyhráno a běží;;;;;',
      'Firma;;Nulová cena;0;CZK;nabídka odeslána;;;;;',
      'Firma;;Cena;abc;CZK;rozjednáno;;;;;',
      'Firma;;Měna;10;USD;rozjednáno;;;;;',
      'Firma;;Stav;10;CZK;prohráno;;;;;',
      'Firma;;Datum;10;CZK;rozjednáno;31. 2. 2026;;;;',
      'Firma;;Termín;10;CZK;rozjednáno;1. 5. 2026;1. 4. 2026;;;',
      'Firma;;Vlastník;10;CZK;rozjednáno;;;nikdo@nikde.cz;;',
      'Firma;;Fakturace;10;CZK;rozjednáno;;;;5;',
      'Firma;;Přijato;10;CZK;vyhráno a běží;;;;5;9',
    ].join('\n'))
    const errs = r.rows.map((x) => x.errors)
    expect(errs[0]).toEqual([])
    expect(errs[1]).toEqual(['chybí klient'])
    expect(errs[2][0]).toContain('IČO')
    expect(errs[3]).toEqual(['u této zakázky chybí cena'])
    expect(errs[4]).toEqual(['cena je nula'])
    expect(errs[5][0]).toContain('nepoznávám')
    expect(errs[6][0]).toContain('měna')
    expect(errs[7][0]).toContain('stav')
    expect(errs[8][0]).toContain('začátek')
    expect(errs[9]).toEqual(['termín je dřív než začátek'])
    expect(errs[10][0]).toContain('neexistuje')
    expect(errs[11]).toEqual(['fakturováno a přijato jde uvést jen u „vyhráno a běží“'])
    expect(errs[12]).toEqual(['přijato je víc než fakturováno'])
    expect(r.rows.map((x) => x.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  test('vlastník se hledá podle e-mailu bez ohledu na velikost písmen', () => {
    expect(ok(`${HEADER}\nF;;Z;1;CZK;rozjednáno;;;VIKTOR@mummiesdaddies.com;;`).rows[0]).toMatchObject({ ownerId: ME, errors: [] })
  })

  test('varování: fakturováno je víc než cena', () => {
    expect(ok(`${HEADER}\nF;;Z;100;CZK;vyhráno a běží;;;;200;`).rows[0].warnings).toEqual(['fakturováno je víc než cena zakázky'])
  })

  test('symbol měny u ceny doplní měnu, spor s pole měna je chyba', () => {
    expect(ok(`${HEADER}\nF;;Z;1200 EUR;;rozjednáno;;;;;`).rows[0]).toMatchObject({ currency: 'EUR', amount: 1200, errors: [] })
    expect(ok(`${HEADER}\nF;;Z;1200 EUR;CZK;rozjednáno;;;;;`).rows[0].errors).toEqual(['měna ve sloupci měna a u ceny se liší'])
  })

  test('stejná zakázka v souboru dvakrát: druhý výskyt je chyba, jiný název ne', () => {
    const r = ok([HEADER, 'ACME s.r.o.;;Web;1000;CZK;rozjednáno;;;;;', 'ACME;;web;1000;CZK;rozjednáno;;;;;', 'ACME;;Web 2;1000;CZK;rozjednáno;;;;;'].join('\n'))
    expect(r.rows[0].errors).toEqual([])
    expect(r.rows[1].errors).toEqual(['stejná zakázka je už na řádku 2'])
    expect(r.rows[2].errors).toEqual([])
  })

  test('typ zakázky: neznámý typ je chyba, prázdný = implementace', () => {
    expect(ok(`${HEADER};typ\nF;;Z;1;CZK;rozjednáno;;;;;;kavárna`).rows[0].errors[0]).toContain('typ')
    expect(ok(`${HEADER};typ\nF;;Z;1;CZK;rozjednáno;;;;;;pravidelny`).rows[0].revenueLine).toBe('firemni_pravidelny')
  })
})

describe('klíče idempotence', () => {
  const base = { clientName: 'ACME s.r.o.', ico: null, title: 'Datová platforma', amount: 580000, currency: 'CZK' }

  test('stejná zakázka = stejný klíč (velikost písmen, právní forma, diakritika, mezery)', async () => {
    const a = await importRowKey(base)
    expect(a).toMatch(/^row:[0-9a-f]{64}$/)
    expect(await importRowKey({ ...base, clientName: '  acme  ', title: 'datová  PLATFORMA' })).toBe(a)
  })

  test('jiná cena, měna, název nebo IČO = jiný klíč; IČO má přednost před názvem', async () => {
    const a = await importRowKey(base)
    expect(await importRowKey({ ...base, amount: 580001 })).not.toBe(a)
    expect(await importRowKey({ ...base, currency: 'EUR' })).not.toBe(a)
    expect(await importRowKey({ ...base, title: 'Jiná' })).not.toBe(a)
    const withIco = await importRowKey({ ...base, ico: '27082440' })
    expect(withIco).not.toBe(a)
    expect(await importRowKey({ ...base, clientName: 'Úplně jiný zápis', ico: '27082440' })).toBe(withIco)
    expect(importRowKeyText({ ...base, amount: null })).toContain('|0.00|')
  })

  test('klíč PDF je otisk obsahu, ne názvu', async () => {
    const a = await importPdfKey(new TextEncoder().encode('%PDF-1.4 abc'))
    expect(a).toMatch(/^pdf:[0-9a-f]{64}$/)
    expect(await importPdfKey(new TextEncoder().encode('%PDF-1.4 abc'))).toBe(a)
    expect(await importPdfKey(new TextEncoder().encode('%PDF-1.4 abd'))).not.toBe(a)
  })
})

describe('párování klientů', () => {
  const index = {
    accounts: [
      { id: 1, name: 'Spolchemie a.s.', ico: '00011258' },
      { id: 2, name: 'Sigmaform s.r.o.', ico: null },
      { id: 3, name: 'Duplicita s.r.o.', ico: null },
      { id: 4, name: 'Duplicita spol. s r.o.', ico: null },
      { id: 5, name: 'Firma Alfa', ico: '27082440' },
      { id: 6, name: 'Mateřská Beta', ico: null },
    ],
    aliases: [
      { account_id: 6, alias_name: 'Beta Dcera s.r.o.' },
      { account_id: 2, alias_name: 'Sigmaform' },
      { account_id: 3, alias_name: null },
    ],
  }

  test('IČO má přednost a shoda je přesná', () => {
    expect(matchClient({ name: 'Úplně jiný název', ico: '27082440' }, index)).toEqual({ kind: 'matched', accountId: 5, name: 'Firma Alfa', by: 'ico' })
    expect(matchClient({ name: 'X', ico: '00011258' }, index)).toMatchObject({ accountId: 1, by: 'ico' })
  })

  test('název bez právní formy, diakritiky a velikosti písmen', () => {
    expect(matchClient({ name: 'SPOLCHEMIE', ico: null }, index)).toMatchObject({ kind: 'matched', accountId: 1, by: 'name' })
    expect(matchClient({ name: 'sigmaform s.r.o', ico: null }, index)).toMatchObject({ kind: 'matched', accountId: 2, by: 'name' })
  })

  test('alias', () => {
    expect(matchClient({ name: 'Beta Dcera', ico: null }, index)).toEqual({ kind: 'matched', accountId: 6, name: 'Mateřská Beta', by: 'alias' })
  })

  test('víc kandidátů = nejistota, rozhodne člověk', () => {
    expect(matchClient({ name: 'Duplicita', ico: null }, index)).toEqual({
      kind: 'ambiguous', reason: 'name', candidates: [{ id: 3, name: 'Duplicita s.r.o.' }, { id: 4, name: 'Duplicita spol. s r.o.' }],
    })
  })

  test('stejný název, ale jiné IČO = dvě různé firmy, rozhodne člověk', () => {
    expect(matchClient({ name: 'Spolchemie', ico: '27082440' }, { ...index, accounts: index.accounts.filter((a) => a.id !== 5) }))
      .toEqual({ kind: 'ambiguous', reason: 'ico_conflict', candidates: [{ id: 1, name: 'Spolchemie a.s.' }] })
  })

  test('neznámý klient = none; nový klient se nezakládá sám', () => {
    expect(matchClient({ name: 'Nikdo Nový', ico: null }, index)).toEqual({ kind: 'none' })
    expect(matchClient({ name: 's.r.o.', ico: null }, index)).toEqual({ kind: 'none' })
    expect(matchClient({ name: 'Nikdo', ico: '12345679' }, index)).toEqual({ kind: 'none' })
  })

  test('obchod stejného jména u téhož klienta', () => {
    const deals = [{ id: 10, account_id: 1, title: 'Datová Platforma' }, { id: 11, account_id: 2, title: 'Datová platforma' }]
    expect(findSameTitleDeal(deals, 1, 'datová platforma')).toEqual(deals[0])
    expect(findSameTitleDeal(deals, 3, 'datová platforma')).toBeNull()
    expect(findSameTitleDeal(deals, 1, '')).toBeNull()
  })
})

describe('vstup potvrzení (applyRowSchema)', () => {
  const valid = {
    batch_id: 7, source: 'csv', account: { mode: 'existing', id: 5 }, key_name: 'ACME', title: 'Web', amount: '580 000', currency: 'CZK',
    stage: 'won', started_on: '2026-03-01', due_on: '2026-12-31', owner_id: ME, invoiced: '300000', received: 100000,
  }

  test('platný vstup projde a částky se normalizují', () => {
    const r = applyRowSchema.safeParse(valid)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toMatchObject({ amount: 580000, invoiced: 300000, received: 100000, started_on: '2026-03-01' })
  })

  test.each([
    ['prázdný název', { title: '  ' }, 'title'],
    ['nula u vyhráno', { amount: 0 }, 'amount'],
    ['bez ceny u nabídky', { stage: 'sent', amount: null }, 'amount'],
    ['záporná cena', { amount: -1 }, 'amount'],
    ['fakturováno u nevyhrané', { stage: 'draft', amount: 0, invoiced: 5 }, 'invoiced'],
    ['přijato víc než fakturováno', { received: 400000 }, 'received'],
    ['termín před začátkem', { due_on: '2026-01-01' }, 'due_on'],
    ['nesmyslné datum', { started_on: '2026-02-30' }, 'started_on'],
    ['neznámá měna', { currency: 'USD' }, 'currency'],
    ['neznámý stav', { stage: 'prohráno' }, 'stage'],
    ['PDF bez návrhu', { source: 'pdf' }, 'proposal_id'],
    ['nový klient bez názvu', { account: { mode: 'new', name: ' ' } }, 'account'],
    ['nový klient se špatným IČO', { account: { mode: 'new', name: 'Nová', ico: '12345678' } }, 'account'],
    ['neplatný vlastník', { owner_id: 'nikdo' }, 'owner_id'],
  ])('odmítne: %s', (_name, over, field) => {
    const r = applyRowSchema.safeParse({ ...valid, ...over })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some((i) => String(i.path[0]) === field)).toBe(true)
  })

  test('rozjednáno bez ceny je v pořádku', () => {
    expect(applyRowSchema.safeParse({ ...valid, stage: 'draft', amount: null, invoiced: null, received: null }).success).toBe(true)
  })

  test('nový klient s platným IČO a výběr existujícího', () => {
    expect(applyRowSchema.safeParse({ ...valid, account: { mode: 'new', name: 'Nová firma', ico: '27082440' } }).success).toBe(true)
    expect(applyRowSchema.safeParse({ ...valid, account: { mode: 'existing', id: 0 } }).success).toBe(false)
  })
})

describe('chyby databáze', () => {
  test('SQLSTATE IM001–IM011 mají českou větu, jiné null', () => {
    for (let i = 1; i <= 11; i++) {
      const code = `IM${String(i).padStart(3, '0')}`
      expect(importDbMessage({ code, message: 'x' }), code).toEqual(expect.any(String))
    }
    expect(importDbMessage({ code: '23505', message: 'dup' })).toBeNull()
    expect(importDbMessage(null)).toBeNull()
  })

  test('nenasazená migrace: chybějící funkce nebo tabulka', () => {
    expect(isImportMissing({ code: '42883' })).toBe(true)
    expect(isImportMissing({ code: 'PGRST202' })).toBe(true)
    expect(isImportMissing({ code: '42P01' })).toBe(true)
    expect(isImportMissing({ code: 'PGRST205' })).toBe(true)
    expect(isImportMissing({ code: '23505' })).toBe(false)
    expect(importDbMessage({ code: 'PGRST202' })).toBe('Hromadný import se připravuje. Zatím nic nezapisuje.')
    expect(importDbMessage({ code: 'PGRST202' })).not.toMatch(/migrac|0098/)
  })

  test('výsledek vrácení se čte defenzivně a shrne jednou větou', () => {
    expect(parseRevertResult(null)).toBeNull()
    expect(parseRevertResult({ deals_reverted: 'x' })).toBeNull()
    const r = parseRevertResult({
      deals_reverted: 2, deals_kept: [{ deal_id: 5, reason: 'linked_work' }, { nope: 1 }], accounts_deleted: 1, accounts_kept: 0, records_deleted: 4, status: 'partial',
    })
    expect(r).toEqual({ deals_reverted: 2, deals_kept: [{ deal_id: 5, reason: 'linked_work' }], accounts_deleted: 1, accounts_kept: 0, records_deleted: 4, status: 'partial' })
    expect(describeRevert(r!)).toBe('Vráceno zakázek: 2. Ponecháno 1, protože se na nich už pracovalo. Smazaní klienti založení importem: 1.')
  })
})

describe('řádek kontrolní fronty', () => {
  const csvRow = (over: Partial<Parameters<typeof rowFromCsv>[0]> = {}): ReviewRow => {
    const parsed = parseImportCsv(`${HEADER}\nACME s.r.o.;;Web;1000;CZK;vyhráno a běží;1. 3. 2026;;;300;100`, MEMBERS)
    if (!parsed.ok) throw new Error(parsed.error)
    return rowFromCsv({ row: parsed.rows[0], match: { kind: 'matched', accountId: 5, name: 'ACME', by: 'name' }, alreadyImported: false, sameTitleDeal: null, ...over })
  }

  test('jistá shoda se předvybere, nejistá a žádná ne (nový klient jen po potvrzení)', () => {
    expect(csvRow().choice).toEqual({ mode: 'existing', id: 5, name: 'ACME' })
    expect(csvRow({ match: { kind: 'none' } }).choice).toEqual({ mode: 'unset' })
    expect(csvRow({ match: { kind: 'ambiguous', reason: 'name', candidates: [] } }).choice).toEqual({ mode: 'unset' })
  })

  test('důvody, proč řádek nejde potvrdit', () => {
    expect(blockers(csvRow())).toEqual([])
    expect(blockers(csvRow({ match: { kind: 'none' } }))).toEqual(['Vyber klienta, nebo potvrď založení nového.'])
    expect(blockers(csvRow({ alreadyImported: true }))).toEqual(['Tahle zakázka už je importovaná.'])
    expect(blockers({ ...csvRow(), amount: '' })).toContain('U této fáze musí být cena větší než nula.')
    expect(blockers({ ...csvRow(), amount: 'abc' })).toContain('Cena není číslo.')
    expect(blockers({ ...csvRow(), choice: { mode: 'new' }, newName: ' ' })).toContain('Doplň název nového klienta.')
    expect(blockers({ ...csvRow(), errors: ['chybí klient'] })).toContain('chybí klient')
    // chyba z načtení tabulky, kterou člověk v řádku opravil, řádek nezamyká
    expect(blockers({ ...csvRow(), errors: ['u této zakázky chybí cena'], amount: '1970000', stage: 'sent' })).toEqual([])
    expect(blockers({ ...csvRow(), errors: ['u této zakázky chybí cena'], amount: '', stage: 'sent' })).toEqual(['U této fáze musí být cena větší než nula.'])
    expect(blockers({ ...csvRow(), errors: ['u této zakázky chybí cena'], amount: '', stage: 'draft' })).toEqual([])
    expect(blockers({ ...csvRow(), startedOn: '2027-02-01', dueOn: '2027-01-01' })).toEqual(['Termín je dřív než začátek.'])
    const same = csvRow({ sameTitleDeal: { id: 9, title: 'Web' } })
    expect(blockers(same)[0]).toContain('už je zakázka se stejným názvem')
    expect(blockers({ ...same, allowSameTitle: true })).toEqual([])
  })

  test('nový klient se potvrdí výslovně (mode new + název)', () => {
    const r = { ...csvRow({ match: { kind: 'none' } }), choice: { mode: 'new' } as const }
    expect(blockers(r)).toEqual([])
    expect(toApplyInput(r, 3).account).toEqual({ mode: 'new', name: 'ACME s.r.o.', ico: null })
  })

  test('vstup potvrzení nese klíč zdroje, ne vybraného klienta, a fakturaci jen u vyhráno', () => {
    const r = csvRow()
    const input = toApplyInput({ ...r, choice: { mode: 'existing', id: 99, name: 'Jiný' } }, 3)
    expect(input).toMatchObject({
      batch_id: 3, source: 'csv', key_name: 'ACME s.r.o.', account: { mode: 'existing', id: 99 }, amount: '1000', stage: 'won',
      invoiced: '300', received: '100', started_on: '2026-03-01', due_on: null, owner_id: null, revenue_line: 'catering_firemni',
    })
    expect(applyRowSchema.safeParse(input).success).toBe(true)
    expect(toApplyInput({ ...r, stage: 'sent' }, 3)).toMatchObject({ invoiced: null, received: null })
  })

  test('řádek z PDF: návrh AI, varování z pokynů blokuje jen „Potvrdit vše“', () => {
    const row = rowFromProposal({
      proposalId: '3f0c2c3e-6a1c-4c53-8d6f-1f1f1f1f1f1f', fileName: 'nabidka.pdf',
      fields: { account_name: 'Sigmaform', title: 'AI audit', amount_one_time: 45000, currency: 'CZK', revenue_line: 'oslava_soukroma' },
      warnings: [], flags: ['ignore_instructions'], match: { kind: 'matched', accountId: 2, name: 'Sigmaform s.r.o.', by: 'name' },
      suggestedStage: 'sent', sameTitleDeal: null,
    })
    expect(row).toMatchObject({ source: 'pdf', label: 'nabidka.pdf', stage: 'sent', amount: '45000', proposalId: '3f0c2c3e-6a1c-4c53-8d6f-1f1f1f1f1f1f' })
    expect(blockers(row)).toEqual([])
    expect(isConfirmable(row)).toBe(true)
    expect(isBulkConfirmable(row)).toBe(false)
    expect(isBulkConfirmable({ ...row, flags: [] })).toBe(true)
  })

  test('součty fronty', () => {
    const a = csvRow()
    const rows: ReviewRow[] = [
      a, { ...a, id: 'b', state: 'done' }, { ...a, id: 'c', state: 'rejected' }, { ...a, id: 'd', state: 'error' },
      { ...a, id: 'e', choice: { mode: 'unset' } }, { ...a, id: 'f', flags: ['model_reported'] },
    ]
    expect(tally(rows)).toEqual({ pending: 3, ready: 1, done: 1, rejected: 1, error: 1, blocked: 2 })
  })
})

describe('úklid nepotvrzených návrhů', () => {
  const NOW = new Date('2026-09-30T12:00:00Z')
  const OLD = '2026-09-01T00:00:00Z'
  const NEW_ = '2026-09-29T00:00:00Z'
  const A = '3f0c2c3e-6a1c-4c53-8d6f-1f1f1f1f1f1f'
  const B = '4f0c2c3e-6a1c-4c53-8d6f-1f1f1f1f1f1f'
  const C = '5f0c2c3e-6a1c-4c53-8d6f-1f1f1f1f1f1f'

  function db(referenced: string[], listError = false) {
    const removed: string[][] = []
    const client = {
      from: () => ({ select: () => ({ in: async () => ({ data: referenced.map((p) => ({ source_pdf_path: p })), error: null }) }) }),
      storage: {
        from: () => ({
          list: vi.fn(async () => (listError
            ? { data: null, error: { message: 'boom' } }
            : { data: [
              { name: `${A}.pdf`, created_at: OLD }, { name: `${A}.navrh.json`, created_at: OLD },
              { name: `${B}.pdf`, created_at: OLD }, { name: `${B}.navrh.json`, created_at: OLD },
              { name: `${C}.pdf`, created_at: NEW_ }, { name: 'cizi-soubor.txt', created_at: OLD },
            ], error: null })),
          remove: vi.fn(async (paths: string[]) => { removed.push(paths); return { error: null } }),
        }),
      },
    }
    return { client: client as unknown as PurgeDb, removed }
  }

  test('smaže staré nepotvrzené návrhy, potvrzené (odkazuje na ně obchod), čerstvé a cizí soubory ne', async () => {
    const { client, removed } = db([`offers/${B}.pdf`])
    expect(await purgeStaleOfferProposals(client, NOW)).toBe(2)
    expect(removed).toEqual([[`offers/${A}.pdf`, `offers/${A}.navrh.json`]])
  })

  test('chyba výpisu úložiště nic nesmaže a nevyhodí', async () => {
    const { client, removed } = db([], true)
    expect(await purgeStaleOfferProposals(client, NOW)).toBe(0)
    expect(removed).toEqual([])
  })
})
