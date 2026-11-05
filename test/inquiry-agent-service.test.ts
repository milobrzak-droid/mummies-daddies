// Agent příchozích poptávek (P2) — běh nad frontou s podvrženým úložištěm,
// poštou, modelem a geokódováním (žádná síť ani DB). Hlídá cesty
// send_offer / eskalace / odklad / chybějící odchozí fronta a to, že text
// e-mailu nikdy neskončí ve statistikách ani v logu.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaseProposalOutput, ProposalDraft } from '@/core/agents/template'
import { runInquiryAgent, type InquiryAgentStore, type MailPort, type MessageFetch, type RunRow, type WebRow } from '@/domain/crm/inquiryAgentService'
import type { FoundResult } from '@/domain/crm/inquiryAgent'

const OWNER = 'u-obchod'
const NOW = new Date('2026-11-05T09:00:00Z')
const SECRET_BODY = 'Tajná věta z těla e-mailu 4711'

function makeStore(over: Partial<{ runs: RunRow[]; web: WebRow[]; modelCalls: number; outboxMissing: boolean; found: Partial<FoundResult>; owner: string | null; vip: boolean }> = {}) {
  const s = {
    finishedRuns: [] as Record<string, unknown>[],
    finishedWeb: [] as Record<string, unknown>[],
    founds: [] as Record<string, unknown>[],
    outbox: [] as Record<string, unknown>[],
    proposals: [] as ProposalDraft<Record<string, never>, CaseProposalOutput>[],
  }
  const store: InquiryAgentStore = {
    claimRuns: vi.fn(async () => over.runs ?? []),
    finishRun: vi.fn(async (p) => void s.finishedRuns.push(p)),
    claimWeb: vi.fn(async () => over.web ?? []),
    finishWeb: vi.fn(async (p) => void s.finishedWeb.push(p)),
    found: vi.fn(async (p) => {
      s.founds.push(p)
      return { status: 'created', account_id: 11, contact_id: 12, deal_id: 13, scope_version_id: (p.scope ? 14 : null), ...over.found } as FoundResult
    }),
    enqueueOutbox: vi.fn(async (p) => {
      if (over.outboxMissing) return { ok: false, missing: true } as const
      s.outbox.push(p)
      return { ok: true, outboxId: 99, duplicate: false } as const
    }),
    modelCallsSince: vi.fn(async () => over.modelCalls ?? 0),
    memberIdByEmail: vi.fn(async () => (over.owner === undefined ? OWNER : over.owner)),
    isVipEmail: vi.fn(async () => over.vip ?? false),
    propose: vi.fn(async (d) => {
      s.proposals.push(d)
      return 'created' as const
    }),
  }
  return { store, s }
}

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 7, internet_message_id: '<poptavka-1@alfa-firma.cz>', graph_message_id: 'g1', thread_id: 't1', mailbox: 'obchod@mummiesdaddies.com',
  mailbox_member_id: OWNER, received_at: '2026-11-05T08:00:00.000Z', status: 'processing', attempts: 1, reply_draft: null, ...over,
})

const AUTH_OK = 'mx.google.com; dkim=pass header.i=@alfa-firma.cz header.s=s1; spf=pass smtp.mailfrom=jan.novak@alfa-firma.cz; dmarc=pass (p=NONE) header.from=alfa-firma.cz'

function mail(headers: Record<string, string> = {}, result?: MessageFetch): MailPort {
  return {
    fetchMessage: vi.fn(async (): Promise<MessageFetch> =>
      result ?? {
        kind: 'ok',
        message: {
          headers: Object.entries({ From: '"Jan Novák" <jan.novak@alfa-firma.cz>', Subject: 'Poptávka oběd', 'Authentication-Results': AUTH_OK, ...headers })
            .map(([name, value]) => ({ name, value })),
          text: `Dobrý den, chceme oběd pro 50 lidí 10. 12. v Karlíně. ${SECRET_BODY}\n\n> citace`,
        },
      }),
  }
}

const EXTRACTED = {
  is_catering_inquiry: true, segment: 'b2b', segment_evidence: 'firma v podpisu', event_type: 'obed', event_date: '2026-12-10', guests: 50,
  package: null, duration_hours: null, venue: 'Karlín, Praha 8', extras: [], dietary: [], special_requests: null,
  customer_name: 'Jan Novák', company_name: 'Firma Alfa s.r.o.', document_instructions: null,
}

