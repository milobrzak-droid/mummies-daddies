// Stav složky pošty ve „Stavu zdrojů": místo holého „nikdy" čitelná česká
// hláška podle kurzoru / chyb a čas posledního pokusu. Plus zápis pokusu do
// connector_state (markAttempt) přes supabaseFake.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ConnectorState } from '@/core/connectorState'
import { describeFolderStatus } from '@/domain/crm/mailFolderStatus'
import { createMailSyncDb, loadMailSourcesStatus } from '@/domain/crm/mailSyncService'
import { serializeCursor } from '@/domain/crm/mailSync'
import { disabledMailWebhookHealth } from '@/domain/crm/mailWebhook'
import { MailSourcesCard } from '@/components/MailSourcesCard'
import { createSupabaseFake, opArgs, type QueryCall } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const G = 'https://graph.microsoft.com/v1.0'
const recent = () => new Date(Date.now() - 2 * 3600_000).toISOString()

function state(over: Partial<ConnectorState>): ConnectorState {
  return {
    connector: 'outlook:sent',
    cursor: null,
    last_success_at: null,
    last_error: null,
    last_error_at: null,
    consecutive_errors: 0,
    updated_at: '2026-09-29T04:00:00.000Z',
    ...over,
  }
}

describe('describeFolderStatus', () => {
  it('bez řádku: složku žádný běh nezaložil', () => {
    const s = describeFolderStatus(null, 36)
    expect(s.tone).toBe('error')
    expect(s.lastAttemptAt).toBeNull()
    expect(s.message).toContain('žádný běh nezaložil')
  })

  it('řádek jen s časem pokusu (nepřišla řada): není to „nikdy nespuštěno"', () => {
    const s = describeFolderStatus(state({}), 36)
    expect(s.tone).toBe('warn')
    expect(s.lastAttemptAt).toBe('2026-09-29T04:00:00.000Z')
    expect(s.message).toContain('nepřišla řada')
  })

  it('kurzor ve fázi paging bez úspěchu: probíhá první načtení historie', () => {
    const s = describeFolderStatus(state({ cursor: serializeCursor({ phase: 'paging', link: `${G}/p1` }) }), 36)
    expect(s.tone).toBe('warn')
    expect(s.message).toContain('první načtení historie')
  })

  it('chyba: text chyby a počet pokusů, čas poslední chyby vyhrává nad updated_at', () => {
    const s = describeFolderStatus(
      state({ consecutive_errors: 2, last_error: 'Chybí oprávnění Mail.Read', last_error_at: '2026-09-29T05:00:00.000Z' }),
      36,
    )
    expect(s.tone).toBe('error')
    expect(s.message).toBe('Poslední pokus selhal (2× po sobě): Chybí oprávnění Mail.Read')
    expect(s.lastAttemptAt).toBe('2026-09-29T05:00:00.000Z')
  })

  it('čerstvý úspěch bez chyby: vše v pořádku, žádná hláška', () => {
    const s = describeFolderStatus(
      state({ last_success_at: recent(), cursor: serializeCursor({ phase: 'delta', link: `${G}/d` }) }),
      36,
    )
    expect(s).toMatchObject({ tone: 'ok', message: null })
  })

  it('starý úspěch: zastaralé s vysvětlením', () => {
    const s = describeFolderStatus(state({ last_success_at: '2026-01-01T00:00:00.000Z' }), 36)
    expect(s.tone).toBe('error')
    expect(s.message).toContain('Zastaralé')
  })
})

describe('MailSourcesCard — složky', () => {
  const render = (sent: ConnectorState | null) =>
    renderToStaticMarkup(
      <MailSourcesCard
        status={{
          syncEnabled: true,
          inbox: state({ connector: 'outlook:inbox', last_success_at: recent() }),
          sent,
          webhook: disabledMailWebhookHealth(),
        }}
      />,
    )

  it('chybějící řádek Odeslané: čitelná hláška, ne holé „nikdy" bez vysvětlení', () => {
    const html = render(null)
    expect(html).toContain('Odeslaná: poslední synchronizace nikdy')
    expect(html).toContain('žádný běh nezaložil')
    expect(html).toContain('poslední pokus: nikdy')
  })

  it('rozpracovaná historie Odeslané: hláška a čas posledního pokusu', () => {
    const html = render(state({ cursor: serializeCursor({ phase: 'paging', link: `${G}/s2` }) }))
    expect(html).toContain('první načtení historie')
    expect(html).toContain('poslední pokus: 29. 9. 2026')
  })

  it('Doručená v pořádku nemá žádnou hlášku', () => {
    const html = render(null)
    expect(html).toMatch(/Doručená: poslední synchronizace [^<]*<\/span><\/li>/)
    expect(html).not.toMatch(/Doručená:[^<]*poslední pokus/)
  })
})

describe('createMailSyncDb.markAttempt', () => {
  beforeEach(() => vi.clearAllMocks())

  it('upsertuje jen connector + updated_at (kurzor, úspěch ani chyby se nemění)', async () => {
    const fake = createSupabaseFake()
    const db = createMailSyncDb(fake.client as never, 'test')
    await db.markAttempt!('outlook:sent')
    const call = fake.calls.find((c: QueryCall) => c.table === 'connector_state')!
    const [row, opts] = opArgs(call, 'upsert') as [Record<string, unknown>, { onConflict: string }]
    expect(Object.keys(row).sort()).toEqual(['connector', 'updated_at'])
    expect(row.connector).toBe('outlook:sent')
    expect(opts).toEqual({ onConflict: 'connector' })
  })

  it('selhání zápisu nevyhodí', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { message: 'boom' } }) })
    const db = createMailSyncDb(fake.client as never, 'test')
    await expect(db.markAttempt!('outlook:sent')).resolves.toBeUndefined()
  })
})

describe('loadMailSourcesStatus', () => {
  it('vrací stav obou složek z connector_state', async () => {
    const rows: Record<string, ConnectorState> = {
      'outlook:inbox': state({ connector: 'outlook:inbox', last_success_at: recent() }),
    }
    const fake = createSupabaseFake({
      resolve: (call) => {
        const eq = opArgs(call, 'eq') as [string, string] | undefined
        return { data: eq ? (rows[eq[1]] ?? null) : null, error: null }
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(fake.client as never)
    const st = await loadMailSourcesStatus({ OUTLOOK_MAIL_SYNC_ENABLED: 'true' })
    expect(st.inbox?.connector).toBe('outlook:inbox')
    expect(st.sent).toBeNull()
  })
})
