// Nabídka z přílohy e-mailu na obrazovkách: karta ve frontě „Pošta k zařazení"
// (klient a cena z PDF, formulář k potvrzení, žádné přiřazení), karta na Dnes,
// stav v Nastavení a dotazy (návrh z řádku, návrat na starý dotaz bez migrace 0099).
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/pripady', redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn() }))
vi.mock('@/domain/crm/mailContentService', () => ({ assignQueuedMail: vi.fn(), discardQueuedMail: vi.fn() }))
vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn() }))
vi.mock('@/connectors/anthropic', () => ({ extractOfferFromPdf: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({ getCurrentMember: vi.fn(), memberSeesSales: vi.fn() }))

import { MailQueueCard } from '@/components/MailQueueCard'
import { TodayMail } from '@/components/ui/TodayMail'
import { MailSourcesCard } from '@/components/MailSourcesCard'
import { describeMailContentStatus, type MailContentSource } from '@/domain/crm/mailContentStatus'
import { getMailContentCard, listQueuedMail, type MailContentCard, type QueuedMail } from '@/domain/crm/queries/mailContent'
import type { OfferProposalView } from '@/domain/crm/actions/offers'
import { mailOfferProposalId } from '@/domain/crm/mailOffer'
import { buildMailOfferDraft } from '@/domain/crm/offerProposal'
import { formatOfferPrice } from '@/lib/format'
import { createSupabaseFake, hasOp, type QueryCall, type QueryResult } from './helpers/supabaseFake'

const PID = mailOfferProposalId('<n1@sigmaform.cz>', 'ATT1')
const FIELDS: OfferProposalView['fields'] = {
  account_name: 'Sigmaform Servis s.r.o.', title: 'Procesní audit', pillar: 'b2b_akce', phase: null, revenue_line: 'svatebni_hostina',
  currency: 'CZK', amount_one_time: 180000, cogs_one_time: null, estimate_md: 12, expected_close: null,
}
const view = (over: Partial<OfferProposalView> = {}): OfferProposalView => ({
  proposalId: PID, fileName: 'Nabidka_Sigmaform.pdf', fields: FIELDS, warnings: [], flags: [], account: { kind: 'existing', id: 1, name: 'Sigmaform Servis s.r.o.' }, ...over,
})
const mail = (over: Partial<QueuedMail> = {}): QueuedMail => ({
  id: 7, receivedAt: '2026-09-29T08:00:00Z', subject: 'Nabídka na procesní audit', excerpt: 'Posílám nabídku.', senderDomain: 'sigmaform.cz',
  attachmentNames: ['Nabidka_Sigmaform.pdf'], signals: ['attachment'], proposedDate: null, waitReason: 'offer_draft', accountId: null, accountName: null,
  webLink: 'https://outlook.office.com/mail/n1', targets: [], offer: view(), ...over,
})

describe('formatOfferPrice', () => {
  it('koruny, eura a chybějící cena', () => {
    expect(formatOfferPrice(180000, 'CZK')).toBe('180 000 Kč')
    expect(formatOfferPrice(3500, 'EUR')).toBe('3 500 EUR')
    expect(formatOfferPrice(null, 'CZK')).toBe('cena chybí')
  })
})

describe('MailQueueCard — návrh zakázky', () => {
  it('ukáže klienta a cenu z nabídky a formulář k potvrzení, ne přiřazení ke klientovi', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail()} /></ul>)
    expect(html).toContain('Čeká na potvrzení')
    expect(html).toContain('Návrh zakázky')
    expect(html).toContain('aria-label="Návrh zakázky z nabídky"')
    expect(html).toContain('Sigmaform Servis s.r.o.')
    expect(html).toContain('Cena bez DPH')
    expect(html).toContain('180 000 Kč')
    expect(html).toContain('Procesní audit')
    // stejný formulář potvrzení jako u ručního importu, cena i klient jsou pole k úpravě
    expect(html).toContain(`name="proposal_id" value="${PID}"`)
    expect(html).toContain('name="amount_one_time"')
    expect(html).toContain('name="account_name"')
    expect(html).toContain('Potvrdit a založit')
    expect(html).toContain('Nic se nezaloží, dokud je nezkontroluješ a nepotvrdíš.')
    expect(html).toContain('PDF se v Cockpitu neukládá')
    expect(html).toContain('V příloze je nabídka.')
    // přiřazení ke klientovi tu není, zahodit ano (a řekne, že smaže návrh)
    expect(html).not.toContain('Přiřadit ke klientovi')
    expect(html).toContain('smaže se předmět, úryvek i návrh zakázky')
    // platné HTML: karta je jediné <li>, formulář v ní je <div>
    expect(html.match(/<li[\s>]/g)).toHaveLength(1)
  })

  it('cena v eurech a chybějící cena; klient existuje nebo je nový', () => {
    const eur = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ offer: view({ fields: { ...FIELDS, currency: 'EUR', amount_one_time: 3500 } }) })} /></ul>)
    expect(eur).toContain('3 500 EUR')
    const none = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ offer: view({ fields: { ...FIELDS, amount_one_time: null }, warnings: ['chybí částka'] }) })} /></ul>)
    expect(none).toContain('cena chybí')
    expect(none).toContain('chybí částka')
    expect(eur).toContain('Obchod se přiřadí ke stávajícímu klientovi')
    const fresh = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ offer: view({ account: { kind: 'new' } }) })} /></ul>)
    expect(fresh).toContain('Nový klient')
  })

  it('text z PDF je prostý text: HTML v názvu klienta se neinterpretuje', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ offer: view({ fields: { ...FIELDS, account_name: '<img src=x onerror=alert(1)>Firma' } }) })} /></ul>)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;Firma')
  })

  it('běžná zpráva bez návrhu zakázky vypadá jako dřív', () => {
    const html = renderToStaticMarkup(<ul><MailQueueCard mail={mail({ waitReason: 'no_match', offer: null })} /></ul>)
    expect(html).toContain('Čeká na přiřazení')
    expect(html).toContain('Přiřadit ke klientovi')
    expect(html).not.toContain('Potvrdit a založit')
    expect(html).toContain('smaže se předmět a úryvek')
  })
})

