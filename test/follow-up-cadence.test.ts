// Follow-up cadence — čistá rozhodovací funkce (domain/crm/followUpCadence.ts):
// pořadí kroků, stop pravidla, maxAttempts, okno odesílání, denní limit,
// idempotence nad existujícími pokusy a kontrola nastavení.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import {
  renderFollowUpTemplate,
  templatePlaceholders,
  validateFollowUpCadence,
  type FollowUpCadenceConfig,
} from '@/core/followUpCadence'
import {
  czechDate,
  exhaustionDay,
  inSendWindow,
  lostReasonText,
  planFollowUpSends,
  safeFirstName,
  type CadenceAction,
  type CadenceAttempt,
  type CadenceDeal,
  type CadenceFacts,
  type CadencePlanInput,
} from '@/domain/crm/followUpCadence'

const CFG = COMPANY.capabilities.followUpCadence!
const OWNER = 'b1111111-1111-4111-8111-111111111111'

// Nabídka odeslaná v pondělí 2. 11. 2026 v 10:00 Praha (CET = UTC+1).
const OFFER_SENT = '2026-11-02T09:00:00Z'
// Čtvrtek 5. 11. 2026 10:00 Praha = 3 pracovní dny po nabídce.
const THU_10 = new Date('2026-11-05T09:00:00Z')

const deal = (over: Partial<CadenceDeal> = {}): CadenceDeal => ({
  id: 1,
  title: 'Vánoční večírek 120 hostů',
  stage: 'rozsah_nabidka',
  pillar: 'b2b_akce',
  phase: 'nabidka',
  owner_id: OWNER,
  account_id: 10,
  primary_contact_id: 100,
  next_step_due: null,
  contact: { id: 100, full_name: 'Karel Ukázkový', email: 'Karel@Alfa.example', do_not_contact: false, notes: null },
  account: { id: 10, notes: null, snooze_until: null },
  ...over,
})

const facts = (over: Partial<CadenceFacts> = {}): CadenceFacts => ({
  deal_id: 1,
  last_inbound_at: '2026-10-30T08:00:00Z', // samotná poptávka, před nabídkou
  last_outbound_at: OFFER_SENT,
  last_human_activity_at: null,
  offer_sent_at: OFFER_SENT,
  contact_do_not_contact: false,
  account_contacts: 1,
  account_opted_out: 0,
  event_date: '2026-12-11',
  ...over,
})

const enq = (attempt: number, at: string, dealId = 1): CadenceAttempt =>
  ({ deal_id: dealId, attempt, status: 'enqueued', planned_on: at.slice(0, 10), enqueued_at: at })

function plan(over: Partial<CadencePlanInput> & { deal?: Partial<CadenceDeal>; fact?: Partial<CadenceFacts> } = {}): CadenceAction {
  const { deal: d, fact: f, ...rest } = over
  const actions = planFollowUpSends({
    deals: [deal(d)],
    attempts: [],
    facts: [facts(f)],
    enqueuedToday: 0,
    now: THU_10,
    cfg: CFG,
    wonPhases: COMPANY.wonPhases,
    ...rest,
  })
  expect(actions).toHaveLength(1)
  return actions[0]
}

describe('pořadí kroků', () => {
  test('1. připomínka přesně 3 pracovní dny po nabídce, šablona pripominka_1', () => {
    const a = plan()
    expect(a).toMatchObject({
      kind: 'send', deal_id: 1, attempt: 1, template: 'pripominka_1', existing: false,
      source_ref: 'followup:1:1', to: 'karel@alfa.example', mailbox_member_id: OWNER,
      subject: CFG.templates.pripominka_1.subject,
      // Další krok: +5 pracovních dnů od dneška (čt 5. 11. → čt 12. 11.).
      next_due: '2026-11-12',
    })
    if (a.kind !== 'send') throw new Error()
    expect(a.text).toContain('Vánoční večírek 120 hostů')
    expect(a.text).toContain('11. 12. 2026')
    expect(a.text).not.toMatch(/\{(jmeno|akce|datum)\}/)
  })

  test('den předem ještě ne (not_due)', () => {
    expect(plan({ now: new Date('2026-11-04T09:00:00Z') })).toEqual({ kind: 'skip', deal_id: 1, reason: 'not_due' })
  })

  test('2. připomínka 5 pracovních dnů po zařazení první (přes svátek 17. 11.)', () => {
    const attempts = [enq(1, '2026-11-12T09:00:00Z')]
    // čt 12. 11. + 5 prac. dnů: pá 13., po 16., (út 17. svátek), st 18., čt 19., pá 20.
    expect(plan({ attempts, now: new Date('2026-11-19T09:00:00Z') })).toMatchObject({ kind: 'skip', reason: 'not_due' })
    const a = plan({ attempts, now: new Date('2026-11-20T09:00:00Z') })
    expect(a).toMatchObject({ kind: 'send', attempt: 2, template: 'pripominka_2', source_ref: 'followup:1:2' })
    // Po poslední připomínce: čeká se ještě 5 pracovních dnů (pá 20. 11. → pá 27. 11.).
    expect(a.kind === 'send' && a.next_due).toBe('2026-11-27')
  })

  test('víc pokusů než kroků opakuje poslední krok', () => {
    const cfg: FollowUpCadenceConfig = { ...CFG, maxAttempts: 3 }
    const attempts = [enq(1, '2026-11-12T09:00:00Z'), enq(2, '2026-11-20T09:00:00Z')]
    const a = plan({ cfg, attempts, now: new Date('2026-11-27T09:00:00Z') })
    expect(a).toMatchObject({ kind: 'send', attempt: 3, template: 'pripominka_2' })
  })

  test('kotva bez odeslané verze nabídky = poslední odchozí e-mail; bez obou se nic neděje', () => {
    expect(plan({ fact: { offer_sent_at: null } })).toMatchObject({ kind: 'send', attempt: 1 })
    expect(plan({ fact: { offer_sent_at: null, last_outbound_at: null } })).toMatchObject({ kind: 'skip', reason: 'no_offer_sent' })
  })
})

