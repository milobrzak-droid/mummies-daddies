import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FinanceRecordsTable } from '@/components/FinanceRecordsTable'
import { KindCards, MilestonePrompt } from '@/components/FinanceCards'
import { FinanceRecordActions, FinanceRecordCreatePanel } from '@/components/FinanceRecordForms'
import { buildFinanceBoard, type FinancialRecordRow } from '@/domain/finance/records'

// Vlna 2, Finance (docs/PROVOZ.md §13): bílé karty s proužkem, tabulka
// s částkami vpravo a součtem v patičce – vždy po druhu, nikdy přes druhy –,
// přidání v panelu a nevratné zrušení až po potvrzení.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }))
vi.mock('@/domain/finance/actions/records', () => ({
  createFinancialRecord: vi.fn(),
  updateFinancialRecord: vi.fn(),
  cancelFinancialRecord: vi.fn(),
}))

const rec = (p: Partial<FinancialRecordRow>): FinancialRecordRow & { account_name: string | null } => ({
  id: 1, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'potential', amount: 100,
  currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'rucne', evidence_id: null,
  external_ref: null, note: null, created_at: '2026-09-01T00:00:00Z', account_name: 'ALFATECH', ...p,
})

const nbsp = (s: string) => s.replace(/[  ]/g, ' ')

describe('Finance: karty stavu', () => {
  test('druhy jsou bílé karty s proužkem, ne plné barvy', () => {
    const html = renderToStaticMarkup(<KindCards board={buildFinanceBoard([rec({})])} showDrafts currentMonth="2026-09" />)
    for (const t of ['tile-lav', 'tile-sky', 'tile-sun', 'tile-mint']) expect(html).toContain(`tile ${t}`)
    expect(html).not.toContain('tile-solid')
  })

  test('výzva k milníkům je klidná bílá karta; sytou barvu má jen faktura po splatnosti (test/finance-due-ui.test.tsx)', () => {
    const m = { id: 1, title: 'Mapa', engagement_id: 4, account_id: 2, account_name: 'ALFATECH', accepted_at: null }
    const html = renderToStaticMarkup(<MilestonePrompt milestones={[m]} />)
    expect(html).toContain('tile tile-sun')
    expect(html).not.toContain('tile-solid')
    expect(html).not.toContain('btn-primary')
    expect(renderToStaticMarkup(<MilestonePrompt milestones={[]} />)).not.toContain('tile-solid')
  })
})

