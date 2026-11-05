import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { ChangesCard } from '@/components/ui/ChangesCard'
import { WaitingCard } from '@/components/ui/WaitingCard'
import { buildChangeSections, emailChanges, milestoneChanges, stageChanges, workChanges } from '@/domain/crm/changes'
import { buildWaitingItems, reminderTaskTitle, type WaitingMilestoneRow } from '@/domain/delivery/waiting'

// Vykreslení karet „Co se změnilo“ a „Čeká na klienta“ (smoke): texty česky,
// důkaz s odkazem u každé položky, klidné prázdné stavy, jeden hlavní úkon.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const NOW_SECTIONS = () => {
  const items = [
    ...emailChanges([{ id: 1, occurred_at: '2026-09-29T06:15:00Z', account_id: 7, account_name: 'ALFATECH' }]),
    ...stageChanges(
      [{ id: 40, action: 'deal.stage_changed', entity_id: 5, occurred_at: '2026-09-29T05:00:00Z', before: { stage: 'diagnostika' }, after: { stage: 'rozhodovani' } }],
      new Map([[5, { id: 5, title: 'AI agent', account_id: 7, account_name: 'ALFATECH' }]]),
    ),
    ...workChanges({ tasks: [{ id: 2, title: 'Poslat podklady', created_at: '2026-09-29T04:00:00Z', created_by: null, assignee_id: null, due_on: null, status: 'todo', account_name: null }], cases: [] }, 'me'),
    ...milestoneChanges({ events: [], milestones: [{ id: 9, title: 'Procesní mapa', status: 'v_praci', updated_at: '2026-09-29T03:00:00Z', engagement_id: 3, account_id: 7, account_name: 'ALFATECH' }] }, { since: new Date('2026-09-28T00:00:00Z'), until: new Date('2026-09-30T00:00:00Z') }),
  ]
  return buildChangeSections(items, { canSeeSales: true })
}