describe('maxAttempts a vyčerpání', () => {
  const both = [enq(1, '2026-11-12T09:00:00Z'), enq(2, '2026-11-20T09:00:00Z')]

  test('po vyčerpání čeká poslední interval, pak exhausted s pořadím max + 1', () => {
    expect(plan({ attempts: both, now: new Date('2026-11-26T09:00:00Z') })).toMatchObject({ kind: 'skip', reason: 'waiting_exhaustion' })
    expect(plan({ attempts: both, now: new Date('2026-11-27T09:00:00Z') })).toEqual({
      kind: 'exhausted', deal_id: 1, attempt: 3, on_exhausted: 'case', escalate_due: '2026-11-24',
    })
  })

  test('vyčerpání se zapíše i mimo okno odesílání (sobota)', () => {
    expect(plan({ attempts: both, now: new Date('2026-11-28T20:00:00Z') })).toMatchObject({ kind: 'exhausted' })
  })

  test('odstup vyčerpání je aspoň 5 kalendářních dnů (hlídač by jinak mlčel)', () => {
    const cfg: FollowUpCadenceConfig = { ...CFG, steps: [{ afterBusinessDays: 1, template: 'pripominka_1' }], maxAttempts: 1 }
    expect(exhaustionDay(cfg, '2026-11-02')).toBe('2026-11-07')
    expect(exhaustionDay(CFG, '2026-11-20')).toBe('2026-11-27')
  })

  test('onExhausted lost → důvod prohry z číselníku firmy', () => {
    const a = plan({ cfg: { ...CFG, onExhausted: 'lost' }, attempts: both, now: new Date('2026-11-27T09:00:00Z') })
    expect(a).toMatchObject({ kind: 'exhausted', on_exhausted: 'lost' })
    expect(lostReasonText('bez_odpovedi')).toBe('Bez odpovědi')
    expect(lostReasonText('neznamy', [])).toBe('neznamy')
  })

  test('ukončená cadence (stopped / exhausted) se už nehýbe', () => {
    for (const status of ['stopped', 'exhausted'] as const) {
      const attempts = [...both, { deal_id: 1, attempt: 3, status, planned_on: '2026-11-27', enqueued_at: null }]
      expect(plan({ attempts, now: new Date('2026-12-04T09:00:00Z') })).toEqual({ kind: 'skip', deal_id: 1, reason: 'finished' })
    }
  })
})

