// Hromadný import zakázek: obrazovka (components/BulkImport.tsx,
// ImportReviewTable.tsx, ImportBatchHistory.tsx). Akce serveru jsou falešné.
// Hlídá: PDF část se bez klíče skryje s vysvětlením a tabulka funguje, řádek bez
// jistého klienta nejde potvrdit a nový klient jen výslovně, „Potvrdit vše“
// zapíše jen připravené řádky, po zápisu je „Zpět“ a vrácení je dvoustupňové.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { BulkImport } from '@/components/BulkImport'
import { ImportBatchHistory } from '@/components/ImportBatchHistory'
import { ImportReviewTable } from '@/components/ImportReviewTable'
import { UndoToastProvider } from '@/components/ui/Toast'
import * as actions from '@/domain/crm/actions/bulkImport'
import { rowFromCsv, type ReviewRow } from '@/domain/crm/bulkImportReview'
import { parseImportCsv } from '@/domain/crm/bulkImport'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }), usePathname: () => '/' }))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn(async () => ({ ok: true, options: [{ id: 8, name: 'Vybraná firma' }] })) }))
vi.mock('@/domain/crm/actions/bulkImport', () => ({
  openImportBatch: vi.fn(async () => ({ ok: true, batchId: 7 })),
  previewCsvImport: vi.fn(),
  proposePdfImport: vi.fn(),
  rejectPdfProposal: vi.fn(async () => ({ ok: true })),
  confirmImportRow: vi.fn(),
  revertImportBatch: vi.fn(),
}))

const ME = '11111111-1111-4111-8111-111111111111'
const MEMBERS = [{ id: ME, email: 'viktor@mummiesdaddies.com', name: 'Viktor' }]
const HEADER = 'klient;název zakázky;cena;stav'

function csvRows(lines: string[]) {
  const r = parseImportCsv([HEADER, ...lines].join('\n'), MEMBERS)
  if (!r.ok) throw new Error(r.error)
  return r.rows
}
const matched = { kind: 'matched', accountId: 5, name: 'Sigmaform s.r.o.', by: 'name' } as const

function review(lines: string[], matches: (typeof matched | { kind: 'none' } | { kind: 'ambiguous'; reason: 'name'; candidates: { id: number; name: string }[] })[]): ReviewRow[] {
  return csvRows(lines).map((row, i) => rowFromCsv({ row, match: matches[i] ?? { kind: 'none' }, alreadyImported: false, sameTitleDeal: null }))
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const button = (label: RegExp | string) =>
  [...host.querySelectorAll('button')].find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''))) as HTMLButtonElement | undefined

describe('kontrolní tabulka (statické vykreslení)', () => {
  const noop = () => {}
  const html = (rows: ReviewRow[]) => renderToStaticMarkup(
    <ImportReviewTable rows={rows} members={MEMBERS} meId={ME} busy={false} onPatch={noop} onConfirm={noop} onReject={noop} />,
  )

  test('jistá shoda: klient předvyplněný a Potvrdit dostupné; nejistá a žádná: Potvrdit zamčené a řeknou proč', () => {
    const rows = review(
      ['Sigmaform;Web;1000;vyhráno a běží', 'Neznámá;Audit;500;nabídka odeslána', 'Duplicita;Projekt;700;rozjednáno'],
      [matched, { kind: 'none' }, { kind: 'ambiguous', reason: 'name', candidates: [{ id: 1, name: 'Duplicita a.s.' }, { id: 2, name: 'Duplicita s.r.o.' }] }],
    )
    const out = html(rows)
    expect(out).toContain('Sigmaform s.r.o.')
    expect(out).toContain('Spárováno podle názvu.')
    expect(out).toContain('V Cockpitu takový klient není. Nový klient se založí jen po tvém potvrzení.')
    expect(out).toContain('Vybrat: Duplicita a.s.')
    expect(out).toContain('Vybrat: Duplicita s.r.o.')
    expect(out).toContain('Založit nového klienta')
    expect(out).toContain('Vyber klienta, nebo potvrď založení nového.')
    // Potvrdit je zamčené u dvou řádků bez klienta, u jistě spárovaného ne
    const confirms = [...out.matchAll(/<button[^>]*aria-label="Potvrdit zakázku ([^"]+)"[^>]*>/g)]
    expect(confirms.map((m) => [m[1], /disabled=""/.test(m[0])])).toEqual([['Web', false], ['Audit', true], ['Projekt', true]])
  })

  test('řádek bez ceny u vyhrané zakázky ukáže, co zbývá, a nejde potvrdit', () => {
    const rows = review(['Sigmaform;Web;;vyhráno a běží'], [matched])
    const out = html(rows)
    expect(out).toContain('Zbývá:')
    expect(out).toContain('U této fáze musí být cena větší než nula.')
    expect(/aria-label="Potvrdit zakázku Web"[^>]*disabled=""|disabled=""[^>]*aria-label="Potvrdit zakázku Web"/.test(out)).toBe(true)
  })

  test('zápis, zamítnutí: hotové řádky jsou stručné a u zapsaného je odkaz na klienta', () => {
    const [a, b] = review(['Sigmaform;Web;1000;rozjednáno', 'Sigmaform;Audit;5;rozjednáno'], [matched, matched])
    const out = html([
      { ...a, state: 'done', result: { dealId: 9, accountId: 5 }, message: 'Založen nový klient.' },
      { ...b, state: 'rejected', message: 'PDF i návrh jsou smazané.' },
    ])
    expect(out).toContain('Zapsáno:')
    expect(out).toContain('/cockpit/clients/5?view=business')
    expect(out).toContain('Zamítnuto: Audit')
    expect(out).toContain('PDF i návrh jsou smazané.')
  })
})

