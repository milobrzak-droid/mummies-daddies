import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { isCurrentUserAdmin } from '@/lib/queries/team'
import { createSupabaseFake, hasOp, opArgs, type QueryResult } from './helpers/supabaseFake'
import { snoozeOutreach, markOutreachNudged } from '@/domain/crm/actions/outreach'
import { foundAccountFromDomain } from '@/domain/crm/actions/prospects'
import { deleteTask, updateTaskStatus } from '@/domain/crm/actions/tasks'
import { deleteContact, updateContact } from '@/domain/crm/actions/contacts'
import { updateDealStage } from '@/domain/crm/actions/sales'
import { endSubscription, updateSubscription } from '@/domain/finance/actions/subscriptions'
import { addDealPartner } from '@/domain/crm/actions/deal-partners'
import { createEngagement } from '@/domain/delivery/actions/engagements'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/connectors/ares', () => ({ aresSearchByName: vi.fn(async () => []), pickAresMatch: vi.fn(() => null) }))
vi.mock('@/lib/queries/team', () => ({ isCurrentUserAdmin: vi.fn(async () => true) }))

function fake(resolve?: (call: { table: string; ops: { method: string; args: unknown[] }[] }) => QueryResult) {
  const f = createSupabaseFake({ user: { id: 'user-1' }, resolve })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isCurrentUserAdmin).mockResolvedValue(true)
  vi.mocked(dbAuditActive).mockResolvedValue(false)
})

const BAD_IDS: unknown[] = [0, -1, 1.5, '7', NaN, null, undefined, Number.MAX_SAFE_INTEGER + 1]

describe('neplatná id se nedostanou do DB', () => {
  test.each(BAD_IDS)('id %s', async (bad) => {
    const f = fake()
    const id = bad as number
    await snoozeOutreach(id, 7)
    await markOutreachNudged(id)
    await updateTaskStatus(id, 'hotovo')
    await deleteTask(id)
    await deleteContact(id, 1)
    await deleteContact(1, id)
    await endSubscription(1, id)
    const fd = new FormData()
    expect(await updateContact(id, null, fd)).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(await updateDealStage(id, 'kvalifikace')).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(await updateSubscription(1, id, null, fd)).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(await addDealPartner(1, id, null, fd)).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(await createEngagement(id, null, fd)).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(f.from).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()
  })
})

describe('snoozeOutreach — hranice dní', () => {
  test.each([0, -3, 366, 2.5, NaN])('odmítne %s dní', async (days) => {
    const f = fake()
    await snoozeOutreach(5, days)
    expect(f.from).not.toHaveBeenCalled()
  })
  test.each([1, 30, 365])('přijme %s dní', async (days) => {
    const f = fake()
    await snoozeOutreach(5, days)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].table).toBe('account')
    expect(opArgs(f.calls[0], 'eq')).toEqual(['id', 5])
  })
})

describe('foundAccountFromDomain — validace vstupu', () => {
  test.each([
    ['prázdná doména', '  ', [], 'Wispr Flow'],
    ['doména s mezerou', 'a b.cz', [], 'Wispr Flow'],
    ['doména s %', '%.cz', [], 'Wispr Flow'],
    ['doména s _', 'a_b.cz', [], 'Wispr Flow'],
    ['příliš dlouhá doména', `${'a'.repeat(250)}.cz`, [], 'Wispr Flow'],
    ['neplatný e-mail', 'firma.cz', ['neni-email'], 'Wispr Flow'],
    ['příliš mnoho e-mailů', 'firma.cz', Array.from({ length: 51 }, (_, i) => `u${i}@firma.cz`), 'Wispr Flow'],
    ['neznámý zdroj', 'firma.cz', [], 'cokoli <script>'],
    ['e-maily nejsou pole', 'firma.cz', 'x@firma.cz', 'Wispr Flow'],
  ])('%s → ok:false bez DB', async (_l, domain, emails, source) => {
    const f = fake()
    const r = await foundAccountFromDomain(domain as string, emails as string[], source as string)
    expect(r.ok).toBe(false)
    expect(f.from).not.toHaveBeenCalled()
  })

  test('platný vstup: hledá existujícího klienta přesnou (escapovanou) shodou', async () => {
    const f = fake(call => call.table === 'account' && hasOp(call, 'ilike')
      ? { data: { id: 11 }, error: null }
      : { data: [], error: null })
    const r = await foundAccountFromDomain('Spolchemie.CZ', ['Jan.Novak@spolchemie.cz'], 'Wispr Flow')
    expect(r).toEqual({ ok: true, accountId: 11, createdAccount: false })
    const lookup = f.calls.find(c => hasOp(c, 'ilike'))!
    expect(opArgs(lookup, 'ilike')).toEqual(['name', 'Spolchemie'])
    const insert = f.calls.find(c => c.table === 'contact' && hasOp(c, 'insert'))!
    expect(opArgs(insert, 'insert')).toEqual([[{ full_name: 'Jan Novak', email: 'jan.novak@spolchemie.cz', account_id: 11 }]])
  })
})