const deps = (
  store: InquiryAgentStore,
  m: MailPort,
  extract: (input: unknown) => Promise<unknown> = vi.fn(async () => EXTRACTED),
  distanceKm: (venue: string) => Promise<number | null> = vi.fn(async () => 10),
) => ({
  store, mail: m, extract, distanceKm, now: () => NOW,
})

let logs: string[] = []
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'error').mockImplementation((...a) => void logs.push(a.join(' ')))
  vi.spyOn(console, 'warn').mockImplementation((...a) => void logs.push(a.join(' ')))
})
afterEach(() => vi.restoreAllMocks())

describe('e-mail', () => {
  it('standardní poptávka: CRM zápis, nabídka do odchozí fronty (vlákno, patička), stav enqueued', async () => {
    const { store, s } = makeStore({ runs: [run()] })
    const extract = vi.fn(async () => EXTRACTED)
    const stats = await runInquiryAgent(deps(store, mail(), extract))
    expect(stats).toMatchObject({ claimed: 1, send_offer: 1, enqueued: 1, modelCalls: 1, escalate: 0 })
    // Model dostal jen nejnovější část zprávy (bez citace) a nic z adres.
    const input = (extract.mock.calls[0] as unknown as [{ text: string; subject: string }])[0]
    expect(input.text).not.toContain('> citace')
    expect(JSON.stringify(input)).not.toContain('jan.novak@')

    expect(s.founds[0]).toMatchObject({
      source: 'email', source_key: '<poptavka-1@alfa-firma.cz>', run_id: 7, owner_id: OWNER, email: 'jan.novak@alfa-firma.cz', person_name: 'Jan Novák',
      company: { name: 'Firma Alfa s.r.o.', domain: 'alfa-firma.cz' }, deal: { pillar: 'b2b_akce', revenue_line: 'catering_firemni' }, task: null,
    })
    expect(s.outbox[0]).toMatchObject({ kind: 'offer', source_ref: 'inquiry:7', deal_id: 13, scope_version_id: 14, mailbox_member_id: OWNER, mode: { reply: 'g1' } })
    expect(String(s.outbox[0].text)).toContain('Dobrý den, Jan Novák,')
    // Patičku firmy připojí až odchozí fronta (P3), ne agent poptávek — jinak by byla dvakrát.
    expect(String(s.outbox[0].text)).not.toContain('IČO 17957524')
    expect(s.finishedRuns).toEqual([expect.objectContaining({ run_id: 7, status: 'enqueued', outbox_id: 99, reply_draft: null, decision_kind: 'send_offer', model_called: true })])
    // Text e-mailu nikdy ve statistikách ani v logu.
    expect(JSON.stringify(stats)).not.toContain('4711')
    expect(logs.join('\n')).not.toContain('4711')
  })

  it('neověřený odesílatel (DMARC fail): CRM zápis + eskalace obchodu, nic do odchozí fronty', async () => {
    const { store, s } = makeStore({ runs: [run()] })
    const fail = AUTH_OK.replace('dmarc=pass', 'dmarc=fail')
    await runInquiryAgent(deps(store, mail({ 'Authentication-Results': fail })))
    expect(s.outbox).toEqual([])
    expect(s.proposals).toHaveLength(1)
    expect(s.proposals[0]).toMatchObject({ capability: 'inquiry_escalation', sourceKey: 'inquiry:7', target: { node: 'obchod', accountId: 11 } })
    expect(s.proposals[0].reasons).toEqual(expect.arrayContaining(['sender_unverified', 'dmarc_fail']))
    expect(s.founds[0].task).toMatchObject({ priority: 'high' })
    expect(s.finishedRuns[0]).toMatchObject({ status: 'decided', decision_kind: 'escalate' })
  })

  it('jiné Reply-To = neodpovídá se (odpověď jen na From)', async () => {
    const { store, s } = makeStore({ runs: [run()] })
    await runInquiryAgent(deps(store, mail({ 'Reply-To': 'jiny@cizi.cz' })))
    expect(s.outbox).toEqual([])
    expect(s.proposals[0].reasons).toContain('reply_to_mismatch')
  })

  it('výpadek modelu: odklad s backoffem, bez CRM; po vyčerpání pokusů eskalace', async () => {
    const overloaded = vi.fn(async () => {
      throw Object.assign(new Error('Anthropic API error 529 (overloaded_error)'), { status: 529 })
    })
    const a = makeStore({ runs: [run({ attempts: 1 })] })
    await runInquiryAgent(deps(a.store, mail(), overloaded))
    expect(a.s.founds).toEqual([])
    expect(a.s.finishedRuns[0]).toMatchObject({ status: 'pending', error_code: 'model_unavailable', retry_after_seconds: 900, model_called: true })

    const b = makeStore({ runs: [run({ attempts: 4 })] })
    await runInquiryAgent(deps(b.store, mail(), overloaded))
    expect(b.s.proposals[0].reasons).toEqual(expect.arrayContaining(['extraction_failed', 'model_unavailable']))
    expect(b.s.finishedRuns[0]).toMatchObject({ status: 'decided', decision_kind: 'escalate' })
  })

  it('nečitelná odpověď modelu = rovnou eskalace (žádné hádání)', async () => {
    const { store, s } = makeStore({ runs: [run()] })
    await runInquiryAgent(deps(store, mail(), vi.fn(async () => { throw new Error('Odpověď modelu není platný JSON') })))
    expect(s.proposals[0].reasons).toEqual(['extraction_failed'])
  })

  it('není poptávka: jen stav skipped, žádný CRM zápis', async () => {
    const { store, s } = makeStore({ runs: [run()] })
    const stats = await runInquiryAgent(deps(store, mail(), vi.fn(async () => ({ ...EXTRACTED, is_catering_inquiry: false }))))
    expect(stats.not_inquiry).toBe(1)
    expect(s.founds).toEqual([])
    expect(s.finishedRuns[0]).toMatchObject({ status: 'skipped', decision_kind: 'not_inquiry' })
  })

  it('chybí agent_outbox_enqueue (P3 nenasazený): stav decided s konceptem; další běh ho zařadí', async () => {
    const a = makeStore({ runs: [run()], outboxMissing: true })
    const stats = await runInquiryAgent(deps(a.store, mail()))
    expect(stats.outboxPending).toBe(1)
    const fin = a.s.finishedRuns[0]
    expect(fin).toMatchObject({ status: 'decided', error_code: 'outbox_missing', retry_after_seconds: 3600 })
    const draft = fin.reply_draft as Record<string, unknown>
    expect(draft).toMatchObject({ kind: 'offer', source_ref: 'inquiry:7' })

    const b = makeStore({ runs: [run({ status: 'decided', reply_draft: draft })] })
    const extract = vi.fn()
    const m = mail()
    await runInquiryAgent(deps(b.store, m, extract))
    expect(extract).not.toHaveBeenCalled()
    expect(m.fetchMessage).not.toHaveBeenCalled()
    expect(b.s.outbox).toEqual([draft])
    expect(b.s.finishedRuns[0]).toMatchObject({ status: 'enqueued', outbox_id: 99, reply_draft: null })
  })

  it('denní strop modelu: zpráva čeká na další den, model se nevolá', async () => {
    const { store, s } = makeStore({ runs: [run()], modelCalls: 100 })
    const extract = vi.fn()
    await runInquiryAgent(deps(store, mail(), extract))
    expect(extract).not.toHaveBeenCalled()
    // 9:00 UTC = 10:00 v Praze → do půlnoci 14 h.
    expect(s.finishedRuns[0]).toMatchObject({ status: 'pending', error_code: 'model_daily_limit', retry_after_seconds: 14 * 3600 })
  })

  it('smazaná zpráva = skipped; výpadek Gmailu = odklad', async () => {
    const a = makeStore({ runs: [run()] })
    await runInquiryAgent(deps(a.store, mail({}, { kind: 'gone' })))
    expect(a.s.finishedRuns[0]).toMatchObject({ status: 'skipped', error_code: 'message_gone' })
    const b = makeStore({ runs: [run()] })
    await runInquiryAgent(deps(b.store, mail({}, { kind: 'retry', seconds: 120, code: 'mail_throttled' })))
    expect(b.s.finishedRuns[0]).toMatchObject({ status: 'pending', error_code: 'mail_throttled', retry_after_seconds: 120 })
  })

  it('deadline: zbytek fronty se vrátí do pending', async () => {
    const { store, s } = makeStore({ runs: [run({ id: 1 }), run({ id: 2 })] })
    let n = 0
    const stats = await runInquiryAgent({ ...deps(store, mail()), timeUp: () => n++ > 0 })
    expect(stats.released).toBe(1)
    expect(s.finishedRuns.find((f) => f.run_id === 2)).toEqual({ run_id: 2, status: 'pending', retry_after_seconds: 0 })
  })

  it('bez vlastníka leadu v týmu běh skončí chybou (nic nezapíše)', async () => {
    const { store, s } = makeStore({ runs: [run()], owner: null })
    await expect(runInquiryAgent(deps(store, mail()))).rejects.toThrow(/Vlastník leadu/)
    expect(s.founds).toEqual([])
  })

  it('opakovaná poptávka (reused) se sama neodpovídá', async () => {
    const { store, s } = makeStore({ runs: [run()], found: { status: 'reused' } })
    await runInquiryAgent(deps(store, mail()))
    expect(s.outbox).toEqual([])
    expect(s.proposals[0].reasons).toContain('existing_open_deal')
  })
})

