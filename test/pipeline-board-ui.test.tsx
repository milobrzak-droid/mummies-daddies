import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PipelineBoard, canUndoNextStep, canUndoStageChange } from '@/components/PipelineBoard'
import type { SalesDealLike } from '@/domain/crm/sales'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const deal = (p: Partial<SalesDealLike>): SalesDealLike => ({
  id: 1, account_id: 7, title: 'AI agent', stage: 'rozsah_nabidka', probability_pct: 50, amount_one_time: 1_635_300,
  expected_mrr: 0, next_step: null, next_step_due: null, owner_id: null, deal_kind: 'implementace',
  last_activity_at: '2026-09-24T10:00:00Z',
  account: { id: 7, name: 'ALFATECH' }, owner: null, primary_contact: null,
  ...p,
} as SalesDealLike)

const noop = async () => ({ success: true as const })

describe('PipelineBoard (tabule obchodů)', () => {
  test('sloupec má počet a součet, karta štítek, šanci a „Chybí další krok“', () => {
    const html = renderToStaticMarkup(
      <PipelineBoard deals={[deal({})]} stages={['diagnostika', 'rozsah_nabidka']} updateStage={noop} updateNextStep={noop} />,
    )
    expect(html).toContain('Nabídka odeslána')
    expect(html).toContain('Jednorázová akce')
    expect(html).toContain('50 %')
    expect(html).toContain('Chybí další krok')
    expect(html).toContain('Bez vlastníka')
    expect(html).toContain('Zatím žádný obchod.')
    expect(html).toContain('/cockpit/clients/7/deals/1')
  })
  test('další krok se zobrazí místo výzvy, uzavřený obchod bez kroku nevaruje', () => {
    const open = renderToStaticMarkup(
      <PipelineBoard deals={[deal({ next_step: 'Poslat nabídku', next_step_due: '2099-01-01', owner_id: 'u1', owner: { id: 'u1', full_name: 'Viktor Kovář' } })]} stages={['rozsah_nabidka']} updateStage={noop} updateNextStep={noop} />,
    )
    expect(open).toContain('Poslat nabídku')
    expect(open).not.toContain('Chybí další krok')
    const closed = renderToStaticMarkup(
      <PipelineBoard deals={[deal({ stage: 'vyhráno' })]} stages={['vyhráno']} updateStage={noop} updateNextStep={noop} />,
    )
    expect(closed).not.toContain('Chybí další krok')
  })
})

describe('PipelineBoard – úpravy na kartě a Zpět', () => {
  test('další krok se upravuje přímo na kartě, žádný odkaz na /edit kvůli kroku', () => {
    const html = renderToStaticMarkup(
      <PipelineBoard deals={[deal({ next_step: 'Poslat nabídku', next_step_due: '2099-01-01' })]} stages={['rozsah_nabidka']} updateStage={noop} updateNextStep={noop} />,
    )
    expect(html).toContain('aria-label="Upravit další krok – AI agent"')
    expect(html).toContain('aria-label="Fáze obchodu AI agent"')
    expect(html).not.toContain('/deals/1/edit')
  })
  test('chybějící krok nabízí „Doplnit“ na místě', () => {
    const html = renderToStaticMarkup(<PipelineBoard deals={[deal({})]} stages={['rozsah_nabidka']} updateStage={noop} updateNextStep={noop} />)
    expect(html).toContain('aria-label="Přidat další krok – AI agent"')
    expect(html).toContain('Doplnit')
  })
  test('Zpět u fáze: běžné přesuny ano, vyhrání ne, návrat do prohry jen s důvodem', () => {
    expect(canUndoStageChange({ stage: 'diagnostika', lost_reason: null }, 'rozsah_nabidka')).toBe(true)
    expect(canUndoStageChange({ stage: 'rozhodovani', lost_reason: null }, 'prohráno')).toBe(true)
    expect(canUndoStageChange({ stage: 'rozhodovani', lost_reason: null }, 'odloženo')).toBe(true)
    expect(canUndoStageChange({ stage: 'rozhodovani', lost_reason: null }, 'vyhráno')).toBe(false)
    expect(canUndoStageChange({ stage: 'vyhráno', lost_reason: null }, 'rozhodovani')).toBe(false)
    expect(canUndoStageChange({ stage: 'prohráno', lost_reason: null }, 'diagnostika')).toBe(false)
    expect(canUndoStageChange({ stage: 'prohráno', lost_reason: 'Rozpočet' }, 'diagnostika')).toBe(true)
    expect(canUndoStageChange({ stage: 'diagnostika', lost_reason: null }, 'diagnostika')).toBe(false)
  })
  test('Zpět u dalšího kroku jen tam, kde předchozí krok s termínem byl', () => {
    expect(canUndoNextStep({ next_step: 'Zavolat', next_step_due: '2026-10-01' })).toBe(true)
    expect(canUndoNextStep({ next_step: null, next_step_due: null })).toBe(false)
    expect(canUndoNextStep({ next_step: 'Zavolat', next_step_due: null })).toBe(false)
  })
})

describe('PipelineBoard – změna vlastníka na kartě (0093)', () => {
  const members = [{ id: 'u2', name: 'Lenka', roleLabel: 'Vedení' }]
  const owned = deal({ owner_id: 'u1', owner: { id: 'u1', full_name: 'Viktor Kovář' } })

  test('karta otevřeného obchodu nabízí „Změnit vlastníka“ jen tomu, kdo smí', () => {
    const admin = renderToStaticMarkup(
      <PipelineBoard deals={[owned]} stages={['rozsah_nabidka']} updateStage={noop} updateNextStep={noop}
        ownerContext={{ actor: { id: 'u9', role: 'vedeni', is_admin: true }, members }} />,
    )
    expect(admin).toContain('aria-label="Změnit vlastníka: AI agent"')
    // Cizí obchodník, který obchod nevlastní, tlačítko nedostane.
    const other = renderToStaticMarkup(
      <PipelineBoard deals={[owned]} stages={['rozsah_nabidka']} updateStage={noop} updateNextStep={noop}
        ownerContext={{ actor: { id: 'u5', role: 'obchodnik', is_admin: false }, members }} />,
    )
    expect(other).not.toContain('Změnit vlastníka')
    // Vlastník obchodu ano.
    const mine = renderToStaticMarkup(
      <PipelineBoard deals={[owned]} stages={['rozsah_nabidka']} updateStage={noop} updateNextStep={noop}
        ownerContext={{ actor: { id: 'u1', role: 'obchodnik', is_admin: false }, members }} />,
    )
    expect(mine).toContain('Změnit vlastníka: AI agent')
  })

  test('uzavřený obchod a tabule bez kontextu změnu vlastníka nenabízejí', () => {
    const ctx = { actor: { id: 'u9', role: 'vedeni', is_admin: true }, members }
    expect(renderToStaticMarkup(
      <PipelineBoard deals={[deal({ stage: 'vyhráno', owner_id: 'u1' })]} stages={['vyhráno']} updateStage={noop} updateNextStep={noop} ownerContext={ctx} />,
    )).not.toContain('Změnit vlastníka')
    expect(renderToStaticMarkup(
      <PipelineBoard deals={[owned]} stages={['rozsah_nabidka']} updateStage={noop} updateNextStep={noop} />,
    )).not.toContain('Změnit vlastníka')
  })
})