describe('TodayMail — návrh zakázky', () => {
  const ok = (items: Extract<MailContentCard, { state: 'ok' }>['items']): MailContentCard => ({ state: 'ok', queued: items.length, items, pendingProposals: 0 })
  it('u nabídky z přílohy ukáže klienta a cenu k potvrzení', () => {
    const html = renderToStaticMarkup(<TodayMail card={ok([{
      id: 1, subject: 'Nabídka na procesní audit', senderDomain: 'sigmaform.cz', accountName: null, waitReason: 'offer_draft', receivedAt: '2026-09-29T08:00:00Z',
      offer: { clientName: 'Sigmaform Servis s.r.o.', amount: 180000, currency: 'CZK', title: 'Procesní audit' },
    }])} />)
    expect(html).toContain('čeká na potvrzení')
    expect(html).toContain('Návrh zakázky z nabídky v příloze')
    expect(html).toContain('Sigmaform Servis s.r.o.')
    expect(html).toContain('180 000 Kč')
    expect(html).toContain('Nic není založené, dokud ho nepotvrdíš')
    expect(html).toContain('href="/cockpit/pripady?view=posta"')
  })
})

describe('Nastavení — stav nabídek z příloh', () => {
  const src = (over: Partial<MailContentSource> = {}): MailContentSource => ({
    enabled: true, folderName: 'Cockpit', aiEnabled: false, aiKeyMissing: true, state: null, ...over,
  })
  it('věta o nabídkách se přenese do stavu a karty; bez ní nic', () => {
    expect(describeMailContentStatus(src(), true).offer).toBeNull()
    const s = describeMailContentStatus(src({ offerNote: 'Nabídky z příloh jsou zapnuté, ale nic se nečte: chybí ANTHROPIC_API_KEY.' }), true)
    expect(s.offer).toContain('ANTHROPIC_API_KEY')
    const html = renderToStaticMarkup(<MailSourcesCard status={{ syncEnabled: true, inbox: null, sent: null, webhook: { enabled: false } as never, content: src({ offerNote: 'Nabídky z příloh jsou zapnuté: test.' }) }} />)
    expect(html).toContain('Nabídky z příloh jsou zapnuté: test.')
  })
})

// ---------------------------------------------------------------------------
// Dotazy