describe('Finance: tabulka záznamů', () => {
  const rows = [
    rec({ id: 1, kind: 'contracted', amount: 360000 }),
    rec({ id: 2, kind: 'contracted', amount: 40000, status: 'draft' }),
    rec({ id: 3, kind: 'received', amount: 48000 }),
    rec({ id: 4, kind: 'received', amount: 5000, status: 'cancelled' }),
  ]

  test('částky vpravo s tabular-nums, součet v patičce po druzích, zrušené se nepočítají', () => {
    const html = nbsp(renderToStaticMarkup(<FinanceRecordsTable rows={rows} kind={null} showDrafts accountingSystem="iDoklad" />))
    expect(html).toContain('<tfoot')
    expect(html).toMatch(/text-right[^"]*">Částka/)
    expect(html).toContain('tabular-nums')
    expect(html).toContain('Součet · Nasmlouváno')
    expect(html).toContain('Součet · Přijato')
    expect(html).not.toContain('Součet · Potenciál')
    expect(html).toContain('360 000,00 Kč')
    expect(html).toContain('+ návrh 40 000,00 Kč')
    // přijato: 48 000 bez zrušených 5 000
    expect(html).toContain('48 000,00 Kč</b>')
    expect(html).not.toContain('53 000')
    // nikdy součet přes druhy (360 000 + 48 000)
    expect(html).not.toContain('408 000')
    expect(html).not.toMatch(/Celkem/i)
  })

  test('filtr jednoho druhu má v patičce jen jeho součet', () => {
    const html = renderToStaticMarkup(
      <FinanceRecordsTable rows={rows.filter((r) => r.kind === 'received')} kind="received" showDrafts accountingSystem="iDoklad" />,
    )
    expect(html).toContain('Součet · Přijato')
    expect(html).not.toContain('Součet · Nasmlouváno')
  })

  test('prázdné období je klidný stav s větou, co dál', () => {
    const html = renderToStaticMarkup(<FinanceRecordsTable rows={[]} kind={null} showDrafts accountingSystem="iDoklad" />)
    expect(html).toContain('V tomto období žádné finanční záznamy.')
    expect(html).not.toContain('<table')
  })
})

describe('Finance: panel a zrušení', () => {
  test('„Přidat záznam“ je hlavní akce a otevírá panel (formulář není na stránce předem)', () => {
    const html = renderToStaticMarkup(<FinanceRecordCreatePanel accounts={[{ id: 1, name: 'ALFATECH' }]} defaultMonth="2026-09" accountingSystem="iDoklad" />)
    expect(html).toContain('btn-primary')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('Přidat záznam')
    expect(html).not.toContain('name="account_id"')
  })

  test('zrušení záznamu se nejdřív potvrzuje, tlačítka nesou, o který záznam jde', () => {
    const html = nbsp(renderToStaticMarkup(<FinanceRecordActions record={rec({ kind: 'invoiced', amount: 60000 })} accountingSystem="iDoklad" />))
    expect(html).toContain('Zrušit záznam — Vyfakturováno 60 000,00 Kč · ALFATECH')
    expect(html).toContain('Upravit — Vyfakturováno 60 000,00 Kč · ALFATECH')
    // potvrzovací formulář se ukáže až po kliknutí
    expect(html).not.toContain('Ano, zrušit')
    expect(renderToStaticMarkup(<FinanceRecordActions record={rec({ status: 'cancelled' })} accountingSystem="iDoklad" />)).not.toContain('Upravit')
  })
})

describe('Ke schválení: anatomie a nevratné akce', () => {
  test('zamítnutí se potvrzuje, schválení není koralové (koral je nejvýš jeden na obrazovce)', async () => {
    const { ApprovalDecideButtons } = await import('@/components/ApprovalDecideButtons')
    const html = renderToStaticMarkup(
      <ApprovalDecideButtons action={vi.fn()} requestId={1} label="Pilot" caseHref="/cockpit/pripady/1" snoozeAction={vi.fn()} />,
    )
    expect(html).toContain('Schválit — Pilot')
    expect(html).toContain('Zamítnout — Pilot')
    expect(html).not.toContain('btn-primary')
    // zamítnutí nejde přímo odeslat: první tlačítko jen otevře potvrzení
    expect(html).not.toMatch(/type="submit"[^>]*Zamítnout — Pilot/)
    expect(html).not.toContain('Ano, zamítnout')
    expect(html).toContain('Odložit — Pilot')
  })

  test('návrh případu: zamítnutí až po potvrzení', async () => {
    const { ProposalDecideButtons } = await import('@/components/ProposalDecideButtons')
    const html = renderToStaticMarkup(<ProposalDecideButtons action={vi.fn()} proposalId={2} label="E-mail" />)
    expect(html).toContain('Přijmout návrh — E-mail')
    expect(html).not.toMatch(/type="submit"[^>]*Zamítnout návrh/)
  })

  test('historie ukáže pět posledních, starší pod rozbalením', async () => {
    const { DecisionHistory } = await import('@/components/DecisionCards')
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1, action_kind: 'external_commitment', status: 'approved' as const, decided_by: null,
      decided_at: '2026-09-25T12:00:00Z', case_id: 1, case_title: `Případ ${i + 1}`,
    }))
    const html = renderToStaticMarkup(<DecisionHistory items={items as never} names={new Map()} />)
    expect(html).toContain('Starší rozhodnutí (2)')
    expect(html).toContain('<details')
  })
})
