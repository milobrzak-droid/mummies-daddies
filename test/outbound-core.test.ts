// Outbound agent (P7) — čisté funkce jádra: kvalifikace podle ICP, právní
// brána oslovení, text ze šablony jen z ověřených faktů, token odhlášení,
// signály z CRM a payload fronty. Bez sítě a bez DB.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import type { OutboundAgentConfig } from '@/core/outbound/config'
import { crmSignals, templateKeyForSignal } from '@/core/outbound/crmSignals'
import { isMissingOutboxRpc, outreachEnqueuePayload, OUTREACH_SOURCE_REF_RE } from '@/core/outbound/outbox'
import { consentIsComplete, decideOutreach, isWithinWindow, isWorkEmail, type OutreachInput } from '@/core/outbound/outreachPolicy'
import { checkStylizedText, manualProposal, renderOutreach, templatePlaceholders } from '@/core/outbound/outreachText'
import { qualifySignal, type QualifyContext } from '@/core/outbound/qualify'
import { matchKeywords, normalizeIco, parseSignalCandidate, signalUpsertPayload, type SignalCandidate } from '@/core/outbound/signal'
import { emailHash, unsubscribeLink, unsubscribeToken, verifyUnsubscribeToken } from '@/core/outbound/unsubscribe'

const CFG = COMPANY.capabilities.outboundAgent as OutboundAgentConfig
const SECRET = 'x'.repeat(40)

const signal = (over: Partial<SignalCandidate> = {}): SignalCandidate => ({
  source: 'vvz', kind: 'public_tender', externalRef: 'z-1', title: 'Catering na konferenci', url: 'https://example.cz/z/1',
  signalDate: '2026-12-01', company: { ico: '12345678', name: 'Firma Beta a.s.' },
  facts: [{ key: 'zakazka', value: 'Catering', sourceUrl: null }, { key: 'zadavatel', value: 'Firma Beta', sourceUrl: null }],
  ...over,
})
const ares = (over: Partial<NonNullable<QualifyContext['ares']>> = {}): QualifyContext['ares'] => ({
  ico: '12345678', legalName: 'Firma Beta a.s.', city: 'Praha', region: 'Hlavní město Praha', nace: ['62010'], ...over,
})
const crm = (over: Partial<QualifyContext['crm']> = {}): QualifyContext['crm'] => ({
  accountId: null, relationship: null, optedOut: false, recentlyContacted: false, ...over,
})

describe('kvalifikace signálu', () => {
  test('ověřená pražská firma z veřejné zakázky → lead', () => {
    const r = qualifySignal(signal(), { ares: ares({ employees: 50 }), crm: crm() }, CFG)
    expect(r.decision).toBe('converted')
    expect(r.score).toBeGreaterThanOrEqual(CFG.scoring.leadThreshold)
    expect(r.reasons).toEqual(expect.arrayContaining(['company_verified', 'region_match', 'size_ok']))
  })

  test('vyloučené IČO, obor konkurence nebo nesouhlas → blocked bez ohledu na skóre', () => {
    const cfg = { ...CFG, icp: { ...CFG.icp, excludedIcos: ['12345678'] } }
    expect(qualifySignal(signal(), { ares: ares(), crm: crm() }, cfg)).toMatchObject({ decision: 'blocked', reasons: ['excluded_company'] })
    expect(qualifySignal(signal(), { ares: ares({ nace: ['56210'] }), crm: crm() }, CFG).decision).toBe('blocked')
    expect(qualifySignal(signal(), { ares: ares(), crm: crm({ optedOut: true }) }, CFG).reasons).toContain('opted_out')
    expect(qualifySignal(signal({ company: { ico: null, name: 'Gastro Servis s.r.o.' } }), { ares: null, crm: crm() }, CFG).reasons).toContain('excluded_name')
  })

  test('rozjednaný obchod a nedávné oslovení → dismiss', () => {
    expect(qualifySignal(signal(), { ares: ares(), crm: crm({ relationship: 'aktivni_obchod' }) }, CFG)).toMatchObject({ decision: 'dismiss', reasons: ['open_deal'] })
    expect(qualifySignal(signal(), { ares: ares(), crm: crm({ recentlyContacted: true }) }, CFG)).toMatchObject({ decision: 'dismiss', reasons: ['cooldown'] })
  })

  test('nejasné (neznámá firma, mimo region, OSVČ) → nanejvýš review', () => {
    const unknown = qualifySignal(signal({ company: { ico: null, name: 'Někdo' } }), { ares: null, crm: crm() }, CFG)
    expect(unknown.decision).toBe('review')
    expect(unknown.reasons).toContain('company_unknown')
    const brno = qualifySignal(signal(), { ares: ares({ city: 'Brno', region: 'Jihomoravský kraj', employees: 500 }), crm: crm() }, CFG)
    expect(brno.decision).not.toBe('converted')
    expect(brno.reasons).toContain('region_outside')
    const osvc = qualifySignal(signal(), { ares: ares({ legalFormCode: '101', employees: 50 }), crm: crm() }, CFG)
    expect(osvc.decision).toBe('review')
    expect(osvc.reasons).toContain('natural_person')
  })

  test('slabý signál bez faktů → dismiss s low_relevance', () => {
    const r = qualifySignal(signal({ kind: 'job_posting', facts: [] }), { ares: ares({ city: 'Ostrava', region: 'Moravskoslezský kraj', employees: 3 }), crm: crm() }, CFG)
    expect(r.decision).toBe('dismiss')
    expect(r.reasons).toContain('low_relevance')
  })
})

