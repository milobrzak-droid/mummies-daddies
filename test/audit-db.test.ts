import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// core/auditDb.ts (napojení appky na DB audit trigger 0064) a zápisy přes
// servisní klíč (domain/crm/apiWrite.ts — REST i MCP), které triggeru
// hlavičkami říkají, za koho zapisují. Supabase je celý falešný.

type Call = { client: number; table: string; op: string; payload?: unknown }
const calls: Call[] = []
const clientHeaders: Record<string, string>[] = []
let migrationRow: unknown = null
let migrationError: unknown = null
let migrationThrows = false

function chain(table: string, client: number) {
  let op = 'select'
  const q: Record<string, unknown> = {}
  const result = () => {
    if (table === 'schema_migration') {
      if (migrationThrows) throw new Error('síť')
      return { data: migrationRow, error: migrationError }
    }
    if (table === 'sales_activity') return { data: { id: 500 }, error: null }
    if (table === 'task') return { data: { id: 600 }, error: null }
    if (table === 'deal') return { data: { id: 700 }, error: null }
    if (table === 'evidence') return { data: op === 'select' ? { id: 41 } : null, error: null }
    return { data: null, error: null }
  }
  const record = (name: string) => (payload?: unknown) => {
    op = name
    calls.push({ client, table, op: name, payload })
    return q
  }
  Object.assign(q, {
    select: () => q,
    insert: record('insert'),
    update: record('update'),
    upsert: (payload: unknown) => {
      calls.push({ client, table, op: 'upsert', payload })
      return Promise.resolve({ error: null })
    },
    eq: () => q,
    single: async () => result(),
    maybeSingle: async () => result(),
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => {
      try { res(result()) } catch (e) { rej(e) }
    },
  })
  return q
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn((opts?: { headers?: Record<string, string> }) => {
    const id = clientHeaders.length
    clientHeaders.push(opts?.headers ?? {})
    return { from: (t: string) => chain(t, id) }
  }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { createAuditedAdminClient, dbAuditActive, resetDbAuditActiveCache } from '@/core/auditDb'
import { AUDIT_ACTOR_HEADER, AUDIT_EVIDENCE_HEADER, AUDIT_INFO_STATE_HEADER } from '@/core/auditCoverage'
import { createActivity, createTask, setNextStep } from '@/domain/crm/apiWrite'

const WISPR = 'https://notes.wisprflow.ai/xyz789'
const of = (table: string, op?: string) => calls.filter((c) => c.table === table && (!op || c.op === op))

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  clientHeaders.length = 0
  migrationRow = null
  migrationError = null
  migrationThrows = false
  resetDbAuditActiveCache()
})

