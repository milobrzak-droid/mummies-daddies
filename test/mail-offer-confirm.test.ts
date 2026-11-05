// Potvrzení návrhu zakázky z přílohy e-mailu (confirmOfferProposal, větev mail):
// stejné potvrzení jako u ručního importu z PDF, jen návrh čeká v řádku fronty
// „Pošta k zařazení" a PDF neexistuje. Klient i cena jdou opravit, nic se
// nezaloží bez potvrzení, druhé potvrzení obchod nezdvojí, řádek se uzavře.
// Supabase je falešný.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'
import { confirmOfferProposal } from '@/domain/crm/actions/offers'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { revalidatePath } from 'next/cache'
import { mailOfferProposalId } from '@/domain/crm/mailOffer'
import { buildMailOfferDraft, mailOfferPath } from '@/domain/crm/offerProposal'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/connectors/cnb', () => ({ czkPerEur: vi.fn(async () => 25) }))
vi.mock('@/connectors/ares', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/connectors/ares')>()),
  aresSearch: vi.fn(async () => ({ candidates: [], total: 0 })),
}))
vi.mock('@/connectors/anthropic', () => ({ extractOfferFromPdf: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(async () => ({ user: { id: 'user-1' }, member: { role: 'obchodnik' } })),
  memberSeesSales: vi.fn((member: { role?: string | null } | null) => member?.role === 'vedeni' || member?.role === 'obchodnik'),
}))

const PROPOSAL_ID = mailOfferProposalId('<n1@sigmaform.cz>', 'ATT1')
const MAIL_PATH = mailOfferPath(PROPOSAL_ID)

const draft = (over: Record<string, unknown> = {}) => ({
  ...buildMailOfferDraft({
    proposalId: PROPOSAL_ID, fileName: 'Nabidka_Sigmaform.pdf', now: new Date('2026-09-30T04:00:00Z'), warnings: [],
    fields: {
      account_name: 'Sigmaform Servis s.r.o.', title: 'Procesní audit', pillar: 'b2b_akce', phase: null, revenue_line: 'svatebni_hostina',
      currency: 'CZK', amount_one_time: 180000, cogs_one_time: null, estimate_md: 12, expected_close: null,
    },
  }),
  ...over,
})

type Env = {
  row: { id: number; status: string; offer_draft: unknown; evidence_id: number } | null
  accountRows: { id: number; name: string }[]
  intakeError: { code: string; message: string } | null
}

function setup(env: Partial<Env> = {}) {
  const e: Env = {
    row: { id: 3, status: 'queued', offer_draft: draft(), evidence_id: 41 },
    accountRows: [{ id: 1, name: 'Sigmaform Servis s.r.o.' }],
    intakeError: null,
    ...env,
  }
  let createdDeal: { id: number; account_id: number; title: string } | null = null
  const rowUpdates: Record<string, unknown>[] = []
  const resolve = (call: QueryCall): QueryResult => {
    if (call.table === 'mail_content_intake') {
      if (hasOp(call, 'update')) {
        rowUpdates.push(opArgs(call, 'update')![0] as Record<string, unknown>)
        if (e.row) e.row = { ...e.row, status: 'proposed', offer_draft: null }
        return { data: null, error: null }
      }
      if (e.intakeError) return { data: null, error: e.intakeError }
      return { data: e.row ? [e.row] : [], error: null }
    }
    if (call.table === 'evidence') {
      if (hasOp(call, 'upsert')) return { data: null, error: null }
      // recordEvidence dohledává id podle (druh, zdroj); návrh čte řádek podle id.
      if (call.ops.some((o) => o.method === 'eq' && o.args[0] === 'source_kind')) return { data: { id: 55 }, error: null }
      return { data: { source_kind: 'email_message', source_id: '<n1@sigmaform.cz>', web_link: 'https://outlook.office.com/mail/n1' }, error: null }
    }
    if (call.table === 'account' && hasOp(call, 'insert')) return { data: { id: 77 }, error: null }
    if (call.table === 'account') return { data: e.accountRows, error: null }
    if (call.table === 'deal' && hasOp(call, 'insert')) {
      createdDeal = { id: 9, account_id: 1, title: 'Procesní audit — fáze 1' }
      return { data: { id: 9 }, error: null }
    }
    if (call.table === 'deal') {
      const path = opArgs(call, 'eq')?.[1]
      return { data: createdDeal && path === MAIL_PATH ? [createdDeal] : [], error: null }
    }
    return { data: null, error: null }
  }
  const fake = createSupabaseFake({ resolve })
  const storageDownloads: string[] = []
  const client = {
    ...fake.client,
    storage: {
      from: () => ({
        // Návrh z e-mailu ve storage není: čte se z řádku fronty.
        download: vi.fn(async (path: string) => { storageDownloads.push(path); return { data: null, error: { message: 'Object not found' } } }),
        upload: vi.fn(),
        remove: vi.fn(),
      }),
    },
  }
  vi.mocked(createAdminClient).mockReturnValue(client as never)
  const inserts = (table: string) => fake.calls.filter((c) => c.table === table && hasOp(c, 'insert'))
  const row = (table: string) => opArgs(inserts(table)[0], 'insert')?.[0] as Record<string, unknown>
  return { fake, inserts, row, rowUpdates, storageDownloads, env: e }
}