describe('karta Co se změnilo', () => {
  test('dlaždice s počty, nejnovější položky s odkazem na záznam a označením důkazu', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={NOW_SECTIONS()} windowLabel="od tvé poslední návštěvy (včera v 15:00)" mode="today" />)
    expect(html).toContain('Co se změnilo')
    expect(html).toContain('4 změny od tvé poslední návštěvy (včera v 15:00)')
    for (const label of ['Nové e-maily od klientů', 'Posun fáze obchodu', 'Rozhodnutí', 'Nové úkoly a případy', 'Milníky dodávek', 'Faktury a platby']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('href="/cockpit/clients/7"')
    expect(html).toContain('href="/cockpit/clients/7/deals/5"')
    expect(html).toContain('Upřesnění → Zákazník rozhoduje')
    expect(html).toContain('Důkaz: Záznam v auditu č. 40')
    expect(html).toContain('Důkaz: Úkol č. 2')
    expect(html).toContain('href="/cockpit/prehled-tydne"')
  })

  test('méně hluku: plná barva a klávesa jen u nenulových dlaždic, nula je klidná a není odkazem', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={NOW_SECTIONS()} windowLabel="x" mode="today" />)
    // Nenulové: klávesa v barvě značky s počtem pro čtečku.
    expect(html).toMatch(/<a class="keycap keycap-\w+ [^"]*" aria-label="Nové e-maily od klientů: 1" href="\/cockpit\/clients\?sort=aktivita">/)
    // Nulové: žádná klávesa ani odkaz, pastelová plocha.
    expect(html).not.toContain('aria-label="Rozhodnutí: 0"')
    expect(html).not.toContain('keycap-white')
    expect(html).toMatch(/<div class="[^"]*bg-\[color:var\(--p-\w+\)\][^"]*"><span class="eyebrow">Rozhodnutí<\/span>/)
    expect(html.match(/class="keycap /g)).toHaveLength(4)
  })

  test('nejnovější položky jsou seskupené podle druhu (název druhu jednou nad řádky)', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={NOW_SECTIONS()} windowLabel="x" mode="today" />)
    expect(html).toContain('Nejnovější')
    for (const label of ['Nové e-maily od klientů', 'Posun fáze obchodu', 'Nové úkoly a případy', 'Milníky dodávek']) {
      expect(html).toContain(`<section aria-label="${label}">`)
    }
    // Skupina s nejčerstvější změnou je první (e-mail 06:15 před posunem fáze 05:00).
    expect(html.indexOf('<section aria-label="Nové e-maily od klientů">')).toBeLessThan(html.indexOf('<section aria-label="Posun fáze obchodu">'))
  })

  test('prázdný stav je klidný a nezaslíbí nic vymyšleného', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={buildChangeSections([], { canSeeSales: true })} windowLabel="za posledních 7 dní" mode="today" />)
    expect(html).toContain('Nic se nezměnilo za posledních 7 dní')
    expect(html).toContain('Od poslední návštěvy se nic nezměnilo')
    expect(html).not.toContain('Nejnovější')
  })

  test('role bez obchodu vidí jen tři dlaždice, žádné obchodní popisky', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={buildChangeSections([], { canSeeSales: false })} windowLabel="x" mode="today" />)
    expect(html).toContain('Milníky dodávek')
    for (const hidden of ['e-maily od klientů', 'Posun fáze obchodu', 'Faktury a platby']) expect(html).not.toContain(hidden)
  })

  test('nenačtený druh se přizná, místo aby karta tvrdila „nic se nezměnilo“', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={buildChangeSections([], { canSeeSales: true })} windowLabel="x" unavailable={['email']} mode="today" />)
    expect(html).toContain('Nepodařilo se načíst: Nové e-maily od klientů')
    expect(html).not.toContain('Od poslední návštěvy se nic nezměnilo')
  })

  test('týdenní režim rozepíše sekce a nemá odkaz na týdenní přehled', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={NOW_SECTIONS()} windowLabel="za týden 39: po 21. 9. až ne 27. 9." mode="week" />)
    expect(html).toContain('za týden 39: po 21. 9. až ne 27. 9.')
    expect(html).toContain('aria-label="Nové e-maily od klientů"')
    expect(html).not.toContain('Nejnovější')
    expect(html).not.toContain('href="/cockpit/prehled-tydne"')
  })

  test('vysvětlení okna (první návštěva) se ukáže', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={buildChangeSections([], { canSeeSales: true })} windowLabel="za posledních 7 dní" note="Je to tvoje první návštěva, proto ukazuju poslední týden." mode="today" />)
    expect(html).toContain('Je to tvoje první návštěva')
  })

  test('nepoužívá slova, která mají zůstat mimo texty pro lidi', () => {
    const html = renderToStaticMarkup(<ChangesCard sections={NOW_SECTIONS()} windowLabel="x" mode="week" />)
    const text = html.replace(/<[^>]*>/g, ' ') // jen viditelný text, ne adresy
    expect(text).not.toMatch(/engagement|uzel|\bL[1-4]\b|pipeline|baseline|delivery/i)
  })
})

