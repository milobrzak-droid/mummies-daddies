import { describe, expect, test } from 'vitest'
import { matchMail, type MailAlias, type MailContact } from '@/domain/crm/mailMatch'

const contacts: MailContact[] = [
  { id: 1, email: 'Jana@Acme.cz', account_id: 10 },
  { id: 2, email: 'petr@acme.cz', account_id: 10 },
  { id: 3, email: 'eva@beta.cz', account_id: 20 },
  { id: 4, email: 'karel@gmail.com', account_id: 30 },
  { id: 5, email: 'x@shared.cz', account_id: 40 },
  { id: 6, email: 'y@shared.cz', account_id: 50 },
  { id: 7, email: 'orphan@nobody.cz', account_id: null },
]
const aliases: MailAlias[] = [
  { domain: 'acme-group.com', account_id: 10 },
  { domain: '@Gamma.cz', account_id: 60 },
  { domain: 'gmail.com', account_id: 99 },
  { domain: 'split.cz', account_id: 70 },
  { domain: 'split.cz', account_id: 71 },
]
const m = (counterparts: string[], direction: 'inbound' | 'outbound' = 'inbound') =>
  matchMail({ direction, counterparts, contacts, aliases })

describe('matchMail', () => {
  test('přesný kontakt → matched s contact_id, bez ohledu na velikost písmen', () => {
    expect(m([' JANA@acme.cz '])).toEqual({ status: 'matched', direction: 'inbound', account_id: 10, contact_id: 1 })
  })
  test('firemní doména přes kontakty → matched bez contact_id', () => {
    expect(m(['novy@acme.cz'], 'outbound')).toEqual({ status: 'matched', direction: 'outbound', account_id: 10, contact_id: null })
  })
  test('dva kontakty téže firmy → matched, contact_id null', () => {
    expect(m(['jana@acme.cz', 'petr@acme.cz'])).toMatchObject({ status: 'matched', account_id: 10, contact_id: null })
  })
  test('alias doména (i se zavináčem a velkými písmeny)', () => {
    expect(m(['a@acme-group.com'])).toMatchObject({ status: 'matched', account_id: 10 })
    expect(m(['a@gamma.cz'])).toMatchObject({ status: 'matched', account_id: 60 })
  })
  test('freemail jen přes přesný e-mail; alias na freemail se ignoruje', () => {
    expect(m(['karel@gmail.com'])).toMatchObject({ status: 'matched', account_id: 30, contact_id: 4 })
    expect(m(['cizi@gmail.com'])).toEqual({ status: 'unknown', direction: 'inbound', counterpart_domain: null })
  })
  test('neznámý freemail nic neprozradí a nebrání shodě', () => {
    const r = m(['cizi@seznam.cz', 'eva@beta.cz'])
    expect(r).toMatchObject({ status: 'matched', account_id: 20 })
    expect(JSON.stringify(m(['cizi@seznam.cz']))).not.toContain('cizi')
  })
  test('mummiesdaddies.com se vylučuje; jen naše adresy → internal', () => {
    expect(m(['viktor@mummiesdaddies.com', 'X@MummiesDaddies.com'])).toEqual({ status: 'internal', direction: 'inbound' })
    expect(m(['viktor@mummiesdaddies.com', 'eva@beta.cz'])).toMatchObject({ status: 'matched', account_id: 20 })
    expect(m([])).toMatchObject({ status: 'internal' })
    expect(m(['nonsense', '@acme.cz'])).toMatchObject({ status: 'internal' })
  })
  test('neznámá firemní doména → unknown jen s doménou', () => {
    const r = m(['boss@newco.cz'])
    expect(r).toEqual({ status: 'unknown', direction: 'inbound', counterpart_domain: 'newco.cz' })
    expect(JSON.stringify(r)).not.toContain('boss')
  })
  test('více neznámých domén → unknown bez domény', () => {
    expect(m(['a@newco.cz', 'b@other.cz'])).toMatchObject({ status: 'unknown', counterpart_domain: null })
  })
  test('známá firma + neznámá firemní doména → ambiguous bez adres', () => {
    const r = m(['eva@beta.cz', 'boss@newco.cz'])
    expect(r).toEqual({ status: 'ambiguous', direction: 'inbound', counterpart_domain: null })
  })
  test('dvě různé firmy → ambiguous', () => {
    expect(m(['jana@acme.cz', 'eva@beta.cz'])).toMatchObject({ status: 'ambiguous' })
  })
  test('doména s kontakty dvou firem → ambiguous, přesný kontakt ale vyhraje', () => {
    expect(m(['z@shared.cz'])).toMatchObject({ status: 'ambiguous' })
    expect(m(['x@shared.cz'])).toMatchObject({ status: 'matched', account_id: 40, contact_id: 5 })
  })
  test('alias doména na dvě firmy → ambiguous', () => {
    expect(m(['q@split.cz'])).toMatchObject({ status: 'ambiguous' })
  })
  test('kontakt bez firmy se nepočítá', () => {
    expect(m(['orphan@nobody.cz'])).toMatchObject({ status: 'unknown', counterpart_domain: 'nobody.cz' })
  })
  test('duplicitní adresy nevadí', () => {
    expect(m(['eva@beta.cz', 'EVA@beta.cz'])).toMatchObject({ status: 'matched', contact_id: 3 })
  })
  test('vlastní ourDomain', () => {
    expect(matchMail({ direction: 'outbound', counterparts: ['a@acme.cz'], contacts, aliases, ourDomain: 'acme.cz' }))
      .toMatchObject({ status: 'internal' })
  })
})
