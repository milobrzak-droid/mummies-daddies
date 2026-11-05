// Agent příchozích poptávek (P2) — čistá logika: pojistky nad verdiktem,
// CRM payload, eskalace bez osobních údajů, položka odchozí fronty a
// předfiltr schránky. Bez sítě a bez DB.
import { describe, expect, it } from 'vitest'
import { COMPANY } from '@/config'
import { OUTBOX_SOURCE_REF_RE, outboxEnqueuePayload } from '@/core/agents/outboxPort'
import { evaluateSenderAuth } from '@/core/agents/mailAuth'
import type { OfferQuote } from '@/core/standardOffer'
import {
  applyAgentGates,
  applyFoundResult,
  contactName,
  escalationProposal,
  inquiryFoundPayload,
  isRpcMissing,
  isTransientModelError,
  leadCompany,
  leadLine,
  outboxItem,
  pragueDayStartIso,
  replyMailboxMember,
  replyMode,
  retryDelaySeconds,
  verdictFromDecision,
  type AgentVerdict,
} from '@/domain/crm/inquiryAgent'
import { inquiryMailboxesFromEnv, listIdForAddress, mailboxConnectorKey, screenInboundMessage, type GmailMetaLike } from '@/domain/crm/inquiryMailbox'

const QUOTE = {
  mapVersion: 'ilustracni-2026-11', segment: 'b2b', eventType: 'obed', eventTypeLabel: 'Oběd',
  package: { key: 'obed_raut', label: 'Obědový raut', pricePerGuest: 690, minGuests: 20, maxGuests: 300, service: true, includes: ['raut'] },
  eventDate: '2026-12-10', guests: 50,
  lines: [{ key: 'food', label: 'Obědový raut', quantity: 50, unit: 'host', unitPrice: 690, total: 34_500, vatClass: 'food', vatRate: 0.12 }],
  subtotal: 34_500, vat: 4_140, vatBreakdown: [{ rate: 0.12, base: 34_500, vat: 4_140 }], total: 38_640, pricesIncludeVat: false, currency: 'CZK', issuedAt: '2026-11-05', validUntil: '2026-11-19',
} as OfferQuote

const offerVerdict = (): AgentVerdict => ({ kind: 'send_offer', reasonCodes: [], missing: [], quote: QUOTE, reply: { subject: 'Re: Poptávka', body: 'Dobrý den,\n\nnabídka…' } })
const infoVerdict = (missing: AgentVerdict['missing']): AgentVerdict => ({ kind: 'ask_info', reasonCodes: [], missing, quote: null, reply: { subject: 'Re: x', body: 'Doplňte…' } })
const ALL_KINDS = ['send_offer', 'ask_info'] as const

