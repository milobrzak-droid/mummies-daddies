// Kapitola 8 + invariant „výstup AI je návrh": čistá logika dvoukrokového
// importu nabídky (domain/crm/offerProposal.ts).
import { describe, expect, test } from 'vitest'
import {
  buildStoredProposal,
  changedOfferFields,
  derivedOfferStage,
  escapeLikePattern,
  isProposalId,
  offerConfirmSchema,
  offerPaths,
  parseStoredProposal,
  sameAccountName,
  toConfirmedFields,
} from '@/domain/crm/offerProposal'
import type { SanitizedOfferFields } from '@/domain/crm/offer-extract'

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b'
const AI: SanitizedOfferFields = {
  account_name: 'Spolchemie', title: 'Nasazení', pillar: 'cheesecaky', phase: 'potvrzeno', revenue_line: 'svatebni_hostina',
  currency: 'CZK', amount_one_time: 100000, cogs_one_time: 40000, estimate_md: null, expected_close: null,
}
const form = (over: Record<string, string> = {}) => ({
  proposal_id: ID, account_name: 'Spolchemie', title: 'Nasazení', pillar: 'cheesecaky', phase: 'potvrzeno',
  revenue_line: 'svatebni_hostina', currency: 'CZK', amount_one_time: '100000', cogs_one_time: '40000',
  estimate_md: '', expected_close: '', ...over,
})

describe('id návrhu a cesty', () => {
  test('jen UUID v4; cesty se odvozují z id, ne z textu od klienta', () => {
    expect(isProposalId(ID)).toBe(true)
    for (const bad of ['', '../../etc/passwd', `${ID}/../x`, ID.toUpperCase(), 'offers/x.pdf', null]) {
      expect(isProposalId(bad), String(bad)).toBe(false)
    }
    expect(offerPaths(ID)).toEqual({ pdf: `offers/${ID}.pdf`, proposal: `offers/${ID}.navrh.json` })
    expect(() => offerPaths('../x')).toThrow()
  })
})

describe('uložený návrh AI', () => {
  const stored = () => buildStoredProposal({
    proposalId: ID, fileName: 'nabidka.pdf', fields: AI, warnings: ['chybí fáze'], flags: ['model_reported'],
    now: new Date('2026-09-28T10:00:00Z'),
  })

  test('nese info_state ai_suggestion a projde vlastním schématem', () => {
    const s = stored()
    expect(s.info_state).toBe('ai_suggestion')
    expect(parseStoredProposal(JSON.parse(JSON.stringify(s)), ID)).toEqual(s)
  })

  test('návrh jiného id, podvržený stav nebo neznámý příznak se odmítne', () => {
    const s = stored()
    expect(parseStoredProposal(s, '11111111-1111-4111-8111-111111111111')).toBeNull()
    expect(parseStoredProposal({ ...s, info_state: 'human_confirmed' }, ID)).toBeNull()
    expect(parseStoredProposal({ ...s, injection_flags: ['nope'] }, ID)).toBeNull()
    expect(parseStoredProposal({ ...s, fields: { ...s.fields, pillar: 'hacked' } }, ID)).toBeNull()
    expect(parseStoredProposal('garbage', ID)).toBeNull()
  })
})

describe('potvrzení člověkem — schéma formuláře', () => {
  test('platný formulář', () => {
    const parsed = offerConfirmSchema.safeParse(form({ estimate_md: '12,5', expected_close: '2026-10-31' }))
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(toConfirmedFields(parsed.data)).toEqual({ ...AI, estimate_md: 12.5, expected_close: '2026-10-31' })
  })

  test('prázdná čísla jsou null, ne 0', () => {
    const parsed = offerConfirmSchema.safeParse(form({ amount_one_time: '', cogs_one_time: ' ' }))
    expect(parsed.success && parsed.data.amount_one_time).toBeNull()
    expect(parsed.success && parsed.data.cogs_one_time).toBeNull()
  })

  test.each([
    [{ account_name: '  ' }, 'account_name'],
    [{ title: '' }, 'title'],
    [{ pillar: 'hacked' }, 'pillar'],
    [{ pillar: 'b2b_akce', phase: 'workshopy' }, 'phase'],
    [{ pillar: '', phase: 'potvrzeno' }, 'phase'],
    [{ revenue_line: 'free_money' }, 'revenue_line'],
    [{ currency: 'BTC' }, 'currency'],
    [{ amount_one_time: '-1' }, 'amount_one_time'],
    [{ amount_one_time: 'abc' }, 'amount_one_time'],
    [{ amount_one_time: '1e12' }, 'amount_one_time'],
    [{ expected_close: '31. 10.' }, 'expected_close'],
    [{ proposal_id: '../x' }, 'proposal_id'],
  ])('odmítne %o', (over, field) => {
    const parsed = offerConfirmSchema.safeParse(form(over as Record<string, string>))
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.map((i) => i.path[0])).toContain(field)
  })
})

describe('co člověk změnil', () => {
  test('jen názvy změněných polí', () => {
    const parsed = offerConfirmSchema.parse(form({ amount_one_time: '90000', phase: 'poptavka' }))
    expect(changedOfferFields(AI, toConfirmedFields(parsed))).toEqual(['phase', 'amount_one_time'])
  })

  test('beze změny = prázdné pole', () => {
    expect(changedOfferFields(AI, toConfirmedFields(offerConfirmSchema.parse(form())))).toEqual([])
  })
})

describe('fáze obchodu z fáze pilíře', () => {
  test('objednáno = vyhráno, poptávka = kvalifikace, nic = výchozí', () => {
    expect(derivedOfferStage('cheesecaky', 'potvrzeno')).toBe('vyhráno')
    expect(derivedOfferStage('cheesecaky', 'poptavka')).toBe('kvalifikace')
    expect(derivedOfferStage(null, null)).toBe('kvalifikace')
  })
})

describe('párování klienta podle názvu', () => {
  test('escapuje zástupné znaky LIKE', () => {
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b')
    expect(escapeLikePattern('ACME s.r.o.')).toBe('ACME s.r.o.')
  })

  test('shoda bez ohledu na velikost písmen a okolní mezery, ne podřetězec', () => {
    expect(sameAccountName('Škoda Auto a.s.', ' ŠKODA AUTO A.S. ')).toBe(true)
    expect(sameAccountName('Spolchemie', 'Spolchemie Holding')).toBe(false)
    expect(sameAccountName('Spolchemie', '*')).toBe(false)
  })
})
