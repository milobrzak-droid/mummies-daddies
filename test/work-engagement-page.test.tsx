import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Stránka dodávky se zamockovanými dotazy: hlavička s fází a lidmi, záložky
// přes ?zalozka=, přehled s časovou osou / půlkruhem / dopadem / týmem /
// předáním a klidné stavy před migracemi. Jedna h1.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('notFound') },
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}))
vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<typeof import('@/lib/pragueDate')>()), pragueToday: () => '2026-09-29' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))
vi.mock('@/lib/queries/dealPublic', () => ({ getDealPublic: vi.fn(async () => []), WON_DEAL_STAGE: 'vyhráno' }))
vi.mock('@/lib/queries/team', () => ({ listTeamMembers: vi.fn(async () => [
  { id: 'u1', full_name: 'Viktor Kovář' }, { id: 'u2', full_name: 'Lenka Horáková' },
]) }))
vi.mock('@/connectors/graph', () => ({ filesScopeEnabled: () => false }))
// Kdo smí měnit vlastníka a koho jde vybrat (0093).
vi.mock('@/lib/queries/ownerChange', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/ownerChange')>()),
  loadOwnerChangeContext: vi.fn(async () => ({
    actor: { id: 'u1', role: 'vedeni', is_admin: true },
    members: [{ id: 'u2', name: 'Lenka Horáková', roleLabel: 'Vedení' }],
    nameOf: () => null,
  })),
}))
vi.mock('@/domain/crm/queries/accounts', () => ({
  getAccount: vi.fn(async () => ({ id: 1, name: 'ALFATECH' })),
  getContacts: vi.fn(async () => []),
}))
vi.mock('@/domain/crm/queries/deals', () => ({
  getDealsForAccount: vi.fn(async () => [{ id: 9, title: 'Pilot · zpracování objednávek', stage: 'vyhráno' }]),
}))
vi.mock('@/domain/finance/queries/records', () => ({ getInvoicedMilestoneIds: vi.fn(async () => ({ state: 'ok', ids: [] })) }))
vi.mock('@/domain/delivery/queries/engagements', () => ({
  getEngagement: vi.fn(async () => ({
    id: 3, account_id: 1, deal_id: 9, kind: 'it', phase: 'pilot', started_on: '2026-09-01', due_on: '2026-11-06',
    gate_outputs_captured: true, gate_ratios_respected: true, gate_peer_learning: null, gate_safety_followed: null,
    gate_next_steps_owned: null, gate_pack_delivered: null, reference_worthy: false, owner_id: 'u1', deputy_id: 'u2',
    delivery_team: null, baseline_adoption_pct: null,
  })),
  getReferenceCards: vi.fn(async () => []),
}))
vi.mock('@/domain/delivery/queries/documents', () => ({ getEngagementDocuments: vi.fn(async () => ({ state: 'ok', documents: [] })) }))
vi.mock('@/domain/delivery/queries/milestones', () => ({
  getEngagementMilestones: vi.fn(async () => ({
    state: 'ok',
    milestones: [
      { id: 1, engagement_id: 3, title: 'Workshop', owner_id: 'u1', deputy_id: null, status: 'prijato', due_on: '2026-09-11', accepted_at: '2026-09-10T10:00:00Z', accepted_by_contact_id: null, acceptance_evidence_id: null, created_at: '2026-09-01T08:00:00Z' },
      { id: 2, engagement_id: 3, title: 'Procesní mapa', owner_id: 'u1', deputy_id: null, status: 'ceka_na_schvaleni', due_on: '2026-09-25', accepted_at: null, accepted_by_contact_id: null, acceptance_evidence_id: null, created_at: '2026-09-14T08:00:00Z' },
    ],
  })),
  getMilestoneAcceptedVersions: vi.fn(async () => ({})),
  getEngagementHandoff: vi.fn(async () => ({ state: 'ok', handoff: { goal: 'Zrychlit zpracování', scope: null, client_sponsor_contact_id: null, financial_frame: null, risks: null, handoff_completed_at: null, handoff_by: null } })),
}))
vi.mock('@/domain/delivery/queries/waiting', () => ({
  getWaitingItems: vi.fn(async () => ({
    state: 'ok',
    items: [{
      key: 'm2', milestoneId: 2, engagementId: 3, accountId: 1, accountName: 'ALFATECH', deliveryLabel: 'Akce',
      title: 'Procesní mapa', status: 'ceka_na_schvaleni', kind: 'approval', ownerId: 'u1', since: '2026-09-14T08:00:00Z',
      daysWaiting: 15, dueOn: '2026-09-25', daysOverdue: 4, signals: ['overdue', 'quiet'],
      what: 'Odesláno klientovi 14. 9., zatím není přijato.', href: '/cockpit/clients/1/engagements/3/edit?zalozka=milniky',
      reminderOpen: false, contact: null,
    }],
  })),
}))
vi.mock('@/domain/delivery/queries/capacity', () => ({
  getEngagementAllocations: vi.fn(async () => ({
    state: 'ok',
    allocations: [{ id: 1, member_id: 'u1', engagement_id: 3, work_case_id: null, hours_per_week: 14, starts_on: '2026-09-01', ends_on: null, substitute_id: 'u2', note: null, created_at: '' }],
  })),
  loadTeamCapacity: vi.fn(async () => ({ ok: true, capacityColumn: true, members: [{ id: 'u1', full_name: 'Viktor Kovář', weekly_capacity_hours: 40 }] })),
}))
vi.mock('@/domain/delivery/queries/impact', () => ({
  getMetricObservations: vi.fn(async () => ({
    state: 'ok',
    observations: [{ id: 1, engagement_id: 3, metric: 'Doba zpracování objednávky', unit: 'min', baseline: 18, actual: 4, observed_on: '2026-09-28', evidence_id: null, note: null, created_at: '', evidence_link: null }],
  })),
}))