const stored = () => JSON.parse(JSON.stringify(buildMailOfferDraft({
  proposalId: PID, fileName: 'Nabidka_Sigmaform.pdf', fields: FIELDS, warnings: ['chybí fáze'], now: new Date('2026-09-30T04:00:00Z'),
})))

describe('dotazy fronty a karty', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 7, received_at: '2026-09-29T08:00:00Z', subject: 'Nabídka', excerpt: 'Posílám nabídku.', sender_domain: 'sigmaform.cz',
    attachment_names: ['Nabidka_Sigmaform.pdf'], signals: ['attachment'], proposed_date: null, wait_reason: 'offer_draft', account_id: null,
    account: null, evidence: { web_link: 'https://outlook.office.com/mail/n1' }, offer_proposal_id: PID, offer_draft: stored(), ...over,
  })

  function db(rows: Record<string, unknown>[], opts: { missingColumn?: boolean } = {}) {
    const selects: string[] = []
    const resolve = (call: QueryCall): QueryResult => {
      if (call.table === 'account') return { data: [{ id: 1, name: 'Sigmaform Servis s.r.o.' }], error: null }
      if (call.table === 'mail_content_intake' && hasOp(call, 'select')) {
        const cols = String(call.ops.find((o) => o.method === 'select')!.args[0])
        selects.push(cols)
        if (opts.missingColumn && cols.includes('offer_draft')) return { data: null, error: { code: '42703', message: 'column mail_content_intake.offer_draft does not exist' } }
        const strip = (r: Record<string, unknown>) => (cols.includes('offer_draft') ? r : Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('offer_'))))
        return { data: rows.map(strip), error: null }
      }
      return { data: [], error: null, count: 0 }
    }
    return { fake: createSupabaseFake({ resolve }), selects }
  }

  it('listQueuedMail vrátí návrh zakázky z řádku a najde klienta podle jména z PDF', async () => {
    const { fake } = db([row()])
    const [m] = await listQueuedMail(50, fake.client as never)
    expect(m.waitReason).toBe('offer_draft')
    expect(m.offer).toMatchObject({
      proposalId: PID, fileName: 'Nabidka_Sigmaform.pdf', warnings: ['chybí fáze'], flags: [],
      fields: { account_name: 'Sigmaform Servis s.r.o.', amount_one_time: 180000, currency: 'CZK' },
      account: { kind: 'existing', id: 1, name: 'Sigmaform Servis s.r.o.' },
    })
  })

  it('poškozený nebo cizí návrh se nezobrazí jako návrh zakázky', async () => {
    const other = mailOfferProposalId('<jina@x.cz>', 'ATT9')
    const { fake } = db([row({ offer_draft: stored(), offer_proposal_id: other }), row({ id: 8, offer_draft: { neco: 1 } }), row({ id: 9, offer_draft: null, wait_reason: 'no_match' })])
    const list = await listQueuedMail(50, fake.client as never)
    expect(list.map((m) => m.offer ?? null)).toEqual([null, null, null])
  })

  it('bez migrace 0099 (chybí sloupec) se fronta čte starým dotazem a nespadne', async () => {
    const { fake, selects } = db([row({ wait_reason: 'no_match' })], { missingColumn: true })
    const list = await listQueuedMail(50, fake.client as never)
    expect(list).toHaveLength(1)
    expect(list[0].offer ?? null).toBeNull()
    expect(selects).toHaveLength(2)
    expect(selects[0]).toContain('offer_draft')
    expect(selects[1]).not.toContain('offer_draft')
  })

  it('karta na Dnes: klient a cena z návrhu; bez migrace 0099 starý dotaz', async () => {
    const { fake } = db([row()])
    const card = await getMailContentCard(fake.client as never)
    expect(card).toMatchObject({ state: 'ok', items: [{ waitReason: 'offer_draft', offer: { clientName: 'Sigmaform Servis s.r.o.', amount: 180000, currency: 'CZK', title: 'Procesní audit' } }] })

    const old = db([row({ wait_reason: 'no_match' })], { missingColumn: true })
    const oldCard = await getMailContentCard(old.fake.client as never)
    expect(oldCard).toMatchObject({ state: 'ok' })
    expect((oldCard as Extract<MailContentCard, { state: 'ok' }>).items[0].offer ?? null).toBeNull()
  })
})
