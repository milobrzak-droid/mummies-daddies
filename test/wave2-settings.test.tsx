import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// Vlna 2, Tým a nastavení: sjednocené karty, segment záložek, nevratné
// zrušení API klíče až po potvrzení (logika oprávnění se nemění).

vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/api-klice', useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/actions/apiKeys', () => ({ revokeApiKey: vi.fn(), createApiKey: vi.fn() }))

describe('API klíče', () => {
  test('zrušení klíče se neodešle prvním klikem', async () => {
    const { ApiKeyActions } = await import('@/components/ApiKeyActions')
    const html = renderToStaticMarkup(<ApiKeyActions id={1} revoked={false} name="Claude Code" />)
    expect(html).toContain('aria-label="Zrušit klíč Claude Code"')
    expect(html).not.toContain('type="submit"')
    expect(html).not.toContain('Ano, zrušit')
    expect(renderToStaticMarkup(<ApiKeyActions id={1} revoked name="X" />)).toBe('')
  })
})

describe('záložky Tým a nastavení', () => {
  test('segmentový přepínač místo pilulek', async () => {
    const { SettingsTabs } = await import('@/components/ui/SettingsTabs')
    const html = renderToStaticMarkup(<SettingsTabs isAdmin />)
    expect(html).toContain('class="seg')
    expect(html).toContain('seg-item')
    expect(html).not.toContain('pill-tab')
  })
})

describe('zdroje v Nastavení', () => {
  test('karta zápisů schůzek je sdílená Card s nadpisem Title 2', async () => {
    const { MeetingSourcesCard } = await import('@/components/MeetingSourcesCard')
    const html = renderToStaticMarkup(<MeetingSourcesCard stats={null} />)
    expect(html).toContain('rounded-card border border-border bg-surface shadow-card')
    expect(html).toMatch(/<h2 class="[^"]*text-title2[^"]*">Zápisy schůzek z Wispr Flow<\/h2>/)
  })
})
