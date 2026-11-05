// Pošta s obsahem — obrazovky a akce: karta fronty, karta na Dnes, stav v Nastavení,
// server akce fronty (přihlášení, AAL2, obchodní role, výsledek služby) a stránka
// /pripady s pohledem „Pošta k zařazení". Služby a dotazy jsou podstrčené.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/pripady', redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const requireUser = vi.fn()
const canSeeSales = vi.fn()
const assignQueuedMail = vi.fn()
const discardQueuedMail = vi.fn()
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: (...a: unknown[]) => requireUser(...a), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: () => canSeeSales() }))
vi.mock('@/domain/crm/mailContentService', () => ({
  assignQueuedMail: (...a: unknown[]) => assignQueuedMail(...a),
  discardQueuedMail: (...a: unknown[]) => discardQueuedMail(...a),
}))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn() }))

import { MailQueueCard } from '@/components/MailQueueCard'
import { TodayMail, hasMailContent } from '@/components/ui/TodayMail'
import { MailSourcesCard } from '@/components/MailSourcesCard'
import { assignMailContent, discardMailContent } from '@/domain/crm/actions/mailContent'
import { describeMailContentStatus, type MailContentSource } from '@/domain/crm/mailContentStatus'
import type { MailContentCard, QueuedMail } from '@/domain/crm/queries/mailContent'
import type { ConnectorState } from '@/core/connectorState'

const mail = (over: Partial<QueuedMail> = {}): QueuedMail => ({
  id: 7,
  receivedAt: '2026-09-14T08:00:00Z',
  subject: 'Re: Procesní mapa',
  excerpt: 'Mapu schvalujeme, děkujeme.',
  senderDomain: 'klient.cz',
  attachmentNames: [],
  signals: ['approval'],
  proposedDate: null,
  waitReason: 'no_match',
  accountId: null,
  accountName: null,
  webLink: 'https://outlook.office.com/mail/x',
  targets: [],
  ...over,
})

describe('MailQueueCard', () => {
  it('neznámý klient: výběr klienta, úryvek, doména, příznak, odkaz na zprávu a Zahodit', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail()} /></ul>)
    expect(html).toContain('Re: Procesní mapa')
    expect(html).toContain('Čeká na přiřazení')
    expect(html).toContain('Od domény klient.cz')
    expect(html).toContain('Klienta jsme nenašli')
    expect(html).toContain('schválení')
    expect(html).toContain('Úryvek ze zprávy')
    expect(html).toContain('Mapu schvalujeme, děkujeme.')
    expect(html).toContain('Přiřadit ke klientovi')
    expect(html).toContain('name="row_id" value="7"')
    expect(html).toContain('href="https://outlook.office.com/mail/x"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('Zahodit')
    expect(html).toContain('smaže se předmět a úryvek')
  })

  it('úryvek je prostý text: HTML z e-mailu se neinterpretuje', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ excerpt: '<img src=x onerror=alert(1)> schvalujeme' })} /></ul>)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('klient jistý, dodávka ne: povinný výběr dodávky včetně „jen klient"', () => {
    const html = renderToStaticMarkup(
      <ul>
        <MailQueueCard
          mail={mail({
            accountId: 2, accountName: 'Novotný Logistika', waitReason: 'ambiguous_target',
            targets: [
              { kind: 'engagement', id: 11, label: 'Workshop pro vedení', dealId: 6 },
              { kind: 'deal', id: 7, label: 'Podpora provozu', dealId: 7 },
            ],
          })}
        />
      </ul>,
    )
    expect(html).toContain('Novotný Logistika')
    expect(html).toContain('href="/cockpit/clients/2"')
    expect(html).toContain('name="account_id" value="2"')
    expect(html).toMatch(/<select[^>]*name="target"[^>]*required/)
    expect(html).toContain('value="engagement:11"')
    expect(html).toContain('Dodávka: Workshop pro vedení')
    expect(html).toContain('value="deal:7"')
    expect(html).toContain('Obchod: Podpora provozu')
    expect(html).toContain('value="account"')
    expect(html).toContain('Založit návrh')
    expect(html).not.toContain('Přiřadit ke klientovi')
  })

  it('čekající návrh téhož druhu: bez výběru dodávky, tlačítko Zkusit znovu', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ accountId: 1, accountName: 'Sigmaform', waitReason: 'proposal_pending' })} /></ul>)
    expect(html).toContain('U klienta už čeká návrh stejného druhu')
    expect(html).toContain('Zkusit znovu')
    expect(html).not.toContain('name="target"')
  })

  it('přílohy jen názvem a datum z textu jako k ověření', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ attachmentNames: ['mapa.pdf'], proposedDate: '2026-10-05', signals: ['schedule', 'attachment'] })} /></ul>)
    expect(html).toContain('Přílohy (jen názvy): mapa.pdf')
    expect(html).toMatch(/Datum z textu: 5\. ?10\. ?2026 \(ověř ve zprávě\)/)
    expect(html).toContain('posun termínu')
  })

  it('bez odkazu a bez předmětu se karta nerozbije', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ webLink: null, subject: null })} /></ul>)
    expect(html).toContain('Zpráva bez předmětu')
    expect(html).not.toContain('Otevřít zprávu v Outlooku')
  })
})