async function render(sp: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/cockpit/clients/[id]/engagements/[engagementId]/edit/page')
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: '1', engagementId: '3' }), searchParams: Promise.resolve(sp) }))
}

beforeEach(() => vi.clearAllMocks())

describe('stránka dodávky', () => {
  test('přehled: hlavička, lidé, osa, půlkruh, dopad, tým a předání; jedna h1; bez slova engagement', async () => {
    const html = await render()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('Dodávka: Pilot · zpracování objednávek')
    expect(html).toContain('Fáze: Zkouška menu')
    expect(html).toContain('Viktor Kovář')
    expect(html).toContain('Lenka Horáková')
    expect(html).toContain('Zbývá 38 dní')
    expect(html).toContain('Časová osa dodávky')
    expect(html).toContain('Časová osa milníků: 2 milníky, 1 přijato.')
    expect(html).toContain('2 z 6 bran splněno')
    expect(html).toContain('Dopad na klienta')
    expect(html).toContain('−77,8 %')
    expect(html).toContain('Tým a vytížení')
    expect(html).toContain('35 % z kapacity')
    expect(html).toContain('card-deep')
    const text = html.replace(/href="[^"]*"/g, '').toLowerCase() // adresy smí engagements obsahovat, texty ne
    expect(text).not.toContain('engagement')
    expect(text).not.toContain('baseline')
  })

  test('přehled: karta Čeká na klienta s milníkem, který stojí, a s výzvou co udělat', async () => {
    const html = await render()
    expect(html).toContain('Čeká na klienta')
    expect(html).toContain('Odesláno klientovi 14. 9., zatím není přijato.')
    expect(html).toContain('Po termínu o 4 dny')
    expect(html).toContain('Připomenout klientovi')
    // U dodávky se klient neopakuje a jiné záložky kartu nemají.
    expect(html).not.toContain('ALFATECH · Akce')
    expect(await render({ zalozka: 'dokumenty' })).not.toContain('Připomenout klientovi')
  })

  test('záložky: aktivní nese aria-current, ?alokace otevře Tým', async () => {
    const tabs = await render({ zalozka: 'milniky' })
    expect(tabs).toContain('href="/cockpit/clients/1/engagements/3/edit?zalozka=milniky"')
    expect(tabs).toContain('Přidat milník')
    const team = await render({ alokace: '1' })
    expect(team).toContain('id="kdo-na-tom-pracuje"')
    expect(team).toContain('Upravit alokaci')
  })

  test('změna vlastníka na místě: přehled, milníky i tým; Upravit milník už výběr vlastníka nenese', async () => {
    expect(await render()).toContain('aria-label="Změnit vlastníka: dodávka Pilot · zpracování objednávek"')
    const milniky = await render({ zalozka: 'milniky' })
    expect(milniky).toContain('aria-label="Změnit vlastníka: milník Procesní mapa"')
    const team = await render({ zalozka: 'tym' })
    expect(team).toContain('aria-label="Změnit vlastníka: dodávka"')
    // Formulář týmu nese vlastníka a zástupce beze změny, ne jako výběry.
    expect(team).toContain('Uložit realizační tým')
    expect(team).toMatch(/<input type="hidden" name="owner_id" value="u1"\/>/)
    expect(team).not.toContain('<select name="owner_id"')
  })

  test('údaje a předání mají vlastní záložku', async () => {
    expect(await render({ zalozka: 'udaje' })).toContain('Uložit dodávku')
    expect(await render({ zalozka: 'predani' })).toContain('Uložit balíček')
    expect(await render({ zalozka: 'dopad' })).toContain('Přidat měření')
    expect(await render({ zalozka: 'dokumenty' })).toContain('Dokumenty')
  })

  test('jednotná hlavička: zpět na Dodávky, stav, jedna hlavní akce, záložky jako segment', async () => {
    const html = await render()
    expect(html).toMatch(/<a[^>]*href="\/cockpit\/dodavky"[^>]*>.*Dodávky<\/a>/)
    expect(html).toContain('Zbývá 38 dní (termín předání 6. 11. 2026).')
    expect(html).toContain('href="/cockpit/clients/1/engagements/3/edit" class="seg-item" aria-current="page">Přehled')
    expect(html).not.toContain('pill-tab')
    expect(html).toMatch(/class="btn btn-secondary">Upravit dodávku/)
    // Na záložce Údaje už hlavní akce „Upravit dodávku“ nedává smysl.
    expect(await render({ zalozka: 'udaje' })).not.toContain('Upravit dodávku')
  })

  test('na každé záložce nejvýš jedna koralová akce', async () => {
    for (const zalozka of ['prehled', 'milniky', 'predani', 'tym', 'dopad', 'dokumenty', 'udaje']) {
      const html = await render({ zalozka })
      expect((html.match(/btn-primary|btn-coral/g) ?? []).length, zalozka).toBeLessThanOrEqual(1)
    }
  })
})