const base: OutreachInput = {
  isExistingCustomer: true, similarService: true, consent: null, email: 'lucie@beta.cz', optedOut: false, vip: false, sensitive: false,
  templateAvailable: true, autosendEnabled: true, withinWindow: true, sentToday: 0, dailyLimit: 10,
}

describe('právní brána oslovení', () => {
  test('stávající zákazník u obdobné služby, pracovní adresa → auto e-mail', () => {
    expect(decideOutreach(base)).toEqual({ channel: 'auto_email', basis: 'existing_customer', reasons: ['existing_customer'] })
  })

  test('nová firma bez souhlasu → jen návrh pro člověka, nikdy e-mail', () => {
    const r = decideOutreach({ ...base, isExistingCustomer: false, similarService: false })
    expect(r).toEqual({ channel: 'manual', basis: 'none', reasons: ['no_legal_basis'] })
  })

  test('stávající zákazník, ale jiná než obdobná služba → manual', () => {
    expect(decideOutreach({ ...base, similarService: false })).toMatchObject({ channel: 'manual', reasons: ['not_similar_service'] })
  })

  test('souhlas jen doložený (znění, verze, čas, zdroj) a neodvolaný', () => {
    const consent = { wording: 'Souhlasím se zasíláním nabídek.', wordingVersion: 'v1', grantedAt: '2026-01-01T00:00:00Z', source: 'event', withdrawnAt: null }
    const noCustomer = { ...base, isExistingCustomer: false, similarService: false }
    expect(decideOutreach({ ...noCustomer, consent })).toMatchObject({ channel: 'auto_email', basis: 'consent' })
    expect(decideOutreach({ ...noCustomer, consent: { ...consent, wordingVersion: '' } })).toMatchObject({ channel: 'manual', reasons: ['consent_incomplete'] })
    expect(decideOutreach({ ...noCustomer, consent: { ...consent, withdrawnAt: '2026-02-01T00:00:00Z' } })).toMatchObject({ channel: 'manual', reasons: ['consent_withdrawn'] })
    expect(consentIsComplete(null)).toBe(false)
  })

  test('odhlášení má přednost před vším', () => {
    expect(decideOutreach({ ...base, optedOut: true })).toMatchObject({ channel: 'none', reasons: ['opted_out'] })
  })

  test('freemail a chybějící e-mail → manual (B2B jen na pracovní adresy)', () => {
    expect(decideOutreach({ ...base, email: 'jana@seznam.cz' })).toMatchObject({ channel: 'manual', reasons: ['freemail'] })
    expect(decideOutreach({ ...base, email: null })).toMatchObject({ channel: 'manual', reasons: ['no_email'] })
    expect(isWorkEmail('a@firma.cz')).toBe(true)
    expect(isWorkEmail('a@gmail.com')).toBe(false)
  })

  test('VIP, citlivý kontakt a vypnuté samostatné odeslání → koncept ke schválení', () => {
    expect(decideOutreach({ ...base, vip: true }).channel).toBe('review_email')
    expect(decideOutreach({ ...base, sensitive: true }).channel).toBe('review_email')
    expect(decideOutreach({ ...base, autosendEnabled: false })).toMatchObject({ channel: 'review_email', reasons: ['existing_customer', 'autosend_off'] })
  })

  test('okno a denní limit → počkat', () => {
    expect(decideOutreach({ ...base, withinWindow: false }).channel).toBe('wait')
    expect(decideOutreach({ ...base, sentToday: 10 })).toMatchObject({ channel: 'wait', reasons: ['existing_customer', 'daily_limit'] })
  })

  test('okno odesílání v pražském čase (Út–Čt 9–16)', () => {
    const w = CFG.outreach.sendWindow
    expect(isWithinWindow(new Date('2026-11-10T09:30:00Z'), w, COMPANY.timeZone)).toBe(true) // út 10:30
    expect(isWithinWindow(new Date('2026-11-10T15:30:00Z'), w, COMPANY.timeZone)).toBe(false) // út 16:30
    expect(isWithinWindow(new Date('2026-11-09T10:00:00Z'), w, COMPANY.timeZone)).toBe(false) // pondělí
  })
})