describe('pojistky agenta (applyAgentGates)', () => {
  it('ověřený odesílatel a standardní nabídka projde beze změny', () => {
    const auth = { ok: true, codes: [], replyAddress: 'a@b.cz' }
    expect(applyAgentGates(offerVerdict(), { senderAuth: auth, venuePresent: true, autoSendKinds: ALL_KINDS })).toEqual(offerVerdict())
  })

  it('neověřený odesílatel → eskalace s kódy, koncept nabídky zůstává, odpověď se zahodí', () => {
    const auth = { ok: false, codes: ['dmarc_fail' as const], replyAddress: 'a@b.cz' }
    const v = applyAgentGates(offerVerdict(), { senderAuth: auth, venuePresent: true, autoSendKinds: ALL_KINDS })
    expect(v).toMatchObject({ kind: 'escalate', reasonCodes: ['sender_unverified', 'dmarc_fail'], quote: QUOTE, reply: null })
  })

  it('nejasný segment se nedoptává — jde na posouzení', () => {
    expect(applyAgentGates(infoVerdict(['segment', 'guests']), { venuePresent: false, autoSendKinds: ALL_KINDS }).reasonCodes).toEqual(['segment_unclear'])
  })

  it('místo uvedené, ale nedohledatelné → eskalace; bez místa se smí doptat', () => {
    expect(applyAgentGates(infoVerdict(['distanceKm']), { venuePresent: true, autoSendKinds: ALL_KINDS })).toMatchObject({ kind: 'escalate', reasonCodes: ['venue_unresolved'] })
    expect(applyAgentGates(infoVerdict(['distanceKm']), { venuePresent: false, autoSendKinds: ALL_KINDS }).kind).toBe('ask_info')
  })

  it('druh mimo autoSendKinds → eskalace', () => {
    expect(applyAgentGates(infoVerdict(['guests']), { venuePresent: false, autoSendKinds: ['send_offer'] }).reasonCodes).toEqual(['auto_send_kind_off'])
  })

  it('selhání čtení modelem = eskalace (extraction_failed)', () => {
    const v = verdictFromDecision({ kind: 'escalate', extracted: null, segment: null, reasons: [{ code: 'extraction_failed', message: 'x' }], missing: [], draft: null })
    expect(v).toMatchObject({ kind: 'escalate', reasonCodes: ['extraction_failed'], reply: null })
  })

  it('rozporný segment z decideInquiry nese segment_unclear', () => {
    const v = verdictFromDecision({
      kind: 'ask_info', extracted: {} as never, segment: { segment: null, basis: 'conflict', note: '' }, missing: ['segment'], email: { subject: 's', body: 'b' },
    })
    expect(applyAgentGates(v, { venuePresent: false, autoSendKinds: ALL_KINDS })).toMatchObject({ kind: 'escalate', reasonCodes: ['segment_unclear'] })
  })

  it('po CRM zápisu: opakovaná poptávka a víc klientů se samo neodpovídá', () => {
    const base = { account_id: 1, contact_id: 2, deal_id: 3, scope_version_id: null }
    expect(applyFoundResult(offerVerdict(), { ...base, status: 'reused' }).reasonCodes).toEqual(['existing_open_deal'])
    expect(applyFoundResult(offerVerdict(), { ...base, status: 'ambiguous' }).reasonCodes).toEqual(['ambiguous_account'])
    expect(applyFoundResult(offerVerdict(), { ...base, status: 'duplicate' }).kind).toBe('send_offer')
  })
})

