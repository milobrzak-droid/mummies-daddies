// Vypnuté moduly firmy (CompanyConfig.modules): layout modulu vrátí 404
// pro všechny jeho stránky, zapnutý modul projde.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { requireModule } from '@/app/cockpit/moduleGuard'
import PartnersLayout from '@/app/cockpit/partners/layout'
import FinanceLayout from '@/app/cockpit/finance/layout'

describe('requireModule', () => {
  test('vypnutý modul = notFound (404)', () => {
    expect(COMPANY.modules.partners).toBe(false)
    expect(() => requireModule('partners')).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
    expect(() => PartnersLayout({ children: null })).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
    expect(() => FinanceLayout({ children: null })).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
  })

  test('zapnutý modul projde', () => {
    expect(COMPANY.modules.deliveries).toBe(true)
    expect(() => requireModule('deliveries')).not.toThrow()
  })
})
