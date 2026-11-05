import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AccountDetail from '@/app/cockpit/clients/[id]/page'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getDealsForAccount } from '@/domain/crm/queries/deals'
import { getSalesActivitiesForAccount } from '@/domain/crm/queries/sales'
import { getSubscriptionsForAccount } from '@/domain/finance/queries/subscriptions'
import { listPartners } from '@/domain/crm/queries/partners'

// Vykreslení detailu klienta: shrnutí nahoře (další krok, tři čísla), záložky
// přes ?tab= a oprávnění — obchodní záložky a data jen pro obchodní role.

vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn() }))
vi.mock('@/domain/crm/queries/accounts', () => ({
  getAccount: vi.fn(async () => ({
    id: 7, name: 'ALFATECH', industry: 'Výroba', region: 'Praha', size_band: null, ms_licenses: null, ico: '12345678',
    web: null, referred_by: null, owner: { id: 'u1', full_name: 'Viktor' }, client_since: null, is_reference: false,
    notes: 'Důležitá poznámka', profile: null, legal_form: null, founded_on: null, nace: null,
  })),
  getContacts: vi.fn(async () => [{ id: 1, full_name: 'Jana Nováková', role: 'CEO', email: null, phone: null, is_champion: true }]),
}))
vi.mock('@/domain/crm/queries/deals', () => ({ getDealsForAccount: vi.fn() }))
vi.mock('@/domain/delivery/queries/engagements', () => ({
  getEngagementsForAccount: vi.fn(async () => [
    { id: 3, kind: 'edu', phase: 'pilot', reference_worthy: false, baseline_adoption_pct: 40, post_adoption_pct: null, adoption_delta_pp: null, trained_count: 12, started_on: '2026-09-01', due_on: null },
  ]),
}))
vi.mock('@/domain/crm/queries/sales', () => ({ getSalesActivitiesForAccount: vi.fn() }))
vi.mock('@/domain/crm/queries/tasks', () => ({
  getOpenTasksForAccount: vi.fn(async () => [
    { id: 9, title: 'Poslat rozsah', description: null, status: 'todo', priority: 'high', assignee_id: null, due_on: '2099-02-01' },
  ]),
  getDoneTaskCountForAccount: vi.fn(async () => 0),
  listAssignableMembers: vi.fn(async () => [{ id: 'u1', full_name: 'Viktor' }]),
}))
vi.mock('@/domain/finance/queries/subscriptions', () => ({ getSubscriptionsForAccount: vi.fn() }))
vi.mock('@/domain/finance/queries/records', () => ({ listAccountFinancialRecords: vi.fn(async () => ({ state: 'ok', records: [] })) }))
vi.mock('@/domain/crm/queries/companyRelationships', () => ({
  listAliasesForAccount: vi.fn(async () => [{ id: 4, account_id: 7, alias_domain: 'alfatech-group.cz', alias_name: null, created_at: '2026-01-01' }]),
  listParentRelationships: vi.fn(async () => [{ id: 6, parent: { id: 8, name: 'ALFATECH Holding' } }]),
  listChildRelationships: vi.fn(async () => []),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) } }) }))
vi.mock('@/domain/crm/actions/contacts', () => ({ createContact: vi.fn(), updateContact: vi.fn() }))
vi.mock('@/domain/crm/actions/sales', () => ({ createSalesActivity: vi.fn() }))
vi.mock('@/domain/crm/actions/tasks', () => ({ createTask: vi.fn() }))
vi.mock('@/domain/finance/actions/subscriptions', () => ({ createSubscription: vi.fn() }))
vi.mock('@/domain/crm/actions/companyRelationships', () => ({
  addCompanyAlias: vi.fn(), removeCompanyAlias: vi.fn(), addRelationship: vi.fn(), removeRelationship: vi.fn(),
}))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findContactOptionsForAccount: vi.fn() }))
vi.mock('@/domain/crm/actions/accounts', () => ({ updateAccount: vi.fn() }))
vi.mock('@/domain/crm/queries/autoIntake', () => ({ getAutoIntakeForAccount: vi.fn(async () => null) }))
vi.mock('@/domain/crm/queries/partners', () => ({ listPartners: vi.fn(async () => []) }))
vi.mock('@/lib/queries/team', () => ({ listTeamMembers: vi.fn(async () => [{ id: 'u1', full_name: 'Viktor' }]) }))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('404') },
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  default: ({ href, children, scroll: _scroll, ...rest }: { href: string; children: ReactNode; scroll?: boolean }) => <a href={href} {...rest}>{children}</a>,
}))

