import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { buildChangeSections } from '@/domain/crm/changes'
import { loadOpsReport } from '@/domain/crm/queries/opsReport'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Čtení provozního přehledu nad zamockovaným Supabase: jen existující dotazy,
// předaný klient (service role pro cron) se použije všude, obchodní zdroje
// jen s can_see_sales, nic se nezapisuje a chyba jednoho zdroje nezboří zbytek.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => { throw new Error('admin klient se tu nesmí použít') }) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ME = '00000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-09-29T05:00:00Z') // úterý
const TODAY = '2026-09-29'

const ENGAGEMENT = {
  id: 3, account_id: 1, deal_id: 9, kind: 'it', phase: 'pilot', started_on: '2026-09-01', due_on: '2026-11-06',
  owner_id: ME, deputy_id: null, updated_at: '2026-09-28T09:00:00Z', reference_worthy: false,
  goal: 'Zrychlit zpracování', scope: 'Rozsah z předání', handoff_completed_at: '2026-09-05T08:00:00Z',
  account: { name: 'ALFATECH' },
}
const MILESTONE = {
  id: 2, engagement_id: 3, title: 'Procesní mapa', owner_id: ME, deputy_id: null, status: 'ceka_na_schvaleni',
  due_on: '2026-10-03', accepted_at: null, updated_at: '2026-09-20T10:00:00Z', created_at: '2026-09-01T10:00:00Z',
  engagement: { id: 3, account_id: 1, kind: 'it', phase: 'pilot', account: { name: 'ALFATECH' } },
}

type Route = (c: QueryCall) => QueryResult | undefined
const table = (name: string, result: QueryResult): Route => (c) => (c.table === name ? result : undefined)

function fake(...routes: Route[]) {
  const all: Route[] = [
    ...routes,
    table('engagement', { data: [ENGAGEMENT], error: null }),
    table('engagement_milestone', { data: [MILESTONE], error: null }),
    table('deal', { data: [{ id: 9, account_id: 1, title: 'Pilot objednávek' }], error: null }),
    table('team_member', { data: [{ id: ME, full_name: 'Viktor Kovář', weekly_capacity_hours: 40 }], error: null }),
    table('allocation', {
      data: [{ id: 1, member_id: ME, engagement_id: 3, work_case_id: null, hours_per_week: 46, starts_on: '2026-09-01', ends_on: null, substitute_id: null, note: null, created_at: '' }],
      error: null,
    }),
    table('approval_request', {
      data: [{ id: 7, case_id: 4, node: null, action_kind: 'external_commitment', requested_level: 'L2', requested_by: 'user:x', created_at: '2026-09-28T08:00:00Z', expires_at: null, work_case: { title: 'Závazek pro ALFATECH', node: null } }],
      error: null,
    }),
    table('case_proposal', { data: null, error: null, count: 2 }),
    table('meeting_note_intake', { data: [], error: null, count: 1 }),
  ]
  const f = createSupabaseFake({
    resolve: (c) => {
      for (const r of all) {
        const out = r(c)
        if (out) return out
      }
      return { data: [], error: null }
    },
    rpc: () => ({ data: null, error: { code: '42501', message: 'Nepřihlášený uživatel' } }),
  })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createAdminClient).mockImplementation(() => { throw new Error('admin klient se tu nesmí použít') })
})

