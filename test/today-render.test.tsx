import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { Task } from '@/lib/types'
import { SalesFocus } from '@/components/SalesFocus'
import { TodayApprovals, TodayMeetings, TodayNumbers, TodayOverdue, TodayWonChart } from '@/components/ui/TodayCards'
import { TodayStageRing } from '@/components/ui/TodayParts'
import { openStageSlices } from '@/domain/crm/today'
import type { SalesFocusItem, SalesDealLike } from '@/domain/crm/sales'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }))

const task = (over: Partial<Task> = {}) => ({
  id: 11, title: 'Poslat nabídku', status: 'todo', due_on: '2026-09-29', account: { id: 3, name: 'ALFATECH' }, ...over,
}) as unknown as Task

const deal = (over: Partial<SalesDealLike> = {}) => ({
  id: 7, account_id: 3, title: 'AI agent', stage: 'rozsah_nabidka', amount_one_time: 1_635_300, probability_pct: 50,
  next_step: null, next_step_due: null, account: { id: 3, name: 'ALFATECH' }, owner: null, ...over,
}) as unknown as SalesDealLike

const item = (d: SalesDealLike): SalesFocusItem => ({ deal: d, reason: 'missing_next_step', label: 'Chybí plán', recommendation: 'Domluvit konkrétní další krok a termín', priority: 300 })

describe('vykreslení obrazovky Dnes (smoke)', () => {
  const slices = openStageSlices([deal(), deal({ id: 8, stage: 'diagnostika' })])

  test('Co dnes udělat: dlaždice s firmou, částkou, tlačítkem Vyřešit', () => {
    const html = renderToStaticMarkup(<SalesFocus items={[item(deal())]} />)
    expect(html).toContain('Co dnes udělat')
    expect(html).toContain('ALFATECH')
    expect(html).toContain('1 635 300')
    expect(html).toContain('Vyřešit')
    expect(html).toContain('/cockpit/aktivity?account=3&amp;deal=7')
    expect(html).toContain('tile-sun') // rozsah / nabídka = žlutá (čeká), §4
  })

  test('Co dnes udělat: úkol na dnes jde dokončit zaškrtnutím (s akcí), jinak je jen odkazem', () => {
    const withAction = renderToStaticMarkup(<SalesFocus items={[]} tasksToday={[task()]} completeTask={async () => {}} />)
    expect(withAction).toContain('Úkoly na dnes')
    expect(withAction).toContain('role="checkbox"')
    expect(withAction).toContain('aria-checked="false"')
    expect(withAction).toContain('aria-label="Hotovo: Poslat nabídku"')
    expect(withAction).toContain('ALFATECH')
    const readOnly = renderToStaticMarkup(<SalesFocus items={[]} tasksToday={[task()]} />)
    expect(readOnly).not.toContain('role="checkbox"')
    expect(readOnly).toContain('href="/cockpit/tasks"')
  })

  test('Co dnes udělat: víc úkolů než limit → zbytek odkazem', () => {
    const many = Array.from({ length: 7 }, (_, i) => task({ id: i + 1, title: `Úkol ${i + 1}` }))
    const html = renderToStaticMarkup(<SalesFocus items={[]} tasksToday={many} completeTask={async () => {}} />)
    expect(html).toContain('Úkol 5')
    expect(html).not.toContain('Úkol 6')
    expect(html).toContain('… a dalších 2 v úkolech')
  })

  test('Co dnes udělat: prázdný stav je klidný', () => {
    expect(renderToStaticMarkup(<SalesFocus items={[]} />)).toContain('Všechno důležité má další krok.')
  })

  test('tři velká čísla a prstenec mají textový popis pro čtečky', () => {
    const html = renderToStaticMarkup(
      <>
        <TodayNumbers open={2_670_000} weighted={1_340_000} won={0} openCount={2} monthLabel="září 2026" />
        <TodayStageRing slices={slices} />
      </>,
    )
    expect(html).toContain('2,67')
    expect(html).toContain('zatím nic uzavřeno')
    expect(html).toMatch(/role="img" aria-label="Otevřené obchody podle fáze, celkem 2: Upřesnění 1, Nabídka odeslána 1"/)
    expect(html).toContain('conic-gradient')
  })

  test('tři KPI jsou klidné: pruh jen u „S pravděpodobností"', () => {
    const html = renderToStaticMarkup(<TodayNumbers open={2_000_000} weighted={500_000} won={100_000} openCount={3} monthLabel="září 2026" />)
    expect(html.match(/class="bar /g)).toHaveLength(1)
    expect(html).toContain('S pravděpodobností je to 25 % z otevřené hodnoty')
    expect(html).not.toContain('Otevřené obchody podle fáze')
  })

  test('prázdné karty ukazují klidný stav, ne prázdné místo', () => {
    const html = renderToStaticMarkup(
      <>
        <TodayApprovals items={[]} total={0} available />
        <TodayMeetings meetings={[]} outlookConnected />
        <TodayOverdue items={[]} />
        <TodayWonChart months={['2026-08', '2026-09']} values={[0, 0]} />
      </>,
    )
    expect(html).toContain('Nic nečeká na tebe')
    expect(html).toContain('Dnes žádná schůzka')
    expect(html).toContain('Nic není po termínu')
    expect(html).toContain('Zatím není z čeho kreslit')
  })

  test('graf vyhráno po měsících se kreslí jen ze skutečných dat', () => {
    const html = renderToStaticMarkup(<TodayWonChart months={['2026-08', '2026-09']} values={[100_000, 621_000]} />)
    expect(html).toContain('role="img"')
    expect(html).toContain('Zář')
  })
})
