// Štítek „Agent" v historii obchodu (P5): jen u sales_activity.source
// s předponou 'agent:' (agent:inquiry, agent:follow_up).
import { describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityTimeline, isAgentActivity } from '@/components/ActivityTimeline'
import type { SalesActivityLike } from '@/domain/crm/sales'

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}))

const act = (id: number, source: string | null): SalesActivityLike => ({
  id, account_id: 1, partner_id: null, deal_id: 2, contact_id: null, source, external_id: null,
  kind: 'email', outcome: 'completed', subject: `Aktivita ${id}`, body: null,
  occurred_at: '2026-11-02T08:00:00Z', follow_up_on: null, created_by: null, created_at: '2026-11-02T08:00:00Z',
})

describe('ActivityTimeline – štítek Agent', () => {
  test('isAgentActivity', () => {
    expect(isAgentActivity({ source: 'agent:inquiry' })).toBe(true)
    expect(isAgentActivity({ source: 'agent:follow_up' })).toBe(true)
    expect(isAgentActivity({ source: 'mail' })).toBe(false)
    expect(isAgentActivity({ source: 'agentura' })).toBe(false)
    expect(isAgentActivity({ source: null })).toBe(false)
    expect(isAgentActivity({})).toBe(false)
  })

  test('štítek jen u kroků agenta', () => {
    const html = renderToStaticMarkup(<ActivityTimeline activities={[act(1, 'agent:inquiry'), act(2, 'manual'), act(3, 'agent:follow_up')]} />)
    const items = html.split('<li').slice(1)
    expect(items).toHaveLength(3)
    expect(items[0]).toContain('>Agent</span>')
    expect(items[1]).not.toContain('>Agent</span>')
    expect(items[2]).toContain('>Agent</span>')
  })
})
