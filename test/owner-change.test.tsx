// Jednotlivá změna vlastníka (případ, milník, obchod, dodávka, cílový seznam):
// čistá logika (lib/ownerChange.ts), akce changeWorkOwner (lib/actions/ownerChange.ts),
// položka v „Co se změnilo" a statická shoda s migrací 0093. Tlačítko a formulář
// zkouší test/owner-change-ui.test.tsx, databázovou funkci change_work_owner
// test/owner-change-0093-pglite.test.ts (PGlite).
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { createAdminClient } from '@/lib/supabase/admin'
import { changeWorkOwner } from '@/lib/actions/ownerChange'
import { handoverChanges, HANDOVER_ACTIONS } from '@/domain/crm/changes'
import {
  OWNER_CHANGE_ERRORS,
  OWNER_CHANGE_PENDING,
  OWNER_KINDS,
  canChangeOwner,
  ownerChangeMessage,
  ownerChangePaths,
  ownerChangeSchema,
  ownerOptions,
} from '@/lib/ownerChange'
import { createSupabaseFake, type QueryResult } from './helpers/supabaseFake'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const SQL = readFileSync('supabase/migrations/0093_owner_change.sql', 'utf8')
const ME = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
const C = '44444444-4444-4444-8444-444444444444'

// --- Shoda s migrací ---------------------------------------------------------

describe('shoda s change_work_owner (0093)', () => {
  test('druhy věcí = p_kind v SQL', () => {
    const m = /p_kind NOT IN \(([^)]+)\)/.exec(SQL)!
    expect([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort()).toEqual(OWNER_KINDS.map((k) => k.key).sort())
  })
  test('druhy se zástupcem = v_has_deputy v SQL', () => {
    const m = /v_has_deputy boolean := p_kind IN \(([^)]+)\)/.exec(SQL)!
    const withDeputy = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort()
    expect(withDeputy).toEqual(OWNER_KINDS.filter((k) => k.hasDeputy).map((k) => k.key).sort())
  })
  test('každý kód chyby OC z SQL má českou hlášku a naopak', () => {
    const codes = [...new Set([...SQL.matchAll(/ERRCODE = '(OC\d{3})'/g)].map((m) => m[1]))].sort()
    expect(codes).toEqual(Object.keys(OWNER_CHANGE_ERRORS).sort())
  })
  test('funkce je jen pro service_role, píše souhrn do auditu a používá akci z „Co se změnilo"', () => {
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION change_work_owner\([^)]*\) FROM PUBLIC, anon, authenticated;/)
    expect(SQL).toMatch(/GRANT EXECUTE ON FUNCTION change_work_owner\([^)]*\) TO service_role;/)
    expect(SQL).toContain(`'team_member.work_item_reassigned'`)
    expect(HANDOVER_ACTIONS).toContain('team_member.work_item_reassigned')
  })
  test('uzavřené věci jako v hromadném předání', () => {
    expect(SQL).toContain(`c.status NOT IN ('open', 'in_progress', 'waiting')`)
    expect(SQL).toContain(`m.status = 'uzavreno'`)
    expect(SQL).toContain(`e.phase::text = 'uzavreno'`)
    expect(SQL).toContain(`d.stage::text IN ('vyhráno', 'prohráno', 'odloženo')`)
  })
})

// --- Čistá logika --------------------------------------------------------------

