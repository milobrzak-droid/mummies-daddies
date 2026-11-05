import { expect, test } from 'vitest'
import { pickAresMatch, normalizeCompanyName, type AresCompany } from '@/connectors/ares'

const c = (legalName: string, ico = '123'): AresCompany => ({
  ico, legalName, city: null, region: null, address: null, founded: null, nace: [], industry: null,
})

test('accepts an exact name match ignoring legal form', () => {
  const r = pickAresMatch('ALFATECH', [c('ALFATECH, s.r.o.', '25092677')], 4)
  expect(r?.how).toBe('přesná shoda')
  expect(r?.company.ico).toBe('25092677')
})

test('accepts a name that is the only company of that name', () => {
  const r = pickAresMatch('NUTREND', [c('NUTREND D.S., a.s.', '25853902')], 1)
  expect(r?.how).toBe('jediný výsledek')
})

test('refuses an abbreviation even when it is the only result', () => {
  // „CCH" vrátí jediný zásah „CCH Vzduchotechnika CZ" — s Coca-Colou
  // nemá nic společného.
  expect(pickAresMatch('CCH', [c('CCH Vzduchotechnika CZ s.r.o.')], 1)).toBeNull()
})

test('refuses when many companies share the name', () => {
  // „Magna" vrací 56 subjektů a první je vinařský spolek.
  expect(pickAresMatch('Magna', [c('AUTENTISTA MORAVIA MAGNA, vinařský spolek')], 56)).toBeNull()
})

test('refuses a name the user themselves flagged as uncertain', () => {
  expect(pickAresMatch('CCH (Coca-Cola HBC?)', [c('CCH Vzduchotechnika CZ s.r.o.')], 1)).toBeNull()
})

test('strips a parenthetical before matching', () => {
  const r = pickAresMatch('Mova Plus (Linsan24h)', [c('Mova Plus s.r.o.', '00537837')], 3)
  expect(r?.company.ico).toBe('00537837')
})

test('normalizes diacritics and legal forms', () => {
  expect(normalizeCompanyName('CENTR GROUP a.s.')).toBe('centr group')
  expect(normalizeCompanyName('Šmídl Holding s.r.o.')).toBe('smidl holding')
})

test('returns nothing when there are no candidates', () => {
  expect(pickAresMatch('Essence BS', [], 0)).toBeNull()
})
