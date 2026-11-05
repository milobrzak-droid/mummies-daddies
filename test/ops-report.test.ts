import { describe, expect, test } from 'vitest'
import { buildChangeSections } from '@/domain/crm/changes'
import { buildDigest, type DigestInput } from '@/domain/crm/digest'
import {
  OPS_SECTIONS, buildOpsReport, dueWhen, opsReportItemCount,
  type OpsSection, type OpsSectionKey,
} from '@/domain/crm/opsReport'
import { digestInput, opsInput as input, portfolioItems } from './helpers/opsReportFixture'

// Provozní přehled: čisté skládání z hotových dat existujících dotazů.
// Pořadí a obsah sekcí, odkaz a důkaz u každé položky, oprávnění (obchodní
// položky jen s can_see_sales), poctivé „nepodařilo se načíst" a žádné
// citlivé údaje (částky, rozsah nabídky, dopad, kontakty klienta).

const sec = (r: { sections: OpsSection[] }, key: OpsSectionKey) => r.sections.find((s) => s.key === key)!
const keys = (s: OpsSection) => s.items.map((i) => i.key)

describe('buildOpsReport: sekce, pořadí a nadpis', () => {
  const r = buildOpsReport(input())

  test('sedm sekcí ve stálém pořadí zadání (obchody → neověřené)', () => {
    expect(r.sections.map((s) => s.key)).toEqual(['obchody', 'dodavky', 'na-nas', 'na-klienta', 'ke-schvaleni', 'riziko', 'neovereno'])
    // Sekce „Rozdíly v financích“ (iDoklad) se ukáže jen s napojením — viz test/idoklad-ops.test.ts.
    // Sekce „Agent na poptávky“ jen se zapnutým modulem agenta — viz test/ops-report-agent.test.ts.
    expect(r.sections.map((s) => s.title)).toEqual(OPS_SECTIONS.filter((s) => s.key !== 'finance-rozdily' && s.key !== 'agent').map((s) => s.title))
  })

  test('nadpis od toho, co hoří; dodávky (stav) v něm nejsou', () => {
    expect(r.headline).toBe('Riziko: 6, Ke schválení: 2, Čeká na nás: 3, Čeká na klienta: 1, Neověřené: 7, Obchody: 3.')
    expect(r.attention).toBe(6 + 2 + 3 + 1 + 7)
    expect(opsReportItemCount(r)).toBe(r.attention + 3)
    expect(r.isEmpty).toBe(false)
    expect(r.activeDeliveries).toBe(3)
    expect(r.unavailable).toEqual([])
  })

  test('každá položka má odkaz do Cockpitu a důkaz', () => {
    for (const s of r.sections) {
      for (const i of s.items) {
        expect(i.href, i.key).toMatch(/^\/(?!\/)/)
        expect(i.proof.length, i.key).toBeGreaterThan(5)
        expect(i.title.trim(), i.key).not.toBe('')
      }
    }
  })

  test('Stav zdrojů z týdenního přehledu jde s přehledem', () => {
    expect(r.sources?.title).toBe('Stav zdrojů')
    expect(r.sources?.lines.length).toBeGreaterThan(0)
  })
})

