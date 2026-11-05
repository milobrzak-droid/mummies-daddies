import { describe, expect, test } from 'vitest'
import { buildDigest, type DigestInput } from '@/domain/crm/digest'
import { escapeHtml, normalizeAppUrl, renderDigestEmail, type DigestEmailOptions } from '@/domain/crm/digestEmail'

const EVIL = `<script>alert("x")</script> & 'Řízení' "žluťoučký"`

function input(o: Partial<DigestInput> = {}): DigestInput {
  return {
    followUps: [
      { deal_id: 11, account_id: 3, title: EVIL, account_name: 'Škoda & syn', due: '2026-09-20', days_overdue: 8, level: 'manager' },
      { deal_id: 12, account_id: null, title: 'Nabídka', account_name: null, due: '2026-09-25', days_overdue: 3, level: 'owner' },
    ],
    outreach: [{ account_id: 7, name: 'Čokoláda <b>s.r.o.</b>', last_direction: 'us', last_at: '2026-08-01', days_silent: 58 }],
    blockedDeals: [{ id: 21, account_id: 5, title: 'Licence', account_name: 'ACME', status_blocker: 'čeká na "právníky"' }],
    connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null },
    lastMeetingNoteAt: '2026-09-27T10:00:00Z',
    outlookMailSyncEnabled: true,
    generatedAt: new Date('2026-09-28T07:00:00Z'),
    ...o,
  }
}

const empty = () => input({ followUps: [], outreach: [], blockedDeals: [] })

function render(i: DigestInput, o: Partial<DigestEmailOptions> = {}) {
  return renderDigestEmail(buildDigest(i), {
    appUrl: 'https://cockpit.example.cz/', generatedAtLabel: 'pondělí 28. 9. 2026', source: i, ...o,
  })
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])

