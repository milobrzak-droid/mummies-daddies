import { describe, expect, test } from 'vitest'
import {
  COMMANDS, filterCommands, foldText, goTarget, isTypingTarget, visibleCommands,
} from '@/lib/commands'

describe('příkazy palety: viditelnost podle role', () => {
  const ids = (canSeeSales: boolean, isAdmin: boolean) => visibleCommands({ canSeeSales, isAdmin }).map((c) => c.id)

  test('obchodní role vidí obchody, finance a zápis aktivity', () => {
    const all = ids(true, false)
    for (const id of ['act-deal', 'act-activity', 'nav-deals', 'nav-finance', 'nav-meetings']) expect(all).toContain(id)
    expect(all).not.toContain('nav-team')
  })

  test('bez obchodní role paleta obchody a finance vůbec nenabídne', () => {
    const all = ids(false, false)
    for (const c of COMMANDS.filter((x) => x.salesOnly)) expect(all).not.toContain(c.id)
    expect(all).toContain('nav-today')
    expect(all).toContain('act-task')
  })

  test('Reporty obchodů jen obchodním rolím, Dodávky všem', () => {
    const reports = COMMANDS.find((c) => c.id === 'nav-deal-reports')
    expect(reports?.href).toBe('/cockpit/pipeline/reporty')
    expect(ids(true, false)).toContain('nav-deal-reports')
    expect(ids(false, false)).not.toContain('nav-deal-reports')
    const deliveries = COMMANDS.find((c) => c.id === 'nav-deliveries')
    expect(deliveries?.href).toBe('/cockpit/dodavky')
    expect(ids(false, false)).toContain('nav-deliveries')
    expect(ids(true, false)).toContain('nav-deliveries')
  })

  test('paleta najde Reporty obchodů i Dodávky podle názvu', () => {
    const sales = visibleCommands({ canSeeSales: true, isAdmin: false })
    expect(filterCommands(sales, 'reporty')[0]?.id).toBe('nav-deal-reports')
    expect(filterCommands(sales, 'dodavky')[0]?.id).toBe('nav-deliveries')
    expect(filterCommands(visibleCommands({ canSeeSales: false, isAdmin: false }), 'reporty')).toEqual([])
  })

  test('tým a nastavení jen pro správce', () => {
    expect(ids(true, true)).toContain('nav-team')
    expect(ids(true, false)).not.toContain('nav-team')
  })

  test('každý příkaz má jedinečné id a cestu začínající lomítkem', () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
    for (const c of COMMANDS) expect(c.href.startsWith('/')).toBe(true)
  })
})

describe('filterCommands', () => {
  test('prázdný dotaz vrací vše', () => {
    expect(filterCommands(COMMANDS, '  ')).toHaveLength(COMMANDS.length)
  })

  test('ignoruje diakritiku a velikost písmen', () => {
    expect(foldText('Schůzky')).toBe('schuzky')
    expect(filterCommands(COMMANDS, 'SCHUZKY').map((c) => c.id)).toContain('nav-meetings')
    expect(filterCommands(COMMANDS, 'uk').map((c) => c.id)).toContain('nav-tasks')
  })

  test('shoda podle klíčových slov, ne jen názvu', () => {
    expect(filterCommands(COMMANDS, 'firma').map((c) => c.id)).toContain('act-client')
    expect(filterCommands(COMMANDS, 'poznamka').map((c) => c.id)).toContain('act-activity')
  })

  test('všechna slova dotazu musí sedět', () => {
    const ids = filterCommands(COMMANDS, 'novy klient').map((c) => c.id)
    expect(ids).toEqual(['act-client'])
  })

  test('názvy začínající dotazem jdou první', () => {
    const ids = filterCommands(COMMANDS, 'klient').map((c) => c.id)
    expect(ids[0]).toBe('nav-clients')
    expect(ids).toContain('act-client')
  })

  test('nic nesedí: prázdný výsledek', () => {
    expect(filterCommands(COMMANDS, 'qqqqzz')).toEqual([])
  })
})

describe('zkratky', () => {
  test('G + klávesa vede na sekci, obchody a finance jen obchodním rolím', () => {
    expect(goTarget('d', false)).toBe('/cockpit')
    expect(goTarget('K', false)).toBe('/cockpit/clients')
    expect(goTarget('o', false)).toBeNull()
    expect(goTarget('o', true)).toBe('/cockpit/pipeline')
    expect(goTarget('f', false)).toBeNull()
    expect(goTarget('x', true)).toBeNull()
  })

  test('zkratky se nespouštějí při psaní do pole', () => {
    const input = document.createElement('input')
    const select = document.createElement('select')
    const textarea = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const div = document.createElement('div')
    for (const el of [input, select, textarea, editable]) expect(isTypingTarget(el)).toBe(true)
    expect(isTypingTarget(div)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