describe('lead do CRM', () => {
  it('firma: firemní doména = podle domény; freemail s názvem = bez domény; B2C = soukromá osoba', () => {
    expect(leadCompany({ segment: 'b2b', email: 'jan@alfa-stroje.cz', companyName: null })).toEqual({ name: 'Alfa Stroje', domain: 'alfa-stroje.cz', ico: null })
    expect(leadCompany({ segment: null, email: 'jan@gmail.com', companyName: 'Firma Alfa s.r.o.', ico: '12345678' })).toEqual({ name: 'Firma Alfa s.r.o.', domain: null, ico: '12345678' })
    expect(leadCompany({ segment: 'b2c', email: 'jana@seznam.cz', companyName: 'Zaměstnavatel' })).toBeNull()
    expect(leadCompany({ segment: null, email: 'jana@seznam.cz', companyName: null })).toBeNull()
  })

  it('jméno kontaktu: ze vstupu, jinak z adresy', () => {
    expect(contactName('  Jan   Novák ', 'x@y.cz')).toBe('Jan Novák')
    expect(contactName(null, 'jan.novak@firma.cz')).toBe('Jan Novak')
  })

  it('pilíř a linka: svatba → svatební hostina, neznámý segment → výchozí', () => {
    const m = COMPANY.capabilities.inquiryAgent.leadMapping
    expect(leadLine(m, 'b2c', 'svatba')).toEqual({ pillar: 'b2c_oslavy', revenueLine: 'svatebni_hostina' })
    expect(leadLine(m, 'b2c', 'oslava')).toEqual({ pillar: 'b2c_oslavy', revenueLine: 'oslava_soukroma' })
    expect(leadLine(m, null, null)).toEqual({ pillar: 'b2b_akce', revenueLine: 'catering_firemni' })
  })

  it('payload: obchod, aktivita, koncept nabídky; úkol jen u eskalace; další krok podle druhu', () => {
    const args = {
      source: 'email' as const, sourceKey: '<m@x>', runId: 7, occurredAt: '2026-11-05T08:00:00Z', ownerId: 'u1', dedupDays: 14,
      email: 'jan@alfa.cz', personName: 'Jan Novák', company: { name: 'Alfa', domain: 'alfa.cz', ico: null },
      facts: { segment: 'b2b', eventType: 'obed', eventTypeLabel: 'Oběd', eventDate: '2026-12-10', guests: 50 },
      line: { pillar: 'b2b_akce', revenueLine: 'catering_firemni', revenueCategory: 'one_time' }, today: '2026-11-06',
    }
    const p = inquiryFoundPayload({ ...args, verdict: offerVerdict() }) as Record<string, Record<string, unknown>>
    expect(p.deal).toMatchObject({ title: 'Oběd — Alfa, 10. 12. 2026', amount: 34_500, next_step_due: '2026-11-11' })
    expect(p.scope).toMatchObject({ amount: 34_500 })
    expect(String(p.scope.text)).toContain('Verze cenové mapy: ilustracni-2026-11')
    expect(p.task).toBeNull()
    const esc = inquiryFoundPayload({ ...args, verdict: { ...offerVerdict(), kind: 'escalate', reasonCodes: ['vip_contact'], reply: null } }) as Record<string, Record<string, unknown>>
    // Pátek 6. 11. + 1 pracovní den = pondělí 9. 11.
    expect(esc.task).toEqual({ title: 'Posoudit poptávku — Alfa', due_on: '2026-11-09', priority: 'high' })
    expect(String(esc.deal.note)).toContain('citlivý / VIP kontakt')
    expect(() => inquiryFoundPayload({ ...args, verdict: { kind: 'not_inquiry', reasonCodes: [], missing: [], quote: null, reply: null } })).toThrow()
  })
})

describe('eskalace (case_proposal)', () => {
  it('zdůvodnění bez e-mailu, jména, částky a adresy; idempotence podle sourceKey', () => {
    const d = escalationProposal({
      sourceKey: 'inquiry:7', source: 'email', occurredAt: '2026-11-05T08:00:00.000Z', node: 'obchod', accountId: 5,
      evidence: { kind: 'email_message', sourceId: 'g1', webLink: 'https://mail.google.com/mail/#all/g1' },
      reasonCodes: ['special_request', 'over_auto_send_limit', 'special_request'], eventTypeLabel: 'Svatební hostina', hasDraft: true,
    })
    expect(d).toMatchObject({ capability: 'inquiry_escalation', sourceKey: 'inquiry:7', method: 'rule', infoState: 'ai_suggestion', target: { node: 'obchod', accountId: 5 } })
    expect(d.reasons).toEqual(['special_request', 'over_auto_send_limit'])
    const text = `${d.output.title} ${d.output.rationale}`
    expect(text).toContain('zvláštní přání')
    expect(text).not.toMatch(/@|Kč|\d{3}/)
  })
})

