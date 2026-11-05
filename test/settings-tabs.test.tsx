// Záložky sekce „Tým a nastavení“: admin vidí všechny tři, ostatní žádné
// (měli by jedinou); aktivní záložka nese aria-current. Navigace není
// bezpečnostní vrstva — stránky si oprávnění hlídají samy.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const pathname = vi.hoisted(() => ({ value: '/cockpit/tym' as string | null }))
vi.mock('next/navigation', () => ({ usePathname: () => pathname.value }))

import { SettingsTabs, SETTINGS_TABS } from '@/components/ui/SettingsTabs'

describe('SettingsTabs', () => {
  it('admin vidí Tým, API klíče a Nastavení; aktivní je jen jedna', () => {
    pathname.value = '/cockpit/api-klice'
    const html = renderToStaticMarkup(<SettingsTabs isAdmin />)
    expect(html).toContain('aria-label="Tým a nastavení"')
    for (const t of SETTINGS_TABS) expect(html).toContain(`href="${t.href}"`)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-current="page"[^>]*>API klíče|href="\/cockpit\/api-klice"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/cockpit\/api-klice"/)
  })

  it('ne-admin záložky nevidí vůbec', () => {
    pathname.value = '/cockpit/nastaveni'
    expect(renderToStaticMarkup(<SettingsTabs isAdmin={false} />)).toBe('')
  })

  it('bez známé cesty (null) nespadne a nic neoznačí', () => {
    pathname.value = null
    const html = renderToStaticMarkup(<SettingsTabs isAdmin />)
    expect(html).not.toContain('aria-current')
  })
})
