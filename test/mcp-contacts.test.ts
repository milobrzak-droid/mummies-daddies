import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryDb, type MemoryDbOptions } from './helpers/memoryDb'

// Konektor Cowork: kontakty a seznamy k oslovení přes MCP. Dotazy běží
// skutečně (nad databází v paměti), jen Supabase je falešný. Hlídá se:
// oprávnění podle role a scope, vynechání lidí, kteří oslovení nechtějí,
// datová minimalizace, stránkování a zápis každého volání do api_request.

let db: MemoryDb
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }))

import { serveMcp, mcpLogPath, OUTREACH_REFUSAL } from '@/lib/mcpServer'
import { POST as mcpPost } from '@/app/api/mcp/route'
import { hashApiKey, requireApiKey } from '@/lib/apiKeyAuth'

const FUTURE = '2999-01-01'
const PAST = '2000-01-01'

function seed(opts: MemoryDbOptions = {}) {
  db = new MemoryDb(opts)
  db.seed('team_member', [{ id: 'user-1', full_name: 'Viktor Kovář', role: 'vedeni', deactivated_at: null }])
  db.seed('account', [
    { id: 1, name: 'Alfa s.r.o.', notes: null, snooze_until: null },
    { id: 2, name: 'Beta a.s.', notes: null, snooze_until: FUTURE },
    { id: 3, name: 'Gama', notes: null, snooze_until: PAST },
    { id: 4, name: 'Delta', notes: 'Firma nechce být oslovována.', snooze_until: null },
  ])
  const c = (id: number, account_id: number | null, full_name: string, over: Record<string, unknown> = {}) => ({
    id, account_id, partner_id: account_id === null ? 9 : null, full_name, role: null, email: null, phone: null,
    notes: null, is_champion: false, created_at: '2026-01-01T00:00:00Z', ...over,
  })
  db.seed('contact', [
    c(11, 1, 'Jana Nováková', { role: 'CFO', email: 'jana@alfa.cz', phone: '+420 111 222 333', notes: 'Volat ráno.', is_champion: true }),
    c(12, 1, 'Petr Svoboda', { role: 'CEO', email: 'petr@alfa.cz', notes: 'Nekontaktovat — požádal 3. 9.' }),
    c(13, 1, 'Adam Malý', { role: 'IT', email: 'adam@alfa.cz' }),
    c(21, 2, 'Eva Černá', { email: 'eva@beta.cz' }),
    c(31, 3, 'Karel Dvořák', { email: 'karel@gama.cz' }),
    c(41, 4, 'Olga Veselá', { email: 'olga@delta.cz' }),
    c(91, null, 'Partner Kontakt', { email: 'p@partner.cz' }),
  ])
  db.seed('sales_activity', [
    { id: 1, account_id: 1, contact_id: 11, occurred_at: '2026-09-10T08:00:00+00:00' },
    { id: 2, account_id: 1, contact_id: 11, occurred_at: '2026-08-10T08:00:00+00:00' },
  ])
  db.seed('mail_event', [
    { id: 1, account_id: 1, contact_id: 11, occurred_at: '2026-09-20T09:30:00+00:00' },
    { id: 2, account_id: 3, contact_id: 31, occurred_at: '2026-07-01T09:30:00+00:00' },
  ])
  db.seed('target_list', [
    { id: 5, name: 'Výroba kolem Prahy', segment: 'vyroba-praha', rationale: 'Rostou a řeší plánování.', value_hypothesis: 'Méně ruční práce', owner_id: 'user-1', created_at: '2026-09-28T10:00:00Z' },
    { id: 6, name: 'Logistika a doprava', segment: 'logistika-doprava', rationale: 'Sklady.', value_hypothesis: null, owner_id: null, created_at: '2026-09-27T10:00:00Z' },
  ])
  const item = (id: number, list_id: number, account_id: number, contact_id: number | null, status: string, created_at: string) => ({
    id, list_id, account_id, contact_id, status, reason: `Důvod ${id}`, next_step: id === 50 ? 'Zavolat' : null,
    next_step_due: id === 50 ? '2026-10-05' : null, created_at,
  })
  db.seed('target_list_item', [
    item(50, 5, 1, 13, 'navrzeno', '2026-09-28T10:01:00Z'),
    item(51, 5, 2, 21, 'osloveno', '2026-09-28T10:02:00Z'),
    item(52, 5, 3, 31, 'vyrazeno', '2026-09-28T10:03:00Z'),
    item(53, 5, 4, 41, 'odpovedel', '2026-09-28T10:04:00Z'),
    item(60, 6, 3, null, 'navrzeno', '2026-09-27T10:01:00Z'),
  ])
}

