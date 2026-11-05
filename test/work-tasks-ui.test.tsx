import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn() }))

import { TaskForm } from '@/components/TaskForm'

// Úkoly (vlna 2): rychlé přidání řádkem místo velkého formuláře pod tabulí.
// Stačí název; zbytek je pod <details>, zodpovědný je přihlášený člověk.

const members = [
  { id: 'a', full_name: 'Alena' },
  { id: 'b', full_name: 'Bořek' },
]
const action = vi.fn()

describe('rychlé přidání úkolu', () => {
  test('název s popiskem pro čtečku, jedno tlačítko Přidat, zbytek sbalený', () => {
    const html = renderToStaticMarkup(<TaskForm action={action} members={members} showDeals={false} defaultAssigneeId="b" />)
    expect(html).toContain('aria-label="Přidat úkol"')
    expect(html).toContain('<label for="task-quick-title" class="sr-only">Název nového úkolu</label>')
    expect(html).toContain('name="title"')
    expect(html).toContain('placeholder="Přidat úkol…"')
    expect(html).toMatch(/<details[^>]*>/)
    expect(html).not.toMatch(/<details[^>]*open/)
    expect(html).toContain('Termín, zodpovědný, klient')
    expect(html.match(/type="submit"/g)).toHaveLength(1)
  })

  test('zodpovědný je předvyplněný přihlášeným člověkem', () => {
    const html = renderToStaticMarkup(<TaskForm action={action} members={members} showDeals={false} defaultAssigneeId="b" />)
    expect(html).toMatch(/<option value="b" selected="">Bořek<\/option>/)
  })

  test('neznámý přihlášený (není v týmu) → nikdo, žádný vymyšlený výběr', () => {
    const html = renderToStaticMarkup(<TaskForm action={action} members={members} showDeals={false} defaultAssigneeId="x" />)
    expect(html).toMatch(/<option value="" selected="">— nikdo —<\/option>/)
  })

  test('výběr obchodu jen pro obchodní role', () => {
    const deals = [{ id: 7, title: 'Pilot', account: { name: 'ALFATECH' } }]
    expect(renderToStaticMarkup(<TaskForm action={action} members={members} deals={deals} showDeals={false} />)).not.toContain('name="deal_id"')
    expect(renderToStaticMarkup(<TaskForm action={action} members={members} deals={deals} showDeals />)).toContain('ALFATECH · Pilot')
  })
})
