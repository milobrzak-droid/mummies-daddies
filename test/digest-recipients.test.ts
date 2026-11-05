import { beforeEach, expect, test, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { filterTeamRecipientsAsService } from '@/domain/crm/digestDelivery'
import { createSupabaseFake, type QueryResult } from './helpers/supabaseFake'

// Přehled nese obchodní data → příjemci jen vedeni/obchodnik (jako
// can_see_sales() v 0020). Chyba čtení týmu = nikomu neposílat.

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

let result: QueryResult
beforeEach(() => {
  const f = createSupabaseFake({ resolve: () => result })
  vi.mocked(createAdminClient).mockReturnValue(f.client as never)
})

const TEAM = [
  { email: 'Viktor@MummiesDaddies.com ', role: 'vedeni' },
  { email: 'obchod@mummiesdaddies.com', role: 'obchodnik' },
  { email: 'projekt@mummiesdaddies.com', role: 'projektak' },
  { email: 'lektor@mummiesdaddies.com', role: 'lektor' },
  { email: 'partner@firma.cz', role: 'partner' },
  { email: null, role: 'vedeni' },
  { email: 'bezrole@mummiesdaddies.com', role: null },
]

test('projdou jen obchodní role; e-mail bez ohledu na velikost písmen a mezery v týmu', async () => {
  result = { data: TEAM, error: null }
  const out = await filterTeamRecipientsAsService([
    'viktor@mummiesdaddies.com', 'OBCHOD@mummiesdaddies.com', 'projekt@mummiesdaddies.com', 'lektor@mummiesdaddies.com',
    'partner@firma.cz', 'bezrole@mummiesdaddies.com', 'cizi@gmail.com',
  ])
  expect(out).toEqual(['viktor@mummiesdaddies.com', 'OBCHOD@mummiesdaddies.com'])
})

test('prázdný e-mail člena nepustí prázdného příjemce', async () => {
  result = { data: TEAM, error: null }
  expect(await filterTeamRecipientsAsService([''])).toEqual([])
})

test('prázdný tým nebo null data → nikdo', async () => {
  result = { data: null, error: null }
  expect(await filterTeamRecipientsAsService(['viktor@mummiesdaddies.com'])).toEqual([])
})

test('chyba čtení týmu → vyhodí (fail closed)', async () => {
  result = { data: null, error: { message: 'permission denied' } }
  await expect(filterTeamRecipientsAsService(['viktor@mummiesdaddies.com'])).rejects.toThrow(/permission denied/)
})
