// Předání práce člověka (změna vlastníka, odchod): přehled otevřené práce,
// kontrola před deaktivací, akce „Předat práci" a položka v „Co se změnilo".
// Databázová funkce transfer_member_work (0088, od 0093 i cílové seznamy) se
// zkouší v PGlite (test/owner-transfer-0088-pglite.test.ts, test/owner-change-0093-pglite.test.ts);
// tady statická shoda s TS s poslední verzí funkce (0093).
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { transferMemberWork } from '@/lib/actions/team'
import { loadMemberOpenWork } from '@/lib/queries/memberWork'
import {
  CLOSED_DEAL_STAGES,
  OPEN_CASE_STATUSES,
  TRANSFER_ERRORS,
  TRANSFER_SEZNAMY_PENDING,
  WORK_KINDS,
  allocationIsOpen,
  buildMemberWork,
  countLabel,
  deactivationBlock,
  parseTransferForm,
  transferResultMessage,
  workSummary,
} from '@/lib/memberWork'
import { handoverChanges } from '@/domain/crm/changes'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<object>()), pragueToday: () => '2026-09-29' }))

const SQL = readFileSync('supabase/migrations/0093_owner_change.sql', 'utf8')
const ME = '11111111-1111-4111-8111-111111111111'
const FROM = '22222222-2222-4222-8222-222222222222'
const TO = '33333333-3333-4333-8333-333333333333'

describe('shoda s transfer_member_work (0093, nová verze 0088)', () => {
  test('druhy práce = v_allowed ve stejném pořadí', () => {
    const m = /v_allowed\s+constant text\[\] := ARRAY\[([^\]]+)\]/.exec(SQL)!
    expect([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1])).toEqual(WORK_KINDS.map((k) => k.key))
  })
  test('uzavřené fáze obchodu a otevřené stavy případu jako v SQL', () => {
    expect(SQL).toContain(`stage::text NOT IN (${CLOSED_DEAL_STAGES.map((s) => `'${s}'`).join(', ')})`)
    expect(SQL).toContain(`status IN (${OPEN_CASE_STATUSES.map((s) => `'${s}'`).join(', ')})`)
  })
  test('každý kód chyby z SQL má českou hlášku', () => {
    const codes = [...new Set([...SQL.matchAll(/ERRCODE = '(TW\d{3})'/g)].map((m) => m[1]))].sort()
    expect(codes).toEqual(Object.keys(TRANSFER_ERRORS).sort())
  })
  test('funkce je jen pro service_role a zapisuje souhrn do auditu', () => {
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION transfer_member_work\([^)]*\) FROM PUBLIC, anon, authenticated;/)
    expect(SQL).toMatch(/GRANT EXECUTE ON FUNCTION transfer_member_work\([^)]*\) TO service_role;/)
    expect(SQL).toContain(`'team_member.work_transferred'`)
  })
})

