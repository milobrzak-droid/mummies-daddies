// Nastavení → karta „Microsoft Outlook (kalendář, pošta)": tlačítko pro
// znovupřipojení s novými oprávněními a upozornění na chybějící Mail.Read /
// Mail.Send (calendar_token.granted_scopes, migrace 0060).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { getMyCalendarConnection } from '@/domain/crm/queries/calendar'
import SettingsPage from '@/app/cockpit/nastaveni/page'

vi.mock('@/domain/crm/queries/calendar', () => ({ getMyCalendarConnection: vi.fn() }))
vi.mock('@/domain/crm/actions/calendar', () => ({ disconnectOutlook: vi.fn(), syncMyTasksToOutlook: vi.fn() }))
vi.mock('@/core/connectorState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/connectorState')>()),
  getConnectorState: vi.fn(async () => null),
}))
vi.mock('@/components/SyncTasksButton', () => ({ SyncTasksButton: () => null }))
vi.mock('@/components/ChangePasswordForm', () => ({ ChangePasswordForm: () => null }))
vi.mock('@/lib/queries/currentMember', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(async () => ({ member: null })),
}))
vi.mock('@/domain/crm/mailSyncService', () => ({ loadMailSourcesStatus: vi.fn(async () => null) }))
vi.mock('@/components/MailSourcesCard', () => ({ MailSourcesCard: () => null }))

async function render(conn: Awaited<ReturnType<typeof getMyCalendarConnection>>) {
  vi.mocked(getMyCalendarConnection).mockResolvedValue(conn)
  return renderToStaticMarkup(await SettingsPage({ searchParams: Promise.resolve({}) }))
}

beforeEach(() => vi.clearAllMocks())

describe('Nastavení — Microsoft Outlook', () => {
  it('karta se jmenuje „Microsoft Outlook (kalendář, pošta)"', async () => {
    const html = await render({ connected: false, email: null, grantedScopes: null })
    expect(html).toContain('Microsoft Outlook (kalendář, pošta)')
    expect(html).not.toContain('Znovu připojit')
    expect(html).toContain('href="/api/ms/connect"')
  })

  it('připojený účet bez Mail.Read/Mail.Send → upozornění + tlačítko Znovu připojit (prompt=consent)', async () => {
    const html = await render({ connected: true, email: 'viktor@mummiesdaddies.com', grantedScopes: 'Calendars.ReadWrite User.Read' })
    expect(html).toContain('Chybí oprávnění: Mail.Read / Mail.Send — klikni Znovu připojit.')
    expect(html).toContain('href="/api/ms/connect?reconnect=1"')
    expect(html).toContain('Znovu připojit (rozšířit oprávnění)')
    expect(html).toContain('Odpojit')
  })

  it('všechna oprávnění udělená → žádné upozornění, tlačítko zůstává', async () => {
    const html = await render({ connected: true, email: 'viktor@mummiesdaddies.com', grantedScopes: 'Calendars.ReadWrite User.Read Mail.Read Mail.Send' })
    expect(html).not.toContain('Chybí oprávnění')
    expect(html).not.toContain('nejsou známá')
    expect(html).toContain('href="/api/ms/connect?reconnect=1"')
  })

  it('neznámá oprávnění (připojeno před 0060) → jen nápověda, žádné tvrzení o chybě', async () => {
    const html = await render({ connected: true, email: 'viktor@mummiesdaddies.com', grantedScopes: null })
    expect(html).not.toContain('Chybí oprávnění')
    expect(html).toContain('Udělená oprávnění nejsou známá')
    expect(html).toContain('Mail.Read, Mail.Send')
  })
})