describe('TodayMail', () => {
  const ok = (over: Partial<Extract<MailContentCard, { state: 'ok' }>> = {}): MailContentCard => ({
    state: 'ok', queued: 0, items: [], pendingProposals: 0, ...over,
  })
  const item = { id: 1, subject: 'Re: mapa', senderDomain: 'klient.cz', accountName: null, waitReason: 'no_match' as const, receivedAt: '2026-09-14T08:00:00Z' }

  it('nic nečeká, chyba nebo chybějící migrace = karta se nevykreslí', () => {
    for (const c of [ok(), { state: 'error' } as const, { state: 'missing_migration' } as const]) {
      expect(hasMailContent(c)).toBe(false)
      expect(renderToStaticMarkup(<TodayMail card={c} />)).toBe('')
    }
  })

  it('čekající zprávy: nadpis, počet, předmět, důvod a odkaz na frontu', () => {
    const html = renderToStaticMarkup(<TodayMail card={ok({ queued: 1, items: [item] })} />)
    expect(hasMailContent(ok({ queued: 1, items: [item] }))).toBe(true)
    expect(html).toContain('Pošta k zařazení')
    expect(html).toContain('Re: mapa')
    expect(html).toContain('Od domény klient.cz')
    expect(html).toContain('čeká na přiřazení')
    expect(html).toContain('href="/cockpit/pripady?view=posta"')
    expect(html).toContain('Přiřadit zprávy')
  })

  it('víc zpráv než ukázaných: počet zbytku a Otevřít frontu', () => {
    const html = renderToStaticMarkup(<TodayMail card={ok({ queued: 5, items: [item, { ...item, id: 2 }, { ...item, id: 3 }] })} />)
    expect(html).toContain('A dalších 2 zprávy.')
    expect(html).toContain('Otevřít frontu')
  })

  it('jen čekající návrhy z pošty: karta vede na návrhy', () => {
    const html = renderToStaticMarkup(<TodayMail card={ok({ pendingProposals: 2 })} />)
    expect(html).toContain('2 návrhy z pošty čekají na tvoje potvrzení')
    expect(html).toContain('href="/cockpit/pripady?view=navrhy"')
    expect(html).not.toContain('view=posta')
  })
})