describe('web (bez modelu)', () => {
  const web = (inquiry: Record<string, unknown>, over: Partial<WebRow> = {}): WebRow => ({
    id: 5, received_at: '2026-11-05T08:30:00.000Z', customer_name: 'Petra Malá', email: 'petra@firma-beta.cz', company_name: 'Beta s.r.o.', ico: null, attempts: 1,
    inquiry: { segment: 'b2b', event_type: 'obed', package_key: null, event_date: '2026-12-10', start_time: '12:00', duration_hours: null, guests: 50,
      venue: 'Karlín, Praha 8', extras: [], dietary: [], special_requests: null, ...inquiry },
    ...over,
  })

  it('standardní poptávka: nabídka na adresu z formuláře, source_ref web:<id>, model se nevolá', async () => {
    const { store, s } = makeStore({ web: [web({})] })
    const extract = vi.fn()
    const stats = await runInquiryAgent(deps(store, mail(), extract))
    expect(extract).not.toHaveBeenCalled()
    expect(stats).toMatchObject({ web: 1, send_offer: 1, enqueued: 1 })
    expect(s.founds[0]).toMatchObject({ source: 'web', source_key: 'web:5', web_inquiry_id: 5, company: { name: 'Beta s.r.o.', domain: 'firma-beta.cz' } })
    expect(s.outbox[0]).toMatchObject({ kind: 'offer', source_ref: 'web:5', mode: { to: 'petra@firma-beta.cz' }, mailbox_member_id: OWNER })
    expect(String(s.outbox[0].text)).toContain('Dobrý den, Petra Malá,')
    expect(s.finishedWeb[0]).toMatchObject({ web_inquiry_id: 5, status: 'decided', decision_kind: 'send_offer' })
  })

  it('nevybraný segment = posouzení obchodu (ne doptání)', async () => {
    const { store, s } = makeStore({ web: [web({ segment: null })] })
    await runInquiryAgent(deps(store, mail()))
    expect(s.outbox).toEqual([])
    expect(s.proposals[0]).toMatchObject({ sourceKey: 'web:5', event: { evidence: { kind: 'url', sourceId: 'web_inquiry:5' } } })
    expect(s.proposals[0].reasons).toContain('segment_unclear')
    expect(s.finishedWeb[0]).toMatchObject({ status: 'decided', decision_kind: 'escalate' })
  })

  it('místo nejde dohledat (geokódování vypnuté / nejasné) = eskalace', async () => {
    const { store, s } = makeStore({ web: [web({})] })
    await runInquiryAgent(deps(store, mail(), vi.fn(), vi.fn(async () => null)))
    expect(s.proposals[0].reasons).toContain('venue_unresolved')
  })

  it('soukromá oslava z freemailu: účet soukromé osoby, linka podle typu akce', async () => {
    const { store, s } = makeStore({ web: [web({ segment: 'b2c', event_type: 'svatba', guests: 80, event_date: '2027-06-12' }, { email: 'petra@seznam.cz', company_name: null })] })
    await runInquiryAgent(deps(store, mail()))
    expect(s.founds[0]).toMatchObject({ company: null, deal: { pillar: 'b2c_oslavy', revenue_line: 'svatebni_hostina' } })
  })

  it('bez odchozí fronty zůstane poptávka new (další běh ji projde znovu)', async () => {
    const { store, s } = makeStore({ web: [web({})], outboxMissing: true })
    await runInquiryAgent(deps(store, mail()))
    expect(s.finishedWeb[0]).toMatchObject({ status: 'new', error_code: 'outbox_missing', decision_kind: 'send_offer' })
  })

  it('poškozený řádek = failed', async () => {
    const { store, s } = makeStore({ web: [web({}, { inquiry: 'nesmysl' })] })
    await runInquiryAgent(deps(store, mail()))
    expect(s.finishedWeb[0]).toMatchObject({ status: 'failed', error_code: 'invalid_inquiry' })
  })
})
