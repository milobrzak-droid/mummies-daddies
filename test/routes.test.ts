// Směrování „web + Cockpit" (lib/routes.ts): co je veřejný web a co Cockpit.
import { describe, expect, test } from 'vitest'
import { COCKPIT_HOME, isCockpitPath, isPublicWebApiPath, isPublicWebPath } from '@/lib/routes'

describe('isPublicWebPath', () => {
  test.each(['/', '/catering', '/catering/svatby', '/cheesecaky', '/kontakt', '/cockpitx', '/loginx', '/authx', '/logo.svg'])('%s je veřejný web', (p) => {
    expect(isPublicWebPath(p)).toBe(true)
  })
  test.each(['/cockpit', '/cockpit/clients/7', '/login', '/auth/mfa', '/api/web/poptavka', '/api/v1/deals', '/_next/static/x.js', '/.well-known/oauth-authorization-server'])('%s není veřejný web', (p) => {
    expect(isPublicWebPath(p)).toBe(false)
  })
})

test('Cockpit a veřejná API webu', () => {
  expect(COCKPIT_HOME).toBe('/cockpit')
  expect(isCockpitPath('/cockpit')).toBe(true)
  expect(isCockpitPath('/cockpit/tasks')).toBe(true)
  expect(isCockpitPath('/cockpitx')).toBe(false)
  expect(isPublicWebApiPath('/api/web/poptavka')).toBe(true)
  expect(isPublicWebApiPath('/api/webx')).toBe(false)
})