describe('text oslovení', () => {
  const tpl = { subject: 'Pro {firma}', body: 'Dobrý den, {firma} — akce {posledni_akce_datum}.' }
  const facts = [{ key: 'firma', value: 'Beta {a.s.}', sourceUrl: null }, { key: 'posledni_akce_datum', value: '11. 12. 2025', sourceUrl: null }]

  test('doplní jen ověřená fakta a vždy přidá patičku s odhlášením', () => {
    const r = renderOutreach(tpl, facts, { footer: 'Firma s.r.o.', unsubscribeLink: 'https://x.cz/o?t=abc' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.subject).toBe('Pro Beta a.s.')
    expect(r.text).toContain('akce 11. 12. 2025')
    expect(r.text).toContain('Firma s.r.o.')
    expect(r.text).toContain('https://x.cz/o?t=abc')
  })

  test('chybějící fakt → text nevznikne (nic se nedomýšlí)', () => {
    expect(renderOutreach(tpl, facts.slice(0, 1), { footer: 'F', unsubscribeLink: 'u' })).toEqual({ ok: false, missing: ['posledni_akce_datum'] })
    expect(templatePlaceholders(tpl)).toEqual(['firma', 'posledni_akce_datum'])
  })

  test('stylizace modelem nesmí přidat čísla, odkazy ani zahodit odhlášení', () => {
    const orig = 'Akce 11. 12. 2025 pro 40 hostů. Odhlásit: https://x.cz/o?t=abc'
    expect(checkStylizedText(orig, 'Vaše akce 11. 12. 2025 pro 40 hostů byla skvělá. Odhlásit: https://x.cz/o?t=abc', 'https://x.cz/o?t=abc')).toBe(true)
    expect(checkStylizedText(orig, 'Akce pro 60 hostů se slevou 20 %. https://x.cz/o?t=abc', 'https://x.cz/o?t=abc')).toBe(false)
    expect(checkStylizedText(orig, 'Akce 11. 12. 2025 pro 40 hostů.', 'https://x.cz/o?t=abc')).toBe(false)
    expect(checkStylizedText(orig, 'Akce 11. 12. 2025 pro 40 hostů, pište na info@jinde.cz https://x.cz/o?t=abc', 'https://x.cz/o?t=abc')).toBe(false)
  })

  test('ruční návrh nese fakta a důvod, proč se e-mail neposílá', () => {
    const p = manualProposal({ kindLabel: 'Veřejná zakázka', title: 'Catering', url: 'https://z.cz', companyName: 'Beta', facts, reasonLabel: 'nová firma bez souhlasu' })
    expect(p.subject).toBe('Oslovit: Beta')
    expect(p.body).toContain('E-mail se neposílá: nová firma bez souhlasu.')
    expect(p.body).toContain('Zdroj: https://z.cz')
  })
})

describe('odhlášení', () => {
  test('token: otisk a id, ověření v konstantním čase, podvrh neprojde', () => {
    const hash = emailHash(' Lucie@Beta.CZ ')
    expect(hash).toBe(emailHash('lucie@beta.cz'))
    const t = unsubscribeToken({ emailHash: hash, outreachId: 42 }, SECRET)
    expect(t).not.toContain('lucie')
    expect(verifyUnsubscribeToken(t, SECRET)).toEqual({ emailHash: hash, outreachId: 42 })
    expect(verifyUnsubscribeToken(t, 'y'.repeat(40))).toBeNull()
    expect(verifyUnsubscribeToken(`${t}x`, SECRET)).toBeNull()
    expect(verifyUnsubscribeToken(t, undefined)).toBeNull()
    expect(verifyUnsubscribeToken('a.b.c', SECRET)).toBeNull()
    expect(() => unsubscribeToken({ emailHash: hash, outreachId: 1 }, 'kratke')).toThrow()
    expect(unsubscribeLink('https://x.cz/o', 'a.b')).toBe('https://x.cz/o?t=a.b')
  })
})

describe('signály z CRM', () => {
  const acc = { accountId: 7, name: 'Firma Alfa s.r.o.', ico: '11111111', lastEventDate: '2025-12-11', lastEventTitle: 'Vánoční večírek', hasOpenDeal: false }

  test('výročí poslední akce v okně před rokem', () => {
    const s = crmSignals([acc], '2026-11-05', CFG)
    expect(s.map((x) => x.externalRef)).toEqual(['anniv:7:2026'])
    expect(s[0].facts.map((f) => f.key)).toEqual(['firma', 'posledni_akce_datum', 'posledni_akce'])
    expect(crmSignals([acc], '2026-12-11', CFG)).toEqual([])
  })

  test('sezóna (vánoční večírky v září–říjnu), ne pro rozjednané', () => {
    const s = crmSignals([acc], '2026-09-15', CFG)
    expect(s.map((x) => x.externalRef)).toEqual(['season:vanoce:7:2026'])
    expect(templateKeyForSignal(s[0], CFG)).toBe('vanoce_klient')
    expect(crmSignals([{ ...acc, hasOpenDeal: true }], '2026-09-15', CFG)).toEqual([])
    expect(crmSignals([{ ...acc, lastEventDate: null }], '2026-09-15', CFG)).toEqual([])
  })
})

describe('signál a fronta', () => {
  test('nedůvěryhodný kandidát se ověří, payload je snake_case', () => {
    expect(parseSignalCandidate({ ...signal(), url: 'javascript:alert(1)' })).toBeNull()
    expect(parseSignalCandidate({ ...signal(), company: { ico: '123', name: null } })).toBeNull()
    expect(signalUpsertPayload(signal())).toMatchObject({ source: 'vvz', external_ref: 'z-1', ico: '12345678', facts: [{ key: 'zakazka', value: 'Catering', source_url: null }, expect.anything()] })
    expect(normalizeIco('64581')).toBe('00064581')
    expect(normalizeIco('CZ123')).toBeNull()
    expect(matchKeywords('Zajištění Občerstvení pro účastníky', ['obcerstveni', 'raut'])).toEqual(['obcerstveni'])
  })

  test('payload fronty: kind outreach, source_ref outreach:<id>, nová zpráva a hlavičky odhlášení', () => {
    const p = outreachEnqueuePayload({ outreachId: 5, dealId: 9, mailboxMemberId: 'm', to: 'a@b.cz', subject: 'S', text: 'T', listUnsubscribeUrl: 'https://x.cz/o?t=1' })
    expect(p).toMatchObject({ kind: 'outreach', source_ref: 'outreach:5', deal_id: 9, mode: { to: 'a@b.cz' } })
    expect(OUTREACH_SOURCE_REF_RE.test(p.source_ref as string)).toBe(true)
    expect(p.headers).toEqual({ 'List-Unsubscribe': '<https://x.cz/o?t=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' })
    expect(isMissingOutboxRpc({ code: 'PGRST202' })).toBe(true)
    expect(isMissingOutboxRpc({ code: '23505' })).toBe(false)
  })
})

describe('konfigurace firmy', () => {
  test('šablony existují pro sezóny i výročí a používají jen fakta z CRM', () => {
    const crmKeys = new Set(['firma', 'posledni_akce_datum', 'posledni_akce', 'sezona'])
    const used = [CFG.sources.crm.anniversaryTemplate, ...CFG.sources.crm.seasons.map((s) => s.template)]
    for (const k of used) {
      const t = CFG.outreach.templates[k]
      expect(t, k).toBeDefined()
      expect(t.audience).toBe('existing_customer')
      for (const p of templatePlaceholders(t)) expect(crmKeys.has(p), `${k}: {${p}}`).toBe(true)
    }
  })

  test('odesílá se z oddělené schránky na subdoméně, odhlášení míří na webovou routu', () => {
    const domain = CFG.outreach.senderMailboxEmail.split('@')[1]
    expect(domain).not.toBe(COMPANY.emailDomain)
    expect(domain.endsWith(`.${COMPANY.emailDomain}`)).toBe(true)
    expect(CFG.outreach.unsubscribeUrl).toMatch(/^https:\/\/.+\/api\/web\/odhlaseni$/)
    expect(CFG.outreach.footer.trim().length).toBeGreaterThan(10)
    expect(COMPANY.nodes as readonly string[]).toContain(CFG.reviewNode)
    expect(COMPANY.pillars.map((p) => p.key) as string[]).toContain(CFG.icp.pillar)
    expect(CFG.scoring.reviewThreshold).toBeLessThan(CFG.scoring.leadThreshold)
  })
})
