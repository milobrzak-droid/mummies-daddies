import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { logError } from '@/lib/log'
import { getChangesView, loadChanges } from '@/domain/crm/queries/changes'
import { touchChangesView } from '@/domain/crm/actions/changesView'
import { weekWindow } from '@/domain/crm/changes'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Čtení „Co se změnilo“ nad zamockovaným Supabase: obchodní druhy se bez
// can_see_sales vůbec nedotazují, chybějící tabulka je klidné „nic“, jiná
// chyba se hlásí (ne „nic se nezměnilo“), okno se posílá do dotazů.

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
// mail_event čte od 0069 jen service role (admin klient); ve zkoušce je to táž fake databáze.
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ME = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-0000000000bb'
const WIN = weekWindow('2026-09-29', 'minuly')
const MEMBERS = [{ id: ME, full_name: 'Viktor Kovář' }, { id: OTHER, full_name: 'Lenka' }]
const SALES_TABLES = ['mail_event', 'financial_record', 'auto_intake']

type Route = (c: QueryCall) => QueryResult | undefined
function fakeWith(...routes: Route[]) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      for (const r of routes) {
        const out = r(call)
        if (out) return out
      }
      return { data: [], error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
  return fake
}
const table = (name: string, result: QueryResult, action?: string): Route => (c) => {
  if (c.table !== name) return undefined
  if (action && !JSON.stringify(c.ops).includes(action)) return undefined
  return result
}
const auditFor = (entity: string, rows: unknown[]): Route => (c) => {
  if (c.table !== 'audit_event') return undefined
  return JSON.stringify(opArgs(c, 'eq')) === JSON.stringify(['entity_table', entity]) ? { data: rows, error: null } : undefined
}

beforeEach(() => vi.clearAllMocks())

describe('loadChanges: oprávnění', () => {
  test('bez can_see_sales se pošta klientů, obchody a peníze vůbec nedotazují', async () => {
    const fake = fakeWith()
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    const tables = fake.calls.map((c) => c.table)
    for (const t of SALES_TABLES) expect(tables).not.toContain(t)
    expect(tables).not.toContain('deal')
    // Audit se čte jen pro milníky a předání práce (team_member), ne pro obchody.
    const audits = fake.calls.filter((c) => c.table === 'audit_event')
    expect(audits.map((c) => JSON.stringify(opArgs(c, 'eq'))).sort()).toEqual(
      [JSON.stringify(['entity_table', 'engagement_milestone']), JSON.stringify(['entity_table', 'team_member'])],
    )
    expect(res.sections.map((s) => s.kind)).toEqual(['delivery', 'decision', 'work', 'handover', 'milestone', 'document'])
  })

  test('s can_see_sales se čtou i obchodní druhy', async () => {
    const fake = fakeWith()
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: true, members: MEMBERS })
    const tables = fake.calls.map((c) => c.table)
    for (const t of SALES_TABLES) expect(tables).toContain(t)
    expect(res.sections).toHaveLength(11)
    // Posunuté a zrušené schůzky: audit sales_activity jen pro obchodní role.
    const meetingAudit = fake.calls.find((c) => c.table === 'audit_event' && JSON.stringify(opArgs(c, 'eq')) === JSON.stringify(['entity_table', 'sales_activity']))
    expect(meetingAudit).toBeDefined()
  })

  test('posunutá schůzka z auditu → položka s klientem a důkazem', async () => {
    fakeWith(
      auditFor('sales_activity', [
        { id: 900, action: 'sales_activity.updated', entity_id: 41, occurred_at: '2026-09-25T06:05:00Z', actor_type: 'system', actor_id: 'calendar-sync',
          before: { occurred_at: '2026-10-01T08:00:00+00:00' }, after: { occurred_at: '2026-10-03T12:00:00+00:00', _columns: ['occurred_at'] } },
        // Doplnění naplánované schůzky zápisem sem nepatří.
        { id: 901, action: 'sales_activity.updated', entity_id: 42, occurred_at: '2026-09-25T07:00:00Z', actor_type: 'api_key', actor_id: ME,
          before: { outcome: 'planned' }, after: { outcome: 'completed', _columns: ['outcome'] } },
      ]),
      table('sales_activity', { data: [{ id: 41, subject: 'Workshop AI', occurred_at: '2026-10-03T12:00:00+00:00', outcome: 'planned', account_id: 7, account: { name: 'ALFATECH' } }], error: null }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: true, members: MEMBERS })
    const meetings = res.sections.find((s) => s.kind === 'meeting')!
    expect(meetings.total).toBe(1)
    expect(meetings.items[0]).toMatchObject({ title: 'ALFATECH · Workshop AI', href: '/cockpit/clients/7', detail: expect.stringContaining('Přesunuto') })
    expect(res.unavailable).toEqual([])
  })

  test('všechny dotazy jsou jen čtení a nesou okno od–do', async () => {
    const fake = fakeWith()
    await loadChanges({ window: WIN, meId: ME, canSeeSales: true, members: MEMBERS })
    for (const c of fake.calls) {
      expect(hasOp(c, 'insert') || hasOp(c, 'update') || hasOp(c, 'delete') || hasOp(c, 'upsert')).toBe(false)
    }
    const mail = fake.calls.find((c) => c.table === 'mail_event')!
    expect(opArgs(mail, 'gte')).toEqual(['occurred_at', WIN.since.toISOString()])
    expect(opArgs(mail, 'lt')).toEqual(['occurred_at', WIN.until.toISOString()])
    expect(opArgs(mail, 'eq')).toEqual(['direction', 'inbound'])
  })

  test('úkoly: jen moje a bez řešitele', async () => {
    const fake = fakeWith()
    await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    const tasks = fake.calls.find((c) => c.table === 'task')!
    expect(opArgs(tasks, 'or')).toEqual([`assignee_id.eq.${ME},assignee_id.is.null`])
  })
})