describe('describeMailContentStatus', () => {
  const src = (over: Partial<MailContentSource> = {}): MailContentSource => ({
    enabled: true, folderName: 'Cockpit', aiEnabled: false, aiKeyMissing: true, state: null, ...over,
  })
  const state = (over: Partial<ConnectorState> = {}): ConnectorState => ({
    connector: 'outlook:cockpit', cursor: null, last_success_at: '2026-09-29T04:00:00Z', last_error: null,
    last_error_at: null, consecutive_errors: 0, updated_at: '2026-09-29T04:00:00Z', ...over,
  })
  const NOW = Date.parse('2026-09-29T12:00:00Z')

  it('vypnuto: říká přepínač a že se čtou jen metadata', () => {
    const s = describeMailContentStatus(src({ enabled: false }), true, NOW)
    expect(s.tone).toBe('idle')
    expect(s.message).toContain('MAIL_CONTENT_INTAKE_ENABLED')
    expect(s.message).toContain('jen metadata')
  })

  it('zapnuto bez synchronizace pošty, bez běhu, s chybou, zastaralé, v pořádku', () => {
    expect(describeMailContentStatus(src(), false, NOW)).toMatchObject({ tone: 'warn', message: expect.stringContaining('OUTLOOK_MAIL_SYNC_ENABLED') })
    expect(describeMailContentStatus(src(), true, NOW)).toMatchObject({ tone: 'warn', message: expect.stringContaining('složka „Cockpit“') })
    const failing = describeMailContentStatus(src({ state: state({ consecutive_errors: 2, last_error: 'Složka „Cockpit“ v Outlooku neexistuje.' }) }), true, NOW)
    expect(failing).toMatchObject({ tone: 'error', message: expect.stringContaining('neexistuje') })
    expect(describeMailContentStatus(src({ state: state({ last_success_at: '2026-09-25T04:00:00Z' }) }), true, NOW).tone).toBe('error')
    const fine = describeMailContentStatus(src({ state: state() }), true, NOW)
    expect(fine).toMatchObject({ tone: 'ok', lastSuccessAt: '2026-09-29T04:00:00Z' })
    expect(fine.message).toContain('Jen zprávy, které do ní přesuneš')
  })

  it('AI: vypnuto = žádná věta, zapnuto bez klíče = upozornění, zapnuto s klíčem = co se posílá', () => {
    expect(describeMailContentStatus(src(), true, NOW).ai).toBeNull()
    expect(describeMailContentStatus(src({ aiEnabled: true }), true, NOW).ai).toContain('ANTHROPIC_API_KEY')
    expect(describeMailContentStatus(src({ aiEnabled: true, aiKeyMissing: false }), true, NOW).ai).toContain('bez adres')
  })

  it('karta v Nastavení ukáže sekci Pošta s obsahem; bez synchronizace o ní řekne jednou větou', () => {
    const webhook = { enabled: false, broken: false, problems: [], expiresAt: null, lastNotificationAt: null, migrationMissing: false } as never
    const html = renderToStaticMarkup(
      <MailSourcesCard status={{ syncEnabled: true, inbox: null, sent: null, webhook, content: src({ enabled: false }) }} />,
    )
    expect(html).toContain('Pošta s obsahem (složka „Cockpit“)')
    expect(html).toContain('MAIL_CONTENT_INTAKE_ENABLED')
    const off = renderToStaticMarkup(
      <MailSourcesCard status={{ syncEnabled: false, inbox: null, sent: null, webhook, content: src() }} />,
    )
    expect(off).toContain('Pošta s obsahem (složka „Cockpit“) je zapnutá, ale běží jen s touto synchronizací.')
  })
})

describe('akce fronty', () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(fields)) f.set(k, v)
    return f
  }
  beforeEach(() => {
    vi.clearAllMocks()
    requireUser.mockResolvedValue({ id: 'user-1' })
    canSeeSales.mockResolvedValue(true)
    assignQueuedMail.mockResolvedValue({ ok: true, data: { proposalId: 5 } })
    discardQueuedMail.mockResolvedValue({ ok: true, data: { id: 7 } })
  })

  it('přiřazení: přihlášení s AAL2 a obchodní role, výsledek služby, volba dodávky se předá', async () => {
    expect(await assignMailContent(null, form({ row_id: '7', account_id: '3', target: 'engagement:11' }))).toEqual({ success: true })
    expect(requireUser).toHaveBeenCalledWith({ aal2: true })
    expect(assignQueuedMail).toHaveBeenCalledWith({ rowId: 7, accountId: 3, targetKey: 'engagement:11', userId: 'user-1' })
  })

  it('bez přihlášení, bez obchodní role nebo s neplatným vstupem se služba nevolá', async () => {
    requireUser.mockResolvedValueOnce(null)
    expect(await assignMailContent(null, form({ row_id: '7', account_id: '3' }))).toEqual({ success: false, error: 'auth' })
    canSeeSales.mockResolvedValueOnce(false)
    expect(await assignMailContent(null, form({ row_id: '7', account_id: '3' }))).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(await assignMailContent(null, form({ row_id: '7' }))).toMatchObject({ success: false, error: 'Vyber klienta ze seznamu.' })
    expect(await assignMailContent(null, form({ row_id: 'x', account_id: '3' }))).toMatchObject({ success: false, error: 'Neplatná zpráva.' })
    expect(assignQueuedMail).not.toHaveBeenCalled()
  })

  it('chyba služby jde uživateli česky beze změny', async () => {
    assignQueuedMail.mockResolvedValueOnce({ ok: false, status: 409, error: 'Zpráva už je vyřízená. Obnov stránku.' })
    expect(await assignMailContent(null, form({ row_id: '7', account_id: '3' }))).toEqual({ success: false, error: 'Zpráva už je vyřízená. Obnov stránku.' })
  })

  it('zahození: stejné brány, služba dostane jen id zprávy a uživatele', async () => {
    expect(await discardMailContent(null, form({ row_id: '7' }))).toEqual({ success: true })
    expect(discardQueuedMail).toHaveBeenCalledWith({ rowId: 7, userId: 'user-1' })
    canSeeSales.mockResolvedValueOnce(false)
    expect(await discardMailContent(null, form({ row_id: '7' }))).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    expect(discardQueuedMail).toHaveBeenCalledTimes(1)
  })
})
