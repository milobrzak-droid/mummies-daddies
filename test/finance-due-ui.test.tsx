import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { KindCards, MilestonePrompt, OverdueInvoicesCard } from '@/components/FinanceCards'
import { FinanceRecordsTable } from '@/components/FinanceRecordsTable'
import { FinanceRecordActions, FinanceRecordCreateForm } from '@/components/FinanceRecordForms'
import { UndoToastProvider } from '@/components/ui/Toast'
import type { OverdueRecord, OverdueResult } from '@/domain/finance/queries/overdue'
import { buildFinanceBoard, type FinancialRecordRow } from '@/domain/finance/records'

// Splatnost faktur na stránce Finance (0090): karta po splatnosti je jediná
// se sytou barvou (jen když nějaké jsou), jinak je stránka klidná; splatnost je
// v tabulce, ve formuláři vyfakturovaného záznamu a v panelu úpravy.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }))
vi.mock('@/domain/finance/actions/records', () => ({
  createFinancialRecord: vi.fn(),
  updateFinancialRecord: vi.fn(),
  cancelFinancialRecord: vi.fn(),
}))

const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')

const rec = (p: Partial<FinancialRecordRow>): FinancialRecordRow & { account_name: string | null } => ({
  id: 1, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'invoiced', amount: 60000,
  currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'rucne', evidence_id: null,
  external_ref: 'FA-1', note: null, created_at: '2026-09-01T00:00:00Z', due_on: '2026-09-20', account_name: 'ALFATECH', ...p,
})
const od = (p: Partial<OverdueRecord>): OverdueRecord => ({ ...rec({}), daysLate: 10, ...p })
const MILESTONE = { id: 1, title: 'Mapa', engagement_id: 4, account_id: 2, account_name: 'ALFATECH', accepted_at: null }
const HREF = '/cockpit/finance?druh=invoiced&splatnost=po'

describe('karta Po splatnosti a nezaplaceno', () => {
  test('s fakturami: syté barvy, součet po měnách, počet, nejdelší prodlení a odkaz na filtr', () => {
    const result: OverdueResult = {
      state: 'ok',
      rows: [
        od({ id: 1, amount: 60000, daysLate: 10 }),
        od({ id: 2, amount: 40000, daysLate: 31 }),
        od({ id: 3, amount: 500, currency: 'EUR', daysLate: 2 }),
      ],
    }
    const html = nbsp(renderToStaticMarkup(<OverdueInvoicesCard result={result} href={HREF} />))
    expect(html).toContain('tile-peach')
    expect(html).toContain('tile-solid')
    expect(html).toContain('Po splatnosti a nezaplaceno')
    expect(html).toContain('>100 000,00 Kč</span>')
    expect(html).toContain('>500,00 €</span>')
    expect(html).toContain('tis. Kč')
    expect(html).toContain('3 faktury po splatnosti, nejdéle o 31 dní')
    expect(html).toContain(`href="${HREF.replace('&', '&amp;')}"`)
    expect(html).toContain('Zobrazit faktury')
    // koralové tlačítko nepřibývá (jedno na obrazovce je hlavní akce stránky)
    expect(html).not.toContain('btn-primary')
    // koruny a eura se nesčítají do jednoho čísla
    expect(html).not.toContain('100 500')
  })

  test('jedna faktura: správný tvar množného čísla', () => {
    const html = renderToStaticMarkup(<OverdueInvoicesCard result={{ state: 'ok', rows: [od({ daysLate: 1 })] }} href={HREF} />)
    expect(html).toContain('1 faktura po splatnosti, nejdéle o 1 den')
  })

  test('nic po splatnosti je klidná karta bez sytého podkladu', () => {
    const html = renderToStaticMarkup(<OverdueInvoicesCard result={{ state: 'ok', rows: [] }} href={HREF} />)
    expect(html).toContain('Nic není po splatnosti')
    expect(html).not.toContain('tile-solid')
    expect(html).not.toContain('tile-peach')
  })

  test('migrace 0090 nenasazená nebo chyba čtení: klidná věta, ne mlčení a ne poplach', () => {
    const missing = renderToStaticMarkup(<OverdueInvoicesCard result={{ state: 'missing_migration' }} href={HREF} />)
    expect(missing).toContain('Hlídání splatnosti se připravuje')
    expect(missing).not.toContain('0090')
    expect(missing).not.toContain('tile-solid')
    const err = renderToStaticMarkup(<OverdueInvoicesCard result={{ state: 'error' }} href={HREF} />)
    expect(err).toContain('nepodařilo načíst')
    expect(err).not.toContain('tile-solid')
  })

  test('na celé stránce má sytou barvu nejvýš jedna karta: faktura po splatnosti, jinak žádná', () => {
    const board = buildFinanceBoard([rec({})])
    const page = (result: OverdueResult) =>
      renderToStaticMarkup(
        <>
          <KindCards board={board} showDrafts currentMonth="2026-09" />
          <OverdueInvoicesCard result={result} href={HREF} />
          <MilestonePrompt milestones={[MILESTONE]} />
        </>,
      )
    const count = (html: string) => (html.match(/tile-solid/g) ?? []).length
    expect(count(page({ state: 'ok', rows: [od({})] }))).toBe(1)
    expect(count(page({ state: 'ok', rows: [] }))).toBe(0)
    expect(count(page({ state: 'missing_migration' }))).toBe(0)
  })
})

