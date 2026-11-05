import { describe, expect, test } from 'vitest'
import { buildChangeSections } from '@/domain/crm/changes'
import { buildDigest, type DigestInput } from '@/domain/crm/digest'
import { buildOpsReport, type OpsReport } from '@/domain/crm/opsReport'
import { EMAIL_ITEMS_PER_SECTION, previewAppUrl, renderOpsReportEmail } from '@/domain/crm/opsReportEmail'
import { digestInput, opsInput, opsReport } from './helpers/opsReportFixture'

// E-mail provozního přehledu (pondělí a pátek): stručný, česky, každá položka
// s odkazem do Cockpitu a důkazem, HTML i textová verze, e-mailově bezpečné
// HTML, escapování a žádná citlivá data navíc (částky, rozsah nabídky, dopad,
// kontakty klienta). Nic se tu neodesílá — jen text a HTML.

const APP = 'https://cockpit.example.cz'
const render = (r: OpsReport = opsReport(), perSection?: number) =>
  renderOpsReportEmail(r, { appUrl: `${APP}/`, generatedAtLabel: 'pondělí 5. 10. 2026', perSection })
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))

describe('renderOpsReportEmail: plný přehled', () => {
  const { subject, html, text } = render()

  test('předmět česky: datum, celkový počet a co hoří', () => {
    expect(subject).toBe('Přehled týdne pondělí 5. 10. 2026: 22 položek (Riziko: 6, Ke schválení: 2, Čeká na nás: 3, Čeká na klienta: 1, Neověřené: 7, Obchody: 3)')
    expect(subject).not.toMatch(/[\r\n]/)
  })

  test('e-mailově bezpečná struktura (tabulky, inline styly, nic externího)', () => {
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('lang="cs"')
    expect(html).toContain('max-width:600px')
    expect(html).toContain('role="presentation"')
    expect(html).not.toMatch(/<style|<link|<img|<script|<iframe|class=/i)
    expect(html).not.toMatch(/url\(/)
  })

  test('sekce v pořadí zadání, Stav zdrojů na konci', () => {
    const order = [
      'Nové a změněné obchody (3)', 'Dodávky podle milníků (3)', 'Čeká na nás (3)', 'Čeká na klienta (1)',
      'Ke schválení (2)', 'Riziko termínů a kapacity (6)', 'Neověřené položky (7)', 'Stav zdrojů',
    ].map((t) => html.indexOf(`>${t}<`))
    expect(order.every((p) => p > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('Obchody a posuny milníků za týden 40: po 28. 9. až ne 4. 10.; ostatní je stav k pondělí 5. 10. 2026.')
  })

  test('každá položka vede absolutním https odkazem na svůj záznam v Cockpitu a nese důkaz', () => {
    const links = hrefs(html)
    for (const l of links) expect(l.startsWith(`${APP}/`), l).toBe(true)
    expect(links).toContain(`${APP}/cockpit/clients/10/deals/5`)
    expect(links).toContain(`${APP}/cockpit/clients/20/engagements/2/edit?zalozka=milniky`)
    expect(links).toContain(`${APP}/cockpit/pripady/4`)
    expect(links).toContain(`${APP}/cockpit/kapacity`)
    expect(links[links.length - 1]).toBe(`${APP}/cockpit/prehled-tydne?tyden=minuly`)
    expect(html).toContain('Důkaz: Záznam v auditu č. 100, 29. 9. 10:00')
    expect(html).toContain('Důkaz: Milník č. 21, čeká od 15. 9. 10:00')
  })

  test('stručně: nejvýš 5 položek na sekci, zbytek odkazem na sekci stránky Týden', () => {
    expect(EMAIL_ITEMS_PER_SECTION).toBe(5)
    // Neověřené: 7 položek → 5 + „a dalších 2", Riziko: 6 → 5 + „a dalších 1"
    expect(html).toContain('… a dalších 2 — celý seznam v Cockpitu')
    expect(hrefs(html)).toContain(`${APP}/cockpit/prehled-tydne?tyden=minuly#neovereno`)
    expect(hrefs(html)).toContain(`${APP}/cockpit/prehled-tydne?tyden=minuly#riziko`)
    expect(html).not.toContain('Milníky nejsou zapsané, plán dodávky nejde ověřit') // 7. položka neověřených
  })

  test('textová verze nese totéž: sekce, detaily, důkazy a odkazy', () => {
    expect(text.split('\n').slice(0, 4)).toEqual([
      'Přehled týdne pondělí 5. 10. 2026',
      'Riziko: 6, Ke schválení: 2, Čeká na nás: 3, Čeká na klienta: 1, Neověřené: 7, Obchody: 3.',
      'Obchody a posuny milníků za týden 40: po 28. 9. až ne 4. 10.; ostatní je stav k pondělí 5. 10. 2026.',
      '',
    ])
    expect(text).toContain('## Čeká na klienta (1)\n- ACME · Školení — Odesláno klientovi 15. 9., zatím není přijato · Čeká už 20 dní · Po termínu o 5 dní\n  Důkaz: Milník č. 21, čeká od 15. 9. 10:00\n  https://cockpit.example.cz/cockpit/clients/20/engagements/2/edit?zalozka=milniky')
    expect(text).toContain('- … a dalších 1 — celý seznam v Cockpitu: https://cockpit.example.cz/cockpit/prehled-tydne?tyden=minuly#riziko')
    expect(text).toContain('## Stav zdrojů')
    expect(text.endsWith('Otevřít v Cockpitu: https://cockpit.example.cz/cockpit/prehled-tydne?tyden=minuly')).toBe(true)
  })

  test('žádná citlivá data navíc: bez částek, rozsahu nabídky, dopadu a kontaktu klienta', () => {
    for (const leak of ['Tajný rozsah', 'Doba zpracování', 'Jana Klientová', 'jana@acme.cz', 'Kč', 'mailto:']) {
      expect(html).not.toContain(leak)
      expect(text).not.toContain(leak)
    }
  })
})

describe('renderOpsReportEmail: okrajové případy', () => {
  test('klidný týden: „nic nečeká", prázdné sekce jedním řádkem, Stav zdrojů zůstává', () => {
    const di: DigestInput = { ...digestInput(), followUps: [], outreach: [], blockedDeals: [] }
    const calm = buildOpsReport(opsInput({
      changes: { sections: buildChangeSections([], { canSeeSales: true }), unavailable: [] },
      portfolio: { state: 'ok', items: [], unavailable: [] },
      waiting: { state: 'ok', items: [] },
      capacity: { state: 'ok', members: [], allocations: [] },
      inbox: { state: 'ok', approvals: [], decisions: [] },
      pendingProposals: 0, unmatchedNotes: 0,
      digest: { digest: buildDigest(di), source: di },
    }))
    const r = render(calm)
    expect(r.subject).toBe('Přehled týdne pondělí 5. 10. 2026: nic nečeká')
    expect(r.html).toContain('Tento týden nic nečeká')
    expect(r.html).toContain('Bez položek: Nové a změněné obchody, Dodávky podle milníků, Čeká na nás, Čeká na klienta, Ke schválení, Riziko termínů a kapacity, Neověřené položky.')
    expect(r.html).toContain('>Stav zdrojů<')
    expect(hrefs(r.html)).toEqual([`${APP}/cockpit/prehled-tydne?tyden=minuly`])
  })

  test('nenačtený zdroj se přizná nahoře a jeho sekce není mezi „bez položek"', () => {
    const r = render(opsReport({ portfolio: { state: 'error', message: 'x' }, waiting: { state: 'error', message: 'x' } }))
    expect(r.html).toContain('Nepodařilo se načíst: dodávky, čekání na klienta. Ověř to v Cockpitu')
    expect(r.html).not.toMatch(/Bez položek:[^<]*Čeká na klienta/)
    expect(r.text).toContain('Nepodařilo se načíst: dodávky, čekání na klienta.')
  })

  test('escapování: název z dat nemůže vložit HTML ani odkaz', () => {
    const evil = `<script>alert("x")</script> & 'Řízení'`
    const base = opsReport()
    const report: OpsReport = {
      ...base,
      sections: base.sections.map((s) => (s.key === 'ke-schvaleni'
        ? { ...s, items: [{ ...s.items[0], title: evil, href: 'javascript:alert(1)' }, { ...s.items[1], href: '//evil.example/x' }] }
        : s)),
    }
    const { html, text } = render(report)
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Řízení&#39;')
    expect(hrefs(html)).not.toContain('javascript:alert(1)')
    expect(hrefs(html).some((h) => h.includes('evil.example'))).toBe(false)
    expect(hrefs(html)).toContain(`${APP}/cockpit/prehled-tydne`)
    expect(text).toContain(evil) // prostý text se neescapuje, ale odkaz vede jen do Cockpitu
    expect(text).not.toContain('javascript:')
  })

  test('datum s novým řádkem neprojde do předmětu; http adresa se odmítne', () => {
    const r = renderOpsReportEmail(opsReport(), { appUrl: APP, generatedAtLabel: 'a\r\nBcc: x' })
    expect(r.subject).not.toMatch(/[\r\n]/)
    expect(() => renderOpsReportEmail(opsReport(), { appUrl: 'http://cockpit.example.cz', generatedAtLabel: 'x' })).toThrow(/https/)
  })

  test('páteční přehled odkazuje na tento týden', () => {
    const r = render(opsReport({ week: 'tento' }))
    expect(hrefs(r.html)).toContain(`${APP}/cockpit/prehled-tydne?tyden=tento`)
  })

  test('adresa pro náhled: APP_URL, jinak výchozí https adresa Cockpitu', () => {
    expect(previewAppUrl({ APP_URL: 'https://cockpit.example.cz/' })).toBe(APP)
    expect(previewAppUrl({})).toBe('https://www.mummiesdaddies.com')
    expect(previewAppUrl({ APP_URL: 'http://localhost:3000' })).toBe('https://www.mummiesdaddies.com')
  })
})

describe('snímek textové verze (malý přehled)', () => {
  test('text e-mailu pro jednu položku v každé sekci', () => {
    const base = opsReport()
    const small: OpsReport = { ...base, sections: base.sections.map((s) => ({ ...s, items: s.items.slice(0, 1), total: Math.min(s.total, 1) })), unavailable: [] }
    const { text } = render({ ...small, headline: 'Riziko: 1.', sources: { title: 'Stav zdrojů', lines: ['Outlook pošta (příjem a odeslání): vypnuto'] } })
    expect(text).toMatchInlineSnapshot(`
      "Přehled týdne pondělí 5. 10. 2026
      Riziko: 1.
      Obchody a posuny milníků za týden 40: po 28. 9. až ne 4. 10.; ostatní je stav k pondělí 5. 10. 2026.

      ## Nové a změněné obchody (1)
      - Beta · Školení AI — Nabídka odeslána → Prohráno
        Důkaz: Záznam v auditu č. 102, 1. 10. 10:00
        https://cockpit.example.cz/cockpit/clients/40/deals/7

      ## Dodávky podle milníků (1)
      - ACME · Firemní akce — Po termínu o 4 dny · Další milník „Školení“ · Čeká na schválení · do 30. 9. (o 5 dní po termínu) · přijato 0 z 1
        Důkaz: Dodávka č. 2, poslední pohyb 15. 9.
        https://cockpit.example.cz/cockpit/clients/20/engagements/2/edit?zalozka=milniky

      ## Čeká na nás (1)
      - Škoda · Agentizace — Další krok obchodu je po termínu o 4 dny · eskalováno
        Důkaz: Obchod č. 11, termín dalšího kroku 1. 10.
        https://cockpit.example.cz/cockpit/clients/3/deals/11

      ## Čeká na klienta (1)
      - ACME · Školení — Odesláno klientovi 15. 9., zatím není přijato · Čeká už 20 dní · Po termínu o 5 dní
        Důkaz: Milník č. 21, čeká od 15. 9. 10:00
        https://cockpit.example.cz/cockpit/clients/20/engagements/2/edit?zalozka=milniky

      ## Ke schválení (1)
      - Závazek pro ALFATECH — Žádost o schválení · čeká 4 dny
        Důkaz: Žádost o schválení č. 7, založena 1. 10. 10:00
        https://cockpit.example.cz/cockpit/pripady/4

      ## Riziko termínů a kapacity (1)
      - ACME · Školení — Milník po termínu o 5 dní · Čeká na schválení · Firemní akce · vlastník Lenka Horáková
        Důkaz: Milník č. 21, termín 30. 9.
        https://cockpit.example.cz/cockpit/clients/20/engagements/2/edit?zalozka=milniky

      ## Neověřené položky (1)
      - Nová poptávka: Acme Stroje — Vzniklo automaticky z e-mailu · odpovědět do 2. 10. · zkontroluj, že jde o poptávku
        Důkaz: Automatické založení č. 3, e-mail přijat 1. 10. 09:30
        https://cockpit.example.cz/cockpit/clients/43

      ## Stav zdrojů
      Outlook pošta (příjem a odeslání): vypnuto

      Otevřít v Cockpitu: https://cockpit.example.cz/cockpit/prehled-tydne?tyden=minuly"
    `)
  })
})
