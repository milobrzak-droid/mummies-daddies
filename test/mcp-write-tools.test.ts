import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryDb, type MemoryDbOptions } from './helpers/memoryDb'

// Rozšíření konektoru (MCP + REST /api/v1): update_deal (jen bezpečná pole),
// create_contact, update_contact, get_activities, get_tasks, update_task_status
// a get_approvals. Dotazy běží nad databází v paměti; hlídá se oprávnění
// (scope read vs full, role bez canSeeSales), validace a pravidla fází,
// audit jménem vlastníka klíče a bezpečné párování klienta (nikdy nehádat).

let db: MemoryDb
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }))
const auditCtx: unknown[] = []
vi.mock('@/core/auditDb', () => ({
  createAuditedAdminClient: (ctx: unknown) => { auditCtx.push(ctx); return db.client },
  dbAuditActive: async () => true,
  dbSoftAuditActive: async () => true,
}))
const czkPerEur = vi.fn(async () => 25)
vi.mock('@/connectors/cnb', () => ({ czkPerEur: () => czkPerEur() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { serveMcp, SALES_REFUSAL } from '@/lib/mcpServer'
import { NEEDS_APPROVAL, applyDealChanges, updateDealForApi } from '@/domain/crm/apiDeals'
import { createContactForApi, updateContactForApi, OPT_OUT_CLEAR_REFUSED } from '@/domain/crm/apiContacts'
import { resolveAccountInIndex, similarAccounts } from '@/domain/crm/apiAccountMatch'
import { hashApiKey } from '@/lib/apiKeyAuth'
import * as dealsRoute from '@/app/api/v1/deals/route'
import { POST as dealsUpdatePost } from '@/app/api/v1/deals/update/route'
import { GET as approvalsGet } from '@/app/api/v1/approvals/route'
import { GET as tasksGet } from '@/app/api/v1/tasks/route'

const ACTOR = { actor: { type: 'api_key', id: 'user-1' } }

function seed(opts: MemoryDbOptions = {}) {
  db = new MemoryDb(opts)
  auditCtx.length = 0
  db.seed('team_member', [
    { id: 'user-1', full_name: 'Viktor', role: 'vedeni', deactivated_at: null },
    { id: 'user-2', full_name: 'Petra', role: 'projektak', deactivated_at: null },
  ])
  db.seed('account', [
    { id: 1, name: 'Alfa s.r.o.', ico: '27074358', owner_id: 'owner-a' },
    { id: 2, name: 'Beta a.s.', ico: null, owner_id: null },
    { id: 3, name: 'BETA, a.s.', ico: null, owner_id: null },
    { id: 4, name: 'Gama Logistika', ico: null, owner_id: null },
  ])
  db.seed('company_alias', [{ id: 1, account_id: 4, alias_name: 'Gama Log' }])
  db.seed('partner', [{ id: 9, name: 'BETA TRADE' }])
  db.seed('deal', [
    {
      id: 10, account_id: 1, title: 'Pilot AI', stage: 'diagnostika', currency: 'CZK', amount_one_time: 100000,
      amount_one_time_original: null, fx_rate: null, probability_pct: 30, pillar: null, phase: null,
      next_step: 'Zavolat', next_step_due: '2026-10-20', lost_reason: null, decision_maker: null, decision_due: null,
      won_at: null, closed_at: null,
    },
    {
      id: 11, account_id: 2, title: 'Školení', stage: 'rozsah_nabidka', currency: 'EUR', amount_one_time: 50000,
      amount_one_time_original: 2000, fx_rate: 25, probability_pct: 55, pillar: null, phase: null,
      next_step: null, next_step_due: null, lost_reason: null, decision_maker: 'CEO', decision_due: '2026-11-01',
      won_at: null, closed_at: null,
    },
  ])
  db.seed('contact', [
    { id: 21, account_id: 1, partner_id: null, full_name: 'Jana Nováková', email: 'jana@alfa.cz', role: 'CFO', do_not_contact: false },
    { id: 22, account_id: 1, partner_id: null, full_name: 'Petr Svoboda', email: 'petr@alfa.cz', role: null, do_not_contact: true },
  ])
  db.seed('task', [
    { id: 31, title: 'Můj úkol', status: 'todo', priority: 'normal', assignee_id: 'user-1', created_by: 'user-2', due_on: '2026-10-10', account_id: 1, deal_id: 10, description: null, created_at: 'x', updated_at: 'x' },
    { id: 32, title: 'Hotový', status: 'done', priority: 'normal', assignee_id: 'user-1', created_by: 'user-1', due_on: null, account_id: null, deal_id: null, description: null, created_at: 'x', updated_at: 'x' },
    { id: 33, title: 'Cizí', status: 'todo', priority: 'high', assignee_id: 'user-2', created_by: 'user-2', due_on: '2026-10-09', account_id: null, deal_id: 10, description: null, created_at: 'x', updated_at: 'x' },
  ])
}

beforeEach(() => {
  seed()
  czkPerEur.mockClear()
})

const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
const call = (name: string, args: unknown = {}) =>
  new Request('http://localhost/api/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
type ToolResult = { isError?: boolean; content: { text: string }[] }
const run = async (name: string, args: unknown = {}, scope: 'read' | 'full' = 'full', sales = true, owner: string | null = 'user-1') =>
  (await (await serveMcp(call(name, args), owner, scope, sales)).json()).result as ToolResult
const json = async (name: string, args: unknown = {}, scope: 'read' | 'full' = 'read', sales = true) => {
  const r = await run(name, args, scope, sales)
  expect(r.isError, r.content[0].text).toBeUndefined()
  return JSON.parse(r.content[0].text)
}
const writes = () => db.calls.filter((c) => c.op === 'insert' || c.op === 'update' || c.op === 'upsert' || c.op === 'delete')

describe('oprávnění: scope read vs full, role bez canSeeSales', () => {
  const SRC = { kind: 'email', message_id: 'AAMk-1', subject: 'Nabídka' }
  const writeTools: [string, Record<string, unknown>][] = [
    ['propose_deal', { account_id: 1, title: 'Nový', source: SRC }],
    ['propose_deals', { items: [{ account_id: 1, title: 'Nový', source: SRC }] }],
    ['propose_deal_update', { deal_id: 10, amount: 1, source: SRC }],
    ['update_deal', { deal_id: 10, note: 'x' }],
    ['create_contact', { account_id: 1, full_name: 'Karel' }],
    ['update_contact', { contact_id: 21, role: 'CEO' }],
    ['update_task_status', { task_id: 31, status: 'done' }],
  ]

  it.each(writeTools)('%s se scope read: odmítnuto, nic se nezapíše', async (name, args) => {
    const r = await run(name, args, 'read', true)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('jen pro čtení')
    expect(writes()).toEqual([])
  })

  it.each(writeTools.filter(([n]) => n !== 'update_task_status'))('%s bez obchodní role: odmítnuto, nic se nezapíše', async (name, args) => {
    const r = await run(name, args, 'full', false, 'user-2')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/jen obchodní role/)
    expect(writes()).toEqual([])
  })

  it('create_deal přes konektor neexistuje (nahradil ho propose_deal)', async () => {
    const r = await run('create_deal', { account_id: 1, title: 'Nový' })
    expect(r.isError).toBe(true)
    expect(writes()).toEqual([])
  })

  it('update_deal bez obchodní role vrací hlášku o obchodech', async () => {
    expect((await run('update_deal', { deal_id: 10, note: 'x' }, 'full', false)).content[0].text).toBe(SALES_REFUSAL)
  })

  it('stav vlastního úkolu smí změnit i role bez obchodů (scope full)', async () => {
    const r = await run('update_task_status', { task_id: 33, status: 'in_progress' }, 'full', false, 'user-2')
    expect(r.isError).toBeUndefined()
    expect(db.rows('task').find((t) => t.id === 33)?.status).toBe('in_progress')
  })

  it('get_activities jen obchodní role; get_tasks a get_approvals i scope read bez obchodů', async () => {
    expect((await run('get_activities', {}, 'read', false)).isError).toBe(true)
    expect((await run('get_activities', {}, 'read', true)).isError).toBeUndefined()
    expect((await run('get_tasks', {}, 'read', false)).isError).toBeUndefined()
    expect((await run('get_approvals', {}, 'read', false)).isError).toBeUndefined()
  })

  it('domain vrstva sama odmítne bez obchodní role (REST i MCP sdílí pravidlo)', async () => {
    expect(await updateDealForApi({ deal_id: 10, note: 'x' }, 'user-2', false)).toMatchObject({ ok: false, status: 403 })
    expect(await createContactForApi({ account_id: 1, full_name: 'x' }, 'user-2', false)).toMatchObject({ ok: false, status: 403 })
    expect(await updateContactForApi({ contact_id: 21, role: 'x' }, 'user-2', false)).toMatchObject({ ok: false, status: 403 })
  })
})

describe('párování klienta podle názvu: nikdy nehádat', () => {
  it('alias a IČO párují (kontakt)', async () => {
    expect((await run('create_contact', { account_name: 'Gama Log', full_name: 'Olga' })).isError).toBeUndefined()
    expect(db.rows('contact').find((c) => c.full_name === 'Olga')?.account_id).toBe(4)
    expect((await run('create_contact', { account_name: 'cokoli', account_ico: '27074358', full_name: 'Přes IČO' })).isError).toBeUndefined()
    expect(db.rows('contact').find((c) => c.full_name === 'Přes IČO')?.account_id).toBe(1)
  })

  it('víc klientů stejného jména = chyba se všemi kandidáty, kontakt se nezaloží', async () => {
    const r = await run('create_contact', { account_name: 'Beta', full_name: 'X' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('(id 2)')
    expect(r.content[0].text).toContain('(id 3)')
    expect(r.content[0].text).toMatch(/Nehádám/)
    expect(writes()).toEqual([])
  })

  it('neznámý klient = chyba s podobnými kandidáty, nový klient se nezakládá', async () => {
    const r = await run('create_contact', { account_name: 'Alfa Group', full_name: 'X' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('„Alfa s.r.o." (id 1)')
    expect(r.content[0].text).toMatch(/nezakládá/)
    expect(db.rows('account')).toHaveLength(4)
  })

  it('id i název najednou, ani jedno, nebo neexistující id = chyba', async () => {
    expect((await run('create_contact', { account_id: 1, account_name: 'Alfa', full_name: 'x' })).content[0].text).toMatch(/jen jedno/)
    expect((await run('create_contact', { full_name: 'x' })).isError).toBe(true)
    expect((await run('create_contact', { account_id: 999, full_name: 'x' })).content[0].text).toMatch(/není/)
    expect(writes()).toEqual([])
  })

  it('čisté funkce: kandidáti jen jako nápověda', () => {
    const index = { accounts: db.rows('account') as { id: number; name: string; ico: string | null }[], aliases: [] }
    expect(resolveAccountInIndex('beta a.s.', null, index)).toMatchObject({ ok: false, status: 409 })
    expect(resolveAccountInIndex('Gama Logistika s.r.o.', null, index)).toMatchObject({ ok: true, id: 4, by: 'name' })
    expect(similarAccounts('Gama', index.accounts)).toEqual([{ id: 4, name: 'Gama Logistika' }])
    expect(similarAccounts('xy', index.accounts)).toEqual([])
  })
})

describe('update_deal: přímo jen bezpečná pole, peníze a stav přes návrh', () => {
  it('změní další krok, termín, poznámku, uzavření a MD; vrátí názvy změněných sloupců', async () => {
    const r = await run('update_deal', { deal_id: 10, estimate_md: 5, expected_close: '2026-12-01', note: null, next_step: 'Poslat rozsah', next_step_due: '2026-10-30' })
    expect(r.isError, r.content[0].text).toBeUndefined()
    expect(r.content[0].text).toContain('estimate_md')
    expect(db.rows('deal').find((d) => d.id === 10)).toMatchObject({
      estimate_md: 5, expected_close: '2026-12-01', note: null, next_step: 'Poslat rozsah', next_step_due: '2026-10-30',
      amount_one_time: 100000, stage: 'diagnostika', title: 'Pilot AI',
    })
    expect(auditCtx).toEqual([ACTOR])
  })

  it('částka, náklad, fáze i prohra přímo NEJDOU (hláška odkáže na propose_deal_update)', async () => {
    for (const extra of [{ amount: 1 }, { cogs: 1 }, { stage: 'vyhráno' }, { stage: 'prohráno', lost_reason: 'x' }, { pillar: 'cheesecaky' }]) {
      const res = await updateDealForApi({ deal_id: 10, ...extra }, 'user-1', true)
      expect(res).toMatchObject({ ok: false, status: 403, error: NEEDS_APPROVAL })
    }
    // MCP schéma neznámá pole zahodí — bez povoleného pole se nic nemění.
    expect((await run('update_deal', { deal_id: 10, amount: 999 })).content[0].text).toMatch(/Nic ke změně/)
    expect(writes()).toEqual([])
  })

  it('pole mimo whitelist (title, owner_id, account_id) neprojde', async () => {
    for (const extra of [{ title: 'jiný' }, { owner_id: 'u' }, { account_id: 2 }]) {
      expect(await updateDealForApi({ deal_id: 10, ...extra }, 'user-1', true)).toMatchObject({ ok: false, status: 400 })
    }
    expect(writes()).toEqual([])
  })

  it('nástroj nesahá na nabídky ani schvalování odeslání', async () => {
    await run('update_deal', { deal_id: 10, next_step: 'Poslat nabídku', next_step_due: '2026-10-12' })
    const tables = new Set(db.calls.map((c) => c.table))
    expect(tables.has('deal_scope_version')).toBe(false)
    expect(tables.has('approval_request')).toBe(false)
  })

  it('neexistující obchod = 404', async () => {
    expect(await updateDealForApi({ deal_id: 999, note: 'x' }, 'user-1', true)).toMatchObject({ ok: false, status: 404 })
  })
})

describe('applyDealChanges (jádro schválené změny): přechody fází a kurz', () => {
  const USER = { type: 'user' as const, id: 'user-1' }
  it('prohráno jen s důvodem; s důvodem uzavře obchod a smaže další krok', async () => {
    expect((await applyDealChanges({ deal_id: 10, stage: 'prohráno' }, USER))).toMatchObject({ ok: false, error: expect.stringMatching(/důvod prohry/) })
    expect(writes()).toEqual([])
    expect((await applyDealChanges({ deal_id: 10, stage: 'prohráno', lost_reason: 'Rozpočet' }, USER)).ok).toBe(true)
    expect(db.rows('deal').find((d) => d.id === 10)).toMatchObject({
      stage: 'prohráno', lost_reason: 'Rozpočet', forecast_category: 'closed', probability_pct: 0,
      next_step: null, next_step_due: null, closed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
    expect(auditCtx).toEqual([{ actor: USER }])
  })

  it('lost_reason bez prohry a další krok spolu s uzavřením se odmítnou', async () => {
    expect((await applyDealChanges({ deal_id: 10, lost_reason: 'x' }, USER)).ok).toBe(false)
    expect((await applyDealChanges({ deal_id: 10, stage: 'vyhráno', next_step: 'Fakturovat' }, USER)).ok).toBe(false)
    expect(writes()).toEqual([])
  })

  it('do „rozhodovani" jen s rozhodovatelem a termínem (obchod 11 je má, 10 ne)', async () => {
    expect(await applyDealChanges({ deal_id: 10, stage: 'rozhodovani' }, USER)).toMatchObject({ ok: false, error: expect.stringMatching(/rozhoduje/) })
    expect((await applyDealChanges({ deal_id: 11, stage: 'rozhodovani' }, USER)).ok).toBe(true)
    expect(db.rows('deal').find((d) => d.id === 11)).toMatchObject({ stage: 'rozhodovani', probability_pct: 75 })
  })

  it('EUR obchod: částka v EUR se přepočte, ne přepíše Kč', async () => {
    await applyDealChanges({ deal_id: 11, amount: 3000 }, USER)
    expect(db.rows('deal').find((d) => d.id === 11)).toMatchObject({ amount_one_time: 75000, amount_one_time_original: 3000 })
  })
})

describe('kontakty', () => {
  it('create_contact: duplicita podle e-mailu i jména se nezaloží', async () => {
    expect((await run('create_contact', { account_id: 1, full_name: 'Někdo', email: 'JANA@alfa.cz' })).content[0].text).toContain('id 21')
    expect((await run('create_contact', { account_id: 1, full_name: 'jana novakova' })).content[0].text).toContain('id 21')
    expect(writes()).toEqual([])
  })

  it('create_contact u partnera a s nesouhlasem s oslovením; audit jménem klíče', async () => {
    const r = await run('create_contact', { partner_id: 9, full_name: 'Tomáš', email: 'tomas@td.cz', do_not_contact: true, do_not_contact_reason: 'Požádal' })
    expect(r.isError, r.content[0].text).toBeUndefined()
    expect(db.rows('contact').find((c) => c.full_name === 'Tomáš'))
      .toMatchObject({ partner_id: 9, account_id: null, do_not_contact: true, do_not_contact_reason: 'Požádal' })
    expect(auditCtx).toEqual([ACTOR])
  })

  it('create_contact: klient i partner najednou, neplatný e-mail = chyba', async () => {
    expect((await run('create_contact', { account_id: 1, partner_id: 9, full_name: 'x' })).isError).toBe(true)
    expect((await run('create_contact', { account_id: 1, full_name: 'x', email: 'neni-mail' })).content[0].text).toMatch(/email/)
    expect(writes()).toEqual([])
  })

  it('update_contact: úprava polí; nesouhlas s oslovením přes konektor zrušit nejde', async () => {
    expect((await run('update_contact', { contact_id: 21, role: 'CEO', phone: '+420 777 111 222' })).isError).toBeUndefined()
    expect(db.rows('contact').find((c) => c.id === 21)).toMatchObject({ role: 'CEO', phone: '+420 777 111 222', account_id: 1 })
    expect((await run('update_contact', { contact_id: 22, do_not_contact: false })).content[0].text).toContain(OPT_OUT_CLEAR_REFUSED)
    expect(db.rows('contact').find((c) => c.id === 22)?.do_not_contact).toBe(true)
  })

  it('update_contact: firmu ani mazání tudy změnit nejde', async () => {
    expect(await updateContactForApi({ contact_id: 21, account_id: 2 }, 'user-1', true)).toMatchObject({ ok: false, status: 400 })
    expect(writes()).toEqual([])
  })
})

describe('čtení: záznamy z jednání, úkoly, schválení', () => {
  beforeEach(() => {
    db.seed('sales_activity', [
      { id: 2, account_id: 1, partner_id: null, deal_id: 10, contact_id: 21, kind: 'meeting', outcome: 'completed', subject: 'Kickoff', body: 'x'.repeat(2500), occurred_at: '2026-10-02T08:00:00.000Z', follow_up_on: null, source: 'api', created_by: 'user-1', created_at: 'x' },
      { id: 1, account_id: null, partner_id: 9, deal_id: null, contact_id: null, kind: 'call', outcome: 'completed', subject: 'Hovor', body: null, occurred_at: '2026-09-01T08:00:00.000Z', follow_up_on: null, source: null, created_by: 'user-1', created_at: 'x' },
    ])
  })

  it('get_activities: nejnovější první, zkrácený zápis, jména klienta a partnera, filtry', async () => {
    const all = await json('get_activities')
    // Nejnovější první (MemoryDb řadí podle posledního order(), proto id souhlasí s časem).
    expect(all.items.map((a: { id: number }) => a.id)).toEqual([2, 1])
    expect(all.items[0]).toMatchObject({ body_truncated: true, account: { id: 1, name: 'Alfa s.r.o.' } })
    expect(all.items[0].body).toHaveLength(2000)
    expect(all.items[1]).toMatchObject({ partner: { id: 9, name: 'BETA TRADE' }, body_truncated: false })
    expect((await json('get_activities', { since: '2026-10-01' })).items.map((a: { id: number }) => a.id)).toEqual([2])
    expect((await json('get_activities', { deal_id: 10 })).total).toBe(1)
    expect((await json('get_activities', { limit: 1 })).next_offset).toBe(1)
  })

  it('get_tasks: výchozí moje a otevřené; deal_id jen pro obchodní role', async () => {
    const mine = await json('get_tasks')
    expect(mine.items.map((t: { id: number }) => t.id)).toEqual([31])
    expect(mine.items[0]).toMatchObject({ deal_id: 10, account: { id: 1, name: 'Alfa s.r.o.' } })
    const all = await json('get_tasks', { only_mine: false, only_open: false }, 'read', false)
    expect(all.total).toBe(3)
    expect(all.items.every((t: { deal_id: number | null }) => t.deal_id === null)).toBe(true)
  })

  it('update_task_status: cizí úkol odmítne, vlastní změní (audit jménem klíče)', async () => {
    expect((await run('update_task_status', { task_id: 33, status: 'done' })).content[0].text).toMatch(/není tvůj/)
    expect(writes()).toEqual([])
    const r = await run('update_task_status', { task_id: 31, status: 'done' })
    expect(r.content[0].text).toContain('todo → done')
    expect(auditCtx).toEqual([ACTOR])
    expect((await run('update_task_status', { task_id: 31, status: 'hotovo' })).isError).toBe(true)
  })

  it('get_approvals: jen čekající, nabídky jen obchodní role, parametry bez volného textu navíc', async () => {
    db.seed('work_case', [{ id: 5, title: 'Případ A' }])
    db.seed('approval_request', [
      { id: 1, case_id: 5, action_kind: 'external_commitment', requested_level: 'L2', requested_by: 'user-1', status: 'pending', created_at: '2026-10-01T00:00:00Z', expires_at: '2000-01-01T00:00:00Z', node: 'obchod', action_type: 'send_offer', target_table: 'deal_scope_version', target_id: 3, params: { deal_id: 10, version_id: 3, version: 2, secret: 'x' }, snoozed_until: null },
      { id: 2, case_id: 5, action_kind: 'confirm_next_step', requested_level: 'L1', requested_by: 'user-2', status: 'pending', created_at: '2026-10-02T00:00:00Z', expires_at: null, node: null, action_type: 'confirm_next_step', target_table: 'work_case', target_id: 5, params: { title: 'Zavolat', assignee_id: 'user-2', due_on: '2026-10-10', decision_id: null }, snoozed_until: null },
      { id: 3, case_id: null, action_kind: 'x', requested_level: 'L1', requested_by: 'user-2', status: 'approved', created_at: '2026-10-03T00:00:00Z', expires_at: null },
    ])
    const sales = await json('get_approvals')
    expect(sales.items.map((a: { id: number }) => a.id)).toEqual([1, 2])
    expect(sales.items[0]).toMatchObject({ case_title: 'Případ A', action_label: 'Odeslat nabídku klientovi', expired: true, params: { deal_id: 10, version_id: 3, version: 2 } })
    expect(sales.items[0].params.secret).toBeUndefined()
    const other = await json('get_approvals', {}, 'read', false)
    expect(other.items.map((a: { id: number }) => a.id)).toEqual([2])
    expect(other.total).toBe(1)
  })

  it('get_approvals bez migrace 0084 (sloupce akce chybí) a bez tabulky nespadne', async () => {
    seed({ fail: (table, op, _p, cols) => (table === 'approval_request' && cols?.includes('action_type') ? { code: '42703', message: 'column action_type does not exist' } : null) })
    db.seed('approval_request', [{ id: 1, case_id: null, action_kind: 'x', requested_level: 'L1', requested_by: 'u', status: 'pending', created_at: '2026-10-01T00:00:00Z', expires_at: null }])
    expect((await json('get_approvals')).items).toEqual([expect.objectContaining({ id: 1, action_type: null, params: null })])
    seed({ fail: (table) => (table === 'approval_request' ? { code: '42P01', message: 'relation does not exist' } : null) })
    expect(await json('get_approvals')).toMatchObject({ items: [], unavailable: true })
  })
})

describe('REST /api/v1 se stejnými pravidly', () => {
  const KEY = 'cockpit_rest_key'
  const req = (url: string, body?: unknown) => new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const key = (scope: string, owner = 'user-1') =>
    db.seed('api_key', [{ id: 7, key_hash: hashApiKey(KEY), revoked_at: null, created_by: owner, scope, expires_at: null }])

  it('POST /api/v1/deals (přímé založení) neexistuje; deals/update: read 403, bez obchodní role 403, peníze 403', async () => {
    expect('POST' in dealsRoute).toBe(false)
    key('read')
    expect((await dealsUpdatePost(req('/api/v1/deals/update', { deal_id: 10, note: 'x' }))).status).toBe(403)
    seed()
    key('full', 'user-2')
    expect((await dealsUpdatePost(req('/api/v1/deals/update', { deal_id: 10, note: 'x' }))).status).toBe(403)
    seed()
    key('full')
    expect((await dealsUpdatePost(req('/api/v1/deals/update', { deal_id: 10, amount: 1 }))).status).toBe(403)
    expect((await dealsUpdatePost(req('/api/v1/deals/update', { deal_id: 10, note: 'REST' }))).status).toBe(200)
  })

  it('GET /api/v1/tasks a /api/v1/approvals s read klíčem', async () => {
    key('read')
    const tasks = await (await tasksGet(req('/api/v1/tasks?only_open=false'))).json()
    expect(tasks.tasks.map((t: { id: number }) => t.id).sort()).toEqual([31, 32])
    expect((await approvalsGet(req('/api/v1/approvals?limit=0'))).status).toBe(400)
  })
})
