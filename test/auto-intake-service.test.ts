// Automatické založení poptávky — služba (domain/crm/autoIntakeService.ts) nad
// databází v paměti a falešnou RPC auto_intake_found. Ověřuje tok zprávy
// (skip / auto / návrh), idempotenci, denní limit, dva klienty, paměť
// zamítnutých domén, chybějící migrace a to, že ze statistik a logu
// neunikne jméno, adresa ani doména. SQL samotné je v test/auto-intake-pglite.test.ts.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryDb } from './helpers/memoryDb'
import { createSupabaseFake } from './helpers/supabaseFake'

const state = vi.hoisted(() => ({ db: null as unknown, logs: [] as unknown[][] }))
const mem = () => state.db as MemoryDb

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mem().client }))
vi.mock('@/core/auditDb', () => ({ createAuditedAdminClient: () => mem().client, dbAuditActive: async () => true }))
vi.mock('@/lib/log', () => ({
  logError: (...a: unknown[]) => { state.logs.push(a) },
  logWarn: (...a: unknown[]) => { state.logs.push(a) },
}))

import { COMPANY } from '@/config'
import type { AutoIntakeConfig, CompanyConfig } from '@/core/tenant'
import type { AuditContext } from '@/core/auditCoverage'
import {
  AutoIntakeMigrationMissing,
  loadIntakeContext,
  runAutoIntake,
  runAresForNewAccounts,
  type AutoIntakeDeps,
} from '@/domain/crm/autoIntakeService'
import { supabaseAresEnrichDb } from '@/domain/crm/aresEnrich'
import type { IntakeCandidate } from '@/domain/crm/autoIntake'

const CFG = COMPANY.capabilities.autoIntake as AutoIntakeConfig
const OWNER = '11111111-1111-4111-8111-111111111111'
const MAILBOX = 'viktor@mummiesdaddies.com'
const NOW = new Date('2026-09-29T10:00:00Z')

const NAME = 'Jan Novák'
const ADDRESS = 'jan.novak@acme-stroje.cz'

function cand(over: Partial<IntakeCandidate> = {}): IntakeCandidate {
  return {
    messageId: '<m1@acme-stroje.cz>',
    occurredAt: '2026-09-29T07:30:00.000Z',
    webLink: 'https://outlook.office.com/mail/id/1',
    fromAddress: ADDRESS,
    fromName: NAME,
    to: [MAILBOX],
    cc: [],
    matchStatus: 'unknown',
    ...over,
  }
}

const other = (n: number, over: Partial<IntakeCandidate> = {}): IntakeCandidate =>
  cand({
    messageId: `<m${n}@firma${n}.cz>`,
    fromAddress: `petr.svoboda${n}@firma${n}.cz`,
    fromName: `Petr Svoboda${'x'.repeat(0)}`,
    ...over,
  })

/** Zjednodušený emulátor RPC: stejná pravidla jako SQL (idempotence, doména, limit, zamítnutí). */
function fakeServer(opts: { migrationMissing?: boolean; failFor?: string; force?: Record<string, unknown> } = {}) {
  const byMessage = new Map<string, number>()
  const byDomain = new Map<string, number>()
  const payloads: Record<string, unknown>[] = []
  let nextAccount = 100
  let created = 0
  const rpc = vi.fn(async (name: string, args: { p: Record<string, unknown> }) => {
    if (opts.migrationMissing) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    if (name !== 'auto_intake_found') return { data: null, error: { code: 'PGRST202', message: 'x' } }
    const p = args.p
    payloads.push(p)
    if (opts.failFor && p.message_id === opts.failFor) return { data: null, error: { code: 'XX000', message: `boom ${String(p.domain)}` } }
    const forced = opts.force?.[p.message_id as string]
    if (forced) return { data: forced, error: null }
    if (byMessage.has(p.message_id as string)) return { data: { status: 'duplicate', account_id: byMessage.get(p.message_id as string) }, error: null }
    if (byDomain.has(p.domain as string)) return { data: { status: 'attached', account_id: byDomain.get(p.domain as string) }, error: null }
    if (created >= (p.daily_limit as number)) return { data: { status: 'limit', count: created }, error: null }
    const id = nextAccount++
    created++
    byMessage.set(p.message_id as string, id)
    byDomain.set(p.domain as string, id)
    return { data: { status: 'created', id: created, account_id: id }, error: null }
  })
  return { rpc, payloads, byMessage }
}