describe('escapeHtml', () => {
  test('escapuje všech pět znaků, diakritiku nechává', () => {
    expect(escapeHtml(`<a href="x">'&'</a> ěščřžýáíé`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt; ěščřžýáíé')
  })
})

describe('normalizeAppUrl', () => {
  test('odstraní koncová lomítka', () => {
    expect(normalizeAppUrl('https://a.cz///')).toBe('https://a.cz')
    expect(normalizeAppUrl('https://a.cz/cockpit/')).toBe('https://a.cz/cockpit')
  })
  test.each(['http://a.cz', 'javascript:alert(1)', 'nesmysl', '', 'https://u:p@a.cz', 'https://a.cz/?x=1', 'https://a.cz/#x'])(
    'odmítne %s', (url) => { expect(() => normalizeAppUrl(url)).toThrow() },
  )
  test('renderDigestEmail odmítne http appUrl', () => {
    expect(() => render(input(), { appUrl: 'http://cockpit.example.cz' })).toThrow(/https/)
  })
})

describe('renderDigestEmail — plný digest', () => {
  const i = input()
  const { subject, html, text } = render(i)

  test('předmět česky s týdnem a počtem', () => {
    expect(subject).toContain('Přehled týdne pondělí 28. 9. 2026')
    expect(subject).toContain('4 položky')
    expect(subject).toContain('Follow-upy po termínu: 2')
    expect(subject).not.toMatch(/[\r\n]/)
  })

  test('žádný neescapovaný vstup', () => {
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Řízení&#39; &quot;žluťoučký&quot;')
    expect(html).toContain('Škoda &amp; syn')
    expect(html).toContain('Čokoláda &lt;b&gt;s.r.o.&lt;/b&gt;')
    expect(html).toContain('čeká na &quot;právníky&quot;')
  })

  test('e-mailově bezpečná struktura', () => {
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('max-width:600px')
    expect(html).toContain('lang="cs"')
    expect(html).not.toMatch(/<style|<link|<img|<script|<iframe|class=/i)
    expect(html).not.toMatch(/url\(/)
    expect(html).toContain('role="presentation"')
    for (const hex of ['#141922', '#1A1F28', '#5A6472', '#E7E9EE', '#FF5A5F']) expect(html).toContain(hex)
    expect(html).toContain('-apple-system')
  })

  test('každá položka odkazuje absolutně na svůj záznam', () => {
    const links = hrefs(html)
    expect(links).toEqual([
      'https://cockpit.example.cz/cockpit/clients/3/deals/11',
      'https://cockpit.example.cz/cockpit/pipeline?deal=12',
      'https://cockpit.example.cz/cockpit/clients/7',
      'https://cockpit.example.cz/cockpit/clients/5/deals/21',
      'https://cockpit.example.cz/cockpit/prehled-tydne',
    ])
    for (const l of links) expect(l.startsWith('https://')).toBe(true)
  })

  test('vlastní dealPath', () => {
    const r = render(i, { dealPath: (id) => `/deals/${id}` })
    expect(hrefs(r.html)).toContain('https://cockpit.example.cz/deals/11')
  })

  test('sekce ve správném pořadí a Stav zdrojů na konci', () => {
    const order = ['Follow-upy po termínu', 'Firmy k oslovení', 'Blokované obchody', 'Stav zdrojů'].map((t) => html.indexOf(`>${t}<`))
    expect(order.every((p) => p > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test('nikdy nesynchronizovaný konektor je zvýrazněn negativní barvou', () => {
    expect(html).toMatch(/color:#C4362F;">Outlook \(kalendář a úkoly\): nikdy/)
    expect(html).toMatch(/color:#5A6472;">Wispr Flow \(zápisy schůzek přes skill\): poslední zápis /)
  })

  test('textová alternativa staví na renderDigestText a nese odkazy', () => {
    expect(text.startsWith(buildDigest(i).headline)).toBe(true)
    expect(text).toContain('## Stav zdrojů')
    expect(text).toContain('Otevřít v Cockpitu: https://cockpit.example.cz/cockpit/prehled-tydne')
    expect(text).toContain('https://cockpit.example.cz/cockpit/clients/7')
    expect(text).toContain('<script>') // plain text se neescapuje
  })
})

describe('renderDigestEmail — prázdný digest', () => {
  const { subject, html, text } = render(empty())
  test('varianta "Tento týden nic nečeká"', () => {
    expect(subject).toBe('Přehled týdne pondělí 28. 9. 2026: nic nečeká')
    expect(html).toContain('Tento týden nic nečeká')
    expect(text.startsWith('Tento týden nic nečeká.')).toBe(true)
    expect(html).not.toContain('Follow-upy po termínu<')
  })
  test('Stav zdrojů je vždy přítomen', () => {
    expect(html).toContain('>Stav zdrojů<')
    expect(html).toContain('Wispr Flow (zápisy schůzek přes skill)')
    expect(text).toContain('## Stav zdrojů')
  })
  test('jediný odkaz je na přehled', () => {
    expect(hrefs(html)).toEqual(['https://cockpit.example.cz/cockpit/prehled-tydne'])
  })
})

describe('okrajové případy', () => {
  test('zastaralý konektor je zvýrazněn', () => {
    const stale = render(input({ lastMeetingNoteAt: '2026-08-01T10:00:00Z' }))
    expect(stale.html).toMatch(/color:#C4362F;">Wispr Flow \(zápisy schůzek přes skill\): [^<]* — zastaralé/)
  })
  test('nesoulad digestu a source vyhodí chybu', () => {
    const i = input()
    expect(() => renderDigestEmail(buildDigest(i), {
      appUrl: 'https://a.cz', generatedAtLabel: 'x', source: { ...i, outreach: [] },
    })).toThrow(/neodpovídá/)
  })
  test('předmět: 1 položka / 5 položek', () => {
    expect(render(input({ followUps: [], blockedDeals: [] })).subject).toContain('1 položka')
    const many = Array.from({ length: 5 }, (_, k) => ({ id: k, account_id: null, title: 't', account_name: null, status_blocker: 'b' }))
    expect(render(input({ followUps: [], outreach: [], blockedDeals: many })).subject).toContain('5 položek')
  })
  test('label s novým řádkem neprojde do předmětu, label je escapován', () => {
    const r = render(input(), { generatedAtLabel: 'a\r\nBcc: x <i>' })
    expect(r.subject).not.toMatch(/[\r\n]/)
    expect(r.html).toContain('a Bcc: x &lt;i&gt;')
  })
  test('appUrl s cestou se zachová', () => {
    expect(hrefs(render(input(), { appUrl: 'https://a.cz/app/' }).html)[0]).toBe('https://a.cz/app/cockpit/clients/3/deals/11')
  })
})

describe('ranní souhrn (variant daily)', () => {
  const daily = (i: DigestInput) => render(i, { generatedAtLabel: 'středa 30. 9. 2026', variant: 'daily' })

  test('s položkami: předmět a hlavička „Ranní souhrn"', () => {
    const r = daily(input({ outreach: [] }))
    expect(r.subject).toBe('Ranní souhrn středa 30. 9. 2026: 3 položky (Follow-upy po termínu: 2, Blokované obchody: 1)')
    expect(r.html).toContain('Cockpit · Ranní souhrn · středa 30. 9. 2026')
    expect(r.html).not.toContain('Přehled týdne')
  })

  test('bez položek, ale se zdrojem, který potřebuje pozornost', () => {
    const r = daily(input({ followUps: [], outreach: [], blockedDeals: [] }))
    expect(r.subject).toBe('Ranní souhrn středa 30. 9. 2026: zdroje dat vyžadují pozornost')
    expect(r.html).toContain('Zdroje dat vyžadují pozornost')
    expect(r.html).toContain('Pozornost vyžaduje stav zdrojů níže.')
    expect(r.text.startsWith('Zdroje dat vyžadují pozornost.')).toBe(true)
    expect(r.html).toContain('>Stav zdrojů<')
  })

  test('řádek zdroje s chybou je zvýrazněný', () => {
    const state = { connector: 'graph_send', cursor: null, last_success_at: new Date().toISOString(), last_error: 'Chybí oprávnění Mail.Send — znovu připojte Outlook v Nastavení', last_error_at: null, consecutive_errors: 1, updated_at: new Date().toISOString() }
    const r = daily(input({ connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: state } }))
    expect(r.html).toMatch(/color:#C4362F;">Odesílání přehledu \(graph_send\): [^<]* — chyba: Chybí oprávnění Mail\.Send/)
  })

  test('týdenní přehled zůstává beze změny (výchozí varianta)', () => {
    expect(render(empty()).subject).toBe('Přehled týdne pondělí 28. 9. 2026: nic nečeká')
  })
})

describe('oříznuté sekce', () => {
  const outreach = Array.from({ length: 40 }, (_, k) => ({ account_id: 100 + k, name: `Firma ${k}`, last_direction: 'us' as const, last_at: '2026-08-01', days_silent: 90 - k }))
  const i = input({ followUps: [], blockedDeals: [], outreach })
  const { subject, html, text } = render(i)

  test('odkazy jen na vypsaných 15 firem + „a dalších 25" na /oslovovani', () => {
    const links = hrefs(html)
    expect(links.filter((h) => h.startsWith('https://cockpit.example.cz/cockpit/clients/'))).toHaveLength(15)
    expect(links).toContain('https://cockpit.example.cz/cockpit/clients/114')
    expect(links).not.toContain('https://cockpit.example.cz/cockpit/clients/115')
    expect(links).toContain('https://cockpit.example.cz/cockpit/oslovovani')
    expect(html).toContain('… a dalších 25 — celý seznam v Cockpitu')
    expect(text).toContain('- … a dalších 25 — celý seznam v Cockpitu: https://cockpit.example.cz/cockpit/oslovovani')
  })

  test('předmět nese celkový počet (40), ne jen vypsané', () => {
    expect(subject).toBe('Přehled týdne pondělí 28. 9. 2026: 40 položek (Firmy k oslovení: 40)')
  })

  test('nesoulad oříznuté sekce se zdrojem pořád vyhodí', () => {
    expect(() => renderDigestEmail(buildDigest(i), {
      appUrl: 'https://a.cz', generatedAtLabel: 'x', source: { ...i, outreach: outreach.slice(0, 39) },
    })).toThrow(/neodpovídá/)
  })
})