const form = (over: Record<string, string> = {}) => {
  const fd = new FormData()
  const values: Record<string, string> = {
    proposal_id: PROPOSAL_ID, account_name: 'Sigmaform Servis s.r.o.', title: 'Procesní audit', pillar: 'b2b_akce', phase: '',
    revenue_line: 'svatebni_hostina', currency: 'CZK', amount_one_time: '180000', cogs_one_time: '',
    estimate_md: '12', expected_close: '', ...over,
  }
  for (const [k, v] of Object.entries(values)) fd.set(k, v)
  return fd
}

beforeEach(() => vi.clearAllMocks())

describe('potvrzení návrhu zakázky z e-mailu', () => {
  test('obchod vznikne z potvrzených hodnot (cena i klient jdou opravit), ne z návrhu AI', async () => {
    const s = setup({ accountRows: [{ id: 1, name: 'Sigmaform Servis s.r.o.' }] })
    const res = await confirmOfferProposal(null, form({ amount_one_time: '150000', title: 'Procesní audit — fáze 1' }))
    expect(res).toEqual({ ok: true, dealId: 9, accountId: 1, title: 'Procesní audit — fáze 1', warnings: [] })
    expect(s.row('deal')).toMatchObject({
      account_id: 1, title: 'Procesní audit — fáze 1', amount_one_time: 150000, currency: 'CZK', pillar: 'b2b_akce',
      source_pdf_path: MAIL_PATH,
    })
    expect(s.inserts('account')).toHaveLength(0)
    // Návrh se četl z řádku fronty, ne ze storage (PDF v Cockpitu není).
    expect(s.storageDownloads).toEqual([`offers/${PROPOSAL_ID}.navrh.json`])
  })

  test('audit: human_confirmed, zdroj mail_offer_attachment, doklad = zpráva v Outlooku (ne soubor), bez textu z PDF', async () => {
    const s = setup()
    await confirmOfferProposal(null, form({ amount_one_time: '150000' }))
    const evidence = s.fake.calls.filter((c) => c.table === 'evidence' && hasOp(c, 'upsert')).map((c) => opArgs(c, 'upsert')?.[0])
    expect(evidence.length).toBeGreaterThan(0)
    for (const ev of evidence) {
      expect(ev).toMatchObject({ source_kind: 'email_message', source_id: '<n1@sigmaform.cz>', web_link: 'https://outlook.office.com/mail/n1' })
    }
    const audit = s.row('audit_event')
    expect(audit).toMatchObject({ action: 'deal.offer_confirmed', entity_table: 'deal', entity_id: 9, info_state: 'human_confirmed' })
    expect(audit.after).toMatchObject({
      source: 'mail_offer_attachment', proposal_id: PROPOSAL_ID, proposal_info_state: 'ai_suggestion', changed_fields: ['amount_one_time'],
    })
    // verze nabídky vychází z téže zprávy
    expect(s.row('deal_scope_version')).toMatchObject({ deal_id: 9, evidence_id: 55 })
  })

  test('řádek fronty se po založení uzavře: klient, obchod, člověk; návrh z něj zmizí', async () => {
    const s = setup()
    await confirmOfferProposal(null, form())
    expect(s.rowUpdates).toHaveLength(1)
    expect(s.rowUpdates[0]).toMatchObject({
      status: 'proposed', wait_reason: null, offer_draft: null, account_id: 1, deal_id: 9, match_method: 'manual', decided_by: 'user:user-1',
    })
    // Stránku Případy nepřekreslujeme (člověk vidí, co vzniklo); Dnes a klienty ano.
    const paths = vi.mocked(revalidatePath).mock.calls.map((c) => c[0])
    expect(paths).toContain('/cockpit')
    expect(paths).not.toContain('/cockpit/pripady')
  })

  test('druhé potvrzení (dvojklik) obchod nezdvojí, i když řádek už je uzavřený', async () => {
    const s = setup()
    const first = await confirmOfferProposal(null, form())
    expect(first).toMatchObject({ ok: true, dealId: 9 })
    const second = await confirmOfferProposal(null, form())
    expect(second).toMatchObject({ ok: true, dealId: 9, alreadyImported: true })
    expect(s.inserts('deal')).toHaveLength(1)
  })

  test('nový klient (v Cockpitu není): založí se až po potvrzení', async () => {
    const s = setup({ accountRows: [] })
    const res = await confirmOfferProposal(null, form())
    expect(res).toMatchObject({ ok: true })
    expect(s.row('account')).toMatchObject({ name: 'Sigmaform Servis s.r.o.' })
  })

  test('neexistující nebo cizí návrh nic nezaloží', async () => {
    const s = setup({ row: null })
    const res = await confirmOfferProposal(null, form())
    expect(res).toMatchObject({ ok: false, error: 'Návrh nenalezen nebo je poškozený — nahraj PDF znovu.' })
    expect(s.inserts('deal')).toHaveLength(0)
    expect(s.inserts('account')).toHaveLength(0)
  })

  test('řádek, který už není čekající, nebo s návrhem jiného id se nepřijme', async () => {
    const closed = setup({ row: { id: 3, status: 'discarded', offer_draft: draft(), evidence_id: 41 } })
    expect(await confirmOfferProposal(null, form())).toMatchObject({ ok: false })
    expect(closed.inserts('deal')).toHaveLength(0)

    const other = mailOfferProposalId('<jina@sigmaform.cz>', 'ATT9')
    const tampered = setup({ row: { id: 3, status: 'queued', offer_draft: draft({ proposal_id: other, pdf_path: mailOfferPath(other) }), evidence_id: 41 } })
    expect(await confirmOfferProposal(null, form())).toMatchObject({ ok: false })
    expect(tampered.inserts('deal')).toHaveLength(0)
  })

  test('před migrací 0099 (chybí sloupec) návrh z e-mailu není a nic se nezaloží', async () => {
    const s = setup({ intakeError: { code: '42703', message: 'column mail_content_intake.offer_draft does not exist' } })
    expect(await confirmOfferProposal(null, form())).toMatchObject({ ok: false, error: expect.stringContaining('Návrh nenalezen') })
    expect(s.inserts('deal')).toHaveLength(0)
  })

  test('jiná chyba databáze při čtení návrhu: srozumitelná chyba, nic se nezaloží', async () => {
    const s = setup({ intakeError: { code: '57014', message: 'timeout' } })
    expect(await confirmOfferProposal(null, form())).toMatchObject({ ok: false, error: expect.stringContaining('nepodařilo načíst') })
    expect(s.inserts('deal')).toHaveLength(0)
  })

  test('role bez obchodu nepotvrdí', async () => {
    const s = setup()
    vi.mocked(getCurrentMember).mockResolvedValueOnce({ user: { id: 'u' } as never, member: { role: 'projektak', full_name: null, is_admin: false } })
    expect(await confirmOfferProposal(null, form())).toEqual({ ok: false, error: 'Nahrát nabídku může jen člen s přístupem k obchodu.' })
    expect(s.fake.calls).toHaveLength(0)
  })
})
