// Pravidla odchozí fronty (core/agents/outboxPolicy.ts): brány pravomoci,
// stop pravidla, ověření odesílatele, limity, okno a text zprávy.
import { describe, expect, test } from 'vitest'
import {
  autoSendOutboxKinds,
  customerText,
  decideOutbox,
  isAutomatedAddress,
  isIllustrativeMapVersion,
  isOwnAddress,
  isVipAddress,
  isWithinWindow,
  outboxLimits,
  parseSingleMailbox,
  replyTarget,
  verifySenderAuth,
  type OutboxFacts,
  type OutboxGates,
  type OutboxItemView,
} from '@/core/agents/outboxPolicy'

const ITEM: OutboxItemView = { kind: 'offer', priceMapVersion: 'v2027-01', quoteTotal: 20_000, humanApproved: false, bodyPurged: false, ageHours: 1 }
const FACTS: OutboxFacts = {
  recipient: 'karel@alfa.example', replyProblems: [], ownAddress: false, automatedRecipient: false, doNotContact: false,
  dealClosed: false, versionIsDraft: true, mailboxActive: true, customerReplied: false, humanActivity: false, snoozed: false, vip: false,
}
const GATES: OutboxGates = {
  autoSendEnabled: true, autonomyGranted: true, companyMapVersion: 'v2027-01', autoSendKinds: ['offer', 'info_request', 'follow_up'],
  autoSendMaxTotal: 30_000, maxQueueAgeHours: 72, withinSendWindow: null,
}
const decide = (i: Partial<OutboxItemView> = {}, f: Partial<OutboxFacts> = {}, g: Partial<OutboxGates> = {}) =>
  decideOutbox({ ...ITEM, ...i }, { ...FACTS, ...f }, { ...GATES, ...g })

describe('brány pravomoci', () => {
  test('všechny brány splněné → samostatné odeslání', () => {
    expect(decide()).toEqual({ action: 'send', autonomous: true })
  })

  test.each([
    ['vypnutý přepínač', {}, {}, { autoSendEnabled: false }, 'autosend_disabled'],
    ['bez L4', {}, {}, { autonomyGranted: false }, 'authority_not_l4'],
    ['ilustrační mapa firmy', {}, {}, { companyMapVersion: 'ilustracni-2026-11' }, 'illustrative_map'],
    ['ilustrační mapa nabídky', { priceMapVersion: 'ilustracni-2026-11' }, {}, {}, 'illustrative_map'],
    ['druh mimo povolené', {}, {}, { autoSendKinds: ['info_request'] }, 'kind_not_allowed'],
    ['nad limitem částky', { quoteTotal: 30_001 }, {}, {}, 'over_auto_send_limit'],
    ['nabídka bez částky', { quoteTotal: null }, {}, {}, 'over_auto_send_limit'],
    ['VIP kontakt', {}, { vip: true }, {}, 'vip_contact'],
    ['zásah člověka', {}, { humanActivity: true }, {}, 'human_activity'],
    ['zastaralá zpráva', { ageHours: 73 }, {}, {}, 'queue_expired'],
    ['odložený obchod', {}, { snoozed: true }, {}, 'snoozed'],
  ] as const)('%s → žádost o schválení', (_n, i, f, g, reason) => {
    const d = decide(i, f, g)
    expect(d.action).toBe('request_approval')
    if (d.action === 'request_approval') expect(d.reasons).toContain(reason)
  })

  test('ilustrační mapa NIKDY nevede na samostatné odeslání, ani u doptání a připomínky', () => {
    for (const kind of ['offer', 'info_request', 'follow_up'] as const) {
      const d = decide({ kind, priceMapVersion: null }, {}, { companyMapVersion: 'ilustracni-2026-11' })
      expect(d).not.toEqual({ action: 'send', autonomous: true })
    }
    expect(isIllustrativeMapVersion('ilustracni-2026-11')).toBe(true)
    expect(isIllustrativeMapVersion('Ilustracni')).toBe(true)
    expect(isIllustrativeMapVersion('2027-01')).toBe(false)
    expect(isIllustrativeMapVersion(null)).toBe(false)
  })

  test('schválená člověkem: odejde bez bran pravomoci, stop pravidla platí dál', () => {
    expect(decide({ humanApproved: true }, {}, { autoSendEnabled: false, autonomyGranted: false, companyMapVersion: 'ilustracni-x' }))
      .toEqual({ action: 'send', autonomous: false })
    expect(decide({ humanApproved: true }, { doNotContact: true })).toEqual({ action: 'block', reason: 'do_not_contact' })
  })
})