describe('jednotlivé sekce', () => {
  const r = buildOpsReport(input())

  test('obchody: nový obchod a posuny fáze za týden s důkazem z auditu', () => {
    const s = sec(r, 'obchody')
    expect(s.items.map((i) => [i.title, i.detail, i.tone])).toEqual([
      ['Beta · Školení AI', 'Nabídka odeslána → Prohráno', 'neg'],
      ['ACME · Licence', 'Zákazník rozhoduje → Vyhráno', 'ok'],
      ['ALFATECH · AI agent', 'Nový obchod', 'ok'],
    ])
    expect(s.items[2]).toMatchObject({ href: '/cockpit/clients/10/deals/5', proof: 'Záznam v auditu č. 100, 29. 9. 10:00' })
  })

  test('dodávky podle milníků: řazení podle termínu dalšího milníku, přijetí a pohyb za týden', () => {
    const s = sec(r, 'dodavky')
    expect(keys(s)).toEqual(['dodavka-2', 'dodavka-1', 'dodavka-3'])
    const [acme, alfatech, climax] = s.items
    // riziková dodávka začíná nejzávažnějším důvodem
    expect(acme.detail).toBe('Po termínu o 4 dny · Další milník „Školení“ · Čeká na schválení · do 30. 9. (o 5 dní po termínu) · přijato 0 z 1')
    expect(acme.tone).toBe('neg')
    expect(alfatech).toMatchObject({
      title: 'ALFATECH · Pilot objednávek',
      detail: 'Blokovaný úkol · Další milník „Procesní mapa“ · V práci · do 7. 10. (za 2 dny) · přijato 1 z 3 · za týden 1 změna milníku',
      href: '/cockpit/clients/10/engagements/1/edit?zalozka=milniky',
      proof: 'Záznam v auditu č. 200, 2. 10. 11:00',
    })
    expect(climax.detail).toBe('Milníky nejsou zapsané · nová dodávka, založená automaticky')
    expect(climax.proof).toBe('Dodávka č. 3, poslední pohyb 4. 10.')
  })

  test('čeká na nás: follow-up po termínu, náš milník do týdne, fronta oslovování jedním řádkem', () => {
    const s = sec(r, 'na-nas')
    expect(keys(s)).toEqual(['followup-11', 'nas-m12', 'oslovovani'])
    expect(s.items[0]).toMatchObject({
      title: 'Škoda · Agentizace', detail: 'Další krok obchodu je po termínu o 4 dny · eskalováno',
      href: '/cockpit/clients/3/deals/11', proof: 'Obchod č. 11, termín dalšího kroku 1. 10.', tone: 'neg',
    })
    expect(s.items[1].detail).toBe('Pilot objednávek · V práci · termín 7. 10. (za 2 dny) · vlastník Viktor Kovář')
    expect(s.items[2]).toMatchObject({ detail: '2 firmy čekají na naši další zprávu · nejdéle 65 dní bez odpovědi', href: '/cockpit/oslovovani' })
    // milník za 15 dní ani milník čekající na klienta sem nepatří
    expect(keys(s)).not.toContain('nas-m13')
    expect(keys(s)).not.toContain('nas-m21')
  })

  test('čeká na klienta: co se čeká, jak dlouho, po termínu — bez kontaktu klienta', () => {
    const s = sec(r, 'na-klienta')
    expect(s.items).toEqual([{
      key: 'klient-m21',
      title: 'ACME · Školení',
      detail: 'Odesláno klientovi 15. 9., zatím není přijato · Čeká už 20 dní · Po termínu o 5 dní',
      href: '/cockpit/clients/20/engagements/2/edit?zalozka=milniky',
      proof: 'Milník č. 21, čeká od 15. 9. 10:00',
      tone: 'neg',
    }])
  })

  test('Ke schválení: čekající schválení a otevřené otázky, nejstarší první, vypršelé ne', () => {
    const s = sec(r, 'ke-schvaleni')
    expect(keys(s)).toEqual(['schvaleni-7', 'otazka-2'])
    expect(s.items[0]).toMatchObject({ title: 'Závazek pro ALFATECH', detail: 'Žádost o schválení · čeká 4 dny', href: '/cockpit/pripady/4', tone: 'warn' })
    expect(s.items[1]).toMatchObject({ title: 'Pokračovat analýzou?', detail: 'Otevřená otázka · čeká 1 den', href: '/cockpit/rozhodnuti', tone: 'info' })
    expect(s.items[1].proof).toBe('Rozhodnutí č. 2, založeno 4. 10. 10:00')
  })

  test('riziko: po termínu nahoře, pak blokace, přetížení a dodávka bez vlastníka', () => {
    const s = sec(r, 'riziko')
    expect(keys(s)).toEqual(['pozde-m21', 'pozde-d2', 'blok-d1', 'blok-o21', 'pretizeni-u-viktor', 'bez-vlastnika-d2'])
    expect(s.items[0].detail).toBe('Milník po termínu o 5 dní · Čeká na schválení · Firemní akce · vlastník Lenka Horáková')
    expect(s.items[1]).toMatchObject({ detail: 'Termín dodávky byl 1. 10., je o 4 dny po termínu · bez vlastníka', proof: 'Dodávka č. 2, termín 1. 10.' })
    expect(s.items[3]).toMatchObject({ title: 'Continental · Rollout', detail: 'Obchod blokuje: čeká na podpis smlouvy', href: '/cockpit/clients/5/deals/21' })
    expect(s.items[4]).toMatchObject({
      title: 'Viktor Kovář', detail: 'Přetížení v T41 a T42 · nejvíc 46 h při kapacitě 40 h', href: '/cockpit/kapacity', proof: 'Kapacity: alokace na T41',
    })
    expect(s.items[5].href).toBe('/cockpit/clients/20/engagements/2/edit?zalozka=tym')
  })

  test('neověřené: automatické poptávky, návrhy, zápisy schůzek, předání, bez milníků, bez pohybu', () => {
    const s = sec(r, 'neovereno')
    expect(keys(s)).toEqual(['intake-3', 'navrhy', 'zapisy', 'predani-d2', 'bez-pohybu-d2', 'predani-d3', 'bez-milniku-d3'])
    expect(s.items[0]).toMatchObject({ title: 'Nová poptávka: Acme Stroje', href: '/cockpit/clients/43' })
    expect(s.items[0].detail).toBe('Vzniklo automaticky z e-mailu · odpovědět do 2. 10. · zkontroluj, že jde o poptávku')
    expect(s.items[1].detail).toBe('2 návrhy čekají na přijetí nebo zamítnutí')
    expect(s.items[2]).toMatchObject({ detail: '1 zápis čeká na ruční přiřazení', href: '/cockpit/schuzky/nesparovane' })
    expect(s.items[3].href).toBe('/cockpit/clients/20/engagements/2/edit?zalozka=predani')
    expect(s.items[4].detail).toBe('Bez pohybu 20 dní, stav je potřeba ověřit u vlastníka')
  })
})

