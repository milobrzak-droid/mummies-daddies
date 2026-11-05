// „Stav zdrojů" pro webhook pošty: řádek v přehledu (rozbitý webhook =
// zdroj s alertem), načtení stavu z graph_subscription (i bez migrace 0066)
// a karta v Nastavení.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturePendingDetailProvider } from '@/components/ui/FeaturePending'
import { renderToStaticMarkup } from 'react-dom/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildDigest, type DigestInput } from '@/domain/crm/digest'
import { disabledMailWebhookHealth, type MailWebhookHealth } from '@/domain/crm/mailWebhook'
import { loadMailWebhookHealth } from '@/domain/crm/mailSyncService'
import { MailSourcesCard } from '@/components/MailSourcesCard'
import { createSupabaseFake } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const NOW = new Date('2026-09-28T07:00:00Z')

const base: DigestInput = {
  followUps: [],
  outreach: [],
  blockedDeals: [],
  connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null },
  lastMeetingNoteAt: null,
  outlookMailSyncEnabled: true,
  generatedAt: NOW,
}

const healthy: MailWebhookHealth = {
  enabled: true,
  migrationMissing: false,
  lastNotificationAt: '2026-09-28T06:30:00.000Z',
  expiresAt: '2026-10-04T04:00:00.000Z',
  problems: [],
  broken: false,
}

const webhookLine = (input: DigestInput) =>
  buildDigest(input).sources.lines.find((l) => l.startsWith('Outlook pošta — okamžité notifikace'))

describe('přehled — řádek webhooku', () => {
  it('bez údaje o webhooku se řádek nevypisuje (starší volání)', () => {
    expect(webhookLine(base)).toBeUndefined()
  })

  it('vypnutý webhook: „vypnuto", bez alertu', () => {
    const without = buildDigest(base).sourceAlerts
    const d = buildDigest({ ...base, mailWebhook: disabledMailWebhookHealth() })
    expect(webhookLine({ ...base, mailWebhook: disabledMailWebhookHealth() })).toBe('Outlook pošta — okamžité notifikace (webhook): vypnuto')
    expect(d.sourceAlerts).toBe(without)
  })

  it('v pořádku: poslední notifikace a expirace, bez alertu', () => {
    const without = buildDigest(base).sourceAlerts
    const d = buildDigest({ ...base, mailWebhook: healthy })
    expect(webhookLine({ ...base, mailWebhook: healthy })).toBe(
      'Outlook pošta — okamžité notifikace (webhook): poslední notifikace 28. 9. 2026, předplatné do 4. 10. 2026',
    )
    expect(d.sourceAlerts).toBe(without)
  })

  it('vypršelé / chybové předplatné = rozbitý zdroj (chyba + alert)', () => {
    const without = buildDigest(base).sourceAlerts
    const broken: MailWebhookHealth = { ...healthy, problems: ['Doručená pošta: předplatné vypršelo'], broken: true }
    const line = webhookLine({ ...base, mailWebhook: broken })
    expect(line).toContain(' — chyba: Doručená pošta: předplatné vypršelo')
    expect(buildDigest({ ...base, mailWebhook: broken }).sourceAlerts).toBe(without + 1)
  })

  it('chybí migrace 0066 = rozbitý zdroj', () => {
    const missing: MailWebhookHealth = { ...disabledMailWebhookHealth(), enabled: true, migrationMissing: true, broken: true }
    expect(webhookLine({ ...base, mailWebhook: missing })).toContain('chybí migrace 0066')
    expect(buildDigest({ ...base, mailWebhook: missing }).sourceAlerts).toBe(buildDigest(base).sourceAlerts + 1)
  })

  it('řádek webhooku je hned za řádkem syncu pošty', () => {
    const lines = buildDigest({ ...base, mailWebhook: healthy }).sources.lines
    const i = lines.findIndex((l) => l.startsWith('Outlook pošta (příjem a odeslání)'))
    expect(lines[i + 1]).toMatch(/^Outlook pošta — okamžité notifikace/)
  })
})

