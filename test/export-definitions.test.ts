import { describe, expect, test } from 'vitest'
import {
  CONTACT_COLUMNS, EXPORT_ACCESS, EXPORT_PREHLEDY, PIPELINE_COLUMNS, clientColumns, clientFilters, clientRows, contactRows,
  dealOutcomeReason, dealSourceLabel, exportAuditPayload, isExportPrehled, lostReasonText, pipelineFilters, pipelineTable,
  shopOrderItemsText, taskColumns,
} from '@/domain/crm/exports'
import { filterPipelineDeals, parsePipelineParams, pipelineStages } from '@/domain/crm/pipelineFilter'
import { buildWeeklyLeadershipReport, weeklyLeadershipDocument } from '@/domain/crm/weeklyLeadershipReport'
import { weekWindow } from '@/domain/crm/changes'
import { deriveStatusSets, parseAccountListParams } from '@/domain/crm/accountList'
import { OPEN_DEAL_STAGES } from '@/domain/crm/sales'
import { exportHref } from '@/lib/export/href'
import { toExportTable } from '@/lib/export/table'
import type { Task } from '@/lib/types'
import { OWNER_JANA, OWNER_PETR, SAMPLE_DEALS, SAMPLE_OFFERS, account, contact, deal } from './helpers/exportFixture'

// domain/crm/exports.ts, pipelineFilter.ts a weeklyLeadershipReport.ts:
// sloupce přehledů, stejné filtry jako stránka, audit bez obsahu a týdenní
// přehled pro vedení.

const members = new Map([[OWNER_JANA.id, OWNER_JANA.full_name], [OWNER_PETR.id, OWNER_PETR.full_name]])

describe('přehledy a oprávnění', () => {
  test('obchodní přehledy jen pro obchodní role', () => {
    expect(EXPORT_PREHLEDY.filter((p) => EXPORT_ACCESS[p] === 'sales')).toEqual(['pipeline', 'aktivity', 'nabidky', 'tydenni-prehled'])
    expect(isExportPrehled('pipeline')).toBe(true)
    expect(isExportPrehled('../etc')).toBe(false)
  })

  test('odkaz na export nese filtry stránky, ne stránkování', () => {
    expect(exportHref('pipeline', 'pdf', { q: 'Šťastná', owner: 'all', page: 3, state: null }))
      .toBe('/cockpit/export/pipeline?format=pdf&q=%C5%A0%C5%A5astn%C3%A1&owner=all')
  })
})

describe('obchody (pipeline)', () => {
  test('sloupce podle zadání', () => {
    expect(PIPELINE_COLUMNS.map((c) => c.header)).toEqual([
      'Obchod', 'Klient', 'Segment', 'Typ akce', 'Fáze', 'Hodnota', 'Vlastník', 'Další krok', 'Datum follow-upu',
      'Poslední aktivita', 'Zdroj', 'Důvod výhry / prohry',
    ])
  })

  test('filtry stejné jako na tabuli', () => {
    const open = filterPipelineDeals(SAMPLE_DEALS, parsePipelineParams({}))
    expect(open.map((d) => d.id)).toEqual([1, 2, 3])
    expect(open.every((d) => OPEN_DEAL_STAGES.includes(d.stage))).toBe(true)
    expect(filterPipelineDeals(SAMPLE_DEALS, parsePipelineParams({ state: 'prohráno' })).map((d) => d.id)).toEqual([5, 6])
    expect(filterPipelineDeals(SAMPLE_DEALS, parsePipelineParams({ state: 'all', owner: OWNER_PETR.id })).map((d) => d.id)).toEqual([2])
    expect(filterPipelineDeals(SAMPLE_DEALS, parsePipelineParams({ state: 'all', kind: 'none' })).map((d) => d.id)).toEqual([5])
    expect(filterPipelineDeals(SAMPLE_DEALS, parsePipelineParams({ q: '  ŠŤASTNÁ ' })).map((d) => d.id)).toEqual([1])
    // Neznámý stav = výchozí „otevřené" (stejně jako stránka).
    expect(parsePipelineParams({ state: 'cokoli' }).state).toBe('open')
    expect(pipelineStages('all')).toHaveLength(7)
  })

  test('řádek obchodu: segment, typ, fáze, zdroj a důvod prohry česky', () => {
    const t = pipelineTable(SAMPLE_DEALS)
    const row = (id: number) => t.rows[SAMPLE_DEALS.findIndex((d) => d.id === id)]
    expect(row(1).slice(0, 8)).toEqual([
      'Vánoční večírek — 120 hostů', 'Účetní kancelář Šťastná s.r.o.', 'Firemní akce', 'Jednorázová akce', 'Poptávka', 186000,
      'Jana Dvořáková', 'Poslat návrh menu a ověřit bezlepkové porce',
    ])
    expect(row(2)[10]).toBe('Nabídka v PDF')
    expect(row(5)[10]).toBe('Doporučení partnera')
    expect(row(5)[11]).toBe('Cena') // klíč z číselníku → popisek
    expect(row(6)[11]).toBe('Jiný termín, ozvou se na jaře') // volný text beze změny
    expect(row(3)[11]).toBe('') // otevřený obchod důvod nemá
    expect(dealSourceLabel({ ...SAMPLE_DEALS[0], import_batch_id: 4 })).toBe('Hromadný import')
    expect(dealSourceLabel(SAMPLE_DEALS[0])).toBe('Ručně v Cockpitu')
    expect(dealOutcomeReason(deal({ id: 9, stage: 'odloženo', lost_reason: 'termin' }))).toBe('Termín')
    expect(lostReasonText(null)).toBe('')
  })

  test('popis filtrů do hlavičky souboru', () => {
    expect(pipelineFilters(parsePipelineParams({ owner: OWNER_PETR.id, kind: 'none', q: 'Nováková' }), members)).toEqual([
      { label: 'Stav', value: 'otevřené' },
      { label: 'Obchodník', value: 'Petr Šťastný' },
      { label: 'Typ', value: 'nedoplněný typ' },
      { label: 'Hledání', value: '„Nováková"' },
    ])
    expect(pipelineFilters(parsePipelineParams({ state: 'vyhráno' }), members)).toEqual([{ label: 'Stav', value: 'Vyhráno' }])
  })
})

