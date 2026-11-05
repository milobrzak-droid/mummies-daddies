import { describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DealDeliveryCard } from '@/components/DealDeliveryCard'
import { ClientEngagementCard } from '@/components/ui/ClientEngagementCard'
import { summarizeDealDeliveries } from '@/domain/delivery/autoDelivery'
import type { Engagement } from '@/lib/types'

// Karta „Dodávka" na detailu vyhraného obchodu (0080): běžně klidná karta
// „Dodávka byla založena automaticky" s odkazem, tlačítko jen jako záloha.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('@/components/CreateDeliveryButton', () => ({
  CreateDeliveryButton: ({ accountId, dealId }: { accountId: number; dealId: number }) => (
    <button type="submit" data-account={accountId} data-deal={dealId}>Založit dodávku</button>
  ),
}))

const del = (id: number, origin?: string) => ({ id, origin, kind: 'it', phase: 'analyza' })
const render = (rows: ReturnType<typeof del>[]) =>
  renderToStaticMarkup(<DealDeliveryCard accountId={7} dealId={3} summary={summarizeDealDeliveries(rows)} />)

describe('DealDeliveryCard', () => {
  test('automaticky založená dodávka: klidná karta s odkazem a úkolem, bez tlačítka', () => {
    const html = render([del(12, 'auto_deal_won')])
    expect(html).toContain('Dodávka byla založena automaticky')
    expect(html).toContain('href="/cockpit/clients/7/engagements/12/edit"')
    expect(html).toContain('Otevřít dodávku')
    expect(html).toContain('Naplánovat realizaci akce')
    expect(html).toContain('2 pracovních dnů')
    expect(html).toContain('st done')
    expect(html).not.toContain('Založit dodávku')
    expect(html).not.toContain('btn-coral')
  })

  test('ruční dodávka: jiný nadpis, žádné „automaticky", žádné tlačítko', () => {
    const html = render([del(5, 'manual')])
    expect(html).toContain('K obchodu je založená dodávka')
    expect(html).not.toContain('automaticky')
    expect(html).not.toContain('Založit dodávku')
  })

  test('víc dodávek: odkaz na první (automatickou) a seznam všech', () => {
    const html = render([del(5, 'manual'), del(12, 'auto_deal_won')])
    expect(html).toContain('href="/cockpit/clients/7/engagements/12/edit"')
    expect(html).toContain('aria-label="Dodávky obchodu"')
    expect(html).toContain('href="/cockpit/clients/7/engagements/5/edit"')
  })

  test('žádná dodávka: záložní tlačítko s obchodem a vysvětlením, ne karta „založeno"', () => {
    const html = render([])
    expect(html).toContain('K vyhranému obchodu zatím chybí dodávka')
    expect(html).toContain('data-account="7"')
    expect(html).toContain('data-deal="3"')
    expect(html).toContain('Založit dodávku')
    expect(html).not.toContain('Dodávka byla založena automaticky')
  })

  test('jazyk prostě česky: nikde „engagement"', () => {
    for (const rows of [[], [del(1, 'auto_deal_won')], [del(1, 'manual')]]) {
      // Viditelný text (ne adresa odkazu) nesmí obsahovat anglické „engagement".
      expect(render(rows).toLowerCase()).not.toMatch(/>[^<]*engagement[^<]*</)
    }
  })
})

describe('ClientEngagementCard: původ dodávky', () => {
  const eng = (origin?: string): Engagement => ({
    id: 12, account_id: 7, deal_id: 3, kind: 'it', phase: 'analyza', started_on: '2026-09-29', due_on: null,
    baseline_adoption_pct: null, baseline_captured_on: null, copilot_licenses: null, post_adoption_pct: null,
    trained_count: null, time_saved_min_week: null, workshops_delivered: null, nnpsa: null, roi_czk_year: null,
    post_captured_on: null, adoption_delta_pp: null, reference_worthy: false, created_at: '', updated_at: '',
    gate_outputs_captured: null, gate_ratios_respected: null, gate_peer_learning: null, gate_safety_followed: null,
    gate_next_steps_owned: null, gate_pack_delivered: null, deliverable_pack_url: null, follow_up_checkpoint_on: null,
    ...(origin ? { origin } : {}),
  })
  test('automaticky založená dodávka má štítek, ruční ne', () => {
    expect(renderToStaticMarkup(<ClientEngagementCard engagement={eng('auto_deal_won')} href="/x" />)).toContain('Založeno automaticky')
    expect(renderToStaticMarkup(<ClientEngagementCard engagement={eng('manual')} href="/x" />)).not.toContain('Založeno automaticky')
    expect(renderToStaticMarkup(<ClientEngagementCard engagement={eng()} href="/x" />)).not.toContain('Založeno automaticky')
  })
})
