import { beforeEach, describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { getWorkCase } from '@/core/loopQueries'
import { WorkCaseButtons } from '@/components/WorkCaseButtons'

// Vlna 2, detail případu (docs/PROVOZ.md §13 Detaily): jednotná
// hlavička (zpět, nadpis, stav, jedna hlavní akce), záložky Práce /
// Schválení / Časová osa, Souvislosti vpravo. Nevratné přechody s potvrzením.

vi.mock('next/navigation', () => ({ notFound: vi.fn(() => { throw new Error('404') }), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))
vi.mock('@/core/loopQueries', async (orig) => ({
  ...(await orig<typeof import('@/core/loopQueries')>()),
  getWorkCase: vi.fn(),
  getActivePolicies: vi.fn(async () => []),
  getCaseOrigin: vi.fn(async () => null),
  getLoopNodes: vi.fn(async () => [{ node: 'obchod', owner_id: null, deputy_id: null }]),
}))
// Kdo se dívá a koho jde vybrat za vlastníka (0093): správce a jedna kolegyně.
vi.mock('@/lib/queries/ownerChange', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/ownerChange')>()),
  loadOwnerChangeContext: vi.fn(async () => ({
    actor: { id: 'u1', role: 'vedeni', is_admin: true },
    members: [{ id: 'u2', name: 'Lenka', roleLabel: 'Vedení' }],
    nameOf: () => null,
  })),
}))
vi.mock('@/domain/crm/queries/tasks', () => ({
  listAssignableMembers: vi.fn(async () => [{ id: 'u1', full_name: 'Viktor', role: 'vedeni' }]),
}))
vi.mock('@/core/actions/workCases', () => ({
  addCaseStep: vi.fn(), changeCaseStatus: vi.fn(), changeStepStatus: vi.fn(),
  recordCaseDecision: vi.fn(), requestCaseApproval: vi.fn(), resolveCaseDecision: vi.fn(),
}))
vi.mock('@/core/actions/approvals', () => ({ requestNextStepApproval: vi.fn() }))

const CASE = {
  id: 5, title: 'Workshop ALFATECH', node: 'obchod', status: 'in_progress', created_at: '2026-09-20T10:00:00Z',
  updated_at: '2026-09-28T10:00:00Z', created_by: 'user:u1', lead_owner_id: 'u1', lead_owner_name: 'Viktor', deputy_name: null,
  account_id: 3, account_name: 'ALFATECH', deal_id: null, deal_title: null, deal_account_id: null,
}

async function render(tab?: string) {
  const { default: Page } = await import('@/app/cockpit/pripady/[id]/page')
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id: '5' }), searchParams: Promise.resolve(tab ? { tab } : {}) }))
}

beforeEach(() => {
  vi.mocked(getWorkCase).mockResolvedValue({
    state: 'ok', case: CASE,
    steps: [{ id: 1, position: 1, title: 'Příprava', status: 'done', due_at: null }],
    decisions: [{ id: 2, question: 'Rozsah?', options: ['Malý', 'Velký'], chosen: null, decided_by: null, decided_at: null, created_at: '2026-09-21T10:00:00Z' }],
    approvals: [], executions: [],
  } as never)
})

describe('detail případu', () => {
  test('hlavička: zpět na seznam, stav slovem, jedna koralová akce, záložky', async () => {
    const html = await render()
    expect(html.match(/<h1/g)).toHaveLength(1)
    expect(html).toContain('href="/cockpit/pripady"')
    expect(html).toContain('Rozpracovaný')
    expect(html.match(/btn-primary/g)).toHaveLength(1)
    expect(html).toContain('Uzavřít jako hotový')
    expect(html).toContain('aria-label="Části případu"')
    expect(html).toMatch(/aria-current="page" class="seg-item" href="\/cockpit\/pripady\/5">Práce/)
    expect(html).toContain('Souvislosti')
    expect(html).toContain('Kroky')
    expect(html).toContain('Rozsah?')
    expect(html).not.toContain('Časová osa případu')
  })

  test('Souvislosti: změna vlastníka na místě (tlačítko), u uzavřeného případu ne', async () => {
    const html = await render()
    expect(html).toContain('aria-label="Změnit vlastníka: Workshop ALFATECH"')
    expect(html.match(/btn-primary/g)).toHaveLength(1)
    vi.mocked(getWorkCase).mockResolvedValue({ state: 'ok', case: { ...CASE, status: 'cancelled' }, steps: [], decisions: [], approvals: [], executions: [] } as never)
    expect(await render()).not.toContain('Změnit vlastníka')
  })

  test('záložka Časová osa ukáže osu, Práce ne', async () => {
    const html = await render('osa')
    expect(html).toContain('Časová osa případu')
    expect(html).not.toContain('Rozsah?')
  })

  test('uzavřený případ nemá akce a řekne to', async () => {
    vi.mocked(getWorkCase).mockResolvedValue({ state: 'ok', case: { ...CASE, status: 'done' }, steps: [], decisions: [], approvals: [], executions: [] } as never)
    const html = await render()
    expect(html).not.toContain('btn-primary')
    expect(html).toContain('Případ je uzavřený.')
  })
})

describe('WorkCaseButtons', () => {
  test('nevratný přechod se neodešle hned, ukáže potvrzení', () => {
    const html = renderToStaticMarkup(
      <WorkCaseButtons action={vi.fn()} buttons={[{ label: 'Zrušit případ', fields: { case_id: 1, to: 'cancelled' }, confirm: 'Nejde vrátit.' }]} />,
    )
    expect(html).toContain('type="button"')
    expect(html).not.toContain('type="submit"')
    expect(html).not.toContain('Nejde vrátit.')
  })
})