describe('audit exportu', () => {
  test('jen přehled, formát, počet řádků a NÁZVY filtrů — žádné hodnoty ani obsah', () => {
    const doc = { tables: [pipelineTable(SAMPLE_DEALS)], filters: pipelineFilters(parsePipelineParams({ q: 'Nováková', owner: OWNER_PETR.id }), members) }
    const payload = exportAuditPayload('pipeline', 'xlsx', doc)
    expect(payload).toEqual({ prehled: 'pipeline', format: 'xlsx', rows: 7, filters: ['Stav', 'Obchodník', 'Hledání'] })
    const text = JSON.stringify(payload)
    for (const secret of ['Nováková', 'Petr', 'Šťastná', '186000']) expect(text).not.toContain(secret)
  })
})

describe('klienti a kontakty', () => {
  const accounts = [
    account({ id: 10, name: 'Účetní kancelář Šťastná s.r.o.', ico: '12345678' }),
    account({ id: 40, name: 'Říčany Logistika s.r.o.', client_since: '2025-03-01' }),
    account({ id: 99, name: 'Zelená zahrada', owner: null, owner_id: null }),
  ]

  test('stav, otevřené obchody a nejbližší krok jako na stránce', () => {
    const rows = clientRows(accounts, SAMPLE_DEALS, deriveStatusSets(SAMPLE_DEALS))
    expect(rows.map((r) => [r.name, r.status, r.openDeals, r.openAmount, r.nextStepDue])).toEqual([
      ['Účetní kancelář Šťastná s.r.o.', 'Aktivní', 1, 186000, '2026-11-10'],
      ['Říčany Logistika s.r.o.', 'Klient', 0, 0, null],
      ['Zelená zahrada', 'Prospekt', 0, 0, null],
    ])
  })

  test('ne-obchodní role nedostane sloupce s obchody a částkami', () => {
    const sales = clientColumns(true).map((c) => c.header)
    const team = clientColumns(false).map((c) => c.header)
    expect(sales).toContain('Hodnota otevřených')
    expect(team).not.toContain('Hodnota otevřených')
    expect(team).not.toContain('Další krok')
    expect(team).toEqual(['Firma', 'IČO', 'Stav', 'Obor', 'Region', 'Vlastník', 'Klientem od', 'Poslední kontakt', 'Doporučil'])
  })

  test('kontakty jen u exportovaných firem, řazené podle firmy a jména', () => {
    const contacts = [
      contact({ id: 1, full_name: 'Zdeněk Říha', account_id: 40, email: 'zdenek@ricany.cz', is_champion: true }),
      contact({ id: 2, full_name: 'Alena Šťastná', account_id: 10, phone: '+420 777 111 222' }),
      contact({ id: 3, full_name: 'Cizí kontakt', account_id: 555 }),
      contact({ id: 4, full_name: 'Partner bez firmy', partner_id: 3 }),
    ]
    const rows = contactRows(contacts, accounts)
    expect(rows.map((c) => [c.full_name, c.accountName])).toEqual([
      ['Zdeněk Říha', 'Říčany Logistika s.r.o.'],
      ['Alena Šťastná', 'Účetní kancelář Šťastná s.r.o.'],
    ])
    const t = toExportTable('Kontakty', CONTACT_COLUMNS, rows)
    expect(t.rows[0]).toEqual(['Zdeněk Říha', 'Říčany Logistika s.r.o.', null, 'zdenek@ricany.cz', null, true, false, '2026-09-01T08:00:00Z'])
  })

  test('filtry seznamu klientů česky', () => {
    const p = parseAccountListParams({ stav: 'klient', q: 'kancelář', vlastnik: '-', bez_ico: '1', sort: 'aktivita' }, { canSeeSales: true })
    expect(clientFilters(p, members)).toEqual([
      { label: 'Stav', value: 'Klient' },
      { label: 'Hledání', value: '„kancelář"' },
      { label: 'Vlastník', value: 'bez vlastníka' },
      { label: 'IČO', value: 'jen bez IČO' },
      { label: 'Řazení', value: 'Poslední aktivita' },
    ])
  })
})