const DEAL = {
  id: 5, account_id: 7, title: 'AI agent', stage: 'rozsah_nabidka', amount_one_time: 1_635_300,
  next_step: 'Domluvit schůzku k rozsahu pilotu', next_step_due: '2099-01-02', status_blocker: null,
  won_at: null, expected_close: null, deal_kind: null, source_pdf_path: null, pillar: null, phase: null,
  delivery_team: null, dev_team: [], channel: null, currency: 'CZK', note: null,
}
const ACTIVITY = {
  id: 1, kind: 'meeting', outcome: 'completed', subject: 'Schůzka k diagnostice', body: null,
  occurred_at: new Date().toISOString(), follow_up_on: null, author: { id: 'u1', full_name: 'Viktor' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getDealsForAccount).mockResolvedValue([DEAL] as never)
  vi.mocked(getSalesActivitiesForAccount).mockResolvedValue([ACTIVITY] as never)
  vi.mocked(getSubscriptionsForAccount).mockResolvedValue([])
})

async function render(sales: boolean, query: Record<string, string> = {}) {
  vi.mocked(canCurrentUserSeeSales).mockResolvedValue(sales)
  const el = await AccountDetail({ params: Promise.resolve({ id: '7' }), searchParams: Promise.resolve(query) })
  return renderToStaticMarkup(el)
}

