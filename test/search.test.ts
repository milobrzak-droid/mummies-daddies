import { describe, expect, test } from 'vitest'
import {
  SEARCH_GROUP_LIMIT,
  escapeLikePattern,
  likeContains,
  mergeAccountResults,
  normalizeSearchQuery,
  shapeAccountResults,
  shapeAliasResults,
  shapeContactResults,
  shapeDealResults,
  shapePartnerResults,
  type SearchResult,
} from '@/domain/crm/queries/search'

describe('normalizeSearchQuery', () => {
  test('trims whitespace', () => {
    expect(normalizeSearchQuery('  ab  ')).toBe('ab')
  })
  test('rejects undefined/null/non-string', () => {
    expect(normalizeSearchQuery(undefined)).toBeNull()
    expect(normalizeSearchQuery(null)).toBeNull()
  })
  test('rejects too short (below 2 chars after trim)', () => {
    expect(normalizeSearchQuery('a')).toBeNull()
    expect(normalizeSearchQuery(' a ')).toBeNull()
    expect(normalizeSearchQuery('')).toBeNull()
    expect(normalizeSearchQuery('   ')).toBeNull()
  })
  test('accepts exactly 2 chars', () => {
    expect(normalizeSearchQuery('ab')).toBe('ab')
  })
  test('accepts exactly 100 chars', () => {
    const q = 'a'.repeat(100)
    expect(normalizeSearchQuery(q)).toBe(q)
  })
  test('rejects over 100 chars', () => {
    expect(normalizeSearchQuery('a'.repeat(101))).toBeNull()
  })
})

describe('escapeLikePattern', () => {
  test('escapes %, _ and backslash', () => {
    expect(escapeLikePattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d')
  })
  test('leaves plain text untouched', () => {
    expect(escapeLikePattern('Spolchemie')).toBe('Spolchemie')
  })
})

describe('likeContains', () => {
  test('wraps escaped value in wildcard pattern', () => {
    expect(likeContains('a_b')).toBe('%a\\_b%')
  })
})

describe('shape* result mappers', () => {
  test('shapeAccountResults prefers IČO subtitle over web', () => {
    const out = shapeAccountResults([{ id: 1, name: 'Acme', ico: '12345678', web: 'acme.cz' }])
    expect(out).toEqual([{ kind: 'account', id: 1, title: 'Acme', subtitle: 'IČO 12345678', href: '/cockpit/clients/1' }])
  })
  test('shapeAccountResults falls back to web when no IČO', () => {
    const out = shapeAccountResults([{ id: 2, name: 'Beta', ico: null, web: 'beta.cz' }])
    expect(out[0]?.subtitle).toBe('beta.cz')
  })
  test('shapeAliasResults maps alias hit to the parent account and drops null accounts', () => {
    const out = shapeAliasResults([
      { account_id: 5, alias_domain: 'spolchemie.cz', alias_name: null, account: { id: 5, name: 'Spolchemie a.s.' } },
      { account_id: 9, alias_domain: 'orphan.cz', alias_name: null, account: null },
    ])
    expect(out).toEqual([
      { kind: 'account', id: 5, title: 'Spolchemie a.s.', subtitle: 'alias: spolchemie.cz', href: '/cockpit/clients/5' },
    ])
  })
  test('shapeAliasResults joins alias_domain and alias_name, skipping the missing one', () => {
    const out = shapeAliasResults([
      { account_id: 1, alias_domain: 'acme.cz', alias_name: 'ACME Group', account: { id: 1, name: 'Acme' } },
      { account_id: 2, alias_domain: null, alias_name: 'Beta Holding', account: { id: 2, name: 'Beta' } },
    ])
    expect(out.map((r) => r.subtitle)).toEqual(['alias: acme.cz · ACME Group', 'alias: Beta Holding'])
  })
  test('shapeContactResults links to kontakty edit page', () => {
    const out = shapeContactResults([{ id: 7, full_name: 'Jan Novák', email: 'jan@acme.cz', account_id: 1, partner_id: null }])
    expect(out).toEqual([{ kind: 'contact', id: 7, title: 'Jan Novák', subtitle: 'jan@acme.cz', href: '/cockpit/kontakty/7/edit' }])
  })
  test('shapeDealResults links to account-scoped deal detail', () => {
    const out = shapeDealResults([{ id: 3, title: 'Workshop AI', account_id: 1, account: { name: 'Acme' } }])
    expect(out).toEqual([{ kind: 'deal', id: 3, title: 'Workshop AI', subtitle: 'Acme', href: '/cockpit/clients/1/deals/3' }])
  })
  test('shapePartnerResults links to partner edit page', () => {
    const out = shapePartnerResults([{ id: 4, name: 'Microsoft', kind: 'reseller' }])
    expect(out).toEqual([{ kind: 'partner', id: 4, title: 'Microsoft', subtitle: 'reseller', href: '/cockpit/partners/4/edit' }])
  })
})

describe('mergeAccountResults', () => {
  const r = (id: number, title: string): SearchResult => ({ kind: 'account', id, title, subtitle: null, href: `/cockpit/clients/${id}` })

  test('deduplicates by id, keeping the direct match order first', () => {
    const direct = [r(1, 'Acme')]
    const viaAlias = [r(1, 'Acme (alias)'), r(2, 'Beta')]
    expect(mergeAccountResults(direct, viaAlias)).toEqual([r(1, 'Acme'), r(2, 'Beta')])
  })
  test('caps the merged list at SEARCH_GROUP_LIMIT', () => {
    const direct = Array.from({ length: SEARCH_GROUP_LIMIT }, (_, i) => r(i, `A${i}`))
    const viaAlias = [r(999, 'Extra')]
    expect(mergeAccountResults(direct, viaAlias)).toHaveLength(SEARCH_GROUP_LIMIT)
  })
  test('returns empty array for two empty inputs', () => {
    expect(mergeAccountResults([], [])).toEqual([])
  })
})