function freshDb(fail?: ConstructorParameters<typeof MemoryDb>[0]) {
  const db = new MemoryDb({
    unique: {
      evidence: [{ columns: ['source_kind', 'source_id'] }],
      case_proposal: [
        { columns: ['capability', 'source_key'] },
        { columns: ['capability', 'account_id', 'node'], where: (r) => r.status === 'pending' && r.account_id != null },
      ],
    },
    ...fail,
  })
  db.seed('team_member', [{ id: OWNER, email: MAILBOX }])
  state.db = db
  return db
}

let server: ReturnType<typeof fakeServer>
let auditCtx: AuditContext[]

function deps(over: Partial<AutoIntakeDeps> = {}): AutoIntakeDeps {
  return {
    tenant: COMPANY,
    candidates: [cand()],
    ownerId: OWNER,
    now: NOW,
    env: {},
    db: { from: (t: string) => mem().from(t), rpc: server.rpc } as never,
    auditedDb: (ctx) => { auditCtx.push(ctx); return { from: (t: string) => mem().from(t), rpc: server.rpc } as never },
    ...over,
  }
}

beforeEach(() => {
  state.logs = []
  auditCtx = []
  server = fakeServer()
  freshDb()
})

const proposals = () => mem().rows('case_proposal')

describe('vypnuto, konfigurace, prázdný běh', () => {
  test('firma bez autoIntake: vypnuto, nic se nečte', async () => {
    const r = await runAutoIntake(deps({ tenant: { ...COMPANY, capabilities: { ...COMPANY.capabilities, autoIntake: null } } as unknown as CompanyConfig }))
    expect(r).toMatchObject({ disabled: true, created: 0 })
    expect(mem().calls).toHaveLength(0)
    expect(server.rpc).not.toHaveBeenCalled()
  })

  test('chybná konfigurace = běh skončí a nic nezapíše', async () => {
    const broken = { ...COMPANY, capabilities: { ...COMPANY.capabilities, autoIntake: { ...CFG, dailyLimit: 0 } } } as unknown as CompanyConfig
    const r = await runAutoIntake(deps({ tenant: broken }))
    expect(r.aborted).toContain('dailyLimit')
    expect(server.rpc).not.toHaveBeenCalled()
    expect(mem().calls).toHaveLength(0)
  })

  test('žádní kandidáti: žádný dotaz do databáze', async () => {
    const r = await runAutoIntake(deps({ candidates: [] }))
    expect(r).toMatchObject({ candidates: 0, created: 0 })
    expect(mem().calls).toHaveLength(0)
  })
})

