import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { setMilestoneDue, updateMilestone } from '@/domain/delivery/actions/milestones'
import {
  isMilestoneLocked,
  milestoneDueSchema,
  milestoneUpdateSchema,
  milestonesWithoutDue,
  missingDueHeadline,
} from '@/domain/delivery/milestone'
import { MilestoneList } from '@/components/MilestoneList'
import { GanttMissingDue, buildGantt } from '@/components/WorkGantt'
import type { EngagementMilestone } from '@/domain/delivery/queries/milestones'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Úprava milníku dodávky (název, termín, vlastník, zástupce) a rychlé
// doplnění termínu u milníku bez termínu (typicky po vyhraném obchodu, 0080).
// Hlídáme: AAL2 bránu, validaci, vazbu na dodávku firmy, zámek přijatého
// milníku, zámek na stav při souběhu, audit (záloha před 0064 ve tvaru
// triggeru, bez názvu jako hodnoty) a výraznou výzvu „Doplnit termín".

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }))
vi.mock('@/core/evidence', () => ({ recordEvidence: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

const USER = { id: '00000000-0000-4000-8000-000000000001' }
const OWNER = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'
const DEPUTY = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue(USER as never)
  vi.mocked(dbAuditActive).mockResolvedValue(false)
})

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

type Route = (call: QueryCall) => QueryResult | undefined
function fakeWith(...routes: Route[]) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      for (const r of routes) {
        const out = r(call)
        if (out) return out
      }
      return { data: null, error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}
const isRead = (c: QueryCall) => !hasOp(c, 'update') && !hasOp(c, 'insert') && !hasOp(c, 'delete')
const engagementOf = (accountId: number): Route => (c) =>
  c.table === 'engagement' && isRead(c) ? { data: { id: 2, account_id: accountId }, error: null } : undefined
const milestone = (extra: Record<string, unknown> = {}): Route => (c) =>
  c.table === 'engagement_milestone' && isRead(c)
    ? {
        data: {
          id: 3, status: 'pripraveno', title: 'Workshop', owner_id: OWNER, deputy_id: null, due_on: null,
          accepted_at: null, accepted_by_contact_id: null, acceptance_evidence_id: null, ...extra,
        },
        error: null,
      }
    : undefined
const updated = (rows: unknown[] = [{ id: 3 }]): Route => (c) => (hasOp(c, 'update') ? { data: rows, error: null } : undefined)
const updates = (fake: ReturnType<typeof fakeWith>) => fake.calls.filter((c) => c.table === 'engagement_milestone' && hasOp(c, 'update'))

describe('updateMilestone', () => {
  const valid = { title: 'Workshop s vedením', owner_id: OWNER, deputy_id: DEPUTY, due_on: '2026-10-15' }

  test('bez AAL2 se nic nečte ani nezapíše', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = fakeWith()
    expect(await updateMilestone(1, 2, 3, undefined, fd(valid))).toEqual({ success: false, error: 'auth' })
    expect(await setMilestoneDue(1, 2, 3, undefined, fd({ due_on: '2026-10-15' }))).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
  })

  test('neplatná ID a vstupy se DB nedotknou', async () => {
    const fake = fakeWith()
    expect(await updateMilestone(1, 2, 0, undefined, fd(valid))).toEqual({ success: false, error: 'Neplatné ID.' })
    expect((await updateMilestone(1, 2, 3, undefined, fd({ ...valid, title: '  ' }))).fieldErrors?.title).toBeTruthy()
    expect((await updateMilestone(1, 2, 3, undefined, fd({ ...valid, deputy_id: OWNER }))).fieldErrors?.deputy_id)
      .toBe('Zástupce musí být jiný člověk než vlastník.')
    expect((await updateMilestone(1, 2, 3, undefined, fd({ ...valid, due_on: '2026-02-31' }))).fieldErrors?.due_on).toBe('Neplatné datum.')
    expect((await updateMilestone(1, 2, 3, undefined, fd({ ...valid, owner_id: 'viktor' }))).fieldErrors?.owner_id).toBe('Neplatný člen týmu.')
    expect(fake.calls).toHaveLength(0)
  })

  test('cizí dodávka (jiná firma) → nenalezeno, žádný zápis', async () => {
    const fake = fakeWith(engagementOf(99), milestone(), updated())
    expect(await updateMilestone(1, 2, 3, undefined, fd(valid))).toEqual({ success: false, error: 'Dodávka nebyla nalezena.' })
    expect(updates(fake)).toHaveLength(0)
  })

  test.each(['prijato', 'uzavreno'])('přijatý milník (%s) je zamčený', async (status) => {
    const fake = fakeWith(engagementOf(1), milestone({ status }), updated())
    const r = await updateMilestone(1, 2, 3, undefined, fd(valid))
    expect(r).toEqual({ success: false, error: 'Přijatý milník už upravit nejde — nese doklad akceptace od klienta.' })
    expect(updates(fake)).toHaveLength(0)
  })

  test('uloží název, lidi i termín se zámkem na stav; audit ve tvaru triggeru, název jen jménem', async () => {
    const fake = fakeWith(engagementOf(1), milestone(), updated())
    expect(await updateMilestone(1, 2, 3, undefined, fd(valid))).toEqual({ success: true })
    const [u] = updates(fake)
    expect(opArgs(u, 'update')).toEqual([valid])
    expect(u.ops.filter((o) => o.method === 'eq').map((o) => o.args)).toEqual([['id', 3], ['engagement_id', 2], ['status', 'pripraveno']])
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1/engagements/2/edit')
    expect(recordAudit).toHaveBeenCalledWith(
      'engagement_milestone', 3, 'engagement_milestone.updated',
      { deputy_id: null, due_on: null },
      { deputy_id: DEPUTY, due_on: '2026-10-15', _columns: ['deputy_id', 'due_on', 'title'] },
      { type: 'user', id: USER.id },
    )
    expect(JSON.stringify(vi.mocked(recordAudit).mock.calls)).not.toContain('Workshop s vedením')
  })

  test('po migraci 0064 audit zapisuje trigger — appka ne (nikdy obojí)', async () => {
    vi.mocked(dbAuditActive).mockResolvedValue(true)
    fakeWith(engagementOf(1), milestone(), updated())
    expect(await updateMilestone(1, 2, 3, undefined, fd(valid))).toEqual({ success: true })
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('souběh: milník mezitím změnil stav → nic se nepřepíše', async () => {
    fakeWith(engagementOf(1), milestone(), updated([]))
    expect(await updateMilestone(1, 2, 3, undefined, fd(valid))).toEqual({
      success: false, error: 'Milník mezitím změnil stav. Načti prosím stránku znovu.',
    })
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('prázdný vlastník, zástupce i termín = nepřiřazen / bez termínu', async () => {
    const fake = fakeWith(engagementOf(1), milestone({ due_on: '2026-10-01' }), updated())
    await updateMilestone(1, 2, 3, undefined, fd({ title: 'Workshop', owner_id: '', deputy_id: '', due_on: '' }))
    expect(opArgs(updates(fake)[0], 'update')).toEqual([{ title: 'Workshop', owner_id: null, deputy_id: null, due_on: null }])
  })
})

describe('setMilestoneDue (Doplnit termín)', () => {
  test('mění jen termín', async () => {
    const fake = fakeWith(engagementOf(1), milestone(), updated())
    expect(await setMilestoneDue(1, 2, 3, undefined, fd({ due_on: '2026-10-20' }))).toEqual({ success: true })
    expect(opArgs(updates(fake)[0], 'update')).toEqual([{ due_on: '2026-10-20' }])
    expect(recordAudit).toHaveBeenCalledWith(
      'engagement_milestone', 3, 'engagement_milestone.updated',
      { due_on: null }, { due_on: '2026-10-20', _columns: ['due_on'] }, { type: 'user', id: USER.id },
    )
  })

  test('bez data nebo s nesmyslným datem nic nezapíše', async () => {
    const fake = fakeWith(engagementOf(1), milestone(), updated())
    expect((await setMilestoneDue(1, 2, 3, undefined, fd({ due_on: '' }))).fieldErrors?.due_on).toBe('Vyber termín.')
    expect((await setMilestoneDue(1, 2, 3, undefined, fd({}))).fieldErrors?.due_on).toBe('Vyber termín.')
    expect((await setMilestoneDue(1, 2, 3, undefined, fd({ due_on: '20266-01-01' }))).fieldErrors?.due_on).toBe('Neplatné datum.')
    expect(fake.calls).toHaveLength(0)
  })

  test('přijatý milník termín nedostane', async () => {
    const fake = fakeWith(engagementOf(1), milestone({ status: 'prijato' }), updated())
    expect((await setMilestoneDue(1, 2, 3, undefined, fd({ due_on: '2026-10-20' }))).success).toBe(false)
    expect(updates(fake)).toHaveLength(0)
  })
})

describe('pravidla milníku', () => {
  test('zámek, milníky bez termínu a české tvary', () => {
    expect(isMilestoneLocked('prijato')).toBe(true)
    expect(isMilestoneLocked('uzavreno')).toBe(true)
    expect(isMilestoneLocked('ceka_na_schvaleni')).toBe(false)
    const list = [
      { id: 1, status: 'pripraveno' as const, due_on: null },
      { id: 2, status: 'v_praci' as const, due_on: '2026-10-01' },
      { id: 3, status: 'prijato' as const, due_on: null },
    ]
    expect(milestonesWithoutDue(list).map((m) => m.id)).toEqual([1])
    expect([1, 2, 4, 5].map(missingDueHeadline)).toEqual([
      '1 milník nemá termín.', '2 milníky nemají termín.', '4 milníky nemají termín.', '5 milníků nemá termín.',
    ])
  })

  test('schémata úpravy a termínu', () => {
    expect(milestoneUpdateSchema.parse({ title: ' Pilot ', owner_id: '', deputy_id: '', due_on: '' }))
      .toEqual({ title: 'Pilot', owner_id: null, deputy_id: null, due_on: null })
    expect(milestoneDueSchema.parse({ due_on: ' 2026-12-31 ' })).toEqual({ due_on: '2026-12-31' })
    expect(milestoneDueSchema.safeParse({ due_on: '2027-02-29' }).success).toBe(false)
    expect(milestoneDueSchema.safeParse({ due_on: '2028-02-29' }).success).toBe(true)
  })
})

const ms = (p: Partial<EngagementMilestone> & { id: number }): EngagementMilestone => ({
  engagement_id: 2, title: `Milník ${p.id}`, owner_id: OWNER, deputy_id: null, status: 'pripraveno', due_on: null,
  accepted_at: null, accepted_by_contact_id: null, acceptance_evidence_id: null, created_at: '2026-09-29T08:00:00Z', ...p,
})

function renderList(milestones: EngagementMilestone[], acceptedVersions?: Record<number, string | null>) {
  return renderToStaticMarkup(
    <MilestoneList
      accountId={1}
      acceptedVersions={acceptedVersions}
      engagementId={2}
      state="ok"
      milestones={milestones}
      members={[{ id: OWNER, full_name: 'Viktor Kovář' }, { id: DEPUTY, full_name: 'Lenka Horáková' }]}
      contacts={[]}
      documents={[]}
      today="2026-09-29"
    />,
  )
}

describe('přijatá verze dokumentu (0094)', () => {
  const accepted = ms({ id: 5, title: 'Nabídka', status: 'prijato', due_on: '2026-09-20', accepted_at: '2026-09-25T12:00:00Z', acceptance_evidence_id: 9 })

  test('přijatý milník ukáže číslo přijaté verze; bez čísla „konkrétní verze dokumentu"; bez vazby nic', () => {
    expect(renderList([accepted], { 5: '3.0' })).toContain('přijatá verze 3.0')
    expect(renderList([accepted], { 5: null })).toContain('přijatá konkrétní verze dokumentu')
    expect(renderList([accepted])).not.toContain('přijatá')
  })

  test('nepřijatý milník verzi neukazuje, ani kdyby nějaká byla', () => {
    const open = ms({ id: 6, title: 'Pilot', status: 'ceka_na_schvaleni', due_on: '2026-10-30' })
    expect(renderList([open], { 6: '3.0' })).not.toContain('přijatá')
  })
})

describe('obrazovka Milníky', () => {
  test('milník bez termínu má výraznou výzvu Doplnit termín a nahoře souhrn', () => {
    const html = renderList([ms({ id: 1, title: 'Workshop' }), ms({ id: 2, title: 'Pilot', due_on: '2026-10-30' })])
    expect(html).toContain('1 milník nemá termín.')
    expect(html).toContain('Milník nemá termín')
    expect(html).toContain('Doplnit termín')
    expect(html).toContain('Termín<span class="sr-only"> milníku Workshop</span>')
    expect(html).toContain('id="milnik-1"')
    // jen jeden formulář s datem (Pilot termín má)
    expect(html.match(/<input[^>]*type="date" required=""[^>]*name="due_on"/g)).toHaveLength(1)
    expect(html).toContain('Termín: bez termínu')
  })

  test('nepřijatý milník jde upravit a smazat; přijatý ne', () => {
    const html = renderList([
      ms({ id: 1, title: 'Workshop', due_on: '2026-10-01' }),
      ms({ id: 2, title: 'Mapa', status: 'prijato', due_on: null, accepted_at: '2026-09-20T12:00:00Z', acceptance_evidence_id: 5 }),
    ])
    expect(html).toContain('aria-label="Upravit milník Workshop"')
    expect(html).not.toContain('aria-label="Upravit milník Mapa"')
    expect(html.match(/>Smazat</g)).toHaveLength(1)
    // přijatý milník bez termínu výzvu nemá (je zamčený) a do souhrnu se nepočítá
    expect(html).not.toContain('nemá termín.')
    expect(html).not.toContain('Doplnit termín')
  })

  test('milník po termínu je vidět i slovy', () => {
    const html = renderList([ms({ id: 1, title: 'Workshop', due_on: '2026-09-20' })])
    expect(html).toContain('Po termínu')
  })
})

describe('obrazovka Milníky: změna vlastníka (0093)', () => {
  const ownerContext = (actor: { id: string; role: string; is_admin?: boolean }) => ({
    actor,
    members: [{ id: DEPUTY, name: 'Lenka Horáková', roleLabel: 'Vedení' }],
  })
  const list = (milestones: EngagementMilestone[], ctx?: ReturnType<typeof ownerContext>) => renderToStaticMarkup(
    <MilestoneList
      accountId={1} engagementId={2} state="ok" milestones={milestones}
      members={[{ id: OWNER, full_name: 'Viktor Kovář' }, { id: DEPUTY, full_name: 'Lenka Horáková' }]}
      contacts={[]} documents={[]} today="2026-09-29" ownerContext={ctx}
    />,
  )

  test('tlačítko je u každého neuzavřeného milníku, komu smí; přijatý (ne uzavřený) milník ho má také', () => {
    const html = list([
      ms({ id: 1, title: 'Workshop', due_on: '2026-10-01', owner_id: OWNER }),
      ms({ id: 2, title: 'Mapa', status: 'prijato', due_on: null, accepted_at: '2026-09-20T12:00:00Z', acceptance_evidence_id: 5, owner_id: OWNER }),
      ms({ id: 3, title: 'Hotovo', status: 'uzavreno', due_on: null, accepted_at: '2026-09-20T12:00:00Z', acceptance_evidence_id: 5, owner_id: OWNER }),
    ], ownerContext({ id: USER.id, role: 'vedeni' }))
    expect(html).toContain('aria-label="Změnit vlastníka: milník Workshop"')
    expect(html).toContain('aria-label="Změnit vlastníka: milník Mapa"')
    expect(html).not.toContain('Změnit vlastníka: milník Hotovo')
  })

  test('cizí projektak tlačítko nedostane, vlastník a zástupce milníku ano', () => {
    const m = [ms({ id: 1, title: 'Workshop', due_on: '2026-10-01', owner_id: OWNER, deputy_id: DEPUTY })]
    expect(list(m, ownerContext({ id: USER.id, role: 'projektak' }))).not.toContain('Změnit vlastníka')
    expect(list(m, ownerContext({ id: OWNER, role: 'projektak' }))).toContain('Změnit vlastníka: milník Workshop')
    expect(list(m, ownerContext({ id: DEPUTY, role: 'lektor' }))).toContain('Změnit vlastníka: milník Workshop')
  })

  test('bez kontextu (starší volající) tlačítko není a Upravit zůstává beze změny', () => {
    const html = list([ms({ id: 1, title: 'Workshop', due_on: '2026-10-01' })])
    expect(html).not.toContain('Změnit vlastníka:')
    expect(html).toContain('aria-label="Upravit milník Workshop"')
  })

  test('Přidat milník nabízí jen aktivní lidi z kontextu', () => {
    const html = list([], ownerContext({ id: USER.id, role: 'vedeni' }))
    const add = html.slice(html.indexOf('id="novy-milnik"'))
    expect(add).toContain('Lenka Horáková')
    expect(add).not.toContain('Viktor Kovář')
  })
})

describe('časová osa: odkaz k doplnění termínu', () => {
  test('vyjmenuje milníky bez termínu a vede na první z nich', () => {
    const g = buildGantt(
      [ms({ id: 4, title: 'Workshop' }), ms({ id: 5, title: 'Pilot', due_on: '2026-10-30' }), ms({ id: 6, title: 'Vyhodnocení' })],
      { startedOn: '2026-09-29', dueOn: null, today: '2026-09-29' },
    )!
    const html = renderToStaticMarkup(<GanttMissingDue model={g} href="/cockpit/clients/1/engagements/2/edit?zalozka=milniky" />)
    expect(html).toContain('Bez termínu: </span>Workshop, Vyhodnocení.')
    expect(html).toContain('href="/cockpit/clients/1/engagements/2/edit?zalozka=milniky#milnik-4"')
    expect(html).toContain('Doplnit termín')
  })

  test('když mají všechny nepřijaté milníky termín, nic neukáže', () => {
    const g = buildGantt(
      [ms({ id: 1, due_on: '2026-10-30' }), ms({ id: 2, status: 'prijato', accepted_at: '2026-09-29T10:00:00Z' })],
      { startedOn: null, dueOn: null, today: '2026-09-29' },
    )!
    expect(renderToStaticMarkup(<GanttMissingDue model={g} href="/x" />)).toBe('')
  })
})