describe('karta Čeká na klienta', () => {
  const row = (over: Partial<WaitingMilestoneRow> = {}): WaitingMilestoneRow => ({
    id: 1, engagement_id: 3, title: 'Procesní mapa', owner_id: null, status: 'ceka_na_schvaleni', due_on: '2026-09-20',
    updated_at: '2026-09-22T08:00:00Z', created_at: '2026-09-01T08:00:00Z',
    engagement: { id: 3, account_id: 1, kind: 'it', phase: 'pilot', account_name: 'ALFATECH' }, ...over,
  })
  const items = (rows: WaitingMilestoneRow[], open = new Map<number, Set<string>>()) =>
    buildWaitingItems({ milestones: rows, moves: new Map(), openReminders: open, contacts: new Map([[3, { name: 'Jana', email: 'jana@firma.cz' }]]), today: '2026-09-29' })

  test('řádek: klient, co se čeká, jak dlouho, po termínu, hlavní úkon a návrh e-mailu bez odeslání', () => {
    const html = renderToStaticMarkup(<WaitingCard result={{ state: 'ok', items: items([row()]) }} />)
    expect(html).toContain('Čeká na klienta')
    expect(html).toContain('1 věc čeká na klienta · 1 po termínu')
    expect(html).toContain('ALFATECH · Akce')
    expect(html).toContain('Procesní mapa')
    expect(html).toContain('Odesláno klientovi 22. 9., zatím není přijato.')
    expect(html).toContain('Čeká už 7 dní')
    expect(html).toContain('Po termínu o 9 dní')
    expect(html).toContain('Bez pohybu')
    expect(html).toContain('Připomenout klientovi')
    expect(html).toContain('Založí úkol s návrhem e-mailu. Nic se neodesílá.')
    expect(html).toContain('href="mailto:jana@firma.cz?subject=')
    expect(html).toContain('Odejde teprve tehdy, když ho odešleš sám.')
    expect(html).toContain('href="/cockpit/clients/1/engagements/3/edit?zalozka=milniky"')
    // Jeden úkon na řádek, sekundární (koral patří jen hlavní akci obrazovky).
    expect(html.match(/btn-secondary/g)).toHaveLength(1)
    expect(html).not.toMatch(/btn-coral|btn-primary/)
  })

  test('u dodávky (scope engagement) se klient neopakuje', () => {
    const html = renderToStaticMarkup(<WaitingCard scope="engagement" result={{ state: 'ok', items: items([row()]) }} />)
    expect(html).not.toContain('ALFATECH · Akce')
    expect(html).toContain('Procesní mapa')
  })

  test('připomínka už je založená: místo tlačítka klidná věta s odkazem na úkoly', () => {
    const html = renderToStaticMarkup(<WaitingCard result={{ state: 'ok', items: items([row()], new Map([[3, new Set([reminderTaskTitle('Procesní mapa')])]])) }} />)
    expect(html).toContain('Připomínka je založená v')
    expect(html).toContain('href="/cockpit/tasks"')
    expect(html).not.toContain('btn-secondary')
  })

  test('nic nečeká: klidný stav', () => {
    const html = renderToStaticMarkup(<WaitingCard result={{ state: 'ok', items: [] }} />)
    expect(html).toContain('Nic nečeká na klienta')
    expect(html).not.toContain('Připomenout klientovi')
  })

  test('víc než limit: zbytek se jen spočítá', () => {
    const many = items(Array.from({ length: 7 }, (_, i) => row({ id: i + 1, title: `Milník ${i + 1}` })))
    const html = renderToStaticMarkup(<WaitingCard result={{ state: 'ok', items: many }} max={5} />)
    expect(html).toContain('A dalších 2 čeká na klienta.')
    expect(html).toContain('Milník 5')
    expect(html).not.toContain('Milník 6')
  })

  test('chybějící migrace a chyba čtení mají klidnou hlášku', () => {
    const missing = renderToStaticMarkup(<WaitingCard result={{ state: 'missing_migration' }} />)
    expect(missing).toContain('Tahle část se připravuje.')
    expect(missing).not.toContain('0042')
    const err = renderToStaticMarkup(<WaitingCard result={{ state: 'error', message: 'boom' }} />)
    expect(err).toContain('role="alert"')
    expect(err).not.toContain('boom')
  })

  test('bez kontaktu klienta nabídne adresu doplnit v poště; mailto bez příjemce', () => {
    const html = renderToStaticMarkup(<WaitingCard result={{ state: 'ok', items: buildWaitingItems({ milestones: [row()], moves: new Map(), openReminders: new Map(), contacts: new Map(), today: '2026-09-29' }) }} />)
    expect(html).toContain('adresu doplníš v poště')
    expect(html).toContain('href="mailto:?subject=')
  })
})