describe('escapování zástupných znaků ILIKE', () => {
  // Doména s % nebo _ neprojde validací, ale escapování je pojistka i pro
  // jméno — ověříme ho přes zdroják, protože funkce není exportovaná
  // (soubor je 'use server', export by z ní udělal endpoint).
  test('escapeLikePattern escapuje \\, % a _', () => {
    const src = readFileSync('domain/crm/actions/prospects.ts', 'utf8')
    const body = /function escapeLikePattern\(value: string\): string \{\n\s*return (.+)\n\}/.exec(src)![1]
    const escape = new Function('value', `return ${body}`) as (v: string) => string
    expect(escape('a%b_c\\d')).toBe('a\\%b\\_c\\\\d')
    expect(escape('Spolchemie')).toBe('Spolchemie')
  })
})

describe('deleteTask — audit jen po potvrzeném smazání jednoho řádku', () => {
  const existing = { title: 'Zavolat', status: 'otevřeno', assignee_id: null }
  function setup(deleteResult: QueryResult) {
    return fake(call => call.table !== 'task'
      ? { data: null, error: null }
      : hasOp(call, 'delete') ? deleteResult : { data: existing, error: null })
  }
  test.each([
    ['0 řádků', { data: [], error: null }],
    ['null data', { data: null, error: null }],
    ['víc řádků', { data: [{ id: 3 }, { id: 4 }], error: null }],
  ])('%s → bez auditu', async (_l, res) => {
    setup(res)
    await deleteTask(3)
    expect(recordAudit).not.toHaveBeenCalled()
  })
  test('chyba DB → vyhodí, bez auditu', async () => {
    setup({ data: null, error: { message: 'boom' } })
    await expect(deleteTask(3)).rejects.toBeTruthy()
    expect(recordAudit).not.toHaveBeenCalled()
  })
  test('právě jeden řádek → audit', async () => {
    const f = setup({ data: [{ id: 3 }], error: null })
    await deleteTask(3)
    expect(recordAudit).toHaveBeenCalledTimes(1)
    const del = f.calls.find(c => hasOp(c, 'delete'))!
    expect(opArgs(del, 'select')).toEqual(['id'])
  })
  test('po migraci 0064 zapisuje smazání DB trigger → appka audit nepíše (nikdy obojí)', async () => {
    vi.mocked(dbAuditActive).mockResolvedValue(true)
    const f = setup({ data: [{ id: 3 }], error: null })
    await deleteTask(3)
    expect(f.calls.some(c => hasOp(c, 'delete'))).toBe(true)
    expect(recordAudit).not.toHaveBeenCalled()
  })
})

describe("redactContactFromSalesActivity není export žádného 'use server' modulu", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      if (name === 'node_modules' || name.startsWith('.')) return []
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : []
    })
  }
  test('sken zdrojáků', () => {
    const offenders = ['app', 'domain', 'lib', 'core', 'components', 'connectors']
      .flatMap(d => { try { return walk(d) } catch { return [] } })
      .filter(p => {
        const src = readFileSync(p, 'utf8')
        return /^\s*['"]use server['"]/.test(src) && /redactContactFromSalesActivity/.test(src)
          && /export[^\n]*redactContactFromSalesActivity/.test(src)
      })
    expect(offenders).toEqual([])
    expect(readFileSync('domain/crm/gdprSweep.ts', 'utf8')).not.toMatch(/^\s*['"]use server['"]/)
  })
})