describe('stop pravidla', () => {
  type Row = [string, Parameters<typeof plan>[0], string, string]
  const rows: Row[] = [
    ['odpověď zákazníka po nabídce', { fact: { last_inbound_at: '2026-11-03T10:00:00Z' } }, 'stop', 'customer_replied'],
    ['odpověď po 1. připomínce', {
      attempts: [enq(1, '2026-11-05T09:00:00Z')], fact: { last_inbound_at: '2026-11-06T10:00:00Z' }, now: new Date('2026-11-12T09:00:00Z'),
    }, 'stop', 'customer_replied'],
    ['ruční aktivita po nabídce', { fact: { last_human_activity_at: '2026-11-03T12:00:00Z' } }, 'stop', 'manual_activity'],
    ['nesouhlas s oslovením (políčko kontaktu)', { deal: { contact: { ...deal().contact!, do_not_contact: true } } }, 'stop', 'opt_out'],
    ['nesouhlas z follow_up_facts', { fact: { contact_do_not_contact: true } }, 'stop', 'opt_out'],
    ['nesouhlas v poznámce kontaktu', { deal: { contact: { ...deal().contact!, notes: 'Prosím nekontaktovat.' } } }, 'stop', 'opt_out'],
    ['nesouhlasí všichni lidé firmy', { fact: { account_contacts: 2, account_opted_out: 2 } }, 'stop', 'opt_out'],
    ['odložená firma', { deal: { account: { id: 10, notes: null, snooze_until: '2027-01-31' } } }, 'stop', 'account_snoozed'],
    ['akce už proběhla', { fact: { event_date: '2026-11-05' } }, 'stop', 'event_passed'],
    ['prohraný obchod', { deal: { stage: 'prohráno' } }, 'skip', 'deal_closed'],
    ['vyhraná fáze', { deal: { phase: 'potvrzeno' } }, 'skip', 'deal_closed'],
    ['fáze mimo appliesToPhases', { deal: { phase: 'poptavka' } }, 'skip', 'phase_not_applicable'],
    ['chybí kontakt', { deal: { contact: null, primary_contact_id: null } }, 'skip', 'no_contact'],
    ['chybí e-mail', { deal: { contact: { ...deal().contact!, email: null } } }, 'skip', 'no_email'],
    ['neplatný e-mail', { deal: { contact: { ...deal().contact!, email: 'karel@' } } }, 'skip', 'no_email'],
    ['chybí vlastník (schránka)', { deal: { owner_id: null } }, 'skip', 'no_owner'],
    ['chybí datum akce pro šablonu', { fact: { event_date: null } }, 'skip', 'template_data_missing'],
    ['otevřený případ hlídače', { activeCaseDealIds: new Set([1]) }, 'skip', 'case_open'],
    ['mimo okno: 8:00 Praha', { now: new Date('2026-11-05T07:00:00Z') }, 'skip', 'outside_window'],
    ['mimo okno: 17:00 Praha', { now: new Date('2026-11-05T16:00:00Z') }, 'skip', 'outside_window'],
    ['mimo okno: sobota', { now: new Date('2026-11-07T09:00:00Z') }, 'skip', 'outside_window'],
    ['mimo okno: státní svátek (út 17. 11.)', { now: new Date('2026-11-17T09:00:00Z') }, 'skip', 'outside_window'],
    ['denní limit vyčerpaný', { enqueuedToday: CFG.dailyLimit }, 'skip', 'daily_limit'],
  ]

  test.each(rows)('%s → %s %s', (_name, over, kind, reason) => {
    const a = plan(over)
    expect(a.kind).toBe(kind)
    expect('reason' in a ? a.reason : null).toBe(reason)
  })

  test('aktivita do hodiny po odeslání nabídky (zápis o odeslání) cadence nezastaví', () => {
    expect(plan({ fact: { last_human_activity_at: '2026-11-02T09:30:00Z' } })).toMatchObject({ kind: 'send' })
  })

  test('příchozí zpráva před nabídkou (samotná poptávka) cadence nezastaví', () => {
    expect(plan({ fact: { last_inbound_at: '2026-11-02T08:59:00Z' } })).toMatchObject({ kind: 'send' })
  })

  test('stop nad naplánovaným pokusem ho přepíše (existing), jinak založí řádek s dalším pořadím', () => {
    const planned: CadenceAttempt = { deal_id: 1, attempt: 1, status: 'planned', planned_on: '2026-11-05', enqueued_at: null }
    expect(plan({ attempts: [planned], fact: { last_inbound_at: '2026-11-05T08:00:00Z' } }))
      .toEqual({ kind: 'stop', deal_id: 1, attempt: 1, reason: 'customer_replied', existing: true })
    expect(plan({ attempts: [planned], deal: { stage: 'vyhráno' } }))
      .toEqual({ kind: 'stop', deal_id: 1, attempt: 1, reason: 'deal_closed', existing: true })
    expect(plan({ attempts: [planned], deal: { phase: 'poptavka' } }))
      .toEqual({ kind: 'stop', deal_id: 1, attempt: 1, reason: 'phase_changed', existing: true })
    expect(plan({ fact: { last_inbound_at: '2026-11-03T08:00:00Z' } }))
      .toEqual({ kind: 'stop', deal_id: 1, attempt: 1, reason: 'customer_replied', existing: false })
  })
})