describe('/cockpit/clients/[id] — shrnutí nahoře', () => {
  test('obchodní role: další krok z obchodu, jedno hlavní tlačítko, tři čísla, záložky', async () => {
    const html = await render(true)
    expect(html).toContain('ALFATECH')
    expect(html).toContain('Domluvit schůzku k rozsahu pilotu')
    expect(html).toContain('k obchodu AI agent')
    expect(html).toContain('href="/cockpit/clients/7?tab=aktivity#zapsat-aktivitu"')
    expect(html.match(/btn-primary/g)).toHaveLength(1) // jedna hlavní akce na obrazovce
    expect(html).toContain('1 635 300 Kč')
    for (const label of ['Obchody', 'Dodávky', 'Úkoly']) expect(html).toContain(`>${label}<`)
    expect(html).toContain('aria-label="Oddíly klienta"')
    expect(html).toContain('href="/cockpit/clients/7?tab=obchody"')
    expect(html).toContain('Důležitá poznámka') // výchozí záložka Přehled
    expect(html).toContain('Aktivní dny')
    expect(html).toContain('role="img"')
  })

  test('záhlaví: zpět na seznam, stavová pilulka, Upravit otevře panel na místě', async () => {
    const html = await render(true)
    expect(html).toContain('href="/cockpit/clients"')
    expect(html).toContain('<h1 class="m-0 font-heading')
    expect(html).toMatch(/<span class="st done">Aktivní klient<\/span>/)
    expect(html).toContain('href="/cockpit/clients/7?upravit=firma"')
    expect(html).not.toContain('role="dialog"')
    expect(listPartners).not.toHaveBeenCalled() // panel zavřený = nic navíc se nenačítá
  })

  test('záložky jako segmenty v pořadí Přehled / Obchody / Dodávky / Kontakty / Historie / Peníze / O firmě', async () => {
    const html = await render(true)
    const nav = html.match(/<nav aria-label="Oddíly klienta"[\s\S]*?<\/nav>/)![0]
    const labels = [...nav.matchAll(/class="seg-item[^"]*"[^>]*>([^<]+)/g)].map((m) => m[1])
    expect(labels).toEqual(['Přehled', 'Obchody', 'Dodávky', 'Kontakty', 'Historie', 'Peníze', 'O firmě'])
    expect(nav).toMatch(/href="\/cockpit\/clients\/7" class="seg-item[^"]*" aria-current="page"/)
    const other = await render(false)
    const otherNav = other.match(/<nav aria-label="Oddíly klienta"[\s\S]*?<\/nav>/)![0]
    expect([...otherNav.matchAll(/class="seg-item[^"]*"[^>]*>([^<]+)/g)].map((m) => m[1]))
      .toEqual(['Přehled', 'Dodávky', 'Kontakty', 'O firmě'])
  })

  test('pravý sloupec Souvislosti: kontakty a poslední aktivita; bez obchodní role bez historie', async () => {
    const html = await render(true)
    expect(html).toContain('aria-label="Souvislosti"')
    expect(html).toContain('Poslední aktivita')
    expect(html).toContain('href="/cockpit/clients/7?tab=kontakty&amp;kontakt=1"')
    const other = await render(false, { tab: 'dodavky' })
    expect(other).toContain('aria-label="Souvislosti"')
    expect(other).not.toContain('Poslední aktivita')
    expect(other).toContain('Poslat rozsah') // úkoly v souvislostech mimo Přehled
  })

  test('role bez obchodů: obchody se nenačítají, žádné obchodní záložky ani číslo Obchody, hlavní akce je úkol', async () => {
    const html = await render(false, { tab: 'obchody' })
    expect(getDealsForAccount).not.toHaveBeenCalled()
    expect(getSalesActivitiesForAccount).not.toHaveBeenCalled()
    expect(getSubscriptionsForAccount).not.toHaveBeenCalled()
    expect(html).not.toContain('tab=obchody')
    expect(html).not.toContain('tab=aktivity')
    expect(html).not.toContain('tab=penize')
    expect(html).not.toContain('1 635 300')
    expect(html).toContain('href="/cockpit/clients/7#pridat-ukol"')
    expect(html).toContain('Poslat rozsah') // další krok z úkolu
    // neznámá / nepovolená záložka spadne na Přehled
    expect(html).toContain('Důležitá poznámka')
  })
})

describe('/cockpit/clients/[id] — záložky', () => {
  test('Obchody: karta obchodu s fází a dalším krokem', async () => {
    const html = await render(true, { tab: 'obchody' })
    expect(html).toContain('href="/cockpit/clients/7/deals/new"')
    expect(html).toContain('Postup obchodu: fáze 3 z 5')
    expect(html).toContain('href="/cockpit/clients/7/deals/5/edit"')
  })

  test('Dodávky: karta s fází a čísly, bez zakázaných slov', async () => {
    const html = await render(true, { tab: 'dodavky' })
    expect(html).toContain('href="/cockpit/clients/7/engagements/new"')
    expect(html).toContain('Firemní akce')
    expect(html).toContain('Výchozí stav')
    expect(html).not.toContain('Baseline')
  })

  test('Aktivity: formulář, filtr podle druhu a časová osa', async () => {
    const html = await render(true, { tab: 'aktivity', druh: 'meeting' })
    expect(html).toContain('id="zapsat-aktivitu"')
    expect(html).toContain('Schůzka k diagnostice')
    expect(html).toContain('aria-label="Filtr historie podle druhu"')
    const empty = await render(true, { tab: 'aktivity', druh: 'call' })
    expect(empty).toContain('V téhle skupině zatím nic není.')
  })

  test('Kontakty a Firma se vykreslí i bez obchodní role', async () => {
    expect(await render(false, { tab: 'kontakty' })).toContain('Jana Nováková')
    const firma = await render(false, { tab: 'firma' })
    expect(firma).toContain('Aliasy domén a názvů')
    expect(firma).toContain('Mateřská a dceřiné firmy')
  })

  test('O firmě: údaje v přehledu, aliasy a vazby pod <details>; odebrání vazby až po potvrzení', async () => {
    const html = await render(false, { tab: 'firma' })
    expect(html).toContain('Údaje o firmě')
    expect(html).toContain('12345678')
    expect(html.match(/<details/g)).toHaveLength(2)
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>\s*<span[^>]*>Aliasy domén a názvů/)
    expect(html).toContain('alfatech-group.cz')
    // alias: vratné odebrání tlačítkem (toast se Zpět), žádný formulář s potvrzením
    expect(html).toContain('aria-label="Odebrat alias alfatech-group.cz"')
    // vazba: první tlačítko jen ptá (type=button), odeslat jde až potvrzením
    expect(html).toContain('ALFATECH Holding')
    expect(html).toMatch(/<button type="button" aria-label="Odebrat vztah: mateřská firma ALFATECH Holding" class="btn btn-danger btn-sm">Odebrat<\/button>/)
  })

  test('Kontakty: úprava v bočním panelu (?kontakt=ID), jen pro kontakt tohoto klienta', async () => {
    const list = await render(false, { tab: 'kontakty' })
    expect(list).toContain('aria-label="Upravit kontakt Jana Nováková"')
    expect(list).toContain('id="novy-kontakt"')
    const panel = await render(false, { tab: 'kontakty', kontakt: '1' })
    expect(panel).toContain('role="dialog"')
    expect(panel).toContain('aria-modal="true"')
    expect(panel).toContain('Upravit kontakt')
    expect(panel).toContain('value="Jana Nováková"')
    expect(panel).toContain('href="/cockpit/kontakty/1/edit"') // záložní stránka (export, smazání)
    const foreign = await render(false, { tab: 'kontakty', kontakt: '999' })
    expect(foreign).not.toContain('role="dialog"')
  })

  test('Firma: úprava v bočním panelu (?upravit=firma), partneři a tým se načtou jen tehdy', async () => {
    const html = await render(true, { upravit: 'firma' })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Upravit údaje o firmě')
    expect(html).toContain('name="ico"')
    expect(listPartners).toHaveBeenCalledTimes(1)
  })
})