describe('loadMailWebhookHealth', () => {
  const ENABLED = { OUTLOOK_MAIL_SYNC_ENABLED: 'true', OUTLOOK_MAIL_WEBHOOK_ENABLED: 'true' }

  beforeEach(() => vi.clearAllMocks())

  it('vypnutý webhook DB vůbec nečte', async () => {
    const h = await loadMailWebhookHealth({ OUTLOOK_MAIL_SYNC_ENABLED: 'true' })
    expect(h.enabled).toBe(false)
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('chybějící tabulka (PGRST205) → „chybí migrace", ne pád', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }) })
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
    const h = await loadMailWebhookHealth(ENABLED, Date.parse('2026-09-28T07:00:00Z'))
    expect(h).toMatchObject({ enabled: true, migrationMissing: true, broken: true })
    expect(fake.calls[0].table).toBe('graph_subscription')
  })

  it('řádky → stav; jiná chyba DB → rozbité, ale bez výjimky', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({
        data: [{
          connector_key: 'outlook:inbox', subscription_id: 'a-1', resource: "me/mailFolders('inbox')/messages",
          expires_at: '2026-10-04T04:00:00.000Z', client_state_hash: 'a'.repeat(64), created_at: '2026-09-27T04:00:00.000Z',
          updated_at: '2026-09-27T04:00:00.000Z', last_notification_at: '2026-09-28T06:30:00.000Z', last_error: null,
        }],
        error: null,
      }),
    })
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
    const h = await loadMailWebhookHealth(ENABLED, Date.parse('2026-09-28T07:00:00Z'))
    expect(h).toMatchObject({ lastNotificationAt: '2026-09-28T06:30:00.000Z', problems: ['Odeslaná pošta: předplatné chybí'], broken: true })

    vi.mocked(createAdminClient).mockReturnValue(createSupabaseFake({ resolve: () => ({ data: null, error: { code: '500', message: 'boom' } }) }).client as never)
    const e = await loadMailWebhookHealth(ENABLED)
    expect(e).toMatchObject({ broken: true, problems: ['stav předplatného nejde načíst'] })
  })
})

describe('Nastavení — karta „Pošta z Outlooku"', () => {
  it('vypnutý sync: jen vysvětlení', () => {
    const html = renderToStaticMarkup(<MailSourcesCard status={{ syncEnabled: false, inbox: null, sent: null, webhook: disabledMailWebhookHealth() }} />)
    expect(html).toContain('Pošta z Outlooku (synchronizace)')
    expect(html).toContain('Synchronizace pošty je vypnutá')
    expect(html).not.toContain('Okamžité notifikace')
  })

  it('zapnutý sync, webhook vypnutý', () => {
    const html = renderToStaticMarkup(<MailSourcesCard status={{ syncEnabled: true, inbox: null, sent: null, webhook: disabledMailWebhookHealth() }} />)
    expect(html).toContain('Doručená: poslední synchronizace nikdy — Tuhle složku zatím žádný běh nezaložil')
    expect(html).toContain('Vypnuto (OUTLOOK_MAIL_WEBHOOK_ENABLED)')
  })

  it('rozbitý webhook: problémy jako upozornění', () => {
    const webhook: MailWebhookHealth = { ...healthy, problems: ['Odeslaná pošta: předplatné vypršelo'], broken: true }
    const html = renderToStaticMarkup(<MailSourcesCard status={{ syncEnabled: true, inbox: null, sent: null, webhook }} />)
    expect(html).toContain('Poslední notifikace: 28. 9. 2026')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Odeslaná pošta: předplatné vypršelo')
  })

  it('chybí migrace', () => {
    const webhook: MailWebhookHealth = { ...disabledMailWebhookHealth(), enabled: true, migrationMissing: true, broken: true }
    const html = renderToStaticMarkup(<MailSourcesCard status={{ syncEnabled: true, inbox: null, sent: null, webhook }} />)
    expect(html).toContain('okamžité notifikace se teprve připravují')
    expect(html).not.toContain('0066')
    // Vedení a správce vidí i technický detail.
    const admin = renderToStaticMarkup(
      <FeaturePendingDetailProvider show><MailSourcesCard status={{ syncEnabled: true, inbox: null, sent: null, webhook }} /></FeaturePendingDetailProvider>,
    )
    expect(admin).toContain('chybí migrace 0066')
  })
})