describe('canChangeOwner (zrcadlo oprávnění v SQL)', () => {
  const item = { ownerId: A, deputyId: B, nodeOwnerId: C }
  test('správce a vedení vždy, jinak jen vlastník, zástupce a u případu vlastník oblasti', () => {
    expect(canChangeOwner('pripady', { id: ME, role: 'projektak', is_admin: true }, item)).toBe(true)
    expect(canChangeOwner('pripady', { id: ME, role: 'vedeni' }, item)).toBe(true)
    expect(canChangeOwner('pripady', { id: A, role: 'projektak' }, item)).toBe(true)
    expect(canChangeOwner('pripady', { id: B, role: 'lektor' }, item)).toBe(true)
    expect(canChangeOwner('pripady', { id: C, role: 'obchodnik' }, item)).toBe(true)
    expect(canChangeOwner('pripady', { id: ME, role: 'projektak' }, item)).toBe(false)
  })
  test('vlastník oblasti jen u případu; obchod a seznam zástupce nemají', () => {
    expect(canChangeOwner('dodavky', { id: C, role: 'obchodnik' }, item)).toBe(false)
    expect(canChangeOwner('obchody', { id: B, role: 'obchodnik' }, item)).toBe(false)
    expect(canChangeOwner('seznamy', { id: A, role: 'obchodnik' }, item)).toBe(true)
  })
  test('Partner, deaktivovaný přihlášený a nikdo nesmí nic', () => {
    expect(canChangeOwner('pripady', { id: A, role: 'partner', is_admin: true }, item)).toBe(false)
    expect(canChangeOwner('pripady', null, item)).toBe(false)
  })
  test('věc bez vlastníka: jen správce a vedení', () => {
    expect(canChangeOwner('obchody', { id: A, role: 'obchodnik' }, { ownerId: null })).toBe(false)
    expect(canChangeOwner('obchody', { id: A, role: 'vedeni' }, { ownerId: null })).toBe(true)
  })
})

describe('ownerOptions', () => {
  test('jen aktivní interní role, seřazené podle jména; deaktivovaný a Partner ne', () => {
    const list = ownerOptions([
      { id: A, full_name: 'Petr', email: 'p@x.cz', role: 'projektak' },
      { id: B, full_name: 'Adéla', email: 'a@x.cz', role: 'vedeni' },
      { id: C, full_name: 'Pryč', email: 'c@x.cz', role: 'projektak', deactivated_at: '2026-09-01T00:00:00Z' },
      { id: ME, full_name: 'Partner', email: 'q@x.cz', role: 'partner' },
    ])
    expect(list).toEqual([
      { id: B, name: 'Adéla', roleLabel: 'Vedení' },
      { id: A, name: 'Petr', roleLabel: 'Projekťák / IT' },
    ])
  })
})

describe('ownerChangeSchema a texty', () => {
  test('přijme vstup akce, zástupce chybějící = null, špatné id a druh ne', () => {
    expect(ownerChangeSchema.parse({ kind: 'pripady', id: 5, owner_id: A })).toMatchObject({ kind: 'pripady', id: 5, owner_id: A, deputy_id: null })
    expect(ownerChangeSchema.safeParse({ kind: 'sklady', id: 5, owner_id: A }).success).toBe(false)
    expect(ownerChangeSchema.safeParse({ kind: 'pripady', id: 0, owner_id: A }).success).toBe(false)
    expect(ownerChangeSchema.safeParse({ kind: 'pripady', id: 5, owner_id: 'viktor' }).success).toBe(false)
  })
  test('věty po změně', () => {
    expect(ownerChangeMessage({ kind: 'pripady', role: 'owner', fromName: 'Petr', toName: 'Lenka' })).toBe('Vlastník případu: Petr → Lenka.')
    expect(ownerChangeMessage({ kind: 'dodavky', role: 'owner', fromName: 'Petr', toName: 'Lenka', freedDeputy: true }))
      .toBe('Vlastník dodávky: Petr → Lenka. Zástupce se uvolnil, doplň nového.')
    expect(ownerChangeMessage({ kind: 'milniky', role: 'deputy', fromName: 'Petr', toName: null })).toBe('Zástupce milníku: Petr → nikdo.')
    expect(ownerChangeMessage({ kind: 'obchody', role: 'owner', fromName: null, toName: 'Lenka', undone: true }))
      .toBe('Vráceno zpět. Vlastník obchodu: nikdo → Lenka.')
  })
  test('cesty k přegenerování podle druhu', () => {
    expect(ownerChangePaths('pripady', 5, null, null)).toEqual(['/cockpit', '/cockpit/pripady/5', '/cockpit/pripady'])
    expect(ownerChangePaths('obchody', 9, 4, null)).toEqual(['/cockpit', '/cockpit/pipeline', '/cockpit/clients/4/deals/9'])
    expect(ownerChangePaths('milniky', 3, 4, 7)).toEqual(['/cockpit', '/cockpit/dodavky', '/cockpit/clients/4/engagements/7/edit'])
    expect(ownerChangePaths('seznamy', 2, null, null)).toEqual(['/cockpit', '/cockpit/cilove-seznamy', '/cockpit/cilove-seznamy/2'])
  })
})