describe('texty a pravidla', () => {
  test('české tvary počtů', () => {
    expect(countLabel('obchody', 1)).toBe('1 obchod')
    expect(countLabel('obchody', 3)).toBe('3 obchody')
    expect(countLabel('dodavky', 5)).toBe('5 dodávek')
    expect(countLabel('alokace', 2)).toBe('2 alokace')
    expect(countLabel('seznamy', 1)).toBe('1 seznam')
    expect(countLabel('seznamy', 5)).toBe('5 seznamů')
    expect(workSummary({ ukoly: 1, obchody: 2, klienti: 0 })).toBe('2 obchody, 1 úkol')
    expect(workSummary({})).toBe('nic otevřeného')
  })

  test('alokace: běžící a budoucí ano, skončená ne', () => {
    expect(allocationIsOpen({ ends_on: null }, '2026-09-29')).toBe(true)
    expect(allocationIsOpen({ ends_on: '2026-09-29' }, '2026-09-29')).toBe(true)
    expect(allocationIsOpen({ ends_on: '2026-09-28' }, '2026-09-29')).toBe(false)
  })

  test('deaktivace: blokuje otevřenou práci i neznámý stav, potvrzení pustí', () => {
    const empty = buildMemberWork([])
    const open = buildMemberWork([{ kind: 'ukoly', state: 'ok', items: [{ id: '1', title: 'x', href: null, role: 'řešitel' }] }])
    const broken = buildMemberWork([{ kind: 'pripady', state: 'error', items: [] }])
    expect(deactivationBlock(empty, false)).toBeNull()
    expect(deactivationBlock(open, false)).toMatch(/1 úkol/)
    expect(deactivationBlock(broken, false)).toMatch(/nepodařilo načíst/)
    expect(deactivationBlock(null, false)).toMatch(/ověřit/)
    expect(deactivationBlock(open, true)).toBeNull()
    expect(deactivationBlock(null, true)).toBeNull()
  })

  test('chybějící migrace (unavailable) deaktivaci neblokuje', () => {
    expect(deactivationBlock(buildMemberWork([{ kind: 'alokace', state: 'unavailable', items: [] }]), false)).toBeNull()
  })

  test('formulář předání: komu a aspoň jeden známý druh', () => {
    const fd = new FormData()
    fd.set('to_member_id', TO)
    fd.append('kinds', 'obchody')
    fd.append('kinds', 'ukoly')
    expect(parseTransferForm(fd).data).toEqual({ to_member_id: TO, kinds: ['obchody', 'ukoly'] })
    const bad = new FormData()
    bad.set('to_member_id', 'x')
    bad.append('kinds', 'vse')
    const r = parseTransferForm(bad)
    expect(r.success).toBe(false)
    expect(r.error!.issues.map((i) => i.path[0])).toEqual(expect.arrayContaining(['to_member_id', 'kinds']))
  })

  test('zpráva po předání upozorní na uvolněné zástupce', () => {
    expect(transferResultMessage({ obchody: 2, dodavky: 1, bez_zastupce: 1 }, 'Lenka'))
      .toBe('Předáno: 2 obchody, 1 dodávka → Lenka. U 1 věci byl(a) Lenka zároveň zástupcem — zástupce se uvolnil, doplň nového.')
    expect(transferResultMessage({ obchody: 0, bez_zastupce: 0 }, 'Lenka')).toMatch(/Nebylo co předat/)
    expect(transferResultMessage({ seznamy: 2 }, 'Lenka')).toBe('Předáno: 2 seznamy → Lenka.')
  })
})

describe('„Co se změnilo": předání práce', () => {
  const names = new Map([[FROM, 'Petr'], [TO, 'Lenka'], [ME, 'Viktor']])
  test('předání i deaktivace s otevřenou prací, s důkazem v auditu', () => {
    const items = handoverChanges([
      { id: 1, action: 'team_member.work_transferred', entity_ref: FROM, actor_id: ME, occurred_at: '2026-09-29T08:00:00Z', after: { to_member_id: TO, counts: { ukoly: 3, bez_zastupce: 0 } } },
      { id: 2, action: 'team_member.deactivated_with_open_work', entity_ref: FROM, actor_id: ME, occurred_at: '2026-09-29T09:00:00Z', after: { counts: { obchody: 1 } } },
      { id: 3, action: 'team_member.updated', entity_ref: FROM, actor_id: ME, occurred_at: '2026-09-29T10:00:00Z', after: {} },
    ], names)
    expect(items.map((i) => [i.title, i.detail, i.href])).toEqual([
      ['Petr: deaktivace s otevřenou prací', 'Nepředáno: 1 obchod · potvrdil(a) Viktor', `/cockpit/tym/${FROM}/predat`],
      ['Petr → Lenka', 'Předáno: 3 úkoly · předal(a) Viktor', '/cockpit/tasks'],
    ])
    expect(items[1].proof).toMatch(/Záznam v auditu č. 1/)
  })
})

// --- Načtení přehledu ---------------------------------------------------------