describe('vysoká jistota → založení', () => {
  test('RPC dostane vlastníka, Kvalifikaci, další krok, úkol a označení; audit jde jako system:auto_intake', async () => {
    const r = await runAutoIntake(deps())
    expect(r).toMatchObject({ candidates: 1, created: 1, proposed: 0, createdAccountIds: [100], limitReached: false, dailyLimit: 10 })
    expect(server.rpc).toHaveBeenCalledTimes(1)
    const p = server.payloads[0] as Record<string, Record<string, unknown> & string>
    expect(p).toMatchObject({
      message_id: '<m1@acme-stroje.cz>', domain: 'acme-stroje.cz', owner_id: OWNER, today: '2026-09-29', daily_limit: 10,
      account: { name: 'Acme Stroje' },
      contact: { full_name: NAME, email: ADDRESS },
      deal: { stage: 'kvalifikace', next_step: 'Odpovědět na poptávku', next_step_due: '2026-09-30', revenue_category: 'one_time' },
      task: { title: 'Odpovědět na poptávku — Acme Stroje', due_on: '2026-09-30' },
    })
    // audit: aktér automatu, stav „fakt ze zdroje", odkaz na zprávu
    expect(auditCtx).toEqual([{ actor: { type: 'system', id: 'auto_intake' }, evidenceId: 1, infoState: 'source_fact' }])
    expect(mem().rows('evidence')).toEqual([expect.objectContaining({ source_kind: 'email_message', source_id: '<m1@acme-stroje.cz>' })])
    expect(proposals()).toHaveLength(0)
  })

  test('opakovaný sync téže zprávy nezaloží nic dvakrát', async () => {
    const first = await runAutoIntake(deps())
    const second = await runAutoIntake(deps())
    expect(first.created).toBe(1)
    expect(second).toMatchObject({ created: 0, duplicates: 1, createdAccountIds: [] })
    expect(server.byMessage.size).toBe(1)
    expect(mem().rows('evidence')).toHaveLength(1)
  })

  test('dvě zprávy téže domény v jednom běhu: klient jen jeden, druhá je aktivita', async () => {
    const r = await runAutoIntake(deps({ candidates: [cand(), cand({ messageId: '<m2@acme-stroje.cz>', occurredAt: '2026-09-29T08:00:00.000Z' })] }))
    expect(r).toMatchObject({ created: 1, attached: 1 })
    expect(r.createdAccountIds).toEqual([100])
  })

  test('deadline běhu: další zpráva se nezačne, zbytek je v deferred', async () => {
    let n = 0
    const r = await runAutoIntake(deps({
      candidates: [cand(), cand({ messageId: '<m2@acme-stroje.cz>', occurredAt: '2026-09-29T08:00:00.000Z' })],
      shouldStop: () => n++ >= 1,
    }))
    expect(r).toMatchObject({ created: 1, deferred: 1 })
    expect(server.rpc).toHaveBeenCalledTimes(1)
  })

  test('kandidát se dvěma stejnými zprávami se zpracuje jednou', async () => {
    const r = await runAutoIntake(deps({ candidates: [cand(), cand()] }))
    expect(r.candidates).toBe(1)
    expect(server.rpc).toHaveBeenCalledTimes(1)
  })

  test('denní limit z prostředí přebije konfiguraci', async () => {
    await runAutoIntake(deps({ env: { AUTO_INTAKE_DAILY_LIMIT: '3' } }))
    expect((server.payloads[0] as { daily_limit: number }).daily_limit).toBe(3)
  })

  test('doména už v CRM podle webu klienta → RPC dostane zprávu a založí jen aktivitu', async () => {
    mem().seed('account', [{ id: 5, name: 'Acme', web: 'https://www.acme-stroje.cz/' }])
    server = fakeServer({ force: { '<m1@acme-stroje.cz>': { status: 'attached', account_id: 5 } } })
    const r = await runAutoIntake(deps())
    expect(r).toMatchObject({ created: 0, attached: 1, createdAccountIds: [] })
  })
})

describe('denní limit', () => {
  test('nad limit nic nezakládá; zbytek jde jako návrh ke schválení', async () => {
    const list = [1, 2, 3, 4].map((n) => other(n, { occurredAt: `2026-09-29T0${n}:00:00.000Z` }))
    const r = await runAutoIntake(deps({ candidates: list, env: { AUTO_INTAKE_DAILY_LIMIT: '2' } }))
    expect(r).toMatchObject({ created: 2, proposed: 2, limitReached: true, dailyLimit: 2 })
    expect(proposals()).toHaveLength(2)
    expect(proposals()[0]).toMatchObject({ capability: 'mail_new_inquiry', status: 'pending', account_id: null, method: 'rule' })
    expect(String(proposals()[0].rationale)).toContain('limit')
  })
})

