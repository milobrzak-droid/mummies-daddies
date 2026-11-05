import { describe, expect, it } from 'vitest'
import {
  allPages, getPage, getSection, legacyRedirects, microcopy, microcopyAll, microcopyList, pageMetadata,
  parseCta, parseItem, splitPlaceholders, stripPlaceholders,
} from '@/lib/web/content'

describe('content', () => {
  it('má všechny stránky z mapy webu', () => {
    const paths = allPages().map((p) => p.path)
    for (const p of ['/', '/catering', '/catering/svatby', '/poptavka', '/cheesecaky', '/kosik', '/kontakt']) expect(paths).toContain(p)
  })

  it('getPage / getSection hlásí překlep chybou', () => {
    expect(() => getPage('/neexistuje')).toThrow()
    expect(() => getSection('/', 'neexistuje')).toThrow()
    expect(getSection('/', 'hero').heading).toBe('CATERING, NA KTERÝ SE NEZAPOMÍNÁ.')
  })

  it('parseItem rozloží titulek, text a odkaz', () => {
    const it = parseItem('Firemní catering — Obědy do kanceláře. Od [DOPLNÍ KLIENT] Kč/os. · od 4 osob → /catering/firemni')
    expect(it.title).toBe('Firemní catering')
    expect(it.href).toBe('/catering/firemni')
    expect(it.text).toBe('Obědy do kanceláře. Od [DOPLNÍ KLIENT] Kč/os. · od 4 osob')
    const lbl = parseItem('Sekundární odkaz: Prohlédnout menu a ceny → /catering')
    expect(lbl).toMatchObject({ label: 'Sekundární odkaz', text: 'Prohlédnout menu a ceny', href: '/catering' })
    expect(parseItem('Průměr: [DOPLNÍ KLIENT]')).toMatchObject({ label: 'Průměr', text: '[DOPLNÍ KLIENT]' })
  })

  it('parseCta', () => {
    expect(parseCta('Chci nabídku do pár minut → /poptavka')).toEqual({ label: 'Chci nabídku do pár minut', href: '/poptavka' })
    expect(parseCta('Spočítat nabídku')).toEqual({ label: 'Spočítat nabídku', href: null })
  })

  it('mikrotexty: klíč, proměnné, seznamy, duplicity', () => {
    expect(microcopy('POPTÁVKA — pole Typ akce')).toBe('Vyberte typ akce')
    expect(microcopy('POTVRZENÍ — standard, text', { 'e-mail': 'a@b.cz' })).toContain('a@b.cz')
    expect(microcopyList('POPTÁVKA — možnosti segmentu')).toEqual(['Za firmu', 'Soukromě', 'Jsem eventová agentura'])
    expect(microcopyAll('ASISTENT — tlačítko')).toHaveLength(2)
    expect(() => microcopy('NEEXISTUJE')).toThrow()
  })

  it('zástupci [DOPLNÍ KLIENT] zůstávají v textu a jdou zvýraznit', () => {
    const parts = splitPlaceholders('Od [DOPLNÍ KLIENT] Kč · [DOPLNÍ KLIENT: role] x')
    expect(parts.filter((p) => p.placeholder).map((p) => p.text)).toEqual(['[DOPLNÍ KLIENT]', '[DOPLNÍ KLIENT: role]'])
    expect(stripPlaceholders('Vaříme od 2018 · [DOPLNÍ KLIENT: x] akcí')).toBe('Vaříme od 2018 · akcí')
  })

  it('pageMetadata bere title doslova (absolute)', () => {
    const m = pageMetadata('/catering/svatby')
    expect(m.title).toEqual({ absolute: getPage('/catering/svatby').metaTitle })
    expect(m.alternates?.canonical).toBe('/catering/svatby')
  })

  it('legacyRedirects čte páry ze strategie', () => {
    const r = legacyRedirects()
    expect(r).toContainEqual({ from: '/wedding', to: '/catering/svatby' })
  })
})