describe('BulkImport: zdroje', () => {
  test('bez klíče Anthropic je PDF část skrytá s vysvětlením a tabulka funguje', async () => {
    await act(async () => root.render(<UndoToastProvider><BulkImport pdfEnabled={false} members={MEMBERS} meId={ME} /></UndoToastProvider>))
    expect(host.textContent).toContain('Stáhnout šablonu CSV')
    expect(host.querySelector('a[href="/cockpit/import/zakazky/sablona"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Čtení PDF není zapnuté')
    await act(async () => { button('Více PDF nabídek')!.click() })
    expect(host.textContent).toContain('Čtení PDF není zapnuté')
    // Technický název klíče vidí jen správce; ostatní dostanou lidskou větu.
    expect(host.textContent).not.toContain('ANTHROPIC_API_KEY')
    expect(host.textContent).toContain('Zapnout ho může správce týmu')
    expect(host.querySelector('input[type=file][accept="application/pdf"]')).toBeNull()
    await act(async () => { button('Tabulka (CSV)')!.click() })
    expect(host.querySelector('input[type=file][accept*=csv]')).not.toBeNull()
  })

  test('správce vidí i technický důvod (chybějící klíč)', async () => {
    await act(async () => root.render(<UndoToastProvider><BulkImport pdfEnabled={false} members={MEMBERS} meId={ME} isAdmin /></UndoToastProvider>))
    await act(async () => { button('Více PDF nabídek')!.click() })
    expect(host.textContent).toContain('ANTHROPIC_API_KEY')
  })

  test('přepínač zdroje je jen aria-pressed (ne aria-current — není to odkaz)', async () => {
    await act(async () => root.render(<UndoToastProvider><BulkImport pdfEnabled={false} members={MEMBERS} meId={ME} /></UndoToastProvider>))
    const csv = button('Tabulka (CSV)')!
    const pdf = button('Více PDF nabídek')!
    expect(csv.getAttribute('aria-pressed')).toBe('true')
    expect(pdf.getAttribute('aria-pressed')).toBe('false')
    expect(csv.hasAttribute('aria-current')).toBe(false)
    await act(async () => { pdf.click() })
    expect(pdf.getAttribute('aria-pressed')).toBe('true')
    expect(pdf.hasAttribute('aria-current')).toBe(false)
  })

  test('s klíčem je vidět dropzóna PDF s limity', async () => {
    await act(async () => root.render(<UndoToastProvider><BulkImport pdfEnabled members={MEMBERS} meId={ME} /></UndoToastProvider>))
    await act(async () => { button('Více PDF nabídek')!.click() })
    expect(host.textContent).toContain('až 30')
    expect(host.textContent).toContain('4 MB')
    expect(host.querySelector('input[type=file][accept="application/pdf"]')).not.toBeNull()
  })

  test('tabulka: kontrola → Potvrdit vše zapíše jen připravené řádky, vznikne dávka a nabídne se Zpět', async () => {
    const rows = csvRows(['Sigmaform;Web;1000;vyhráno a běží', 'Neznámá;Audit;500;nabídka odeslána'])
    vi.mocked(actions.previewCsvImport).mockResolvedValueOnce({
      ok: true, ignoredColumns: [], members: MEMBERS, meId: ME,
      rows: [
        { row: rows[0], key: 'row:a', match: matched, alreadyImported: false, sameTitleDeal: null },
        { row: rows[1], key: 'row:b', match: { kind: 'none' }, alreadyImported: false, sameTitleDeal: null },
      ],
    })
    vi.mocked(actions.confirmImportRow).mockResolvedValue({
      ok: true, dealId: 9, accountId: 5, accountCreated: false, engagementId: 4, records: 1, duplicate: false, warnings: [],
    })
    vi.mocked(actions.revertImportBatch).mockResolvedValue({
      ok: true, message: 'Vráceno zakázek: 1.',
      result: { deals_reverted: 1, deals_kept: [], accounts_deleted: 0, accounts_kept: 0, records_deleted: 2, status: 'reverted' },
    })
    await act(async () => root.render(<UndoToastProvider><BulkImport pdfEnabled={false} members={MEMBERS} meId={ME} /></UndoToastProvider>))

    const input = host.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'zakazky.csv', { type: 'text/csv' })], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { button('Zkontrolovat tabulku')!.click() })
    await flush()

    expect(actions.previewCsvImport).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('2. K potvrzení')
    expect(host.textContent).toContain('Potvrdit vše (1)')
    expect(host.textContent).toContain('čeká na tebe 1')
    expect(actions.openImportBatch).not.toHaveBeenCalled()

    await act(async () => { button(/Potvrdit vše/)!.click() })
    await flush()
    await flush()

    expect(actions.openImportBatch).toHaveBeenCalledWith('csv', 'zakazky.csv')
    expect(actions.confirmImportRow).toHaveBeenCalledTimes(1)
    expect(vi.mocked(actions.confirmImportRow).mock.calls[0][0]).toMatchObject({
      batch_id: 7, source: 'csv', title: 'Web', stage: 'won', amount: '1000', account: { mode: 'existing', id: 5 }, key_name: 'Sigmaform',
    })
    expect(host.textContent).toContain('Zapsáno:')
    expect(host.textContent).toContain('Zakázka je zapsaná.')
    expect(refresh).toHaveBeenCalled()

    // Zpět v toastu vrátí dávku
    await act(async () => { button('Zpět')!.click() })
    await flush()
    expect(actions.revertImportBatch).toHaveBeenCalledWith(7)
  })

  test('potvrzení po jednom nemá tlačítko Zpět a sdílí dávku; „Potvrdit vše“ má vlastní dávku i Zpět jen za sebe', async () => {
    const rows = csvRows(['Sigmaform;Web;1000;rozjednáno', 'Sigmaform;Audit;500;rozjednáno', 'Sigmaform;Projekt;700;rozjednáno'])
    vi.mocked(actions.previewCsvImport).mockResolvedValueOnce({
      ok: true, ignoredColumns: [], members: MEMBERS, meId: ME,
      rows: rows.map((row, i) => ({ row, key: `row:${i}`, match: matched, alreadyImported: false, sameTitleDeal: null })),
    })
    vi.mocked(actions.openImportBatch).mockResolvedValueOnce({ ok: true, batchId: 7 }).mockResolvedValueOnce({ ok: true, batchId: 8 })
    vi.mocked(actions.confirmImportRow).mockResolvedValue({
      ok: true, dealId: 9, accountId: 5, accountCreated: false, engagementId: null, records: 0, duplicate: false, warnings: [],
    })
    vi.mocked(actions.revertImportBatch).mockResolvedValue({
      ok: true, message: 'Vráceno zakázek: 2.',
      result: { deals_reverted: 2, deals_kept: [], accounts_deleted: 0, accounts_kept: 0, records_deleted: 0, status: 'reverted' },
    })
    await act(async () => root.render(<UndoToastProvider><BulkImport pdfEnabled={false} members={MEMBERS} meId={ME} /></UndoToastProvider>))
    const input = host.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'zakazky.csv')], configurable: true })
    await act(async () => { button('Zkontrolovat tabulku')!.click() })
    await flush()

    await act(async () => { (host.querySelector('button[aria-label="Potvrdit zakázku Web"]') as HTMLButtonElement).click() })
    await flush()
    await flush()
    expect(vi.mocked(actions.confirmImportRow).mock.calls.map((c) => (c[0] as { batch_id: number }).batch_id)).toEqual([7])
    expect(host.textContent).toContain('Zakázka je zapsaná.')
    expect(button('Zpět')).toBeUndefined()

    await act(async () => { button(/Potvrdit vše \(2\)/)!.click() })
    await flush()
    await flush()
    expect(vi.mocked(actions.confirmImportRow).mock.calls.map((c) => (c[0] as { batch_id: number }).batch_id)).toEqual([7, 8, 8])
    expect(actions.openImportBatch).toHaveBeenCalledTimes(2)
    await act(async () => { button('Zpět')!.click() })
    await flush()
    // vrací se jen dávka „Potvrdit vše“ (8), ne dřívější jednotlivé potvrzení (7)
    expect(actions.revertImportBatch).toHaveBeenCalledWith(8)
  })

  test('vadná tabulka ukáže chybu souboru a nezobrazí frontu', async () => {
    vi.mocked(actions.previewCsvImport).mockResolvedValueOnce({ ok: false, error: 'V hlavičce chybí sloupec: stav.' })
    await act(async () => root.render(<UndoToastProvider><BulkImport pdfEnabled={false} members={MEMBERS} meId={ME} /></UndoToastProvider>))
    const input = host.querySelector('input[type=file]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'z.csv')], configurable: true })
    await act(async () => { button('Zkontrolovat tabulku')!.click() })
    await flush()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('chybí sloupec')
    expect(host.textContent).not.toContain('2. K potvrzení')
  })
})

