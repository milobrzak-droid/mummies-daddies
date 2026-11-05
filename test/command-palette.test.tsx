import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { searchPalette } from '@/domain/crm/actions/paletteSearch'
import { CommandPaletteProvider, useCommandPalette } from '@/components/CommandPalette'

// Chování palety ⌘K v prohlížeči (happy-dom): otevření zkratkou, ARIA dialog
// a combobox, fokus (zachycen a vrácen), šipky + Enter, Esc, filtrace příkazů,
// hledání záznamů se zpožděním a oprávnění (obchody jen obchodní role).

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/domain/crm/actions/paletteSearch', () => ({ searchPalette: vi.fn() }))

let container: HTMLDivElement
let root: Root

function Opener() {
  const palette = useCommandPalette()
  return <button id="opener" onClick={() => palette.open()}>Hledat</button>
}

function mount(props: { canSeeSales?: boolean; isAdmin?: boolean } = {}) {
  act(() => {
    root.render(
      <CommandPaletteProvider canSeeSales={props.canSeeSales ?? true} isAdmin={props.isAdmin ?? false}>
        <main id="main" tabIndex={-1}><Opener /><input id="field" /></main>
      </CommandPaletteProvider>,
    )
  })
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
const labels = () => options().map((o) => o.textContent ?? '')

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  push.mockReset()
  vi.mocked(searchPalette).mockResolvedValue({ ok: true, items: [] })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.style.overflow = ''
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('otevření a přístupnost', () => {
  test('zavřená paleta nic nevykreslí', () => {
    mount()
    expect(dialog()).toBeNull()
  })

  test('Ctrl+K otevře dialog s ARIA a fokusem ve vstupu', () => {
    mount()
    press('k', { ctrlKey: true })
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('aria-label')).toBe('Paleta příkazů')
    expect(document.activeElement).toBe(input())
    expect(input().getAttribute('aria-controls')).toBe(document.querySelector('[role="listbox"]')!.id)
    expect(document.querySelector('[role="status"]')).not.toBeNull()
  })

  test('⌘K funguje i v poli a přepíná (druhé stisknutí zavře)', () => {
    mount()
    const field = document.getElementById('field')!
    press('k', { metaKey: true }, field)
    expect(dialog()).not.toBeNull()
    press('k', { metaKey: true }, input())
    expect(dialog()).toBeNull()
  })

  test('lomítko otevře paletu jen mimo pole', () => {
    mount()
    press('/', {}, document.getElementById('field')!)
    expect(dialog()).toBeNull()
    press('/')
    expect(dialog()).not.toBeNull()
  })

  test('Esc zavře a vrátí fokus na tlačítko, ze kterého se otevřela', () => {
    mount()
    const opener = document.getElementById('opener')!
    opener.focus()
    act(() => opener.click())
    expect(dialog()).not.toBeNull()
    expect(document.activeElement).toBe(input())
    press('Escape')
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  test('Tab nevyleze z dialogu', () => {
    mount()
    press('k', { ctrlKey: true })
    const closeBtn = dialog()!.querySelector<HTMLButtonElement>('button')!
    // z posledního prvku dopředu na první, z prvního zpět na poslední
    closeBtn.focus()
    press('Tab', {}, closeBtn)
    expect(document.activeElement).toBe(input())
    press('Tab', { shiftKey: true }, input())
    expect(document.activeElement).toBe(closeBtn)
    // fokus mimo dialog se vrátí dovnitř
    document.getElementById('opener')!.focus()
    press('Tab', {}, document.getElementById('opener')!)
    expect(dialog()!.contains(document.activeElement)).toBe(true)
  })

  test('otevřená paleta zamkne posouvání stránky a po zavření ho vrátí', () => {
    mount()
    press('k', { ctrlKey: true })
    expect(document.body.style.overflow).toBe('hidden')
    press('Escape')
    expect(document.body.style.overflow).toBe('')
  })
})

describe('příkazy a klávesnice', () => {
  test('bez dotazu ukáže akce a navigaci', () => {
    mount()
    press('k', { ctrlKey: true })
    const headings = [...document.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-labelledby'))
    expect(headings).toHaveLength(2)
    expect(labels().join('|')).toContain('Nový úkol')
    expect(labels().join('|')).toContain('Dnes')
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
  })

  test('filtruje příkazy bez ohledu na diakritiku', async () => {
    mount()
    press('k', { ctrlKey: true })
    await type('novy klient')
    expect(labels()).toHaveLength(1 + 1) // příkaz + řádek „Hledat ve všech záznamech“
    expect(labels()[0]).toContain('Nový klient')
  })

  test('šipky vybírají (i dokola) a Enter otevře vybraný příkaz a zavře paletu', async () => {
    mount()
    press('k', { ctrlKey: true })
    await type('novy')
    const before = options().length
    expect(before).toBeGreaterThan(2)
    press('ArrowDown', {}, input())
    expect(options()[1].getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1].id)
    press('ArrowUp', {}, input())
    press('ArrowUp', {}, input())
    expect(options()[before - 1].getAttribute('aria-selected')).toBe('true')
    press('ArrowDown', {}, input())
    press('Enter', {}, input())
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('/cockpit/tasks#novy-ukol')
    expect(dialog()).toBeNull()
  })

  test('klik na položku naviguje', () => {
    mount()
    press('k', { ctrlKey: true })
    const clients = options().find((o) => o.textContent?.startsWith('Klienti'))!
    act(() => clients.click())
    expect(push).toHaveBeenCalledWith('/cockpit/clients')
    expect(dialog()).toBeNull()
  })

  test('bez obchodní role nenabídne obchody, finance ani zápis aktivity', async () => {
    mount({ canSeeSales: false })
    press('k', { ctrlKey: true })
    const all = labels().join('|')
    expect(all).toContain('Nový úkol')
    for (const hidden of ['Nový obchod', 'Obchody', 'Finance', 'Zapsat aktivitu']) expect(all).not.toContain(hidden)
    await type('acme')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    // hledání záznamů běží, ale obchody paleta neukazuje
    expect(searchPalette).toHaveBeenCalledWith('acme')
  })

  test('správce vidí Tým a nastavení, ostatní ne', () => {
    mount({ isAdmin: true })
    press('k', { ctrlKey: true })
    expect(labels().join('|')).toContain('Tým a nastavení')
    press('Escape')
    act(() => root.unmount())
    root = createRoot(container)
    mount({ isAdmin: false })
    press('k', { ctrlKey: true })
    expect(labels().join('|')).not.toContain('Tým a nastavení')
  })
})

describe('hledání záznamů', () => {
  test('po pauze zavolá akci jednou a ukáže výsledky ve skupinách', async () => {
    vi.mocked(searchPalette).mockResolvedValue({
      ok: true,
      items: [
        { kind: 'account', id: 7, title: 'Acme a.s.', subtitle: 'IČO 123', href: '/cockpit/clients/7' },
        { kind: 'contact', id: 3, title: 'Jana Nováková', subtitle: 'jana@acme.cz', href: '/cockpit/kontakty/3/edit' },
      ],
    })
    mount()
    press('k', { ctrlKey: true })
    await type('ac')
    await type('acme')
    expect(searchPalette).not.toHaveBeenCalled() // ještě neuplynulo zpoždění
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(searchPalette).toHaveBeenCalledTimes(1)
    expect(searchPalette).toHaveBeenCalledWith('acme')
    expect(labels().join('|')).toContain('Acme a.s.')
    expect(labels().join('|')).toContain('Jana Nováková')
    const acme = options().find((o) => o.textContent?.includes('Acme a.s.'))!
    act(() => acme.click())
    expect(push).toHaveBeenCalledWith('/cockpit/clients/7')
  })

  test('jeden znak nespouští hledání a poradí, že je potřeba víc', async () => {
    mount()
    press('k', { ctrlKey: true })
    await type('a')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(searchPalette).not.toHaveBeenCalled()
    expect(dialog()!.textContent).toContain('aspoň 2 znaky')
  })

  test('vždy nabídne hledání na stránce Hledat (žádná slepá ulička)', async () => {
    mount()
    press('k', { ctrlKey: true })
    await type('zzzz qq')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(dialog()!.textContent).toContain('Nic jsme nenašli')
    const last = options()[options().length - 1]
    expect(last.textContent).toContain('Hledat „zzzz qq“')
    act(() => last.click())
    expect(push).toHaveBeenCalledWith('/cockpit/hledat?q=zzzz%20qq')
  })

  test('chyba hledání se ukáže a paleta dál funguje', async () => {
    vi.mocked(searchPalette).mockResolvedValue({ ok: false, error: 'Hledání se nepovedlo. Zkus to znovu.' })
    mount()
    press('k', { ctrlKey: true })
    await type('acme')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(dialog()!.textContent).toContain('Hledání se nepovedlo')
    expect(options().length).toBeGreaterThan(0)
  })

  test('odpověď na starší dotaz se zahodí', async () => {
    let resolveFirst: (v: Awaited<ReturnType<typeof searchPalette>>) => void = () => {}
    vi.mocked(searchPalette)
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
      .mockResolvedValueOnce({ ok: true, items: [{ kind: 'account', id: 2, title: 'Nová firma', subtitle: null, href: '/cockpit/clients/2' }] })
    mount()
    press('k', { ctrlKey: true })
    await type('stara')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    await type('nova')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    await act(async () => { resolveFirst({ ok: true, items: [{ kind: 'account', id: 1, title: 'Stará firma', subtitle: null, href: '/cockpit/clients/1' }] }) })
    expect(labels().join('|')).toContain('Nová firma')
    expect(labels().join('|')).not.toContain('Stará firma')
  })
})