describe('loadChanges: předání práce (0088)', () => {
  test('souhrn z auditu team_member se jmény; před 0082 (chybí entity_ref) tichý „nic"', async () => {
    fakeWith(auditFor('team_member', [{
      id: 91, action: 'team_member.work_transferred', entity_ref: OTHER, actor_id: ME, occurred_at: '2026-09-24T09:00:00Z',
      after: { to_member_id: ME, counts: { obchody: 2, ukoly: 1, bez_zastupce: 1 } },
    }]))
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    const handover = res.sections.find((s) => s.kind === 'handover')!
    expect(handover.items).toEqual([expect.objectContaining({
      title: 'Lenka → Viktor Kovář',
      detail: 'Předáno: 2 obchody, 1 úkol · 1 bez zástupce · předal(a) Viktor Kovář',
      proof: expect.stringContaining('Záznam v auditu č. 91'),
    })])

    fakeWith((c) => (c.table === 'audit_event' && JSON.stringify(opArgs(c, 'eq')) === JSON.stringify(['entity_table', 'team_member'])
      ? { data: null, error: { code: '42703', message: 'column audit_event.entity_ref does not exist' } }
      : undefined))
    const before = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    expect(before.unavailable).toEqual([])
  })
})

describe('loadChanges: dokumenty dodávek (0094)', () => {
  const finding = { id: 31, kind: 'changed', detected_at: '2026-09-25T04:05:00Z', resolved_at: null, document_id: 9, version_id: 71 }
  const docRow = { id: 9, title: 'Nabídka pro ALFATECH', status: 'sent', engagement_id: 4, approved_version_id: 70, engagement: { account_id: 7, account: { name: 'ALFATECH' } } }

  test('nález z kontroly → položka s klientem, verzemi a důkazem; čte se i bez can_see_sales', async () => {
    const fake = fakeWith(
      table('engagement_document_finding', { data: [finding], error: null }),
      table('engagement_document', { data: [docRow], error: null }),
      table('engagement_document_version', { data: [{ id: 70, version_label: '3.0' }, { id: 71, version_label: '4.0' }], error: null }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    const s = res.sections.find((x) => x.kind === 'document')!
    expect(s.total).toBe(1)
    expect(s.items[0]).toMatchObject({
      title: 'ALFATECH · Nabídka pro ALFATECH',
      href: '/cockpit/clients/7/engagements/4/edit?zalozka=dokumenty',
      detail: 'Od schválení se změnil (dokument je odesláno): schválená verze 3.0, nyní verze 4.0.',
    })
    expect(res.unavailable).toEqual([])
    // Okno se posílá do dotazu; jen čtení.
    const q = fake.calls.find((c) => c.table === 'engagement_document_finding')!
    expect(q.ops).toEqual(expect.arrayContaining([
      { method: 'gte', args: ['detected_at', WIN.since.toISOString()] },
      { method: 'lt', args: ['detected_at', WIN.until.toISOString()] },
    ]))
    expect(fake.calls.some((c) => hasOp(c, 'insert') || hasOp(c, 'update') || hasOp(c, 'delete'))).toBe(false)
  })

  test('bez nálezů se nedočítají dokumenty ani verze', async () => {
    const fake = fakeWith(table('engagement_document_finding', { data: [], error: null }))
    await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS, kinds: ['document'] })
    expect(fake.calls.map((c) => c.table)).toEqual(['engagement_document_finding'])
  })

  test('bez migrace 0094 (tabulka není) je to klidné „nic", ne chyba karty', async () => {
    fakeWith(table('engagement_document_finding', { data: null, error: { code: '42P01', message: 'relation "engagement_document_finding" does not exist' } }))
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    expect(res.sections.find((x) => x.kind === 'document')!.total).toBe(0)
    expect(res.unavailable).toEqual([])
  })

  test('jiná chyba se ohlásí (karta neřekne „nic se nezměnilo")', async () => {
    fakeWith(table('engagement_document_finding', { data: null, error: { code: 'XX000', message: 'boom' } }))
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    expect(res.unavailable).toEqual(['document'])
  })

  test('chyba čtení čísel verzí nález nezruší: ukáže se jako „jiná verze"', async () => {
    fakeWith(
      table('engagement_document_finding', { data: [finding], error: null }),
      table('engagement_document', { data: [docRow], error: null }),
      table('engagement_document_version', { data: null, error: { code: 'XX000', message: 'x' } }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    expect(res.sections.find((x) => x.kind === 'document')!.items[0].detail).toMatch(/jiná verze než schválená/)
    expect(res.unavailable).toEqual([])
  })
})

describe('loadChanges: výběr druhů a klient (provozní přehled)', () => {
  test('kinds: dotazují se jen vybrané druhy, ostatní sekce zůstanou prázdné', async () => {
    const fake = fakeWith()
    const res = await loadChanges({ window: WIN, meId: null, canSeeSales: true, members: [], kinds: ['stage', 'milestone'] })
    const tables = new Set(fake.calls.map((c) => c.table))
    for (const t of ['mail_event', 'financial_record', 'auto_intake', 'task', 'work_case', 'approval_request', 'decision']) expect(tables.has(t)).toBe(false)
    // milník potřebuje vědět o nových dodávkách (engagement), obchody audit
    expect([...tables].sort()).toEqual(['audit_event', 'engagement', 'engagement_milestone'])
    expect(res.sections).toHaveLength(11)
    expect(res.unavailable).toEqual([])
  })

  test('kinds bez obchodního oprávnění: obchodní druh se nedotáže ani na požádání', async () => {
    const fake = fakeWith()
    await loadChanges({ window: WIN, meId: null, canSeeSales: false, members: [], kinds: ['stage', 'intake'] })
    expect(fake.calls).toHaveLength(0)
  })

  test('předaný klient (service role pro cron) se použije místo session', async () => {
    const own = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    await loadChanges({ window: WIN, meId: null, canSeeSales: true, members: [], kinds: ['stage', 'intake', 'delivery'], db: own.client as never })
    expect(createClient).not.toHaveBeenCalled()
    expect(own.calls.map((c) => c.table).sort()).toEqual(['audit_event', 'auto_intake', 'engagement'])
  })
})

describe('loadChanges: skládání z dat', () => {
  test('vrací položky s odkazy z pošty, fází obchodu, rozhodnutí, úkolů a milníků', async () => {
    fakeWith(
      table('auto_intake', { data: [{ id: 2, account_id: 50, created_at: '2026-09-25T07:00:00Z', occurred_at: '2026-09-25T06:59:00Z', account: { name: 'Acme Stroje' }, deal: { next_step_due: '2026-09-30' } }], error: null }),
      table('mail_event', { data: [{ id: 1, occurred_at: '2026-09-25T08:00:00Z', account_id: 7, account: { name: 'ALFATECH' } }], error: null }),
      auditFor('deal', [{ id: 40, action: 'deal.stage_changed', entity_id: 5, occurred_at: '2026-09-25T09:00:00Z', before: { stage: 'diagnostika' }, after: { stage: 'rozhodovani' } }]),
      table('deal', { data: [{ id: 5, title: 'AI agent', account_id: 7, account: { name: 'ALFATECH' } }], error: null }),
      table('approval_request', { data: [{ id: 4, status: 'approved', decided_at: '2026-09-25T10:00:00Z', decided_by: `user:${OTHER}`, action_kind: 'external_commitment', case_id: 8, work_case: { title: 'Follow-up: ALFATECH' } }], error: null }),
      table('task', { data: [{ id: 2, title: 'Poslat podklady', created_at: '2026-09-25T11:00:00Z', created_by: OTHER, assignee_id: ME, due_on: null, status: 'todo', account: { name: 'ALFATECH' } }], error: null }),
      auditFor('engagement_milestone', [{ id: 60, action: 'milestone.status', entity_id: 9, occurred_at: '2026-09-25T12:00:00Z', before: { status: 'v_praci' }, after: { status: 'ceka_na_schvaleni' } }]),
      table('engagement_milestone', { data: [{ id: 9, title: 'Procesní mapa', status: 'ceka_na_schvaleni', updated_at: '2026-09-25T12:00:00Z', engagement_id: 3, engagement: { account_id: 7, account: { name: 'ALFATECH' } } }], error: null }),
      table('financial_record', { data: [{ id: 3, kind: 'invoiced', status: 'draft', amount: '50000', currency: 'CZK', created_at: '2026-09-25T13:00:00Z', account: { name: 'ALFATECH' } }], error: null }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: true, members: MEMBERS })
    expect(res.unavailable).toEqual([])
    const by = Object.fromEntries(res.sections.map((s) => [s.kind, s.items]))
    expect(by.intake[0]).toMatchObject({ title: 'Nová poptávka: Acme Stroje', href: '/cockpit/clients/50', detail: 'Vzniklo automaticky z e-mailu · odpovědět do 30. 9.' })
    expect(by.email[0]).toMatchObject({ href: '/cockpit/clients/7', count: 1 })
    expect(by.stage[0]).toMatchObject({ detail: 'Upřesnění → Zákazník rozhoduje', href: '/cockpit/clients/7/deals/5' })
    expect(by.decision[0]).toMatchObject({ detail: 'Schváleno · Lenka', href: '/cockpit/pripady/8' })
    expect(by.work[0]).toMatchObject({ href: '/cockpit/tasks' })
    expect(by.milestone[0]).toMatchObject({ detail: 'Stav: V práci → Čeká na schválení', href: '/cockpit/clients/7/engagements/3/edit?zalozka=milniky' })
    expect(by.money[0].detail).toContain('50 000 Kč')
  })

  test('chybějící tabulky (nenasazené migrace) jsou klidné „nic“, ne chyba', async () => {
    const missing = { data: null, error: { code: '42P01', message: 'relation does not exist' } }
    fakeWith(
      table('mail_event', missing), table('financial_record', missing), table('work_case', missing), table('auto_intake', missing),
      table('approval_request', missing), table('decision', missing), table('engagement_milestone', missing),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: true, members: MEMBERS })
    expect(res.unavailable).toEqual([])
    expect(logError).not.toHaveBeenCalled()
  })

  test('jiná chyba jednoho druhu: ohlásí se v unavailable a ostatní druhy se ukážou dál', async () => {
    fakeWith(
      table('mail_event', { data: null, error: { code: 'XX000', message: 'boom' } }),
      table('task', { data: [{ id: 2, title: 'Úkol', created_at: '2026-09-25T11:00:00Z', created_by: OTHER, assignee_id: ME, due_on: null, status: 'todo', account: null }], error: null }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: true, members: MEMBERS })
    expect(res.unavailable).toEqual(['email'])
    expect(res.sections.find((s) => s.kind === 'work')?.total).toBe(1)
    expect(logError).toHaveBeenCalled()
  })

  test('chyba čtení názvů obchodů: posun fáze se ukáže jako „Obchod č. N“', async () => {
    fakeWith(
      auditFor('deal', [{ id: 40, action: 'deal.stage_changed', entity_id: 5, occurred_at: '2026-09-25T09:00:00Z', before: { stage: 'diagnostika' }, after: { stage: 'rozhodovani' } }]),
      table('deal', { data: null, error: { code: 'XX000', message: 'x' } }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: true, members: MEMBERS })
    expect(res.sections.find((s) => s.kind === 'stage')?.items[0].title).toBe('Obchod č. 5')
  })
})

describe('loadChanges: dodávky založené automaticky (0080)', () => {
  const DELIVERY = { id: 12, kind: 'it', created_at: '2026-09-25T08:00:00Z', account_id: 7, account: { name: 'Servis Climax' } }
  const MILESTONE = (id: number) => ({ id, title: 'Pilot', status: 'pripraveno', updated_at: '2026-09-25T08:00:00Z', engagement_id: 12, engagement: { account_id: 7, account: { name: 'Servis Climax' } } })

  test('čte engagement podle origin a okna; položka vede na dodávku, i bez can_see_sales', async () => {
    const fake = fakeWith(table('engagement', { data: [DELIVERY], error: null }))
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    const call = fake.calls.find((c) => c.table === 'engagement')!
    expect(opArgs(call, 'eq')).toEqual(['origin', 'auto_deal_won'])
    expect(opArgs(call, 'gte')).toEqual(['created_at', WIN.since.toISOString()])
    expect(opArgs(call, 'lt')).toEqual(['created_at', WIN.until.toISOString()])
    expect(res.sections.find((s) => s.kind === 'delivery')?.items[0]).toMatchObject({
      title: 'Servis Climax · Akce', href: '/cockpit/clients/7/engagements/12/edit',
    })
  })

  test('milníky nové automatické dodávky se po jednom nehlásí, jen vznik dodávky', async () => {
    fakeWith(
      table('engagement', { data: [DELIVERY], error: null }),
      auditFor('engagement_milestone', [
        { id: 70, action: 'engagement_milestone.created', entity_id: 21, occurred_at: '2026-09-25T08:00:00Z', before: null, after: { _columns: ['status', 'title'] } },
      ]),
      table('engagement_milestone', { data: [MILESTONE(21)], error: null }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    expect(res.sections.find((s) => s.kind === 'delivery')?.total).toBe(1)
    expect(res.sections.find((s) => s.kind === 'milestone')?.total).toBe(0)
  })

  test('před nasazením 0080 (chybí sloupec origin) je to klidné „nic“ a milníky se hlásí jako dřív', async () => {
    fakeWith(
      table('engagement', { data: null, error: { code: '42703', message: 'column engagement.origin does not exist' } }),
      auditFor('engagement_milestone', [
        { id: 70, action: 'engagement_milestone.created', entity_id: 21, occurred_at: '2026-09-25T08:00:00Z', before: null, after: { _columns: ['status', 'title'] } },
      ]),
      table('engagement_milestone', { data: [MILESTONE(21)], error: null }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    expect(res.unavailable).toEqual([])
    expect(res.sections.find((s) => s.kind === 'delivery')?.total).toBe(0)
    expect(res.sections.find((s) => s.kind === 'milestone')?.items[0].detail).toContain('Nový milník')
    expect(logError).not.toHaveBeenCalled()
  })

  test('jiná chyba čtení dodávek se ohlásí a milníky přesto přežijí', async () => {
    fakeWith(
      table('engagement', { data: null, error: { code: 'XX000', message: 'boom' } }),
      table('engagement_milestone', { data: [MILESTONE(21)], error: null }),
    )
    const res = await loadChanges({ window: WIN, meId: ME, canSeeSales: false, members: MEMBERS })
    expect(res.unavailable).toEqual(['delivery'])
    expect(logError).toHaveBeenCalled()
  })
})

describe('getChangesView + touchChangesView', () => {
  test('vlastní řádek návštěvy; chybějící tabulka = missing_migration', async () => {
    fakeWith(table('changes_view', { data: { baseline_at: null, last_open_at: '2026-09-28T13:00:00Z' }, error: null }))
    expect(await getChangesView(ME)).toEqual({ state: 'ok', row: { baseline_at: null, last_open_at: '2026-09-28T13:00:00Z' } })
    fakeWith(table('changes_view', { data: null, error: { code: '42P01', message: 'no' } }))
    expect(await getChangesView(ME)).toEqual({ state: 'missing_migration' })
    fakeWith(table('changes_view', { data: null, error: { code: 'XX000', message: 'no' } }))
    expect(await getChangesView(ME)).toEqual({ state: 'error' })
    fakeWith(table('changes_view', { data: null, error: null }))
    expect(await getChangesView(ME)).toEqual({ state: 'ok', row: null })
  })

  test('touchChangesView volá RPC touch_changes_view, jen s AAL2, a nikdy nevyhodí', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
    const fake = fakeWith()
    expect(await touchChangesView()).toEqual({ ok: true })
    expect(fake.rpc).toHaveBeenCalledWith('touch_changes_view')

    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const denied = fakeWith()
    expect(await touchChangesView()).toEqual({ ok: false })
    expect(denied.rpc).not.toHaveBeenCalled()
  })

  test('RPC ještě neexistuje (před 0075) nebo spadne: ok=false, chyba se zbytečně nehlásí / hlásí', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
    const noFn = createSupabaseFake({ rpc: () => ({ data: null, error: { code: '42883', message: 'function does not exist' } }) })
    vi.mocked(createClient).mockResolvedValue(noFn.client as never)
    expect(await touchChangesView()).toEqual({ ok: false })
    expect(logError).not.toHaveBeenCalled()
    const boom = createSupabaseFake({ rpc: () => ({ data: null, error: { code: 'XX000', message: 'x' } }) })
    vi.mocked(createClient).mockResolvedValue(boom.client as never)
    expect(await touchChangesView()).toEqual({ ok: false })
    expect(logError).toHaveBeenCalled()
  })
})