describe('historie dávek', () => {
  const batch = { id: 3, kind: 'csv' as const, label: 'zakazky.csv', status: 'open' as const, createdAt: '2026-09-30T08:00:00Z', createdByName: 'Viktor', revertedAt: null, deals: 12, accountsCreated: 2 }

  test('vrácení je dvoustupňové a po vrácení ukáže, co zůstalo a proč', async () => {
    vi.mocked(actions.revertImportBatch).mockResolvedValueOnce({
      ok: true, message: 'Vráceno zakázek: 11. Ponecháno 1, protože se na nich už pracovalo.',
      result: { deals_reverted: 11, deals_kept: [{ deal_id: 4, reason: 'linked_work' }], accounts_deleted: 2, accounts_kept: 0, records_deleted: 30, status: 'partial' },
    })
    await act(async () => root.render(<ImportBatchHistory batches={[batch]} />))
    expect(host.textContent).toContain('Zakázek v dávce: 12')
    expect(host.textContent).toContain('nových klientů: 2')
    await act(async () => { button('Vrátit import')!.click() })
    expect(actions.revertImportBatch).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Smaže zakázky z této dávky, kde se nic nezměnilo.')
    await act(async () => { button('Ne')!.click() })
    expect(host.textContent).not.toContain('Ano, vrátit import')
    await act(async () => { button('Vrátit import')!.click() })
    await act(async () => { button('Ano, vrátit import')!.click() })
    await flush()
    expect(actions.revertImportBatch).toHaveBeenCalledWith(3)
    expect(host.textContent).toContain('Ponecháno 1')
    expect(host.textContent).toContain('navázaná práce')
  })

  test('vrácená dávka a dávka bez zakázek tlačítko nemá', () => {
    const out = renderToStaticMarkup(<ImportBatchHistory batches={[{ ...batch, status: 'reverted', deals: 0 }, { ...batch, id: 4, deals: 0 }]} />)
    expect(out).toContain('Vráceno')
    expect(out).not.toContain('Vrátit import')
  })
})