beforeEach(() => seed())

const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
const rpc = (method: string, params?: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/mcp', { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
const call = (name: string, args: unknown = {}) => rpc('tools/call', { name, arguments: args })
const result = async (res: Response) => (await res.json()).result as { isError?: boolean; content: { text: string }[] }
const run = (name: string, args: unknown = {}, scope: 'read' | 'full' = 'read', sales = true) =>
  serveMcp(call(name, args), 'user-1', scope, sales).then(result)
const data = async (name: string, args: unknown = {}, scope: 'read' | 'full' = 'read') => {
  const r = await run(name, args, scope)
  expect(r.isError, r.content[0].text).toBeUndefined()
  return JSON.parse(r.content[0].text)
}
const touched = (table: string) => db.calls.some((c) => c.table === table)

describe('oprávnění: jen obchodní role, scope read i full', () => {
  it('bez obchodní role se kontakty ani seznamy nevrátí a databáze se jich nedotkne', async () => {
    for (const scope of ['read', 'full'] as const) {
      for (const tool of ['get_contacts', 'get_target_list']) {
        const r = await run(tool, {}, scope, false)
        expect(r.isError).toBe(true)
        expect(r.content[0].text).toBe(OUTREACH_REFUSAL)
      }
    }
    expect(touched('contact') || touched('target_list') || touched('target_list_item')).toBe(false)
  })

  it('obchodní role čte se scope read i full', async () => {
    for (const scope of ['read', 'full'] as const) {
      expect((await run('get_contacts', {}, scope)).isError).toBeUndefined()
      expect((await run('get_target_list', {}, scope)).isError).toBeUndefined()
    }
  })

  it('čtení nic nezapisuje', async () => {
    await run('get_contacts')
    await run('get_target_list', { list_id: 5 })
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })
})

describe('get_contacts: nesouhlas a datová minimalizace', () => {
  it('vynechá odmítnuté (odložená firma, nesouhlas v poznámce kontaktu i firmy) a partnerské kontakty', async () => {
    const out = await data('get_contacts')
    expect(out.items.map((i: { id: number }) => i.id)).toEqual([13, 11, 31])
    expect(out.excluded).toEqual({ count: 3, contact_opt_out: 0, account_snoozed: 1, note_opt_out: 2 })
    expect(out.total).toBe(3)
    expect(out.next_offset).toBeNull()
    const text = JSON.stringify(out)
    for (const hidden of ['Petr Svoboda', 'petr@alfa.cz', 'Eva Černá', 'Olga Veselá', 'Partner Kontakt', 'Nekontaktovat', 'Volat ráno', 'champion', 'notes']) {
      expect(text).not.toContain(hidden)
    }
  })

  it('vrací jen pole k oslovení a poslední aktivitu z jednání i e-mailu', async () => {
    const out = await data('get_contacts', { account_id: 1 })
    const jana = out.items.find((i: { id: number }) => i.id === 11)
    expect(jana).toEqual({
      id: 11, full_name: 'Jana Nováková', role: 'CFO', email: 'jana@alfa.cz', phone: '+420 111 222 333',
      account: { id: 1, name: 'Alfa s.r.o.' }, last_activity_at: '2026-09-20T09:30:00.000Z',
    })
    expect(out.items.find((i: { id: number }) => i.id === 13).last_activity_at).toBeNull()
  })

  it('hledání bez diakritiky; hledaný člověk s nesouhlasem se nevrátí, jen se započítá', async () => {
    expect((await data('get_contacts', { search: 'novakova' })).items.map((i: { id: number }) => i.id)).toEqual([11])
    expect((await data('get_contacts', { search: 'gama' })).items.map((i: { id: number }) => i.id)).toEqual([31])
    const svoboda = await data('get_contacts', { search: 'Svoboda' })
    expect(svoboda.items).toEqual([])
    expect(svoboda.excluded).toEqual({ count: 1, contact_opt_out: 0, account_snoozed: 0, note_opt_out: 1 })
  })

  it('firma s odloženým oslovením: prázdný výsledek a důvod v počtech', async () => {
    const out = await data('get_contacts', { account_id: 2 })
    expect(out.items).toEqual([])
    expect(out.excluded).toEqual({ count: 1, contact_opt_out: 0, account_snoozed: 1, note_opt_out: 0 })
  })

  it('prošlé odložení oslovení už neplatí', async () => {
    expect((await data('get_contacts', { account_id: 3 })).items.map((i: { id: number }) => i.id)).toEqual([31])
  })
})

describe('get_contacts: stránkování', () => {
  it('limit a offset, next_offset jen když něco zbývá, total se nemění', async () => {
    const first = await data('get_contacts', { limit: 2 })
    expect(first.items.map((i: { id: number }) => i.id)).toEqual([13, 11])
    expect(first).toMatchObject({ total: 3, next_offset: 2 })
    const second = await data('get_contacts', { limit: 2, offset: first.next_offset })
    expect(second.items.map((i: { id: number }) => i.id)).toEqual([31])
    expect(second).toMatchObject({ total: 3, next_offset: null })
  })

  it('výchozí stránka je 50 a strop 200; mimo rozsah je chyba vstupu', async () => {
    const many = Array.from({ length: 60 }, (_, k) => ({
      id: 1000 + k, account_id: 1, partner_id: null, full_name: `Kontakt ${String(k).padStart(2, '0')}`,
      role: null, email: null, phone: null, notes: null, is_champion: false, created_at: '2026-01-01T00:00:00Z',
    }))
    db.seed('contact', many)
    const out = await data('get_contacts')
    expect(out.items).toHaveLength(50)
    expect(out).toMatchObject({ total: 63, next_offset: 50 })
    for (const bad of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { search: 'x' }]) {
      const r = await run('get_contacts', bad)
      expect(r.isError, JSON.stringify(bad)).toBe(true)
    }
  })
})