describe('loadMemberOpenWork', () => {
  const run = (routes: Record<string, QueryResult>, canSeeSales = true) => {
    const fake = createSupabaseFake({ resolve: (c) => routes[c.table] ?? { data: [], error: null } })
    return { fake, work: loadMemberOpenWork(FROM, { canSeeSales, today: '2026-09-29', admin: fake.client as never }) }
  }

  test('otevřené věci ve všech druzích, role vlastník/zástupce, uzavřené obchody a skončené alokace ne', async () => {
    const { fake, work } = run({
      deal: { data: [{ id: 1, title: 'Agent', stage: 'rozhodovani', account_id: 4, account: { name: 'ALFATECH' } }, { id: 2, title: 'Starý', stage: 'prohráno', account_id: 4 }], error: null },
      engagement: { data: [{ id: 3, kind: 'it', account_id: 4, owner_id: TO, deputy_id: FROM, account: { name: 'ALFATECH' } }], error: null },
      allocation: { data: [
        { id: 8, member_id: FROM, engagement_id: 3, work_case_id: null, hours_per_week: '8', starts_on: '2026-09-01', ends_on: null, engagement: { account_id: 4, kind: 'it', account: { name: 'ALFATECH' } }, work_case: null },
        { id: 9, member_id: FROM, engagement_id: 3, work_case_id: null, hours_per_week: 4, starts_on: '2026-08-01', ends_on: '2026-08-31', engagement: null, work_case: null },
      ], error: null },
      loop_node: { data: [{ node: 'eventy', owner_id: FROM, deputy_id: null }], error: null },
      target_list: { data: [{ id: 5, name: 'Výroba střední Morava', segment: 'Výroba' }], error: null },
    })
    const w = await work
    const by = Object.fromEntries(w.groups.map((g) => [g.kind, g]))
    expect(by.obchody.items).toEqual([expect.objectContaining({ id: '1', title: 'Agent', href: '/cockpit/clients/4/deals/1' })])
    expect(by.dodavky.items[0]).toMatchObject({ role: 'zástupce', title: 'ALFATECH · Akce' })
    expect(by.alokace.items.map((i) => i.id)).toEqual(['8'])
    expect(by.oblasti.items[0]).toMatchObject({ title: 'Eventy a realizace', role: 'vlastník oblasti' })
    expect(by.seznamy.items).toEqual([{ id: '5', title: 'Výroba střední Morava', href: '/cockpit/cilove-seznamy/5', role: 'vlastník seznamu', detail: 'Výroba' }])
    expect(w.total).toBe(5)
    expect(opArgs(fake.calls.find((c) => c.table === 'target_list')!, 'eq')).toEqual(['owner_id', FROM])
    // dodávky: jen neuzavřené, vlastník nebo zástupce
    const eng = fake.calls.find((c) => c.table === 'engagement')!
    expect(opArgs(eng, 'or')).toEqual([`owner_id.eq.${FROM},deputy_id.eq.${FROM}`])
    expect(opArgs(eng, 'neq')).toEqual(['phase', 'uzavreno'])
    expect(fake.calls.every((c) => !hasOp(c, 'update') && !hasOp(c, 'insert'))).toBe(true)
  })

  test('bez obchodní role jen počet obchodů, ne názvy', async () => {
    const { work } = run({ deal: { data: [{ id: 1, title: 'Tajný obchod', stage: 'kvalifikace', account_id: 4 }], error: null } }, false)
    const deals = (await work).groups.find((g) => g.kind === 'obchody')!
    expect(deals.hiddenTitles).toBe(true)
    expect(JSON.stringify(deals)).not.toContain('Tajný')
    expect(deals.items[0].href).toBeNull()
  })

  test('cílové seznamy bez obchodní role: jen počet, ne názvy', async () => {
    const { work } = run({ target_list: { data: [{ id: 5, name: 'Tajný seznam', segment: 'Banky' }], error: null } }, false)
    const lists = (await work).groups.find((g) => g.kind === 'seznamy')!
    expect(lists.hiddenTitles).toBe(true)
    expect(JSON.stringify(lists)).not.toMatch(/Tajný|Banky/)
    expect(lists.items[0].href).toBeNull()
  })

  test('chybějící tabulka = čeká na migraci, jiná chyba = neúplné', async () => {
    const { work } = run({
      allocation: { data: null, error: { code: '42P01', message: 'relation "allocation" does not exist' } },
      work_case: { data: null, error: { code: '57014', message: 'timeout' } },
    })
    const w = await work
    expect(w.groups.find((g) => g.kind === 'alokace')!.state).toBe('unavailable')
    expect(w.groups.find((g) => g.kind === 'pripady')!.state).toBe('error')
    expect(w.incomplete).toBe(true)
  })
})