describe('nižší jistota → návrh ke schválení', () => {
  test('obecná schránka info@ = návrh case_proposal, nic se nezakládá', async () => {
    const r = await runAutoIntake(deps({ candidates: [cand({ fromAddress: 'info@acme-stroje.cz', fromName: 'Acme Stroje' })] }))
    expect(r).toMatchObject({ created: 0, proposed: 1 })
    expect(server.rpc).not.toHaveBeenCalled()
    expect(proposals()).toHaveLength(1)
    const p = proposals()[0]
    expect(p).toMatchObject({
      capability: 'mail_new_inquiry', source_key: 'outlook:inbox|inquiry.domain|acme-stroje.cz', node: 'obchod',
      account_id: null, status: 'pending', info_state: 'ai_suggestion', method: 'rule', title: 'Nová poptávka z domény acme-stroje.cz — ověřit',
      created_by: 'system:mail_new_inquiry',
    })
    expect(p.steps).toEqual(CFG.proposalSteps)
    expect(mem().rows('evidence')).toHaveLength(1)
  })

  test('druhá zpráva téže domény ani druhý běh nezdvojí návrh', async () => {
    const c = cand({ fromAddress: 'info@acme-stroje.cz', fromName: null })
    await runAutoIntake(deps({ candidates: [c] }))
    const again = await runAutoIntake(deps({ candidates: [c, { ...c, messageId: '<m2@acme-stroje.cz>' }] }))
    expect(again).toMatchObject({ proposed: 0 })
    expect(again.skipped).toEqual({ has_proposal: 2 })
    expect(proposals()).toHaveLength(1)
  })

  test('zamítnutý návrh: další zpráva ze stejné domény nezaloží ani automaticky', async () => {
    mem().seed('case_proposal', [{
      id: 1, capability: 'mail_new_inquiry', source_key: 'outlook:inbox|inquiry.domain|acme-stroje.cz', status: 'rejected', account_id: null,
    }])
    const r = await runAutoIntake(deps())
    expect(r.skipped).toEqual({ rejected: 1 })
    expect(server.rpc).not.toHaveBeenCalled()
  })

  test('doména vrácená tlačítkem „Není poptávka" je zamítnutá', async () => {
    mem().seed('auto_intake', [{ id: 1, domain: 'acme-stroje.cz', status: 'undone' }])
    const r = await runAutoIntake(deps())
    expect(r.skipped).toEqual({ rejected: 1 })
    expect(server.rpc).not.toHaveBeenCalled()
  })

  test('RPC řekne „rejected" (souběh): zpráva se nezaloží a je to počítané jako zamítnutá', async () => {
    server = fakeServer({ force: { '<m1@acme-stroje.cz>': { status: 'rejected' } } })
    const r = await runAutoIntake(deps())
    expect(r).toMatchObject({ created: 0, skipped: { rejected: 1 } })
    expect(proposals()).toHaveLength(0)
  })

  test('RPC řekne „name_conflict": zpráva nezmizí, jde jako návrh', async () => {
    server = fakeServer({ force: { '<m1@acme-stroje.cz>': { status: 'name_conflict' } } })
    const r = await runAutoIntake(deps())
    expect(r).toMatchObject({ created: 0, proposed: 1 })
    expect(String(proposals()[0].rationale)).toContain('stejným názvem')
  })
})

describe('e-mail se dvěma klienty', () => {
  test('v kopii je známý klient → návrh (nikdy automat), návrh míří na jeho firmu', async () => {
    mem().seed('account', [{ id: 7, name: 'Známý klient s.r.o.' }])
    mem().seed('contact', [{ id: 1, account_id: 7, partner_id: null, email: 'petr@znamy-klient.cz' }])
    const r = await runAutoIntake(deps({ candidates: [cand({ cc: ['petr@znamy-klient.cz'] })] }))
    expect(r).toMatchObject({ created: 0, proposed: 1 })
    expect(server.rpc).not.toHaveBeenCalled()
    const p = proposals()[0]
    expect(p).toMatchObject({ title: 'E-mail se dvěma klienty — rozhodni, komu patří', account_id: 7 })
    expect(String(p.rationale)).toContain('Známý klient s.r.o.')
  })

  test('doména odesílatele patří dvěma klientům → návrh bez firmy, jmenuje oba', async () => {
    mem().seed('account', [{ id: 3, name: 'Alfa s.r.o.' }, { id: 9, name: 'Beta a.s.' }])
    mem().seed('company_alias', [
      { id: 1, account_id: 3, alias_domain: 'acme-stroje.cz' },
      { id: 2, account_id: 9, alias_domain: 'acme-stroje.cz' },
    ])
    const r = await runAutoIntake(deps({ candidates: [cand({ matchStatus: 'ambiguous' })] }))
    expect(r).toMatchObject({ created: 0, proposed: 1 })
    expect(proposals()[0]).toMatchObject({ account_id: null })
    expect(String(proposals()[0].rationale)).toMatch(/Alfa s\.r\.o\., Beta a\.s\.|Beta a\.s\., Alfa s\.r\.o\./)
  })

  test('RPC řekne „ambiguous": návrh se dvěma klienty', async () => {
    mem().seed('account', [{ id: 3, name: 'Alfa' }, { id: 9, name: 'Beta' }])
    server = fakeServer({ force: { '<m1@acme-stroje.cz>': { status: 'ambiguous', account_ids: [3, 9] } } })
    const r = await runAutoIntake(deps())
    expect(r.proposed).toBe(1)
    expect(proposals()[0].title).toBe('E-mail se dvěma klienty — rozhodni, komu patří')
  })
})