describe('odchozí fronta (P3)', () => {
  it('nabídka: kind offer, patička firmy, verze mapy, source_ref podle kontraktu', () => {
    const item = outboxItem({ verdict: offerVerdict(), sourceRef: 'inquiry:7', dealId: 3, scopeVersionId: 9, mailboxMemberId: 'u1', mode: { reply: 'g1' }, footer: 'Patička firmy' })
    expect(item).toMatchObject({ kind: 'offer', scopeVersionId: 9, priceMapVersion: 'ilustracni-2026-11', subject: 'Re: Poptávka' })
    expect(item.text.endsWith('\n\nPatička firmy')).toBe(true)
    expect(OUTBOX_SOURCE_REF_RE.test(item.sourceRef)).toBe(true)
    expect(outboxEnqueuePayload(item)).toMatchObject({ kind: 'offer', source_ref: 'inquiry:7', mode: { reply: 'g1' }, scope_version_id: 9 })
  })

  it('doptání: info_request bez verze nabídky; eskalace se neodesílá', () => {
    expect(outboxItem({ verdict: infoVerdict(['guests']), sourceRef: 'web:4', dealId: 3, scopeVersionId: 9, mailboxMemberId: 'u1', mode: { to: 'a@b.cz' }, footer: null }))
      .toMatchObject({ kind: 'info_request', scopeVersionId: null, mode: { to: 'a@b.cz' } })
    expect(() => outboxItem({ verdict: { ...offerVerdict(), kind: 'escalate' }, sourceRef: 'web:4', dealId: 3, scopeVersionId: null, mailboxMemberId: 'u1', mode: { to: 'a@b.cz' }, footer: null })).toThrow()
  })

  it('schránka a režim: lead_owner vs. receiving_mailbox; vlákno jen ze stejné schránky', () => {
    expect(replyMailboxMember('lead_owner', 'ceo', 'cso')).toBe('cso')
    expect(replyMailboxMember('receiving_mailbox', 'ceo', 'cso')).toBe('ceo')
    expect(replyMailboxMember('receiving_mailbox', null, 'cso')).toBe('cso')
    expect(replyMode({ senderMemberId: 'cso', receivingMemberId: 'cso', gmailMessageId: 'g1', replyAddress: 'a@b.cz' })).toEqual({ reply: 'g1' })
    expect(replyMode({ senderMemberId: 'cso', receivingMemberId: 'ceo', gmailMessageId: 'g1', replyAddress: 'a@b.cz' })).toEqual({ to: 'a@b.cz' })
  })

  it('chybějící RPC (P3 nenasazený) se pozná podle kódu', () => {
    expect(isRpcMissing({ code: 'PGRST202' })).toBe(true)
    expect(isRpcMissing({ code: '42883' })).toBe(true)
    expect(isRpcMissing({ code: '23505' })).toBe(false)
  })
})

describe('výpadek modelu a odklad', () => {
  const httpErr = (status: number, msg = `Anthropic API error ${status}`) => Object.assign(new Error(msg), { status })
  it('dočasné chyby: 429, 5xx, 529, kredit, timeout, chybějící klíč', () => {
    expect(isTransientModelError(httpErr(429))).toBe(true)
    expect(isTransientModelError(httpErr(529, 'Anthropic API error 529 (overloaded_error)'))).toBe(true)
    expect(isTransientModelError(httpErr(400, 'Anthropic API error 400 (billing)'))).toBe(true)
    expect(isTransientModelError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true)
    expect(isTransientModelError(new Error('ANTHROPIC_API_KEY is not set'))).toBe(true)
    expect(isTransientModelError(httpErr(400, 'Anthropic API error 400 (invalid_request_error)'))).toBe(false)
    expect(isTransientModelError(new Error('Odpověď modelu není platný JSON'))).toBe(false)
  })
  it('backoff 15 min → nejvýš 6 h', () => {
    expect([1, 2, 3, 10].map(retryDelaySeconds)).toEqual([900, 1800, 3600, 21_600])
  })
  it('začátek pražského dne (zima UTC+1, léto UTC+2)', () => {
    expect(pragueDayStartIso('2026-11-05', 'Europe/Prague')).toBe('2026-11-04T23:00:00.000Z')
    expect(pragueDayStartIso('2026-07-01', 'Europe/Prague')).toBe('2026-06-30T22:00:00.000Z')
  })
})