describe('faktury po splatnosti v Riziku (0090)', () => {
  const inv = (id: number, daysLate: number, o: Partial<import('@/domain/crm/opsReport').OpsOverdueInvoice> = {}) => ({
    id, accountId: 10, accountName: 'ALFATECH', externalRef: `FA-${id}`, dueOn: '2026-09-25', daysLate, ...o,
  })

  test('položka nese firmu, doklad a data, řadí se podle dní po splatnosti a je „na červeno"; částka v ní není', () => {
    const r = buildOpsReport(input({ overdueInvoices: [inv(1, 3), inv(2, 30, { accountName: 'ACME', dueOn: '2026-09-05' })] }))
    const s = sec(r, 'riziko')
    const fa = s.items.filter((i) => i.key.startsWith('faktura-'))
    expect(fa.map((i) => i.key)).toEqual(['faktura-2', 'faktura-1'])
    expect(fa[0]).toMatchObject({
      title: 'ACME · faktura FA-2', href: '/cockpit/finance?druh=invoiced&splatnost=po', tone: 'neg',
      detail: 'Splatnost byla 5. 9., faktura je o 30 dní po splatnosti a platba není zapsaná',
      proof: 'Finance: vyfakturováno, doklad FA-2, splatnost 5. 9.',
    })
    // po termínu dodávek a milníků (1000+), před blokacemi (500)
    expect(s.items.map((i) => i.key).indexOf('faktura-2')).toBeGreaterThan(s.items.map((i) => i.key).indexOf('pozde-d2'))
    expect(s.items.map((i) => i.key).indexOf('faktura-1')).toBeLessThan(s.items.map((i) => i.key).indexOf('blok-d1'))
    expect(JSON.stringify(r.sections)).not.toMatch(/Kč|CZK|amount/)
    expect(r.headline).toMatch(/Riziko: \d+/)
  })

  test('bez can_see_sales se faktury po splatnosti vyřadí, i když je volající předá', () => {
    const r = buildOpsReport(input({ canSeeSales: false, overdueInvoices: [inv(1, 3)] }))
    expect(JSON.stringify(r.sections)).not.toContain('faktura-1')
    expect(sec(r, 'riziko').unavailable).not.toContain('faktury po splatnosti')
  })

  test('nenačtené faktury (null) sekce přizná; nepředané (undefined) nic neříká', () => {
    expect(sec(buildOpsReport(input({ overdueInvoices: null })), 'riziko').unavailable).toContain('faktury po splatnosti')
    expect(sec(buildOpsReport(input()), 'riziko').unavailable).not.toContain('faktury po splatnosti')
  })

  test('faktura bez čísla dokladu ani firmy nerozbije text', () => {
    const r = buildOpsReport(input({ overdueInvoices: [inv(3, 2, { externalRef: null, accountName: null })] }))
    const i = sec(r, 'riziko').items.find((x) => x.key === 'faktura-3')!
    expect(i.title).toBe('Bez firmy · faktura')
    expect(i.proof).toBe('Finance: vyfakturováno, splatnost 25. 9.')
  })
})

describe('oprávnění a citlivá data', () => {
  test('bez can_see_sales: žádné obchody, follow-upy, oslovování, blokované obchody, poptávky ani zápisy — ani když je volající předá', () => {
    const r = buildOpsReport(input({ canSeeSales: false }))
    expect(r.sections.map((s) => s.key)).not.toContain('obchody')
    const all = r.sections.flatMap((s) => s.items.map((i) => i.key))
    for (const k of ['followup-11', 'oslovovani', 'blok-o21', 'intake-3', 'zapisy']) expect(all).not.toContain(k)
    // dodávky, čekání, schvalování a návrhy zůstávají
    expect(all).toEqual(expect.arrayContaining(['dodavka-1', 'klient-m21', 'schvaleni-7', 'navrhy', 'pozde-m21']))
    expect(r.headline).not.toContain('Obchody')
    const text = JSON.stringify(r.sections)
    for (const leak of ['Agentizace', 'Continental', 'Tichá', 'Acme Stroje']) expect(text).not.toContain(leak)
  })

  test('žádné částky, rozsah nabídky, měření dopadu ani kontakt klienta', () => {
    const text = JSON.stringify(buildOpsReport(input()).sections)
    for (const leak of ['Tajný rozsah', 'Doba zpracování', 'Jana Klientová', 'jana@acme.cz', 'Kč']) expect(text).not.toContain(leak)
  })
})