describe('co se nikdy nezaloží', () => {
  const NEVER: [string, Partial<IntakeCandidate>][] = [
    ['freemail', { fromAddress: 'jan.novak@gmail.com' }],
    ['interní adresa', { fromAddress: 'lenka@mummiesdaddies.com' }],
    ['no-reply', { fromAddress: 'no-reply@acme-stroje.cz' }],
    ['hromadná zpráva', { cc: Array.from({ length: 9 }, (_, i) => `x${i}@jina${i}.cz`) }],
    ['stará zpráva', { occurredAt: '2026-09-20T10:00:00.000Z' }],
  ]
  test.each(NEVER)('%s: žádné RPC ani návrh', async (_label, over) => {
    const r = await runAutoIntake(deps({ candidates: [cand(over)] }))
    expect(r).toMatchObject({ created: 0, proposed: 0 })
    expect(server.rpc).not.toHaveBeenCalled()
    expect(proposals()).toHaveLength(0)
    expect(mem().rows('evidence')).toHaveLength(0)
  })

  test('partner: doména z kontaktu partnera', async () => {
    mem().seed('contact', [{ id: 1, account_id: null, partner_id: 4, email: 'jan.novak@acme-stroje.cz' }])
    const r = await runAutoIntake(deps())
    expect(r.skipped).toEqual({ partner: 1 })
  })

  test('adresa schránky neznámá → nikdy „přímo": jen návrh', async () => {
    mem().tables.team_member = []
    const r = await runAutoIntake(deps())
    expect(r).toMatchObject({ created: 0, proposed: 1 })
  })
})

describe('chyby a chybějící migrace', () => {
  test('RPC neexistuje (0081 neaplikovaná): běh skončí hláškou, ostatní se nezkouší', async () => {
    server = fakeServer({ migrationMissing: true })
    const r = await runAutoIntake(deps({ candidates: [other(1), other(2)] }))
    expect(r.aborted).toBe('Automatické zakládání poptávek čeká na migraci 0081.')
    expect(r.created).toBe(0)
    expect(server.rpc).toHaveBeenCalledTimes(1)
  })

  test('tabulka auto_intake neexistuje: běh skončí hláškou a nic nezapíše', async () => {
    freshDb({ fail: (t, op) => (t === 'auto_intake' && op === 'select' ? { code: '42P01', message: 'relation "auto_intake" does not exist' } : null) })
    const r = await runAutoIntake(deps())
    expect(r.aborted).toContain('0081')
    expect(server.rpc).not.toHaveBeenCalled()
    await expect(loadIntakeContext(mem().client as never, { tenant: COMPANY, ownerId: OWNER, now: NOW, env: {} })).rejects.toBeInstanceOf(AutoIntakeMigrationMissing)
  })

  test('chybí case_proposal (0067): automat funguje, návrhy ne', async () => {
    freshDb({ fail: (t) => (t === 'case_proposal' ? { code: '42P01', message: 'missing' } : null) })
    const created = await runAutoIntake(deps())
    expect(created.created).toBe(1)
    const info = await runAutoIntake(deps({ candidates: [cand({ messageId: '<i@x.cz>', fromAddress: 'info@x-firma.cz', fromName: null })] }))
    expect(info.aborted).toBeTruthy()
    expect(info.proposed).toBe(0)
  })

  test('chyba u jedné zprávy neshodí ostatní; do logu jde jen kód', async () => {
    server = fakeServer({ failFor: '<m1@firma1.cz>' })
    const r = await runAutoIntake(deps({ candidates: [other(1), other(2)] }))
    expect(r).toMatchObject({ created: 1, errors: 1, firstError: 'auto_intake_found: XX000' })
    const logged = JSON.stringify(state.logs)
    expect(logged).toContain('XX000')
    expect(logged).not.toMatch(/firma1\.cz|boom/)
  })

  test('neočekávaná odpověď RPC se počítá jako chyba, ne jako založení', async () => {
    server = fakeServer({ force: { '<m1@acme-stroje.cz>': { status: 'kdovi' } } })
    const r = await runAutoIntake(deps())
    expect(r).toMatchObject({ created: 0, errors: 1 })
  })
})

