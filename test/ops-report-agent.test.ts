// Sekce „Agent na poptávky“ v provozním přehledu (P5): jen se zapnutým
// modulem (agent v OpsReportInput) a jen obchodní role; fronta k pozornosti
// a eskalace se počítají do pozornosti, souhrn týdne ne.
import { describe, expect, test } from 'vitest'
import { agentItems, buildOpsReport } from '@/domain/crm/opsReport'
import { opsInput } from './helpers/opsReportFixture'

const summary = { inquiries: 12, escalations: 3, sent: 8, needsAttention: 1, blocked: 2 }

describe('sekce agent', () => {
  test('bez modulu (undefined) se neukáže', () => {
    expect(buildOpsReport(opsInput()).sections.map((s) => s.key)).not.toContain('agent')
  })

  test('jen obchodní role', () => {
    const r = buildOpsReport(opsInput({ canSeeSales: false, agent: summary }))
    expect(r.sections.map((s) => s.key)).not.toContain('agent')
  })

  test('položky, odkazy a total jen z věcí k řešení', () => {
    const base = buildOpsReport(opsInput())
    const r = buildOpsReport(opsInput({ agent: summary }))
    const s = r.sections.find((x) => x.key === 'agent')!
    expect(s.items.map((i) => [i.key, i.tone, i.href])).toEqual([
      ['agent-pozornost', 'neg', '/cockpit/agent#fronta'],
      ['agent-blokovano', 'warn', '/cockpit/agent#fronta'],
      ['agent-eskalace', 'warn', '/cockpit/agent#rozhodnuti'],
      ['agent-souhrn', 'info', '/cockpit/agent'],
    ])
    expect(s.total).toBe(6)
    expect(r.attention).toBe(base.attention + 6)
    expect(r.headline).toContain('Agent: 6')
  })

  test('klidný týden: total 0, nezvedá pozornost', () => {
    const r = buildOpsReport(opsInput({ agent: { inquiries: 4, escalations: 0, sent: 4, needsAttention: 0, blocked: 0 } }))
    const s = r.sections.find((x) => x.key === 'agent')!
    expect(s.total).toBe(0)
    expect(r.headline).not.toContain('Agent')
  })

  test('null = nepodařilo se načíst; off = agent neběží', () => {
    expect(buildOpsReport(opsInput({ agent: null })).sections.find((x) => x.key === 'agent')!.unavailable).toEqual(['agent'])
    expect(agentItems({ state: 'off' })).toMatchObject({ total: 0, items: [{ key: 'agent-off' }] })
  })
})
