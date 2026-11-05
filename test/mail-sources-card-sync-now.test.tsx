// Karta „Pošta z Outlooku": tlačítko „Dotáhnout další část" jen když stránka
// předá akci (správce / obchodní role), popisek podle stavu složek, poznámka
// o okně prvního načtení a postup místo holého „probíhá".
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MailSourcesCard } from '@/components/MailSourcesCard'
import { serializeCursor } from '@/domain/crm/mailSync'
import { disabledMailWebhookHealth } from '@/domain/crm/mailWebhook'
import type { ConnectorState } from '@/core/connectorState'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const G = 'https://graph.microsoft.com/v1.0'
const DAY = 86_400_000

function state(over: Partial<ConnectorState>): ConnectorState {
  return {
    connector: 'outlook:sent', cursor: null, last_success_at: null, last_error: null, last_error_at: null,
    consecutive_errors: 0, updated_at: new Date().toISOString(), ...over,
  }
}
const caughtUp = (connector: string) =>
  state({ connector, last_success_at: new Date().toISOString(), cursor: serializeCursor({ phase: 'delta', link: `${G}/d` }) })

const render = (opts: { sent: ConnectorState | null; action?: () => Promise<{ success: boolean }>; initialDays?: number }) =>
  renderToStaticMarkup(
    <MailSourcesCard
      status={{
        syncEnabled: true,
        inbox: caughtUp('outlook:inbox'),
        sent: opts.sent,
        webhook: disabledMailWebhookHealth(),
        initialDays: opts.initialDays,
      }}
      syncNowAction={opts.action}
    />,
  )

describe('MailSourcesCard — ruční dotažení', () => {
  it('bez akce (ostatní role) tlačítko není', () => {
    expect(render({ sent: null })).not.toContain('Dotáhnout další část')
  })

  it('s akcí a nedotaženou složkou: tlačítko „Dotáhnout další část" + vysvětlení', () => {
    const html = render({ sent: null, action: async () => ({ success: true }) })
    expect(html).toContain('Dotáhnout další část')
    expect(html).toContain('nemusíš čekat na denní synchronizaci')
  })

  it('všechno dotažené: tlačítko se jmenuje „Synchronizovat poštu teď"', () => {
    const html = render({ sent: caughtUp('outlook:sent'), action: async () => ({ success: true }) })
    expect(html).toContain('Synchronizovat poštu teď')
    expect(html).not.toContain('Dotáhnout další část')
  })

  it('vypnutá synchronizace: tlačítko se nezobrazí ani s akcí', () => {
    const html = renderToStaticMarkup(
      <MailSourcesCard
        status={{ syncEnabled: false, inbox: null, sent: null, webhook: disabledMailWebhookHealth() }}
        syncNowAction={async () => ({ success: true })}
      />,
    )
    expect(html).not.toContain('Dotáhnout')
    expect(html).not.toContain('Synchronizovat poštu teď')
  })

  it('okno prvního načtení: věta s počtem dní; 0 = celá historie', () => {
    expect(render({ sent: null, initialDays: 120 })).toContain('jen poštu z posledních 120 dní')
    expect(render({ sent: null, initialDays: 0 })).toContain('celou historii pošty')
    expect(render({ sent: null })).not.toContain('První načtení bere')
  })

  it('rozpracované první načtení ukáže „načteno zpět do", procenta a odhad běhů', () => {
    const now = Date.now()
    const html = render({
      sent: state({
        cursor: serializeCursor({
          phase: 'paging', link: `${G}/s2`, since: new Date(now - 120 * DAY).toISOString(),
          reached: new Date(now - 60 * DAY).toISOString(), runs: 2,
        }),
      }),
    })
    expect(html).toContain('načteno zpět do')
    expect(html).toContain('hotovo asi 50 %')
    expect(html).toContain('ještě asi 2 běhy')
  })
})
