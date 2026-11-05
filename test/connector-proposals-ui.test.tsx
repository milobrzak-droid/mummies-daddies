import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// Karta návrhu zakázky z konektoru na /rozhodnuti: ukáže všechna pole
// (upravitelná), zdroj, varování a duplicity; „Schválit vše" jen pro položky
// bez varování; bez role vedení/admin žádná tlačítka. Text ze zdroje je prostý
// text (React ho escapuje), nikdy HTML.
vi.mock('@/domain/crm/actions/connectorProposals', () => ({
  approveConnectorProposalAction: vi.fn(), rejectConnectorProposalAction: vi.fn(), approveConnectorBatchAction: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/rozhodnuti', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { ConnectorProposalsSection } from '@/components/ConnectorProposalsSection'
import type { ConnectorDraft } from '@/domain/crm/connectorProposals'

const base: ConnectorDraft = {
  version: 1, kind: 'connector_deal', info_state: 'ai_suggestion', mode: 'create', proposed_by: 'u1', proposed_by_name: 'Viktor',
  proposed_at: '2026-10-20T10:00:00Z', batch: { id: 'b1', label: 'Z odeslané pošty 20.–24. 10., 2 zakázky' },
  account: { id: 1, name: 'Alfa s.r.o.', ico: null, status: 'matched', matched_by: 'name', candidates: [] }, deal_id: null,
  fields: {
    title: 'Školení Copilot', stage: 'nabidka_odeslana', amount: 120000, amount_range: null, currency: 'CZK', cogs: null, estimate_md: 4,
    pillar: null, phase: null, revenue_line: null, expected_close: null, next_step: 'Zavolat', next_step_due: '2026-10-27', note: null,
  },
  changes: null, reason: null, contact: { full_name: 'Karel Novák', email: 'karel@alfa.cz', phone: null, role: 'CTO' },
  source: { kind: 'email', message_id: 'AAMk-1', web_link: 'https://outlook.office.com/mail/x', subject: 'Nabídka <script>alert(1)</script>', sender: null, recipient: 'karel@alfa.cz', date: '2026-10-20', label: null },
  duplicates: [], warnings: [], injection_flags: [],
}
const risky: ConnectorDraft = {
  ...base,
  fields: { ...base.fields, title: 'Audit', amount: null },
  account: { id: null, name: 'Beta', ico: null, status: 'ambiguous', matched_by: null, candidates: [{ id: 2, name: 'Beta a.s.' }, { id: 3, name: 'BETA, a.s.' }] },
  duplicates: [{ deal_id: 10, title: 'Audit IT', stage: 'diagnostika', amount_czk: 50000, reason: 'similar_title' }],
  warnings: ['client_ambiguous', 'price_missing', 'duplicate_deal', 'injection'], injection_flags: ['ignore_instructions'],
}
const res = { state: 'ok' as const, items: [{ id: 1, createdAt: 'x', draft: base, deal: null }, { id: 2, createdAt: 'x', draft: risky, deal: null }] }

describe('Ke schválení: zakázky navržené z Claude', () => {
  it('dávka, pole k úpravě, zdroj, Schválit vše jen pro položky bez varování', () => {
    const html = renderToStaticMarkup(<ConnectorProposalsSection res={res} canDecide />)
    expect(html).toContain('Zakázky navržené z Claude (2)')
    expect(html).toContain('Z odeslané pošty 20.–24. 10., 2 zakázky')
    expect(html).toContain('Schválit vše bez varování (1 z 2)')
    expect(html).toContain('Návrh od Claude jménem Viktor')
    for (const name of ['title', 'stage', 'amount', 'cogs', 'estimate_md', 'next_step', 'next_step_due', 'contact_full_name']) {
      expect(html).toContain(`name="${name}"`)
    }
    expect(html).toContain('Schválit a založit')
    expect(html).toContain('Otevřít zdroj v Outlooku')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('nejistý klient = výběr z kandidátů / nový; duplicita nabídne aktualizaci; varování a injection', () => {
    const html = renderToStaticMarkup(<ConnectorProposalsSection res={res} canDecide />)
    expect(html).toContain('Beta a.s. (id 2)')
    expect(html).toContain('Nový klient')
    expect(html).toContain('Aktualizovat existující')
    expect(html).toContain('Audit IT')
    expect(html).toContain('Chybí cena.')
    expect(html).toContain('pokyny pro AI')
  })

  it('bez role vedení/admin: žádné schvalování ani zamítnutí', () => {
    const html = renderToStaticMarkup(<ConnectorProposalsSection res={res} canDecide={false} />)
    expect(html).not.toContain('Schválit a založit')
    expect(html).not.toContain('Schválit vše')
    expect(html).not.toContain('Zamítnout')
    expect(html).toContain('Schválit může jen vedení nebo admin.')
  })

  it('prázdná fronta nic nekreslí; bez migrace oznámení', () => {
    expect(renderToStaticMarkup(<>{ConnectorProposalsSection({ res: { state: 'ok', items: [] }, canDecide: true })}</>)).toBe('')
    expect(renderToStaticMarkup(<ConnectorProposalsSection res={{ state: 'missing_migration' }} canDecide />)).toContain('návrhy zakázek z Claude')
  })
})