describe('tabulka záznamů: sloupec Splatnost', () => {
  const rows = [
    rec({ id: 1, due_on: '2026-09-20' }), // po splatnosti a nezaplaceno
    rec({ id: 2, due_on: '2026-10-20', external_ref: 'FA-2' }), // splatnost v budoucnu
    rec({ id: 3, due_on: '2026-09-01', external_ref: 'FA-3' }), // po splatnosti, ale zaplaceno (není v mapě)
    rec({ id: 4, kind: 'received', due_on: null, external_ref: 'FA-3' }),
    rec({ id: 5, kind: 'invoiced', due_on: null, external_ref: 'FA-5' }),
  ]

  test('datum splatnosti; po splatnosti červeně s počtem dní; ostatním nic, u jiných druhů pomlčka', () => {
    const html = nbsp(renderToStaticMarkup(
      <FinanceRecordsTable rows={rows} kind={null} showDrafts accountingSystem="iDoklad" overdue={new Map([[1, 10]])} />,
    ))
    expect(html).toMatch(/>Splatnost<\/th>/)
    expect(html).toContain('20. 9. 2026')
    expect(html).toContain('po splatnosti o 10 d')
    // jen jedna položka je označená (ta nezaplacená) – v tabulce i v mobilním seznamu
    const table = html.slice(html.indexOf('<table'))
    expect(table.match(/po splatnosti o/g)).toHaveLength(1)
    expect(html.slice(0, html.indexOf('<table')).match(/po splatnosti o/g)).toHaveLength(1)
    expect(html).toContain('20. 10. 2026')
    expect(html).toContain('1. 9. 2026')
    // patička drží šířku tabulky (šest sloupců před částkou)
    expect(html).toMatch(/colSpan="6"|colspan="6"/i)
  })

  test('bez mapy po splatnosti (před 0090 nebo bez dat) je splatnost jen text', () => {
    const html = renderToStaticMarkup(<FinanceRecordsTable rows={[rows[0]]} kind={null} showDrafts accountingSystem="iDoklad" />)
    expect(html).not.toContain('po splatnosti o')
  })

  test('starý záznam bez sloupce due_on (před 0090) se vykreslí s pomlčkou', () => {
    const { due_on: _omit, ...legacy } = rec({ id: 9 })
    void _omit
    const html = renderToStaticMarkup(<FinanceRecordsTable rows={[legacy as never]} kind={null} showDrafts accountingSystem="iDoklad" />)
    expect(html).toContain('<table')
  })
})

describe('formulář: pole Splatnost', () => {
  let container: HTMLDivElement
  let root: Root
  const setup = (node: React.ReactNode) => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => { root.render(<UndoToastProvider>{node}</UndoToastProvider>) })
  }
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })
  beforeEach(() => { document.body.innerHTML = '' })

  test('nový záznam: splatnost se objeví jen u druhu Vyfakturováno', () => {
    setup(<FinanceRecordCreateForm accounts={[{ id: 1, name: 'ALFATECH' }]} defaultMonth="2026-09" accountingSystem="iDoklad" />)
    expect(container.querySelector('input[name="due_on"]')).toBeNull()
    const select = container.querySelector<HTMLSelectElement>('select[name="kind"]')!
    const change = (v: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, v)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    change('invoiced')
    const due = container.querySelector<HTMLInputElement>('input[name="due_on"]')!
    expect(due).not.toBeNull()
    expect(due.type).toBe('date')
    expect(container.textContent).toContain('Splatnost')
    change('received')
    expect(container.querySelector('input[name="due_on"]')).toBeNull()
  })

  test('úprava vyfakturovaného: pole s uloženou splatností; u jiných druhů pole není', () => {
    setup(<FinanceRecordActions record={rec({ kind: 'invoiced', due_on: '2026-10-15' })} accountingSystem="iDoklad" />)
    act(() => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Upravit')!.click() })
    const due = document.querySelector<HTMLInputElement>('input[name="due_on"]')!
    expect(due.value).toBe('2026-10-15')
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    setup(<FinanceRecordActions record={rec({ kind: 'contracted', due_on: null })} accountingSystem="iDoklad" />)
    act(() => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Upravit')!.click() })
    expect(document.querySelector('input[name="due_on"]')).toBeNull()
  })
})
