import { describe, it, expect } from 'vitest'
import { safeNext } from '@/lib/auth/safeNext'

const O = 'https://crm.example.cz'

describe('safeNext', () => {
  it.each([
    ['/', '/'],
    ['/klienti/5', '/klienti/5'],
    ['/api/oauth/authorize?client_id=x&state=y', '/api/oauth/authorize?client_id=x&state=y'],
  ])('povolí %s', (raw, out) => expect(safeNext(raw, O)).toBe(out))

  it.each([
    null, undefined, '', 'https://evil.com', '//evil.com', '/\\evil.com', '\\\\evil.com',
    '@evil.com', 'evil.com', '/\t/evil.com', '/\n/evil.com', 'javascript:alert(1)',
  ])('odmítne %s', (raw) => expect(safeNext(raw, O)).toBe('/cockpit'))
})