describe('idempotence a denní limit', () => {
  test('naplánovaný pokus (fronta ho minule nepřijala) se zkusí znovu se stejným source_ref', () => {
    const planned: CadenceAttempt = { deal_id: 1, attempt: 1, status: 'planned', planned_on: '2026-11-05', enqueued_at: null }
    expect(plan({ attempts: [planned], now: new Date('2026-11-06T09:00:00Z') }))
      .toMatchObject({ kind: 'send', attempt: 1, existing: true, source_ref: 'followup:1:1' })
  })

  test('už zařazená připomínka se nezopakuje', () => {
    const a = plan({ attempts: [enq(1, '2026-11-05T09:00:00Z')] })
    expect(a).toEqual({ kind: 'skip', deal_id: 1, reason: 'not_due' })
  })

  test('limit dostanou nejdřív nejstarší termíny, zbytek čeká na zítřek', () => {
    const cfg: FollowUpCadenceConfig = { ...CFG, dailyLimit: 2 }
    const deals = [3, 2, 1].map((id) => deal({ id }))
    const f = [
      facts({ deal_id: 1, offer_sent_at: '2026-10-29T09:00:00Z', last_inbound_at: '2026-10-28T08:00:00Z' }), // splatné už v úterý
      facts({ deal_id: 2 }),
      facts({ deal_id: 3, offer_sent_at: '2026-10-30T09:00:00Z', last_inbound_at: '2026-10-28T08:00:00Z' }),
    ]
    const actions = planFollowUpSends({ deals, attempts: [], facts: f, enqueuedToday: 0, now: THU_10, cfg, wonPhases: COMPANY.wonPhases })
    expect(actions.map((a) => [a.deal_id, a.kind, 'reason' in a ? a.reason : null])).toEqual([
      [1, 'send', null], [2, 'skip', 'daily_limit'], [3, 'send', null],
    ])
    const again = planFollowUpSends({ deals, attempts: [], facts: f, enqueuedToday: 1, now: THU_10, cfg, wonPhases: COMPANY.wonPhases })
    expect(again.filter((a) => a.kind === 'send').map((a) => a.deal_id)).toEqual([1])
  })

  test('stejný vstup = stejný plán', () => {
    const input: CadencePlanInput = { deals: [deal()], attempts: [], facts: [facts()], enqueuedToday: 0, now: THU_10, cfg: CFG }
    expect(planFollowUpSends(input)).toEqual(planFollowUpSends(input))
  })
})

describe('okno a pomocníci', () => {
  test('okno Po–Pá 9–17 v pražském čase (letní i zimní čas)', () => {
    expect(inSendWindow(new Date('2026-07-01T07:00:00Z'), CFG.sendWindow)).toBe(true) // 9:00 CEST
    expect(inSendWindow(new Date('2026-07-01T06:59:00Z'), CFG.sendWindow)).toBe(false)
    expect(inSendWindow(new Date('2026-11-05T15:59:00Z'), CFG.sendWindow)).toBe(true) // 16:59 CET
    // Druhý denní cron v 08:05 UTC je v okně v zimě i v létě.
    expect(inSendWindow(new Date('2026-01-07T08:05:00Z'), CFG.sendWindow)).toBe(true)
    expect(inSendWindow(new Date('2026-07-07T08:05:00Z'), CFG.sendWindow)).toBe(true)
  })

  test('oslovení jen bezpečným jménem', () => {
    expect(safeFirstName('Karel Ukázkový')).toBe('Karel')
    expect(safeFirstName('<script>')).toBeNull()
    expect(safeFirstName('')).toBeNull()
    expect(czechDate('2026-12-11')).toBe('11. 12. 2026')
  })
})

describe('nastavení a šablony (core)', () => {
  test('nastavení firmy je platné', () => {
    expect(validateFollowUpCadence(CFG, { lostReasonKeys: COMPANY.lostReasons!.map((r) => r.key) })).toEqual([])
  })

  test('chyby nastavení se najdou', () => {
    const bad: FollowUpCadenceConfig = {
      ...CFG,
      appliesToPhases: [],
      steps: [{ afterBusinessDays: 0, template: 'neni' }],
      maxAttempts: 0,
      dailyLimit: 0,
      sendWindow: { days: [0, 1, 1], fromHour: 17, toHour: 9 },
      onExhausted: 'lost',
      lostReasonKey: 'xyz',
      templates: { a: { subject: 'Ahoj\n', body: 'Text {telefon}' } },
    }
    expect(validateFollowUpCadence(bad, { lostReasonKeys: ['cena'] })).toHaveLength(10)
  })

  test('šablona s chybějící hodnotou neodejde', () => {
    expect(templatePlaceholders('{a} {b} {a}')).toEqual(['a', 'b'])
    expect(renderFollowUpTemplate({ subject: 'S', body: 'Dne {datum}' }, { datum: null })).toEqual({ ok: false, missing: ['datum'] })
    expect(renderFollowUpTemplate({ subject: '{jmeno}', body: 'x' }, { jmeno: 'Karel' })).toEqual({ ok: true, subject: 'Karel', body: 'x' })
  })
})