// --- Akce ---------------------------------------------------------------------

describe('changeWorkOwner', () => {
  function setup(rpc: QueryResult, user: { id: string } | null = { id: ME }) {
    const fake = createSupabaseFake({
      rpc: () => rpc,
      resolve: () => ({
        data: [
          { id: A, full_name: 'Petr Novák', email: 'p@mummiesdaddies.com' },
          { id: B, full_name: 'Lenka', email: 'm@mummiesdaddies.com' },
        ],
        error: null,
      }),
    })
    vi.mocked(tryRequireUser).mockResolvedValue(user as never)
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
    return fake
  }
  beforeEach(() => vi.clearAllMocks())

  test('zavolá change_work_owner s aktérem z přihlášení, hlavičkou auditu a očekávaným stavem; vrátí větu a Zpět', async () => {
    const fake = setup({
      data: { changed: true, audit_id: 77, kind: 'pripady', id: 5, account_id: 3, engagement_id: null, role: 'owner', owner: B, deputy: null, before_owner: A, before_deputy: B, freed_deputy: 1 },
      error: null,
    })
    const r = await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: B, deputy_id: null, expect: { owner: A, deputy: B } })
    expect(r).toEqual({
      success: true,
      changed: true,
      message: 'Vlastník případu: Petr Novák → Lenka. Zástupce se uvolnil, doplň nového.',
      undo: { auditId: 77, owner: A, deputy: B },
    })
    expect(fake.rpc).toHaveBeenCalledWith('change_work_owner', {
      p_kind: 'pripady', p_id: 5, p_actor: ME, p_owner: B, p_deputy: null, p_expect: { owner: A, deputy: B }, p_undo_of: null,
    })
    expect(vi.mocked(createAdminClient)).toHaveBeenCalledWith({ headers: { 'x-cockpit-audit-actor': `user:${ME}` } })
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(['/cockpit', '/cockpit/pripady/5', '/cockpit/pripady'])
  })

  test('vrácení: undo_of jde do funkce, výsledek už Zpět nenabízí', async () => {
    const fake = setup({
      data: { changed: true, audit_id: 78, kind: 'pripady', id: 5, role: 'owner', owner: A, deputy: B, before_owner: B, before_deputy: null, freed_deputy: 0 },
      error: null,
    })
    const r = await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A, deputy_id: B, undo_of: 77 })
    expect(r).toMatchObject({ success: true, changed: true, undo: null, message: 'Vráceno zpět. Vlastník případu: Lenka → Petr Novák.' })
    expect(fake.rpc).toHaveBeenCalledWith('change_work_owner', expect.objectContaining({ p_undo_of: 77, p_expect: null }))
  })

  test('beze změny nic neohlašuje ani nepřegenerovává', async () => {
    setup({ data: { changed: false, kind: 'pripady', id: 5 }, error: null })
    expect(await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A })).toEqual({ success: true, changed: false, message: 'Beze změny.', undo: null })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('nepřihlášený, špatný vstup a vlastník = zástupce nic nevolají', async () => {
    let fake = setup({ data: null, error: null }, null)
    expect(await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A })).toEqual({ success: false, error: 'auth' })
    fake = setup({ data: null, error: null })
    expect((await changeWorkOwner({ kind: 'sklady', id: 5, owner_id: A })).success).toBe(false)
    expect(await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A, deputy_id: A })).toMatchObject({ success: false, fieldErrors: { deputy_id: OWNER_CHANGE_ERRORS.OC008 } })
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test('chyby funkce česky, u výběru s chybou u pole; bez migrace klidná hláška', async () => {
    setup({ data: null, error: { code: 'OC001', message: 'x' } })
    expect(await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A })).toEqual({ success: false, error: OWNER_CHANGE_ERRORS.OC001 })
    setup({ data: null, error: { code: 'OC007', message: 'x' } })
    expect(await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A })).toMatchObject({ success: false, fieldErrors: { owner_id: OWNER_CHANGE_ERRORS.OC007 } })
    setup({ data: null, error: { code: 'OC006', message: 'x' } })
    expect((await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A }) as { error: string }).error).toBe(OWNER_CHANGE_ERRORS.OC006)
    setup({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    expect(await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A })).toEqual({ success: false, error: OWNER_CHANGE_PENDING })
    setup({ data: null, error: { code: 'XX000', message: 'secret table name' } })
    const r = await changeWorkOwner({ kind: 'pripady', id: 5, owner_id: A })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r)).not.toContain('secret')
  })
})