describe('stop pravidla', () => {
  test.each([
    ['text po retenci', { bodyPurged: true }, {}, 'body_purged'],
    ['bez příjemce', {}, { recipient: null }, 'missing_recipient'],
    ['vlastní adresa', {}, { ownAddress: true }, 'own_address'],
    ['automat', {}, { automatedRecipient: true }, 'automated_recipient'],
    ['nesouhlas s oslovením', {}, { doNotContact: true }, 'do_not_contact'],
    ['uzavřený obchod', {}, { dealClosed: true }, 'deal_closed'],
    ['verze už není koncept', {}, { versionIsDraft: false }, 'version_not_draft'],
    ['neaktivní schránka', {}, { mailboxActive: false }, 'mailbox_inactive'],
    ['jiné Reply-To', {}, { replyProblems: ['reply_to_mismatch'] }, 'reply_to_mismatch'],
    ['neověřený odesílatel', {}, { replyProblems: ['sender_not_verified'] }, 'sender_not_verified'],
    ['nečitelné From', {}, { replyProblems: ['from_invalid'], recipient: null }, 'from_invalid'],
    ['zákazník napsal znovu', {}, { customerReplied: true }, 'customer_replied'],
  ] as const)('%s → blok', (_n, i, f, reason) => {
    expect(decide(i, f)).toEqual({ action: 'block', reason })
  })

  test('odložená připomínka se neposílá vůbec; mimo okno se čeká', () => {
    expect(decide({ kind: 'follow_up' }, { snoozed: true })).toEqual({ action: 'block', reason: 'snoozed' })
    expect(decide({ kind: 'follow_up' }, {}, { withinSendWindow: false })).toEqual({ action: 'wait', reason: 'outside_send_window' })
    expect(decide({ kind: 'follow_up' }, {}, { withinSendWindow: true })).toEqual({ action: 'send', autonomous: true })
  })
})

describe('adresy a ověření odesílatele', () => {
  test('From: jediná adresa', () => {
    expect(parseSingleMailbox('Karel Ukázkový <Karel@Alfa.example>')).toBe('karel@alfa.example')
    expect(parseSingleMailbox('"Novák, Jan" <jan@beta.example>')).toBe('jan@beta.example')
    expect(parseSingleMailbox('jan@beta.example')).toBe('jan@beta.example')
    expect(parseSingleMailbox('a@b.example, c@d.example')).toBeNull()
    expect(parseSingleMailbox('<a@b.example> <c@d.example>')).toBeNull()
    expect(parseSingleMailbox('nesmysl')).toBeNull()
  })

  const OK = 'mx.google.com; dkim=pass header.i=@alfa.example header.s=s1; spf=pass (google.com: domain of karel@alfa.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=karel@alfa.example; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=alfa.example'

  test('SPF/DKIM/DMARC jen z hlavičky našeho serveru', () => {
    expect(verifySenderAuth([OK], 'karel@alfa.example', 'mx.google.com')).toBe('pass')
    expect(verifySenderAuth([OK.replace('dmarc=pass', 'dmarc=fail')], 'karel@alfa.example', 'mx.google.com')).toBe('fail')
    // Podvržená hlavička jiného serveru se nepočítá.
    expect(verifySenderAuth([OK.replace('mx.google.com', 'evil.example')], 'karel@alfa.example', 'mx.google.com')).toBe('missing')
    // Platí PRVNÍ hlavička našeho serveru (nejnovější), ne pozdější podvržená.
    expect(verifySenderAuth([OK.replace('dmarc=pass', 'dmarc=fail'), OK], 'karel@alfa.example', 'mx.google.com')).toBe('fail')
    // DMARC pass pro jinou doménu než From.
    expect(verifySenderAuth([OK], 'karel@jina.example', 'mx.google.com')).toBe('fail')
    // Bez DMARC záznamu: zarovnané DKIM stačí, nezarovnané ne.
    const noDmarc = 'mx.google.com; dkim=pass header.i=@mail.alfa.example; spf=neutral smtp.mailfrom=bounce@esp.example'
    expect(verifySenderAuth([noDmarc], 'karel@alfa.example', 'mx.google.com')).toBe('pass')
    expect(verifySenderAuth(['mx.google.com; dkim=pass header.i=@esp.example; spf=pass smtp.mailfrom=b@esp.example'], 'karel@alfa.example', 'mx.google.com')).toBe('fail')
    expect(verifySenderAuth([], 'karel@alfa.example', 'mx.google.com')).toBe('missing')
  })

  test('odpovídá se jen na From; jiné Reply-To nebo neověřený odesílatel = problém', () => {
    expect(replyTarget({ from: 'Karel <karel@alfa.example>', replyTo: null, authResults: [OK], trustedAuthServId: 'mx.google.com' }))
      .toEqual({ recipient: 'karel@alfa.example', problems: [] })
    expect(replyTarget({ from: 'Karel <karel@alfa.example>', replyTo: 'KAREL@alfa.example', authResults: [OK], trustedAuthServId: 'mx.google.com' }).problems).toEqual([])
    expect(replyTarget({ from: 'Karel <karel@alfa.example>', replyTo: 'utok@evil.example', authResults: [OK], trustedAuthServId: 'mx.google.com' }))
      .toEqual({ recipient: 'karel@alfa.example', problems: ['reply_to_mismatch'] })
    expect(replyTarget({ from: 'Karel <karel@alfa.example>', replyTo: null, authResults: [], trustedAuthServId: 'mx.google.com' }).problems).toEqual(['sender_not_verified'])
    expect(replyTarget({ from: null, replyTo: null, authResults: [OK], trustedAuthServId: 'mx.google.com' })).toEqual({ recipient: null, problems: ['from_invalid'] })
  })

  test('vlastní doména, automaty a VIP', () => {
    expect(isOwnAddress('info@firma.example', ['firma.example'])).toBe(true)
    expect(isOwnAddress('x@mail.firma.example', ['firma.example'])).toBe(true)
    expect(isOwnAddress('x@nefirma.example', ['firma.example'])).toBe(false)
    expect(isAutomatedAddress('noreply@alfa.example')).toBe(true)
    expect(isAutomatedAddress('no-reply+x@alfa.example')).toBe(true)
    expect(isAutomatedAddress('mailer-daemon@googlemail.com')).toBe(true)
    expect(isAutomatedAddress('karel@alfa.example')).toBe(false)
    expect(isVipAddress('ceo@beta.example', ['@beta.example'])).toBe(true)
    expect(isVipAddress('jan@alfa.example', ['JAN@alfa.example'])).toBe(true)
    expect(isVipAddress('jan@alfa.example', ['@beta.example'])).toBe(false)
  })
})