describe('schránky a předfiltr', () => {
  const NOW = new Date('2026-11-05T10:00:00Z')
  const ctx = {
    mailbox: 'obchod@mummiesdaddies.com', companyDomains: ['mummiesdaddies.com'], inquiryAddresses: ['info@mummiesdaddies.com'],
    automatedDomains: ['mailchimp.com'], maxAgeDays: 3, now: NOW,
  }
  const msg = (headers: Record<string, string>, over: Partial<GmailMetaLike> = {}): GmailMetaLike => ({
    id: 'g1', threadId: 't1', labelIds: ['INBOX'], receivedAt: '2026-11-05T08:00:00.000Z',
    headers: Object.entries({ From: 'Jana <jana@seznam.cz>', 'Message-ID': '<a@b>', ...headers }).map(([name, value]) => ({ name, value })),
    ...over,
  })

  it('env schránek: jen platné adresy, bez duplicit', () => {
    expect(inquiryMailboxesFromEnv({ INQUIRY_AGENT_MAILBOXES: ' Obchod@Firma.cz, x, obchod@firma.cz,info@firma.cz ' })).toEqual(['obchod@firma.cz', 'info@firma.cz'])
    expect(mailboxConnectorKey('A@B.cz', () => 'abcdef0123456789ffff')).toBe('gmail:inquiry:abcdef0123456789')
  })

  it('freemail (B2C) projde; do fronty jen identifikátory', () => {
    expect(screenInboundMessage(msg({}), ctx)).toEqual({ ok: true, candidate: { internetMessageId: '<a@b>', gmailMessageId: 'g1', threadId: 't1', receivedAt: '2026-11-05T08:00:00.000Z' } })
  })

  it('vyřadí odeslané/spam, interní, automaty, hromadné a staré zprávy', () => {
    expect(screenInboundMessage(msg({}, { labelIds: ['SENT'] }), ctx)).toEqual({ ok: false, reason: 'not_inbox' })
    expect(screenInboundMessage(msg({}, { labelIds: ['INBOX', 'SPAM'] }), ctx)).toEqual({ ok: false, reason: 'not_inbox' })
    expect(screenInboundMessage(msg({ From: 'Kolega <ceo@mummiesdaddies.com>' }), ctx)).toEqual({ ok: false, reason: 'internal' })
    expect(screenInboundMessage(msg({ From: 'noreply@shop.cz' }), ctx)).toEqual({ ok: false, reason: 'automated' })
    expect(screenInboundMessage(msg({ From: 'akce@news.mailchimp.com' }), ctx)).toEqual({ ok: false, reason: 'automated' })
    expect(screenInboundMessage(msg({ 'Auto-Submitted': 'auto-replied' }), ctx)).toEqual({ ok: false, reason: 'automated' })
    expect(screenInboundMessage(msg({ 'List-Unsubscribe': '<mailto:x@y>' }), ctx)).toEqual({ ok: false, reason: 'bulk' })
    expect(screenInboundMessage(msg({}, { receivedAt: '2026-10-30T08:00:00.000Z' }), ctx)).toEqual({ ok: false, reason: 'too_old' })
  })

  it('zpráva přes skupinu info@ (List-Id, Precedence list) není hromadná pošta', () => {
    expect(listIdForAddress('info@mummiesdaddies.com')).toBe('info.mummiesdaddies.com')
    const viaGroup = msg({ 'List-Id': '<info.mummiesdaddies.com>', Precedence: 'list', 'List-Unsubscribe': '<mailto:x>' })
    expect(screenInboundMessage(viaGroup, ctx).ok).toBe(true)
  })

  it('skupina s přepisem From (zákazník v Reply-To) se nevyřadí — ověření ji pošle člověku', () => {
    const rewritten = msg({ From: "'Jana' via info <info@mummiesdaddies.com>", 'Reply-To': 'jana@seznam.cz', 'List-Id': '<info.mummiesdaddies.com>' })
    expect(screenInboundMessage(rewritten, ctx).ok).toBe(true)
    const auth = evaluateSenderAuth(rewritten.headers, 'mx.google.com')
    expect(auth.ok).toBe(false)
    expect(auth.codes).toContain('reply_to_mismatch')
  })

  it('bez Message-ID náhradní klíč bez <> (P3 ho nepoužije jako In-Reply-To)', () => {
    const m = msg({})
    const r = screenInboundMessage({ ...m, headers: m.headers.filter((h) => h.name !== 'Message-ID') }, ctx)
    expect(r.ok && r.candidate.internetMessageId).toBe('gmail:obchod@mummiesdaddies.com:g1')
  })
})
