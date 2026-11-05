import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CommandPaletteProvider } from '@/components/CommandPalette'
import { ShortcutsProvider, useShortcutsHelp } from '@/components/Shortcuts'

// Klávesové zkratky: ? přehled, G + písmeno = přechod, C = zakládání.
// Nesmí kolidovat s psaním do polí ani s otevřenými modálními vrstvami.

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/domain/crm/actions/paletteSearch', () => ({ searchPalette: vi.fn(async () => ({ ok: true, items: [] })) }))

let container: HTMLDivElement
let root: Root

function HelpButton() {
  const help = useShortcutsHelp()
  return <button id="help-btn" onClick={() => help.open()}>Zkratky</button>
}

function mount(canSeeSales = true) {
  act(() => {
    root.render(
      <CommandPaletteProvider canSeeSales={canSeeSales} isAdmin={false}>
        <ShortcutsProvider canSeeSales={canSeeSales}>
          <main id="main" tabIndex={-1}><HelpButton /><input id="field" /><textarea id="area" /></main>
        </ShortcutsProvider>
      </CommandPaletteProvider>,
    )
  })
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

const help = () => document.querySelector<HTMLElement>('[aria-labelledby="shortcuts-title"]')
const palette = () => document.querySelector<HTMLElement>('[aria-label="Paleta příkazů"]')

beforeEach(() => {
  vi.useFakeTimers()
  push.mockReset()
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
})

describe('přehled zkratek', () => {
  test('? otevře dialog s ARIA a fokusem na tlačítku Zavřít, Esc zavře a vrátí fokus', () => {
    mount()
    const btn = document.getElementById('help-btn')!
    btn.focus()
    press('?', { shiftKey: true }, btn)
    const d = help()!
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.textContent).toContain('Klávesové zkratky')
    expect(d.textContent).toContain('⌘K')
    expect(d.contains(document.activeElement)).toBe(true)
    press('Escape')
    expect(help()).toBeNull()
    expect(document.activeElement).toBe(btn)
  })

  test('tlačítko v menu (kontext) přehled otevře', () => {
    mount()
    act(() => document.getElementById('help-btn')!.click())
    expect(help()).not.toBeNull()
  })

  test('obchodní zkratky se bez obchodní role v přehledu neukážou', () => {
    mount(false)
    press('?', { shiftKey: true })
    const text = help()!.textContent!
    expect(text).toContain('Klienti')
    expect(text).not.toContain('Obchody')
    expect(text).not.toContain('Finance')
  })

  test('? v poli nic neotevře', () => {
    mount()
    press('?', { shiftKey: true }, document.getElementById('field')!)
    expect(help()).toBeNull()
  })
})

describe('G a písmeno', () => {
  test('G pak K přejde na klienty', () => {
    mount()
    press('g')
    press('k')
    expect(push).toHaveBeenCalledWith('/cockpit/clients')
  })

  test('G pak D přejde na Dnes, G pak O na obchody', () => {
    mount()
    press('g'); press('d')
    expect(push).toHaveBeenLastCalledWith('/cockpit')
    press('g'); press('o')
    expect(push).toHaveBeenLastCalledWith('/cockpit/pipeline')
  })

  test('bez obchodní role G pak O ani G pak F nikam nevede', () => {
    mount(false)
    press('g'); press('o')
    press('g'); press('f')
    expect(push).not.toHaveBeenCalled()
  })

  test('po vypršení okna (1,2 s) druhá klávesa nic nedělá', () => {
    mount()
    press('g')
    act(() => { vi.advanceTimersByTime(1500) })
    press('k')
    expect(push).not.toHaveBeenCalled()
  })

  test('v poli se G+písmeno nespouští (psaní slova „gk“)', () => {
    mount()
    const field = document.getElementById('field')!
    press('g', {}, field)
    press('k', {}, field)
    press('g', {}, document.getElementById('area')!)
    press('d', {}, document.getElementById('area')!)
    expect(push).not.toHaveBeenCalled()
  })

  test('s modifikátorem se zkratka nespouští (⌘G, Ctrl+K nepatří sem)', () => {
    mount()
    press('g', { metaKey: true })
    press('k')
    expect(push).not.toHaveBeenCalled()
  })

  test('G a jiná klávesa zkratku zruší', () => {
    mount()
    press('g'); press('x'); press('k')
    expect(push).not.toHaveBeenCalled()
  })
})

describe('C zakládá', () => {
  test('C otevře paletu jen s akcemi zakládání', () => {
    mount()
    press('c')
    const p = palette()!
    expect(p).not.toBeNull()
    expect(p.textContent).toContain('Nový úkol')
    expect(p.textContent).not.toContain('Přejít na')
    expect(p.textContent).not.toContain('Týden')
  })

  test('C v poli nic neotevře', () => {
    mount()
    press('c', {}, document.getElementById('field')!)
    expect(palette()).toBeNull()
  })

  test('pod otevřeným přehledem zkratky nefungují', () => {
    mount()
    press('?', { shiftKey: true })
    press('c')
    expect(palette()).toBeNull()
    press('g'); press('k')
    expect(push).not.toHaveBeenCalled()
  })
})