// --- „Co se změnilo" -----------------------------------------------------------

describe('„Co se změnilo": jednotlivá změna vlastníka', () => {
  const names = new Map([[A, 'Petr'], [B, 'Lenka'], [ME, 'Viktor']])
  const ev = (id: number, after: Record<string, unknown>, entity_ref: string | null = A) => ({
    id, action: 'team_member.work_item_reassigned', entity_ref, actor_id: ME, occurred_at: '2026-09-30T08:00:00Z', after,
  })

  test('případ: od koho komu, role, kdo předal, odkaz na věc a důkaz v auditu', () => {
    const [item] = handoverChanges([ev(5, {
      kind: 'pripady', item_id: 12, account_id: 3, engagement_id: null, role: 'owner', from_member_id: A, to_member_id: B,
      counts: { pripady: 1, bez_zastupce: 1 },
    })], names)
    expect(item).toMatchObject({
      kind: 'handover',
      title: 'Petr → Lenka',
      detail: 'Předáno: 1 případ (vlastník) · 1 bez zástupce · předal(a) Viktor',
      href: '/cockpit/pripady/12',
    })
    expect(item.proof).toMatch(/Záznam v auditu č. 5/)
  })

  test('věc bez dosavadního vlastníka, zrušený zástupce, vrácení zpět', () => {
    const items = handoverChanges([
      ev(1, { kind: 'dodavky', item_id: 7, account_id: 3, engagement_id: 7, role: 'owner', from_member_id: null, to_member_id: B, counts: { dodavky: 1, bez_zastupce: 0 } }, B),
      ev(2, { kind: 'milniky', item_id: 9, account_id: 3, engagement_id: 7, role: 'deputy', from_member_id: A, to_member_id: null, counts: { milniky: 1, bez_zastupce: 0 } }),
      ev(3, { kind: 'pripady', item_id: 12, role: 'owner', from_member_id: B, to_member_id: A, undo_of: 5, counts: { pripady: 1, bez_zastupce: 0 } }),
    ], names)
    const by = Object.fromEntries(items.map((i) => [i.key, i]))
    expect(by['handover-1']).toMatchObject({ title: 'Bez vlastníka → Lenka', href: '/cockpit/clients/3/engagements/7/edit?zalozka=tym' })
    expect(by['handover-2']).toMatchObject({
      title: 'Petr → bez zástupce',
      detail: 'Předáno: 1 milník (zástupce) · předal(a) Viktor',
      href: '/cockpit/clients/3/engagements/7/edit?zalozka=milniky#milnik-9',
    })
    expect(by['handover-3'].detail).toBe('Vráceno zpět: 1 případ (vlastník) · vrátil(a) Viktor')
  })

  test('obchody a seznamy vedou na detail jen obchodní roli, jinak na neutrální odkaz; v audit záznamu jsou jen id', () => {
    const deal = ev(4, { kind: 'obchody', item_id: 9, account_id: 4, role: 'owner', from_member_id: A, to_member_id: B, counts: { obchody: 1, bez_zastupce: 0 } })
    const list = ev(5, { kind: 'seznamy', item_id: 2, role: 'owner', from_member_id: A, to_member_id: B, counts: { seznamy: 1, bez_zastupce: 0 } })
    expect(handoverChanges([deal, list], names, { canSeeSales: true }).map((i) => i.href).sort()).toEqual(['/cockpit/cilove-seznamy/2', '/cockpit/clients/4/deals/9'])
    expect(handoverChanges([deal, list], names).map((i) => i.href)).toEqual(['/cockpit/tasks', '/cockpit/tasks'])
    expect(handoverChanges([deal], names, { canSeeSales: true })[0].detail).toBe('Předáno: 1 obchod (vlastník) · předal(a) Viktor')
  })

  test('poškozený záznam bez druhu se ukáže s neutrálním odkazem, ne pádem', () => {
    const [item] = handoverChanges([ev(6, { counts: { pripady: 1 } })], names)
    expect(item.href).toBe('/cockpit/tasks')
  })
})
