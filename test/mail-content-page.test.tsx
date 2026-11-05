// @vitest-environment node
// /pripady (Práce): pohled „Pošta k zařazení" jen pro obchodní role a jen když
// něco čeká (nebo je otevřený), a úryvky u návrhů z pošty jen pro ně.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToReadableStream } from 'react-dom/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/pripady', redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn() }))
vi.mock('@/domain/crm/actions/mailContent', () => ({ assignMailContent: vi.fn(), discardMailContent: vi.fn() }))
vi.mock('@/core/actions/caseProposals', () => ({ decideCaseProposal: vi.fn() }))

const canSeeSales = vi.fn()
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: () => canSeeSales() }))

const loop = vi.hoisted(() => ({
  listWorkCases: vi.fn(),
  countPendingProposals: vi.fn(),
  listPendingProposals: vi.fn(),
}))
vi.mock('@/core/loopQueries', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/core/loopQueries')>()), ...loop }))

const mailQ = vi.hoisted(() => ({
  getMailContentStats: vi.fn(),
  listQueuedMail: vi.fn(),
  getMailProposalEvidence: vi.fn(),
}))
vi.mock('@/domain/crm/queries/mailContent', () => mailQ)

const queued = (over: Record<string, unknown> = {}) => ({
  id: 7, receivedAt: '2026-09-14T08:00:00Z', subject: 'Re: mapa', excerpt: 'Schvalujeme mapu.', senderDomain: 'klient.cz',
  attachmentNames: [], signals: ['approval'], proposedDate: null, waitReason: 'no_match', accountId: null, accountName: null,
  webLink: null, targets: [], ...over,
})

async function render(sp: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/cockpit/pripady/page')
  // Stránka skládá asynchronní serverové části (návrhy, pošta), proto proud, ne statické vykreslení.
  const stream = await renderToReadableStream(await Page({ searchParams: Promise.resolve(sp) }))
  await stream.allReady
  return new Response(stream).text()
}

beforeEach(() => {
  vi.clearAllMocks()
  canSeeSales.mockResolvedValue(true)
  loop.listWorkCases.mockResolvedValue({ state: 'ok', cases: [] })
  loop.countPendingProposals.mockResolvedValue(0)
  loop.listPendingProposals.mockResolvedValue({ state: 'ok', proposals: [] })
  mailQ.getMailContentStats.mockResolvedValue({ queued: 0, proposed30d: 0, lastAt: null })
  mailQ.listQueuedMail.mockResolvedValue([])
  mailQ.getMailProposalEvidence.mockResolvedValue(new Map())
})

describe('/pripady — pošta k zařazení', () => {
  it('nic nečeká: záložka se nezobrazí (funkce nezasahuje do obrazovky)', async () => {
    const html = await render()
    expect(html).not.toContain('Pošta k zařazení')
    expect(html).not.toContain('view=posta')
  })

  it('něco čeká: záložka s počtem vede na frontu', async () => {
    mailQ.getMailContentStats.mockResolvedValue({ queued: 3, proposed30d: 0, lastAt: null })
    const html = await render()
    expect(html).toContain('href="/cockpit/pripady?view=posta"')
    expect(html).toContain('Pošta k zařazení')
    expect(html).toMatch(/Pošta k zařazení<span class="seg-count tabular-nums">3<\/span>/)
  })

  it('pohled posta ukáže karty zpráv a vysvětlení, co Cockpit uložil', async () => {
    mailQ.getMailContentStats.mockResolvedValue({ queued: 1, proposed30d: 0, lastAt: null })
    mailQ.listQueuedMail.mockResolvedValue([queued()])
    const html = await render({ view: 'posta' })
    expect(html).toContain('Re: mapa')
    expect(html).toContain('Schvalujeme mapu.')
    expect(html).toContain('jen předmět, krátký úryvek a názvy příloh, celé tělo ne')
    expect(html).toContain('aria-current="page"')
    expect(loop.listWorkCases).not.toHaveBeenCalled()
  })

  it('prázdná fronta: klidný stav s vysvětlením, jak to funguje', async () => {
    const html = await render({ view: 'posta' })
    expect(html).toContain('Žádná pošta k zařazení')
    expect(html).toContain('složky Cockpit')
  })

  it('bez obchodní role se pohled nenačte a fronta se nečte', async () => {
    canSeeSales.mockResolvedValue(false)
    mailQ.getMailContentStats.mockResolvedValue({ queued: 3, proposed30d: 0, lastAt: null })
    const html = await render({ view: 'posta' })
    expect(html).not.toContain('Pošta k zařazení')
    expect(mailQ.listQueuedMail).not.toHaveBeenCalled()
    expect(mailQ.getMailContentStats).not.toHaveBeenCalled()
    expect(loop.listWorkCases).toHaveBeenCalled()
  })

  it('chyba načtení fronty: hláška, stránka nespadne', async () => {
    mailQ.getMailContentStats.mockResolvedValue({ queued: 1, proposed30d: 0, lastAt: null })
    mailQ.listQueuedMail.mockRejectedValue(new Error('boom'))
    const html = await render({ view: 'posta' })
    expect(html).toContain('Poštu k zařazení se nepodařilo načíst')
  })

  it('návrhy z pošty nesou úryvek jen tam, kde ho RLS vrátilo; ostatní návrhy dotaz nespouštějí', async () => {
    const p = (id: number, capability: string) => ({
      id, capability, node: 'eventy', title: `Návrh ${id}`, rationale: `Zdůvodnění ${id}`, method: 'rule',
      occurred_at: '2026-09-14T08:00:00Z', created_at: '2026-09-14T09:00:00Z', account_id: null, account_name: null, evidence_link: null,
    })
    loop.listPendingProposals.mockResolvedValue({ state: 'ok', proposals: [p(1, 'mail_content_approval'), p(2, 'mail_to_case')] })
    mailQ.getMailProposalEvidence.mockResolvedValue(new Map([[1, { excerpt: 'Schvalujeme mapu.', subject: null, signals: [], attachmentNames: [] }]]))
    const html = await render({ view: 'navrhy' })
    expect(mailQ.getMailProposalEvidence).toHaveBeenCalledWith([1])
    expect(html).toContain('Úryvek ze zprávy (vidí vedení a obchod)')
    expect(html.match(/Úryvek ze zprávy/g)).toHaveLength(1)
    expect(html).toContain('Schvalujeme mapu.')
    expect(html).toContain('Zdůvodnění 2')
  })
})