describe('odolnost: co se nenačetlo, sekce přizná', () => {
  test('portfolio selže: sekce z dodávek to řeknou, ostatní fungují', () => {
    const r = buildOpsReport(input({ portfolio: { state: 'error', message: 'boom' } }))
    for (const k of ['dodavky', 'na-nas', 'riziko', 'neovereno'] as const) expect(sec(r, k).unavailable).toContain('dodávky')
    expect(sec(r, 'dodavky').items).toEqual([])
    expect(sec(r, 'na-klienta').items).toHaveLength(1)
    expect(r.activeDeliveries).toBeNull()
    expect(r.unavailable).toContain('dodávky')
  })

  test('chybí milníky v portfoliu: dodávka bez milníků se nehlásí jako neověřená', () => {
    const items = portfolioItems()
    const r = buildOpsReport(input({ portfolio: { state: 'ok', items, unavailable: ['milníky'] } }))
    expect(sec(r, 'dodavky').unavailable).toEqual(['milníky'])
    expect(keys(sec(r, 'neovereno'))).not.toContain('bez-milniku-d3')
  })

  test('změny, čekání, Ke schválení, kapacity a digest nenačtené', () => {
    const r = buildOpsReport(input({
      changes: null,
      waiting: { state: 'error', message: 'x' },
      inbox: { state: 'error', message: 'x' },
      capacity: { state: 'error', message: 'x' },
      digest: null,
    }))
    expect(sec(r, 'obchody').unavailable).toEqual(['obchody'])
    expect(sec(r, 'dodavky').unavailable).toEqual(['posuny milníků'])
    expect(sec(r, 'na-klienta').unavailable).toEqual(['čekání na klienta'])
    expect(sec(r, 'ke-schvaleni').unavailable).toEqual(['Ke schválení'])
    expect(sec(r, 'riziko').unavailable).toEqual(['kapacity', 'blokované obchody'])
    expect(sec(r, 'na-nas').unavailable).toEqual(['follow-upy'])
    expect(sec(r, 'neovereno').unavailable).toEqual(['poptávky z e-mailu'])
    expect(r.sources).toBeNull()
  })

  test('chybějící migrace (Ke schválení, čekání, kapacity) je klidné prázdno, ne chyba', () => {
    const r = buildOpsReport(input({
      waiting: { state: 'missing_migration' }, inbox: { state: 'missing_migration' }, capacity: { state: 'missing_migration' },
    }))
    expect(sec(r, 'na-klienta')).toMatchObject({ items: [], unavailable: [] })
    expect(sec(r, 'ke-schvaleni')).toMatchObject({ items: [], unavailable: [] })
    expect(keys(sec(r, 'riziko'))).not.toContain('pretizeni-u-viktor')
    expect(r.unavailable).toEqual([])
  })
})

describe('klidný týden', () => {
  test('nic k řešení: sekce existují s nulou a klidnou větou', () => {
    const di: DigestInput = { ...digestInput(), followUps: [], outreach: [], blockedDeals: [] }
    const r = buildOpsReport(input({
      changes: { sections: buildChangeSections([], { canSeeSales: true }), unavailable: [] },
      portfolio: { state: 'ok', items: [], unavailable: [] },
      waiting: { state: 'ok', items: [] },
      capacity: { state: 'ok', members: [], allocations: [] },
      inbox: { state: 'ok', approvals: [], decisions: [] },
      pendingProposals: 0,
      unmatchedNotes: 0,
      digest: { digest: buildDigest(di), source: di },
    }))
    expect(r.headline).toBe('Nic k řešení.')
    expect(r.isEmpty).toBe(true)
    expect(r.attention).toBe(0)
    expect(r.sections).toHaveLength(7)
    for (const s of r.sections) {
      expect(s.total).toBe(0)
      expect(s.calm.length).toBeGreaterThan(5)
    }
  })
})

describe('pomocné', () => {
  test('dueWhen', () => {
    expect([0, 1, 2, 5, -1, -3].map(dueWhen)).toEqual(['dnes', 'zítra', 'za 2 dny', 'za 5 dní', 'o 1 den po termínu', 'o 3 dny po termínu'])
  })
})
