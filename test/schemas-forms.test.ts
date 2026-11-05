import { describe, expect, test } from 'vitest'
import {
  apiKeyName, areEntityIds, contactSchema, dealPartnerSchema, engagementSchema, outreachSnoozeDays,
  partnerRegistrationSchema, partnerSchema, prospectFromDomainSchema, referenceCardSchema,
  resetPasswordSchema, subscriptionSchema, taskSchema, teamMemberId,
} from '@/lib/validation/schemas'

// Formulářová schémata z lib/validation/schemas.ts, která dosud neměla
// vlastní test: převody z FormData (řetězce, prázdná pole, checkboxy) a meze.

describe('subscriptionSchema', () => {
  const base = { account_id: '4', product: 'Copilot', mrr: '1500' }

  test('seats: prázdné pole = 1 místo, záporné neprojde', () => {
    expect(subscriptionSchema.parse({ ...base, seats: '' }).seats).toBe(1)
    expect(subscriptionSchema.parse({ ...base, seats: '25' }).seats).toBe(25)
    expect(subscriptionSchema.safeParse({ ...base, seats: '-1' }).success).toBe(false)
    expect(subscriptionSchema.safeParse({ ...base, seats: '1.5' }).success).toBe(false)
  })

  test('health_score 0–100 nebo prázdné; výchozí churn_risk low a MS dotace false', () => {
    const r = subscriptionSchema.parse({ ...base, health_score: '' })
    expect(r).toMatchObject({ health_score: null, churn_risk: 'low', is_ms_subsidized: false, deal_id: null })
    expect(subscriptionSchema.parse({ ...base, health_score: '100' }).health_score).toBe(100)
    expect(subscriptionSchema.safeParse({ ...base, health_score: '101' }).success).toBe(false)
    expect(subscriptionSchema.safeParse({ ...base, health_score: '-1' }).success).toBe(false)
    expect(subscriptionSchema.safeParse({ ...base, churn_risk: 'extreme' }).success).toBe(false)
  })

  test('checkbox "on" = true', () => {
    expect(subscriptionSchema.parse({ ...base, is_ms_subsidized: 'on' }).is_ms_subsidized).toBe(true)
  })
})

describe('engagementSchema — brány dodávky mají tři stavy', () => {
  const base = { account_id: '1', kind: 'edu', phase: 'pilot' }
  test('prázdné / chybějící = nehodnoceno (null), ne nesplněno', () => {
    const r = engagementSchema.parse({ ...base, gate_outputs_captured: '' })
    expect(r.gate_outputs_captured).toBeNull()
    expect(r.gate_pack_delivered).toBeNull()
  })
  test('on/true/yes = splněno, cokoli jiného = nesplněno', () => {
    for (const yes of ['on', 'true', 'yes', true]) {
      expect(engagementSchema.parse({ ...base, gate_peer_learning: yes }).gate_peer_learning).toBe(true)
    }
    for (const no of ['false', 'off', 'no', false]) {
      expect(engagementSchema.parse({ ...base, gate_peer_learning: no }).gate_peer_learning).toBe(false)
    }
  })
  test('fáze musí být z číselníku, druh povinný', () => {
    expect(engagementSchema.safeParse({ ...base, phase: 'hotovo' }).success).toBe(false)
    expect(engagementSchema.safeParse({ ...base, kind: '' }).success).toBe(false)
  })
  test('číselná pole z řetězců; nečíslo neprojde', () => {
    const r = engagementSchema.parse({ ...base, trained_count: '12', roi_czk_year: '1500.5', copilot_licenses: '' })
    expect(r).toMatchObject({ trained_count: 12, roi_czk_year: 1500.5, copilot_licenses: null })
    expect(engagementSchema.safeParse({ ...base, trained_count: 'dvanáct' }).success).toBe(false)
    expect(engagementSchema.safeParse({ ...base, trained_count: '1.5' }).success).toBe(false)
  })
})

describe('partnerSchema a registrace', () => {
  test('role z čárkami odděleného textu, prázdné položky pryč', () => {
    expect(partnerSchema.parse({ name: 'BETA TRADE', roles: ' distributor, ,reseller ' }).roles).toEqual(['distributor', 'reseller'])
    expect(partnerSchema.parse({ name: 'X', roles: ['a', 'b'] }).roles).toEqual(['a', 'b'])
    expect(partnerSchema.parse({ name: 'X' }).roles).toEqual([])
    expect(partnerSchema.safeParse({ name: '' }).success).toBe(false)
  })
  test('registrace: program z číselníku, status výchozí none', () => {
    const r = partnerRegistrationSchema.parse({ partner_id: '3', program: 'dodavatel_napoju', margin_pct: '' })
    expect(r).toMatchObject({ partner_id: 3, status: 'none', margin_pct: null })
    expect(partnerRegistrationSchema.safeParse({ partner_id: '3', program: 'neznamy' }).success).toBe(false)
  })
  test('dealPartnerSchema: sourcing checkbox a atribuce', () => {
    const r = dealPartnerSchema.parse({ deal_id: '1', partner_id: '2', program: 'svatebni_agentura', attribution_pct: '30', is_sourcing: 'on' })
    expect(r).toMatchObject({ deal_id: 1, partner_id: 2, attribution_pct: 30, is_sourcing: true, nnpsa_target: null })
  })
})

