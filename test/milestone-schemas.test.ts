import { describe, expect, test } from 'vitest'
import {
  handoffLabel, hasAcceptance, HANDOFF_ITEMS, milestoneAcceptSchema, milestoneCreateSchema,
} from '@/domain/delivery/milestone'
import { documentEntityId } from '@/domain/delivery/documents'
import { targetEntityId, targetStatusSchema } from '@/domain/crm/targetLists'

// Vstupy milníku dodávky (domain/delivery/milestone.ts): zástupce ≠ vlastník
// a akceptace „buď existující dokument, nebo nový odkaz do SharePointu".

const OWNER = '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'
const OTHER = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'
const SP = 'https://mummiesdaddies.sharepoint.com/sites/x/akceptace.pdf'

describe('milestoneCreateSchema', () => {
  test('prázdná pole z formuláře = null', () => {
    expect(milestoneCreateSchema.parse({ title: ' Pilot ', owner_id: '', deputy_id: '', due_on: '' }))
      .toEqual({ title: 'Pilot', owner_id: null, deputy_id: null, due_on: null })
  })
  test('zástupce musí být jiný člověk než vlastník', () => {
    const r = milestoneCreateSchema.safeParse({ title: 'x', owner_id: OWNER, deputy_id: OWNER })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].path).toEqual(['deputy_id'])
    expect(milestoneCreateSchema.safeParse({ title: 'x', owner_id: OWNER, deputy_id: OTHER }).success).toBe(true)
    expect(milestoneCreateSchema.safeParse({ title: 'x', owner_id: null, deputy_id: OWNER }).success).toBe(true)
  })
  test('neplatné UUID, datum nebo prázdný název neprojde', () => {
    expect(milestoneCreateSchema.safeParse({ title: 'x', owner_id: 'viktor' }).error?.issues[0].message).toBe('Neplatný člen týmu.')
    expect(milestoneCreateSchema.safeParse({ title: 'x', due_on: '1. 10. 2026' }).error?.issues[0].message).toBe('Neplatné datum.')
    expect(milestoneCreateSchema.safeParse({ title: '  ' }).success).toBe(false)
    expect(milestoneCreateSchema.safeParse({ title: 'x'.repeat(301) }).success).toBe(false)
  })
})

describe('milestoneAcceptSchema', () => {
  const messages = (input: Record<string, unknown>) => {
    const r = milestoneAcceptSchema.safeParse({ accepted_on: '2026-09-28', ...input })
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
  }

  test('existující dokument stačí', () => {
    const r = milestoneAcceptSchema.parse({ document_id: '7', new_title: '', new_url: '', accepted_on: '2026-09-28', accepted_by_contact_id: '' })
    expect(r).toEqual({ document_id: 7, new_title: null, new_url: null, accepted_on: '2026-09-28', accepted_by_contact_id: null })
  })

  test('nový odkaz s názvem stačí', () => {
    expect(messages({ new_title: 'Akceptační protokol', new_url: SP })).toEqual([])
  })

  test('bez dokumentu i bez odkazu neprojde', () => {
    expect(messages({})).toEqual([expect.stringMatching(/^document_id: Vyber dokument/)])
  })

  test('obojí najednou neprojde', () => {
    expect(messages({ document_id: '7', new_title: 'A', new_url: SP })).toEqual([expect.stringMatching(/^document_id: .*ne obojí/)])
  })

  test('nový dokument potřebuje název i odkaz', () => {
    expect(messages({ new_title: 'A' })).toEqual(['new_url: Vyplň odkaz na SharePoint.'])
    expect(messages({ new_url: SP })).toEqual(['new_title: Vyplň název dokumentu.'])
  })

  test('odkaz jen do firemního SharePointu', () => {
    for (const url of ['https://evil.sharepoint.com/x', 'http://mummiesdaddies.sharepoint.com/x', 'https://mummiesdaddies.sharepoint.com.evil.cz/x', 'https://drive.google.com/x']) {
      expect(messages({ new_title: 'A', new_url: url }).some((m) => m.startsWith('new_url: Odkaz musí vést na SharePoint')), url).toBe(true)
    }
    expect(messages({ new_title: 'A', new_url: 'https://mummiesdaddies-my.sharepoint.com/personal/x' })).toEqual([])
  })

  test('datum akceptace povinné ve tvaru YYYY-MM-DD', () => {
    expect(milestoneAcceptSchema.safeParse({ document_id: '7', accepted_on: '' }).success).toBe(false)
    expect(milestoneAcceptSchema.safeParse({ document_id: '7' }).success).toBe(false)
  })
})

test('hasAcceptance vyžaduje datum i evidenci; kontakt je jen informační', () => {
  expect(hasAcceptance({ acceptedAt: '2026-09-28', acceptedByContactId: null, acceptanceEvidenceId: 3 })).toBe(true)
  expect(hasAcceptance({ acceptedAt: null, acceptedByContactId: 1, acceptanceEvidenceId: 3 })).toBe(false)
  expect(hasAcceptance({ acceptedAt: '2026-09-28', acceptedByContactId: 1, acceptanceEvidenceId: null })).toBe(false)
})

test('handoffLabel: popisek z HANDOFF_ITEMS, neznámý klíč beze změny', () => {
  for (const item of HANDOFF_ITEMS) expect(handoffLabel(item.key)).toBe(item.label)
  expect(handoffLabel('neco' as never)).toBe('neco')
})

test('id předávaná akcím dokumentů a cílových seznamů: jen kladná bezpečná celá čísla', () => {
  for (const schema of [documentEntityId, targetEntityId]) {
    expect(schema.safeParse(1).success).toBe(true)
    for (const bad of [0, -1, 2.5, '1', NaN, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(schema.safeParse(bad).success).toBe(false)
    }
  }
  expect(targetStatusSchema.safeParse('osloveno').success).toBe(true)
  expect(targetStatusSchema.safeParse('hotovo').success).toBe(false)
})