describe('dbAuditActive — běží už DB audit trigger (0064)?', () => {
  // Počítá dotazy na schema_migration přes počet vytvořených klientů
  // (dbAuditActive si pro každý dotaz bere nového admin klienta).
  const queries = () => vi.mocked(createAdminClient).mock.calls.length

  test('řádek 0064 v schema_migration → true, a pak už se neptá', async () => {
    migrationRow = { version: '0064' }
    expect(await dbAuditActive(1_000)).toBe(true)
    expect(await dbAuditActive(10_000_000)).toBe(true)
    expect(queries()).toBe(1)
  })

  test('bez řádku → false, zapamatované jen na minutu (aplikace migrace se projeví bez redeploye)', async () => {
    expect(await dbAuditActive(0)).toBe(false)
    expect(await dbAuditActive(59_999)).toBe(false)
    expect(queries()).toBe(1)
    migrationRow = { version: '0064' }
    expect(await dbAuditActive(60_000)).toBe(true)
    expect(queries()).toBe(2)
  })

  test('chyba čtení nebo výjimka → false (appka pak zapíše audit sama) a zaloguje se', async () => {
    migrationError = { message: 'boom' }
    expect(await dbAuditActive(0)).toBe(false)
    resetDbAuditActiveCache()
    migrationThrows = true
    expect(await dbAuditActive(0)).toBe(false)
    expect(logError).toHaveBeenCalledTimes(2)
  })

  test('ptá se přesně na verzi 0064', () => {
    const src = readFileSync('core/auditDb.ts', 'utf8')
    // Společný dotaz migrationApplied(version) + dvě verze: 0064 a 0082.
    expect(src).toMatch(/from\('schema_migration'\)[\s\S]*?\.eq\('version', version\)/)
    expect(src).toMatch(/migrationApplied\(AUDIT_TRIGGER_MIGRATION,/)
    expect(src).toMatch(/migrationApplied\(AUDIT_SOFT_TRIGGER_MIGRATION,/)
  })
})

describe('createAuditedAdminClient', () => {
  test('předá admin klientovi hlavičky aktéra a původu', () => {
    createAuditedAdminClient({ actor: { type: 'user', id: 'u-1' }, evidenceId: 9, infoState: 'human_confirmed' })
    expect(createAdminClient).toHaveBeenCalledWith({
      headers: { [AUDIT_ACTOR_HEADER]: 'user:u-1', [AUDIT_EVIDENCE_HEADER]: '9', [AUDIT_INFO_STATE_HEADER]: 'human_confirmed' },
    })
  })
})

describe('REST/MCP zápisy po migraci 0064 — aktér z hlavičky, žádný dvojí audit', () => {
  beforeEach(() => { migrationRow = { version: '0064' } })

  const insertClient = (table: string) => of(table, 'insert')[0]?.client ?? of(table, 'update')[0]?.client

  test('schůzka se zdrojem: evidence PŘED aktivitou, aktivita s hlavičkami api_key + evidence + human_confirmed, appka audit nepíše', async () => {
    const r = await createActivity({ account_id: 77, kind: 'meeting', subject: 'Schůzka', source_url: WISPR, source_id: 'wf-1' }, 'user-1', true)
    expect(r).toEqual({ ok: true, data: { id: 500, evidence_id: 41 } })
    const evidenceIdx = calls.findIndex((c) => c.table === 'evidence' && c.op === 'upsert')
    const activityIdx = calls.findIndex((c) => c.table === 'sales_activity' && c.op === 'insert')
    expect(evidenceIdx).toBeGreaterThanOrEqual(0)
    expect(evidenceIdx).toBeLessThan(activityIdx)
    expect(clientHeaders[insertClient('sales_activity')!]).toEqual({
      [AUDIT_ACTOR_HEADER]: 'api_key:user-1',
      [AUDIT_EVIDENCE_HEADER]: '41',
      [AUDIT_INFO_STATE_HEADER]: 'human_confirmed',
    })
    expect(of('audit_event')).toHaveLength(0)
  })

  test('poznámka bez zdroje: jen aktér, bez evidence a stavu údaje', async () => {
    await createActivity({ account_id: 77, kind: 'note', subject: 'Poznámka' }, 'user-1', true)
    expect(clientHeaders[insertClient('sales_activity')!]).toEqual({ [AUDIT_ACTOR_HEADER]: 'api_key:user-1' })
    expect(of('evidence')).toHaveLength(0)
    expect(of('audit_event')).toHaveLength(0)
  })

  test('úkol a další krok obchodu nesou aktéra API klíče; klíč bez vlastníka = api_key', async () => {
    expect(await createTask({ title: 'Zavolat' }, 'user-1', true)).toEqual({ ok: true, data: { id: 600 } })
    expect(clientHeaders[insertClient('task')!]).toEqual({ [AUDIT_ACTOR_HEADER]: 'api_key:user-1' })
    expect(await setNextStep({ deal_id: 700, next_step: 'poslat nabídku', next_step_due: '2026-10-01' }, null)).toEqual({ ok: true, data: { id: 700 } })
    expect(clientHeaders[insertClient('deal')!]).toEqual({ [AUDIT_ACTOR_HEADER]: 'api_key' })
  })

  test('před migrací (bez řádku 0064) zapíše schůzku se zdrojem appka sama — jednou', async () => {
    migrationRow = null
    await createActivity({ account_id: 77, kind: 'meeting', subject: 'Schůzka', source_url: WISPR }, 'user-1', true)
    expect(of('audit_event', 'insert')).toHaveLength(1)
    expect(of('audit_event', 'insert')[0].payload).toMatchObject({
      actor_type: 'api_key', actor_id: 'user-1', action: 'activity.created', evidence_id: 41, info_state: 'human_confirmed',
    })
  })
})

describe('admin klient jednající za člověka nese aktéra (plánování schůzky, import nabídek)', () => {
  test.each(['domain/crm/actions/planMeeting.ts', 'domain/crm/actions/offers.ts'])('%s', (file) => {
    const src = readFileSync(file, 'utf8')
    expect(src).toContain("createAuditedAdminClient({ actor: { type: 'user', id: user.id } })")
    expect(src).not.toMatch(/\bcreateAdminClient\(/)
  })
})
