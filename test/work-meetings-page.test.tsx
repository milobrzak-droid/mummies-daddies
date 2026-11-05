import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { getRecentMeetings } from '@/domain/crm/queries/meetingNotes'
import { getMeetingIntakeStats } from '@/domain/crm/queries/meetingIntake'

// /schuzky (vlna 2): zápisy a formulář jako dvě karty, jedna hlavní akce,
// prázdný stav s cestou na formulář, návod pod <details>.

vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/schuzky', redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))
vi.mock('@/domain/crm/queries/meetingNotes', () => ({ getRecentMeetings: vi.fn() }))
vi.mock('@/domain/crm/queries/meetingIntake', () => ({ getMeetingIntakeStats: vi.fn() }))
vi.mock('@/app/cockpit/schuzky/actions', () => ({ checkMeetingsInOutlook: vi.fn() }))
vi.mock('@/domain/crm/actions/planMeeting', () => ({ planMeeting: vi.fn() }))
vi.mock('@/domain/crm/actions/meetingMilestones', () => ({ findMeetingMilestones: vi.fn() }))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn() }))

async function renderPage() {
  const { default: Page } = await import('@/app/cockpit/schuzky/page')
  return renderToStaticMarkup(await Page())
}

beforeEach(() => vi.clearAllMocks())

describe('stránka /schuzky', () => {
  test('bez schůzek: jedna h1, jedna koralová akce, prázdný stav vede na formulář', async () => {
    vi.mocked(getRecentMeetings).mockResolvedValue([])
    vi.mocked(getMeetingIntakeStats).mockResolvedValue({ unmatched: 0 } as never)
    const html = await renderPage()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html.match(/btn-primary/g)).toHaveLength(1)
    expect(html).toContain('Zatím žádné schůzky')
    expect(html).toContain('href="#planovat"')
    expect(html).toContain('id="planovat"')
    expect(html).toContain('Jak sem zápisy přicházejí')
    expect(html).not.toContain('/cockpit/schuzky/nesparovane')
  })

  test('nespárované zápisy: upozornění s odkazem na frontu', async () => {
    vi.mocked(getRecentMeetings).mockResolvedValue([
      { id: 1, subject: 'Workshop', occurred_at: '2026-09-28T08:00:00Z', outcome: 'planned', source: 'cockpit', account: { id: 4, name: 'ALFATECH' } },
    ] as never)
    vi.mocked(getMeetingIntakeStats).mockResolvedValue({ unmatched: 2 } as never)
    const html = await renderPage()
    expect(html).toContain('Nespárované zápisy k přiřazení: 2')
    expect(html).toContain('naplánováno')
    expect(html).toContain('V přehledu 1 schůzka, z toho 1 naplánovaná.')
  })
})