describe('get_contacts: seznam k oslovení', () => {
  it('jen firmy ze seznamu (bez vyřazených), hlavní kontakt první a označený', async () => {
    const out = await data('get_contacts', { target_list_id: 5 })
    expect(out.target_list).toEqual({ id: 5, name: 'Výroba kolem Prahy' })
    expect(out.items.map((i: { id: number }) => i.id)).toEqual([13, 11])
    expect(out.items[0].target).toEqual({ list_id: 5, item_id: 50, status: 'navrzeno', main_contact: true })
    expect(out.items[1].target.main_contact).toBe(false)
    // Petr (poznámka), Eva (Beta odložená), Olga (Delta, poznámka firmy); Gama je vyřazená ze seznamu.
    expect(out.excluded).toEqual({ count: 3, contact_opt_out: 0, account_snoozed: 1, note_opt_out: 2 })
    expect(JSON.stringify(out)).not.toContain('Karel')
  })

  it('filtr stavu: osloveno = jen Beta, a ta je odložená', async () => {
    const out = await data('get_contacts', { target_list_id: 5, target_status: 'osloveno' })
    expect(out.items).toEqual([])
    expect(out.excluded).toEqual({ count: 1, contact_opt_out: 0, account_snoozed: 1, note_opt_out: 0 })
  })

  it('vyřazené firmy nejdou vyžádat a stav bez seznamu je chyba', async () => {
    expect((await run('get_contacts', { target_list_id: 5, target_status: 'vyrazeno' })).isError).toBe(true)
    const r = await run('get_contacts', { target_status: 'navrzeno' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('jen spolu s target_list_id')
  })

  it('firma i seznam: průnik; neexistující seznam je chyba', async () => {
    expect((await data('get_contacts', { target_list_id: 5, account_id: 3 })).items).toEqual([])
    expect((await data('get_contacts', { target_list_id: 6, account_id: 3 })).items.map((i: { id: number }) => i.id)).toEqual([31])
    const r = await run('get_contacts', { target_list_id: 999 })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('neexistuje')
  })
})

describe('get_target_list', () => {
  it('přehled seznamů s počty podle stavu a vlastníkem', async () => {
    const out = await data('get_target_list')
    expect(out.lists.map((l: { id: number }) => l.id)).toEqual([5, 6])
    expect(out.lists[0]).toMatchObject({
      name: 'Výroba kolem Prahy', segment: 'vyroba-praha', owner: 'Viktor Kovář',
      counts: { navrzeno: 1, osloveno: 1, odpovedel: 1, vyrazeno: 1, total: 4 },
    })
    expect(out.lists[1]).toMatchObject({ owner: null, counts: { navrzeno: 1, total: 1 } })
  })

  it('položky: firma, stav, další krok, hlavní kontakt jen jménem; kdo nechce, ten chybí a je řečeno proč', async () => {
    const out = await data('get_target_list', { list_id: 5 })
    expect(out.list.counts.total).toBe(4)
    expect(out.items.map((i: { id: number }) => i.id)).toEqual([50, 51, 52, 53])
    expect(out.items[0]).toEqual({
      id: 50, account: { id: 1, name: 'Alfa s.r.o.' }, reason: 'Důvod 50', status: 'navrzeno', status_label: 'Navrženo',
      next_step: 'Zavolat', next_step_due: '2026-10-05',
      main_contact: { id: 13, full_name: 'Adam Malý', role: 'IT' }, outreach_blocked: null,
    })
    expect(out.items[1]).toMatchObject({ main_contact: null, outreach_blocked: 'account_snoozed' })
    expect(out.items[2]).toMatchObject({ status: 'vyrazeno', main_contact: { id: 31 }, outreach_blocked: null })
    expect(out.items[3]).toMatchObject({ main_contact: null, outreach_blocked: 'note_opt_out' })
    expect(out.excluded).toEqual({ count: 2, contact_opt_out: 0, account_snoozed: 1, note_opt_out: 1 })
    expect(JSON.stringify(out.items)).not.toContain('@')
  })

  it('filtr stavu a stránkování položek', async () => {
    const vyrazene = await data('get_target_list', { list_id: 5, status: 'vyrazeno' })
    expect(vyrazene.items.map((i: { id: number }) => i.id)).toEqual([52])
    expect(vyrazene).toMatchObject({ total: 1, next_offset: null })
    const page = await data('get_target_list', { list_id: 5, limit: 2 })
    expect(page.items.map((i: { id: number }) => i.id)).toEqual([50, 51])
    expect(page).toMatchObject({ total: 4, next_offset: 2 })
  })

  it('stav bez seznamu, neexistující seznam a chybějící migrace 0048 = srozumitelná chyba', async () => {
    expect((await run('get_target_list', { status: 'navrzeno' })).content[0].text).toContain('jen spolu s list_id')
    expect((await run('get_target_list', { list_id: 999 })).content[0].text).toContain('neexistuje')
    seed({ fail: (table) => (table === 'target_list' ? { code: '42P01', message: 'relation "target_list" does not exist' } : null) })
    for (const args of [{}, { list_id: 5 }]) {
      const r = await run('get_target_list', args)
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain('migraci 0048')
    }
    expect((await run('get_contacts', { target_list_id: 5 })).content[0].text).toContain('migraci 0048')
  })
})

describe('políčko „Nesouhlasí s oslovením" (contact.do_not_contact, 0087)', () => {
  const optedOut = () => db.seed('contact', [{
    id: 14, account_id: 1, partner_id: null, full_name: 'Lucie Tichá', role: 'HR', email: 'lucie@alfa.cz', phone: '+420 999',
    notes: null, is_champion: false, created_at: '2026-01-01T00:00:00Z',
    do_not_contact: true, do_not_contact_at: '2026-09-29T08:00:00Z', do_not_contact_reason: 'Řekla to na veletrhu', do_not_contact_by: 'user-1',
  }])

  it('get_contacts: člověk s políčkem se nevrátí vůbec, jen se započítá jako contact_opt_out', async () => {
    optedOut()
    const out = await data('get_contacts', { account_id: 1 })
    expect(out.items.map((i: { id: number }) => i.id)).toEqual([13, 11])
    expect(out.excluded).toEqual({ count: 2, contact_opt_out: 1, account_snoozed: 0, note_opt_out: 1 })
    const text = JSON.stringify(out)
    for (const hidden of ['Lucie', 'lucie@alfa.cz', 'veletrhu', 'do_not_contact']) expect(text).not.toContain(hidden)
    const byName = await data('get_contacts', { search: 'Ticha' })
    expect(byName.items).toEqual([])
    expect(byName.excluded).toMatchObject({ count: 1, contact_opt_out: 1 })
  })

  it('get_target_list: hlavní kontakt s políčkem chybí, důvod contact_opt_out a počet v excluded', async () => {
    optedOut()
    db.seed('target_list', [{ id: 7, name: 'HR', segment: 'hr', rationale: 'x', value_hypothesis: null, owner_id: null, created_at: '2026-09-20T10:00:00Z' }])
    db.seed('target_list_item', [{ id: 70, list_id: 7, account_id: 1, contact_id: 14, status: 'navrzeno', reason: 'HR', next_step: null, next_step_due: null, created_at: '2026-09-20T10:01:00Z' }])
    const out = await data('get_target_list', { list_id: 7 })
    expect(out.items[0]).toMatchObject({ id: 70, main_contact: null, outreach_blocked: 'contact_opt_out' })
    expect(out.excluded).toEqual({ count: 1, contact_opt_out: 1, account_snoozed: 0, note_opt_out: 0 })
    expect(JSON.stringify(out)).not.toContain('Lucie')
    // Přes seznam get_contacts ji taky nevrátí.
    const contacts = await data('get_contacts', { target_list_id: 7 })
    expect(contacts.items.map((i: { id: number }) => i.id)).toEqual([13, 11])
    expect(contacts.excluded).toMatchObject({ contact_opt_out: 1 })
  })

  it('bez migrace 0087 (sloupec chybí) konektor běží dál a rozhoduje poznámka', async () => {
    seed({
      fail: (table, op, _p, cols) => (table === 'contact' && op === 'select' && cols?.includes('do_not_contact')
        ? { code: '42703', message: 'column contact.do_not_contact does not exist' } : null),
    })
    const out = await data('get_contacts')
    expect(out.items.map((i: { id: number }) => i.id)).toEqual([13, 11, 31])
    expect(out.excluded).toEqual({ count: 3, contact_opt_out: 0, account_snoozed: 1, note_opt_out: 2 })
    const list = await data('get_target_list', { list_id: 5 })
    expect(list.items[3]).toMatchObject({ main_contact: null, outreach_blocked: 'note_opt_out' })
  })

  it('jiná chyba čtení kontaktů se nezamaskuje', async () => {
    seed({ fail: (table, op) => (table === 'contact' && op === 'select' ? { code: '57014', message: 'timeout' } : null) })
    const r = await run('get_contacts')
    expect(r.isError).toBe(true)
  })
})

describe('každé čtení přes /api/mcp se zapíše do api_request a počítá do limitu', () => {
  const KEY = 'cockpit_test_key'
  const auth = { Authorization: `Bearer ${KEY}` }

  beforeEach(() => {
    db.seed('api_key', [{ id: 7, key_hash: hashApiKey(KEY), revoked_at: null, created_by: 'user-1', scope: 'read', expires_at: null }])
  })

  it('čtení kontaktů: záznam s názvem nástroje, bez argumentů', async () => {
    const res = await mcpPost(rpc('tools/call', { name: 'get_contacts', arguments: { search: 'novakova' } }, auth))
    expect(res.status).toBe(200)
    const r = await result(res)
    expect(r.isError).toBeUndefined()
    expect(JSON.parse(r.content[0].text).items).toHaveLength(1)
    expect(db.rows('api_request')).toEqual([expect.objectContaining({ key_id: 7, path: '/api/mcp#get_contacts' })])
    expect(JSON.stringify(db.rows('api_request'))).not.toContain('novakova')
  })

  it('ostatní zprávy se zapíšou jako /api/mcp', async () => {
    await mcpPost(rpc('tools/list', {}, auth))
    expect(db.rows('api_request').map((r) => r.path)).toEqual(['/api/mcp'])
  })

  it('nad limitem 120 za minutu: 429 a kontakty se nečtou', async () => {
    const now = new Date().toISOString()
    db.seed('api_request', Array.from({ length: 120 }, () => ({ key_id: 7, path: '/api/mcp#get_contacts', at: now })))
    const res = await mcpPost(rpc('tools/call', { name: 'get_contacts', arguments: {} }, auth))
    expect(res.status).toBe(429)
    expect(touched('contact')).toBe(false)
  })

  it('neověřený požadavek tělo nečte ani nezapisuje', async () => {
    const logPath = vi.fn(async () => '/api/mcp#x')
    const res = await requireApiKey(new Request('http://localhost/api/mcp', { method: 'POST', headers: { Authorization: 'Bearer spatny' }, body: '{}' }), { logPath })
    expect(res).toMatchObject({ ok: false, status: 401 })
    expect(logPath).not.toHaveBeenCalled()
    expect(db.rows('api_request')).toEqual([])
  })

  it('název nástroje jen podle vzoru; cokoli jiného = /api/mcp', async () => {
    const at = (body: string, method = 'POST') => mcpLogPath(new Request('http://localhost/api/mcp', { method, body: method === 'POST' ? body : undefined }))
    const tool = (name: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } })
    expect(await at(tool('get_deliveries'))).toBe('/api/mcp#get_deliveries')
    for (const bad of [tool('GET_CONTACTS'), tool('../x'), tool('a'.repeat(80)), tool(42), '[{"method":"tools/call"}]', 'nejson', '{"method":"initialize"}']) {
      expect(await at(bad), bad).toBe('/api/mcp')
    }
    expect(await at('', 'GET')).toBe('/api/mcp')
  })
})