describe('úkoly a objednávky', () => {
  test('úkoly: obchod jen obchodním rolím, řešitel jménem', () => {
    const task = {
      id: 1, title: 'Objednat květiny', description: null, status: 'in_progress', priority: 'high', assignee_id: OWNER_PETR.id,
      created_by: null, due_on: '2026-11-09', account_id: 10, deal_id: 2, engagement_id: null, ms_event_id: null,
      created_at: '2026-11-01T08:00:00Z', updated_at: '2026-11-01T08:00:00Z',
      account: { id: 10, name: 'Účetní kancelář Šťastná s.r.o.' }, deal: { id: 2, title: 'Svatební hostina Novákovi' },
    } satisfies Task
    const sales = toExportTable('Úkoly', taskColumns(members, true), [task])
    expect(sales.rows[0].slice(0, 7)).toEqual(['Objednat květiny', 'Dělá se', 'Vysoká', 'Petr Šťastný', '2026-11-09', 'Účetní kancelář Šťastná s.r.o.', 'Svatební hostina Novákovi'])
    expect(taskColumns(members, false).map((c) => c.header)).not.toContain('Obchod')
  })

  test('položky objednávky cheesecaků jako text', () => {
    expect(shopOrderItemsText([{ label: 'Daddy vanilkový', quantity: 2 }, { product_key: 'mini_mix', quantity: 1 }])).toBe('2× Daddy vanilkový, 1× mini_mix')
    expect(shopOrderItemsText(null)).toBe('')
  })
})

describe('týdenní přehled pro vedení', () => {
  const range = weekWindow('2026-11-05', 'tento')
  const report = buildWeeklyLeadershipReport({ deals: SAMPLE_DEALS, offers: SAMPLE_OFFERS, range, generatedAt: new Date('2026-11-05T13:00:00Z') })

  test('pipeline podle fáze (jen otevřené obchody)', () => {
    expect(report.byStage.map((r) => [r.stage, r.count, r.amount])).toEqual([
      ['kvalifikace', 1, 186000], ['diagnostika', 0, 0], ['rozsah_nabidka', 1, 245500], ['rozhodovani', 1, 64000],
    ])
    expect(report.byStage[0].label).toBe('Poptávka')
  })

  test('nové leady, nabídky, výhry a prohry v týdnu (po–ne, pražský čas)', () => {
    expect(report.newLeads.map((d) => d.id)).toEqual([1, 3])
    expect(report.offers.map((o) => o.id)).toEqual([101, 102]) // 103 byla odeslaná v říjnu
    expect(report.won.map((d) => d.id)).toEqual([4])
    expect(report.lost.map((d) => d.id)).toEqual([5]) // 6 prohraný 1. 10. do týdne nepatří
    expect(report.summary.find((s) => s.label === 'Úspěšnost uzavřených')?.value).toBe('50 %')
    expect(report.summary.find((s) => s.label === 'Odeslané nabídky')?.value).toBe('1 · 245 500 Kč')
  })

  test('dokument: souhrn, pipeline, leady, nabídky, vyhrané, prohrané s důvodem', () => {
    const doc = weeklyLeadershipDocument(report, 'Jana Dvořáková')
    expect(doc.title).toBe('Týdenní přehled pro vedení')
    expect(doc.tables.map((t) => t.title)).toEqual(['Souhrn', 'Pipeline podle fáze', 'Nové leady', 'Nabídky', 'Vyhrané', 'Prohrané'])
    const lost = doc.tables[5]
    expect(lost.columns.map((c) => c.header)).toContain('Důvod prohry')
    expect(lost.rows[0]).toContain('Cena')
    expect(range.label).toMatch(/^za týden 45: /)
    expect(doc.filters).toEqual([{ label: 'Týden', value: range.label.replace('za týden ', '') }])
    expect(doc.tables[0].note).toBe(`Z${range.label.slice(1)}`)
    expect(doc.fileBase).toBe('tydenni-prehled-tyden-45')
  })
})