// --- Akce „Předat práci" -------------------------------------------------------

describe('transferMemberWork', () => {
  const form = (to: string, kinds: string[]) => {
    const fd = new FormData()
    fd.set('to_member_id', to)
    for (const k of kinds) fd.append('kinds', k)
    return fd
  }
  function setup(opts: { admin?: boolean; rpc?: QueryResult } = {}) {
    const gate = createSupabaseFake({ resolve: () => ({ data: { is_admin: opts.admin ?? true }, error: null }) })
    const adminFake = createSupabaseFake({
      resolve: (c: QueryCall) => (c.table === 'team_member' ? { data: { full_name: 'Lenka', email: 'm@mummiesdaddies.com' }, error: null } : { data: null, error: null }),
      rpc: () => opts.rpc ?? { data: { obchody: 2, ukoly: 1, bez_zastupce: 0 }, error: null },
    })
    vi.mocked(tryRequireUser).mockResolvedValue({ id: ME } as never)
    vi.mocked(createClient).mockResolvedValue(gate.client as never)
    vi.mocked(createAdminClient).mockReturnValue(adminFake.client as never)
    return adminFake
  }
  beforeEach(() => vi.clearAllMocks())

  test('zavolá transfer_member_work s aktérem, dneškem a hlavičkou aktéra auditu', async () => {
    const fake = setup()
    const r = await transferMemberWork(FROM, null, form(TO, ['obchody', 'ukoly']))
    expect(r).toEqual({ success: true, message: 'Předáno: 2 obchody, 1 úkol → Lenka.' })
    expect(fake.rpc).toHaveBeenCalledWith('transfer_member_work', {
      p_from: FROM, p_to: TO, p_actor: ME, p_kinds: ['obchody', 'ukoly'], p_today: '2026-09-29',
    })
    expect(vi.mocked(createAdminClient)).toHaveBeenCalledWith({ headers: { 'x-cockpit-audit-actor': `user:${ME}` } })
  })

  test('jen správce; sám sobě ne; neplatný vstup nic nevolá', async () => {
    let fake = setup({ admin: false })
    expect(await transferMemberWork(FROM, null, form(TO, ['ukoly']))).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(fake.rpc).not.toHaveBeenCalled()
    fake = setup()
    expect((await transferMemberWork(FROM, null, form(FROM, ['ukoly']))).fieldErrors?.to_member_id).toBe(TRANSFER_ERRORS.TW001)
    expect((await transferMemberWork(FROM, null, form(TO, []))).fieldErrors?.kinds).toBeTruthy()
    expect((await transferMemberWork('x', null, form(TO, ['ukoly']))).error).toBe('Neplatný uživatel.')
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test('chyby funkce česky; bez migrace klidná hláška', async () => {
    setup({ rpc: { data: null, error: { code: 'TW002', message: 'x' } } })
    expect((await transferMemberWork(FROM, null, form(TO, ['ukoly']))).error).toBe(TRANSFER_ERRORS.TW002)
    setup({ rpc: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } })
    expect((await transferMemberWork(FROM, null, form(TO, ['ukoly']))).error).toBe('Předání práce čeká na migraci 0088.')
  })

  test('starší databáze (jen 0088) nezná druh seznamy: hláška o migraci 0093, ne „neznámý druh"', async () => {
    setup({ rpc: { data: null, error: { code: 'TW004', message: 'x' } } })
    expect((await transferMemberWork(FROM, null, form(TO, ['ukoly', 'seznamy']))).error).toBe(TRANSFER_SEZNAMY_PENDING)
    expect((await transferMemberWork(FROM, null, form(TO, ['ukoly']))).error).toBe(TRANSFER_ERRORS.TW004)
  })

  test('cílové seznamy se posílají do funkce jako další druh', async () => {
    const fake = setup({ rpc: { data: { seznamy: 2, bez_zastupce: 0 }, error: null } })
    const r = await transferMemberWork(FROM, null, form(TO, ['seznamy']))
    expect(r).toEqual({ success: true, message: 'Předáno: 2 seznamy → Lenka.' })
    expect(fake.rpc).toHaveBeenCalledWith('transfer_member_work', expect.objectContaining({ p_kinds: ['seznamy'] }))
  })
})