describe('loadOpsReport', () => {
  test('cron (service role): všechno přes předaného klienta, názvy obchodů bez rpc, jen čtení', async () => {
    const f = fake()
    vi.mocked(createClient).mockRejectedValue(new Error('session klient se tu nesmí použít'))
    const r = await loadOpsReport({ now: NOW, week: 'minuly', canSeeSales: true, digest: null, db: f.client as never, asService: true })
    expect(createClient).not.toHaveBeenCalled()
    expect(f.rpc).not.toHaveBeenCalled()
    for (const c of f.calls) expect(hasOp(c, 'insert') || hasOp(c, 'update') || hasOp(c, 'delete') || hasOp(c, 'upsert'), c.table).toBe(false)
    expect(r.today).toBe(TODAY)
    expect(r.window.label).toBe('za týden 39: po 21. 9. až ne 27. 9.')
    const by = Object.fromEntries(r.sections.map((s) => [s.key, s]))
    expect(by.dodavky.items[0].title).toBe('ALFATECH · Pilot objednávek')
    expect(by['na-klienta'].items.map((i) => i.key)).toEqual(['klient-m2'])
    expect(by['ke-schvaleni'].items.map((i) => i.key)).toEqual(['schvaleni-7'])
    expect(by.riziko.items.map((i) => i.key)).toEqual(['pretizeni-' + ME])
    expect(by.neovereno.items.map((i) => i.key)).toEqual(['navrhy', 'zapisy'])
    expect(r.unavailable).toEqual(['follow-upy', 'blokované obchody'])
    expect(logError).not.toHaveBeenCalled()
    // rozsah přijaté nabídky přehled nepotřebuje, takže se nečte ani v cronu
    expect(f.calls.some((c) => c.table === 'deal_scope_version')).toBe(false)
  })

  test('změny za týden: jen potřebné druhy (obchody, poptávky, milníky, nové dodávky) a okno týdne', async () => {
    const f = fake()
    await loadOpsReport({ now: NOW, week: 'tento', canSeeSales: true, digest: null, db: f.client as never })
    const tables = new Set(f.calls.map((c) => c.table))
    expect(tables.has('mail_event')).toBe(false)
    // peníze: jen dotaz na faktury po splatnosti (potvrzené vyfakturované se splatností před dneškem), nic jiného
    const money = f.calls.filter((c) => c.table === 'financial_record')
    expect(money).toHaveLength(1)
    expect(opArgs(money[0], 'or')).toEqual([`due_on.lt.${TODAY},and(due_on.is.null,idoklad_due_on.lt.${TODAY})`])
    expect(money[0].ops.filter((o) => o.method === 'eq').map((o) => o.args)).toEqual([['kind', 'invoiced'], ['status', 'confirmed']])
    // nové úkoly a případy ani udělaná rozhodnutí (druhy work, decision) se v okně nečtou
    const windowed = (t: string) => f.calls.filter((c) => c.table === t && hasOp(c, 'gte'))
    expect(windowed('work_case')).toEqual([])
    expect(windowed('task')).toEqual([])
    expect(windowed('decision')).toEqual([])
    const intake = f.calls.find((c) => c.table === 'auto_intake')!
    expect(opArgs(intake, 'gte')).toEqual(['created_at', '2026-09-27T22:00:00.000Z'])
    // bez asService se názvy obchodů čtou postaru přes deal_public
    expect(f.rpc).toHaveBeenCalledWith('deal_public', { p_account_id: null })
  })

  test('bez can_see_sales se obchodní zdroje vůbec nedotazují', async () => {
    const f = fake()
    const r = await loadOpsReport({ now: NOW, week: 'minuly', canSeeSales: false, digest: null, db: f.client as never })
    const tables = new Set(f.calls.map((c) => c.table))
    for (const t of ['auto_intake', 'meeting_note_intake', 'deal_scope_version', 'financial_record']) expect(tables.has(t)).toBe(false)
    const audits = f.calls.filter((c) => c.table === 'audit_event')
    expect(audits.some((c) => JSON.stringify(opArgs(c, 'eq')) === JSON.stringify(['entity_table', 'deal']))).toBe(false)
    expect(r.sections.map((s) => s.key)).not.toContain('obchody')
  })

  test('faktury po splatnosti: nezaplacené se dostanou do Rizika bez částky, zaplacené (Přijato se stejným dokladem) ne', async () => {
    const f = fake((c) => {
      if (c.table !== 'financial_record') return undefined
      if (opArgs(c, 'eq')?.[1] === 'received') return { data: [{ account_id: 1, kind: 'received', status: 'confirmed', external_ref: 'FA-2' }], error: null }
      return {
        data: [
          { id: 41, account_id: 1, kind: 'invoiced', status: 'confirmed', amount: 99000, currency: 'CZK', external_ref: 'FA-1', due_on: '2026-09-19', account: { name: 'ALFATECH' } },
          { id: 42, account_id: 1, kind: 'invoiced', status: 'confirmed', amount: 5000, currency: 'CZK', external_ref: 'FA-2', due_on: '2026-09-10', account: { name: 'ALFATECH' } },
        ],
        error: null,
      }
    })
    const r = await loadOpsReport({ now: NOW, week: 'minuly', canSeeSales: true, digest: null, db: f.client as never })
    const risk = r.sections.find((s) => s.key === 'riziko')!
    const inv = risk.items.filter((i) => i.key.startsWith('faktura-'))
    expect(inv.map((i) => i.key)).toEqual(['faktura-41'])
    expect(inv[0]).toMatchObject({ title: 'ALFATECH · faktura FA-1', href: '/cockpit/finance?druh=invoiced&splatnost=po', tone: 'neg' })
    expect(inv[0].detail).toBe('Splatnost byla 19. 9., faktura je o 10 dní po splatnosti a platba není zapsaná')
    expect(JSON.stringify(r.sections)).not.toMatch(/99000|99 000|Kč/)
  })

  test('faktury po splatnosti: chybějící migrace 0090 nebo chyba dotazu přehled přizná, ostatní sekce fungují', async () => {
    for (const error of [{ code: '42703', message: 'column financial_record.due_on does not exist' }, { code: 'XX000', message: 'boom' }]) {
      const f = fake((c) => (c.table === 'financial_record' ? { data: null, error } : undefined))
      const r = await loadOpsReport({ now: NOW, week: 'minuly', canSeeSales: true, digest: null, db: f.client as never })
      const risk = r.sections.find((s) => s.key === 'riziko')!
      expect(risk.unavailable).toContain('faktury po splatnosti')
      expect(risk.items.some((i) => i.key.startsWith('pretizeni-'))).toBe(true)
    }
  })

  test('změny předané stránkou se znovu nenačítají', async () => {
    const f = fake()
    const changes = { sections: buildChangeSections([], { canSeeSales: true }), unavailable: [] }
    await loadOpsReport({ now: NOW, week: 'minuly', canSeeSales: true, digest: null, changes, db: f.client as never })
    expect(f.calls.some((c) => c.table === 'auto_intake')).toBe(false)
  })

  test('výchozí klient je session přihlášeného (stránka Týden)', async () => {
    fake()
    await loadOpsReport({ now: NOW, today: TODAY, week: 'minuly', canSeeSales: true, digest: null })
    expect(createClient).toHaveBeenCalled()
  })

  test('chyba jednoho zdroje: sekce to přizná, ostatní se ukážou', async () => {
    const f = fake(
      table('approval_request', { data: null, error: { code: 'XX000', message: 'boom' } }),
      table('engagement', { data: null, error: { code: 'XX000', message: 'boom' } }),
    )
    const r = await loadOpsReport({ now: NOW, week: 'minuly', canSeeSales: true, digest: null, db: f.client as never })
    const by = Object.fromEntries(r.sections.map((s) => [s.key, s]))
    expect(by['ke-schvaleni'].unavailable).toEqual(['Ke schválení'])
    expect(by.dodavky.unavailable).toContain('dodávky')
    expect(by['na-klienta'].items).toHaveLength(1)
  })

  test('výjimka v dotazu se zaloguje a přehled se přesto složí', async () => {
    const f = createSupabaseFake({ resolve: () => { throw new Error('síť spadla') } })
    const r = await loadOpsReport({ now: NOW, week: 'minuly', canSeeSales: true, digest: null, db: f.client as never })
    expect(logError).toHaveBeenCalled()
    expect(r.sections).toHaveLength(7)
    expect(r.unavailable).toEqual(expect.arrayContaining(['dodávky', 'čekání na klienta', 'Ke schválení', 'kapacity']))
  })
})