describe('stropy a soukromí', () => {
  test('z jednoho běhu se zpracuje nejvýš 100 nejnovějších kandidátů', async () => {
    const list = Array.from({ length: 130 }, (_, i) => other(i + 1, { fromAddress: `no-reply@f${i}.cz`, occurredAt: new Date(NOW.getTime() - (130 - i) * 60_000).toISOString() }))
    const r = await runAutoIntake(deps({ candidates: list }))
    expect(r.candidates).toBe(100)
  })

  test('návrhů z jednoho běhu je nejvýš 20', async () => {
    const list = Array.from({ length: 30 }, (_, i) => other(i + 1, { fromAddress: `info@f${i + 1}-firma.cz`, fromName: null, occurredAt: new Date(NOW.getTime() - (30 - i) * 60_000).toISOString() }))
    const r = await runAutoIntake(deps({ candidates: list }))
    expect(r.proposed).toBe(20)
    expect(r.skipped).toEqual({ proposal_limit: 10 })
  })

  test('statistiky ani log neobsahují jméno, adresu ani doménu odesílatele', async () => {
    server = fakeServer({ failFor: '<m9@boom.cz>' })
    const r = await runAutoIntake(deps({
      candidates: [cand(), cand({ messageId: '<i@i.cz>', fromAddress: 'info@bila-firma.cz', fromName: 'Bílá firma' }), other(9, { messageId: '<m9@boom.cz>', fromAddress: 'karel.cerny@boom.cz', fromName: 'Karel Černý' })],
    }))
    const blob = JSON.stringify([r, state.logs])
    for (const secret of [NAME, ADDRESS, 'Novák', 'acme-stroje', 'bila-firma', 'Karel', 'boom.cz', MAILBOX]) expect(blob).not.toContain(secret)
  })

  test('jméno a adresa jdou jen do RPC (kontakt), do návrhu nikdy', async () => {
    await runAutoIntake(deps({ candidates: [cand(), cand({ messageId: '<i@i.cz>', fromAddress: 'info@bila-firma.cz', fromName: 'Bílá Firma Praha' })] }))
    expect(JSON.stringify(server.payloads)).toContain(ADDRESS)
    expect(JSON.stringify(proposals())).not.toMatch(/@|Bílá|Novák/)
  })
})

describe('ARES pro nové klienty', () => {
  test('zúžená dávka se ptá jen na dané klienty a sídlo nedoplňuje', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    const ares = supabaseAresEnrichDb(fake.client as never, { type: 'system', id: 'job:ares-enrich' }, { onlyAccountIds: [100, 101] })
    expect(await ares.loadMissingIco(5)).toEqual([])
    expect(await ares.loadRegionBackfill(5)).toEqual([])
    expect(fake.calls).toHaveLength(1) // sídlo se v zúžené dávce nedotazuje vůbec
    const ops = fake.calls[0].ops.map((o) => [o.method, ...o.args])
    expect(ops).toContainEqual(['in', 'id', [100, 101]])
    expect(ops).toContainEqual(['is', 'ico', null])
    expect(ops).toContainEqual(['is', 'ares_status', null])
  })

  test('bez klientů se nedělá nic (žádné volání ARES ani DB)', async () => {
    const fake = createSupabaseFake()
    expect(await runAresForNewAccounts([], { client: fake.client as never })).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  test('nezúžená dávka zůstává beze změny (bez .in)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    const ares = supabaseAresEnrichDb(fake.client as never, { type: 'system', id: 'job:ares-enrich' })
    await ares.loadMissingIco(5)
    expect(fake.calls[0].ops.some((o) => o.method === 'in')).toBe(false)
  })
})
