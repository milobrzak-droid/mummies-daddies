// Obrazovky kolem schůzek podle Outlooku: zrušená schůzka v kartě Dnes,
// tlačítko ruční kontroly, návrh milníku podle názvu schůzky a formulář.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@/domain/crm/actions/planMeeting', () => ({ planMeeting: vi.fn() }))
vi.mock('@/domain/crm/actions/meetingMilestones', () => ({ findMeetingMilestones: vi.fn(async () => ({ ok: true, available: true, options: [] })) }))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn(), findContactOptionsForAccount: vi.fn() }))

import { TodayMeetings } from '@/components/ui/TodayCards'
import { CalendarCheckButton } from '@/components/CalendarCheckButton'
import { SyncTasksButton } from '@/components/SyncTasksButton'
import { PlanMeetingForm, suggestMilestone } from '@/components/PlanMeetingForm'

const opt = (id: number, title: string) => ({ id, title, engagementLabel: 'EDU', dueOn: null, dueFromMeeting: false })

describe('suggestMilestone — předvýběr milníku podle názvu schůzky', () => {
  test('jediný milník, jehož název je v názvu schůzky (bez ohledu na diakritiku a velikost)', () => {
    const options = [opt(1, 'Workshop'), opt(2, 'Procesní mapa'), opt(3, 'Pilot')]
    expect(suggestMilestone('Workshop AI – ALFATECH', options)).toBe(1)
    expect(suggestMilestone('Předání: procesni MAPA', options)).toBe(2)
  })

  test('žádný nebo víc kandidátů → nic (radši nevybrat než špatně)', () => {
    expect(suggestMilestone('Úvodní jednání', [opt(1, 'Workshop')])).toBeNull()
    expect(suggestMilestone('Workshop a pilot', [opt(1, 'Workshop'), opt(3, 'Pilot')])).toBeNull()
    expect(suggestMilestone('Workshopy pro vedení', [opt(1, 'Workshop')])).toBeNull()
    expect(suggestMilestone('AI', [opt(9, 'AI')])).toBeNull()
  })
})

describe('karta Schůzky dnes', () => {
  test('zrušená schůzka zůstane vidět s poznámkou „zrušeno"', () => {
    const html = renderToStaticMarkup(
      <TodayMeetings
        outlookConnected
        meetings={[
          { id: 1, subject: 'Workshop AI', occurred_at: '2026-09-29T08:00:00Z', source: 'cockpit', outcome: 'cancelled', account: { id: 7, name: 'ALFATECH' } },
          { id: 2, subject: 'Pilot', occurred_at: '2026-09-29T12:00:00Z', source: 'cockpit', outcome: 'planned', account: null },
        ]}
      />,
    )
    expect(html).toContain('zrušeno')
    expect(html).toContain('line-through')
    expect(html).toContain('naplánováno')
  })
})

describe('tlačítka', () => {
  test('ruční kontrola kalendáře na /schuzky', () => {
    const html = renderToStaticMarkup(<CalendarCheckButton action={async () => ({ ok: true, summary: 'x', changed: false })} />)
    expect(html).toContain('Zkontrolovat změny v Outlooku')
  })

  test('Nastavení: popisek podle role', () => {
    expect(renderToStaticMarkup(<SyncTasksButton action={async () => ({ success: true })} />)).toContain('Synchronizovat úkoly')
    expect(renderToStaticMarkup(<SyncTasksButton action={async () => ({ success: true })} label="Synchronizovat úkoly a schůzky" />))
      .toContain('Synchronizovat úkoly a schůzky')
  })
})

describe('formulář Naplánovat schůzku', () => {
  test('bez vybraného klienta výběr milníku není; patička říká, že posun v Outlooku Cockpit promítne sám', () => {
    const html = renderToStaticMarkup(<PlanMeetingForm />)
    expect(html).not.toContain('name="milestone_id"')
    expect(html).toContain('Cockpit to promítne sám')
    expect(html).toContain('doplní tuhle schůzku')
  })
})