describe('limity, okno a text', () => {
  test('povolené druhy z kontraktů P2 a P4', () => {
    expect(autoSendOutboxKinds(['send_offer', 'ask_info'], true)).toEqual(['offer', 'info_request', 'follow_up'])
    expect(autoSendOutboxKinds(['send_offer'], false)).toEqual(['offer'])
    expect(autoSendOutboxKinds(undefined, false)).toEqual([])
  })

  test('limity: odpovědi na poptávku sdílí denní limit agenta, připomínky mají svůj', () => {
    const inquiry = { dailyAutoSendLimit: 20, perRecipientDailyLimit: 2 }
    expect(outboxLimits('offer', inquiry, { dailyLimit: 5 })).toEqual({ dailyLimit: 20, limitKinds: ['offer', 'info_request'], perRecipientDailyLimit: 2 })
    expect(outboxLimits('follow_up', inquiry, { dailyLimit: 5 })).toEqual({ dailyLimit: 5, limitKinds: ['follow_up'], perRecipientDailyLimit: 2 })
    // Bez nastavení nic (limit 0 = claim vždy odmítne).
    expect(outboxLimits('offer', null, null).dailyLimit).toBe(0)
  })

  test('okno Po–Pá 9–17', () => {
    const w = { days: [1, 2, 3, 4, 5], fromHour: 9, toHour: 17 }
    expect(isWithinWindow({ isoWeekday: 1, hour: 9 }, w)).toBe(true)
    expect(isWithinWindow({ isoWeekday: 5, hour: 16 }, w)).toBe(true)
    expect(isWithinWindow({ isoWeekday: 5, hour: 17 }, w)).toBe(false)
    expect(isWithinWindow({ isoWeekday: 6, hour: 10 }, w)).toBe(false)
  })

  test('patička a podmínky nabídky se připojí jen jednou; doptání bez podmínek nabídky', () => {
    const cfg = { footer: '—\nIČO 00000000', offerTerms: 'Kalkulace je nezávazná.' }
    const once = customerText('offer', 'Dobrý den,\r\nnabídka.', cfg)
    expect(once).toBe('Dobrý den,\nnabídka.\n\nKalkulace je nezávazná.\n\n—\nIČO 00000000')
    expect(customerText('offer', once, cfg)).toBe(once)
    expect(customerText('info_request', 'Dobrý den.', cfg)).toBe('Dobrý den.\n\n—\nIČO 00000000')
    expect(customerText('follow_up', 'Připomínka.', cfg)).toContain('Kalkulace je nezávazná.')
  })
})