describe('taskSchema, contactSchema, referenceCardSchema', () => {
  test('úkol: výchozí stav a priorita, neznámé hodnoty neprojdou', () => {
    expect(taskSchema.parse({ title: 'x' })).toMatchObject({ status: 'todo', priority: 'normal', account_id: null, assignee_id: null })
    expect(taskSchema.safeParse({ title: 'x', status: 'hotovo' }).success).toBe(false)
    expect(taskSchema.safeParse({ title: 'x', priority: 'urgent' }).success).toBe(false)
    expect(taskSchema.safeParse({ title: '' }).success).toBe(false)
  })
  test('kontakt: jméno povinné, champion z checkboxu', () => {
    expect(contactSchema.safeParse({ full_name: '' }).error?.issues[0].message).toBe('Jméno je povinné.')
    expect(contactSchema.parse({ full_name: 'Jan', is_champion: 'on', email: '' })).toMatchObject({ is_champion: true, email: null })
    expect(contactSchema.parse({ full_name: 'Jan' }).is_champion).toBe(false)
  })
  test('referenční karta: veřejné schválení jen výslovně', () => {
    expect(referenceCardSchema.parse({ account_id: '1' })).toMatchObject({ approved_public: false, is_ms_anchor: false, engagement_id: null })
    expect(referenceCardSchema.parse({ account_id: '1', approved_public: 'true' }).approved_public).toBe(true)
  })
})

describe('drobné vstupy akcí', () => {
  test('areEntityIds: všechna id musí být kladná celá čísla', () => {
    expect(areEntityIds()).toBe(true)
    expect(areEntityIds(1, 2, 3)).toBe(true)
    expect(areEntityIds(1, '2')).toBe(false)
    expect(areEntityIds(1, 0)).toBe(false)
  })
  test('outreachSnoozeDays 1–365', () => {
    expect(outreachSnoozeDays.safeParse(1).success).toBe(true)
    expect(outreachSnoozeDays.safeParse(365).success).toBe(true)
    for (const bad of [0, 366, 1.5, '7']) expect(outreachSnoozeDays.safeParse(bad).success).toBe(false)
  })
  test('resetPasswordSchema: aspoň 8 znaků', () => {
    expect(resetPasswordSchema.safeParse({ password: '1234567' }).success).toBe(false)
    expect(resetPasswordSchema.safeParse({ password: '12345678' }).success).toBe(true)
  })
  test('teamMemberId jen UUID', () => {
    expect(teamMemberId.safeParse('0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0').success).toBe(true)
    expect(teamMemberId.safeParse('user-1').success).toBe(false)
  })
  test('apiKeyName ořízne a hlídá délku', () => {
    expect(apiKeyName.parse('  Cowork  ')).toBe('Cowork')
    expect(apiKeyName.safeParse('   ').success).toBe(false)
    expect(apiKeyName.safeParse('x'.repeat(101)).success).toBe(false)
  })
})

describe('prospectFromDomainSchema', () => {
  const base = { domain: 'Acme.CZ', emails: ['jan@acme.cz'], sourceLabel: 'Wispr Flow' }
  test('doména se normalizuje na malá písmena', () => {
    expect(prospectFromDomainSchema.parse(base).domain).toBe('acme.cz')
  })
  test('neplatná doména, cizí zdroj nebo moc e-mailů neprojde', () => {
    for (const domain of ['acme', '-acme.cz', 'acme..cz', 'ac me.cz', 'acme.cz/x', 'a'.repeat(64) + '.cz']) {
      expect(prospectFromDomainSchema.safeParse({ ...base, domain }).success, domain).toBe(false)
    }
    expect(prospectFromDomainSchema.safeParse({ ...base, sourceLabel: 'Ručně' }).success).toBe(false)
    expect(prospectFromDomainSchema.safeParse({ ...base, emails: ['není e-mail'] }).success).toBe(false)
    expect(prospectFromDomainSchema.safeParse({ ...base, emails: Array.from({ length: 51 }, (_, i) => `a${i}@acme.cz`) }).success).toBe(false)
  })
})
