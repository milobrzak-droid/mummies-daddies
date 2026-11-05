import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UndoToastProvider, useUndoToast, TOAST_DURATION_MS, type ToastOptions } from '@/components/ui/Toast'
import { TaskBoard } from '@/components/TaskBoard'
import type { Task } from '@/lib/types'

// Toast se „Zpět“: přístupná živá oblast, mizí po 6 s (pauza při najetí),
// Zpět a ⌘Z volají undo, chyba vrácení se oznámí. Nasazení: změna stavu úkolu.

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

let container: HTMLDivElement
let root: Root
const api: { show: (o: ToastOptions) => void } = { show: () => {} }
const show = (o: ToastOptions) => api.show(o)

function Grab() {
  const toast = useUndoToast()
  useEffect(() => { api.show = toast.show })
  return null
}

function mount(children: React.ReactNode = null) {
  act(() => {
    root.render(<UndoToastProvider><Grab />{children}</UndoToastProvider>)
  })
}

const region = () => document.querySelector<HTMLElement>('[role="status"]')!
const undoBtn = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Zpět')

beforeEach(() => {
  vi.useFakeTimers()
  refresh.mockReset()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('UndoToast', () => {
  test('živá oblast role=status existuje ještě před prvním toastem', () => {
    mount()
    expect(region()).not.toBeNull()
    expect(region().getAttribute('aria-live')).toBe('polite')
    expect(region().textContent).toBe('')
  })

  test('ukáže zprávu a tlačítko Zpět, po 6 s zmizí', () => {
    mount()
    act(() => show({ message: 'Úkol je hotový.', undo: () => {} }))
    expect(region().textContent).toContain('Úkol je hotový.')
    expect(undoBtn()).toBeDefined()
    act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS - 100) })
    expect(region().textContent).toContain('Úkol je hotový.')
    act(() => { vi.advanceTimersByTime(200) })
    expect(region().textContent).toBe('')
  })

  test('bez undo se tlačítko Zpět nezobrazí', () => {
    mount()
    act(() => show({ message: 'Uloženo.' }))
    expect(undoBtn()).toBeUndefined()
  })

  test('Zpět zavolá undo jednou a toast zavře', async () => {
    const undo = vi.fn()
    mount()
    act(() => show({ message: 'Hotovo.', undo }))
    await act(async () => { undoBtn()!.click() })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(region().textContent).toBe('')
  })

  test('⌘Z / Ctrl+Z vrací, dokud je toast vidět; v poli ne', async () => {
    const undo = vi.fn()
    mount(<input id="f" />)
    act(() => show({ message: 'Hotovo.', undo }))
    const field = document.getElementById('f')!
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(undo).not.toHaveBeenCalled()
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })) })
    expect(undo).toHaveBeenCalledTimes(1)
    // toast je pryč, další ⌘Z už nic nevrací
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })) })
    expect(undo).toHaveBeenCalledTimes(1)
  })

  test('Esc toast zavře, ale ne pod otevřeným modálním dialogem', () => {
    mount()
    act(() => show({ message: 'Hotovo.', undo: () => {} }))
    const dlg = document.createElement('div')
    dlg.setAttribute('aria-modal', 'true')
    document.body.appendChild(dlg)
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(region().textContent).toContain('Hotovo.')
    dlg.remove()
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(region().textContent).toBe('')
  })

  test('při najetí myší se odpočet zastaví a po odchodu pokračuje', () => {
    mount()
    act(() => show({ message: 'Hotovo.', undo: () => {} }))
    act(() => { vi.advanceTimersByTime(4000) })
    const card = region().firstElementChild as HTMLElement
    act(() => { card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    act(() => { vi.advanceTimersByTime(20_000) })
    expect(region().textContent).toContain('Hotovo.') // čas stojí, dokud je myš nad toastem
    act(() => { card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    act(() => { vi.advanceTimersByTime(TOAST_DURATION_MS) })
    expect(region().textContent).toBe('')
  })

  test('nový toast nahradí starý', () => {
    mount()
    act(() => show({ message: 'První.' }))
    act(() => show({ message: 'Druhý.' }))
    expect(region().textContent).toContain('Druhý.')
    expect(region().textContent).not.toContain('První.')
  })

  test('selhání vrácení se oznámí novým toastem', async () => {
    mount()
    act(() => show({ message: 'Hotovo.', undo: async () => { throw new Error('boom') } }))
    await act(async () => { undoBtn()!.click() })
    expect(region().textContent).toContain('Vrácení se nepovedlo')
  })

  test('tlačítka mají přístupné názvy', () => {
    mount()
    act(() => show({ message: 'Hotovo.', undo: () => {} }))
    expect(document.querySelector('button[aria-label="Zavřít oznámení"]')).not.toBeNull()
  })
})

const TASK: Task = {
  id: 5, title: 'Poslat nabídku', description: null, status: 'todo', priority: 'normal',
  assignee_id: null, created_by: null, due_on: null, account_id: null, deal_id: null, engagement_id: null,
  ms_event_id: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
}

// Stav se mění zaškrtnutím (hotovo) nebo segmentem na kartě, ne výběrem.
function clickButton(label: string) {
  const btn = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  )
  if (!btn) throw new Error(`Tlačítko ${label} nenalezeno`)
  return act(async () => { btn.click() })
}

describe('Zpět u změny stavu úkolu', () => {
  test('změna se provede hned, Zpět vrátí původní stav stejnou akcí', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)
    mount(<TaskBoard tasks={[TASK]} members={[]} updateStatus={updateStatus} today="2026-09-29" />)
    await clickButton('Označit jako hotové: Poslat nabídku')
    expect(updateStatus).toHaveBeenCalledWith(5, 'done')
    expect(region().textContent).toContain('Úkol „Poslat nabídku“ je teď ve stavu Hotovo.')
    await act(async () => { undoBtn()!.click() })
    expect(updateStatus).toHaveBeenLastCalledWith(5, 'todo')
    expect(updateStatus).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  test('selhání akce ukáže hlášku bez Zpět', async () => {
    const updateStatus = vi.fn().mockRejectedValue(new Error('rls'))
    mount(<TaskBoard tasks={[TASK]} members={[]} updateStatus={updateStatus} today="2026-09-29" />)
    await clickButton('Blokováno')
    expect(region().textContent).toContain('nepodařilo změnit')
    expect(undoBtn()).toBeUndefined()
  })
})

describe('stav úkolu přímo na kartě', () => {
  test('místo rozevíracího výběru segment se stisknutým stavem a zaškrtnutí', () => {
    mount(<TaskBoard tasks={[{ ...TASK, status: 'in_progress' }]} members={[]} updateStatus={vi.fn()} today="2026-09-29" />)
    expect(document.querySelector('select')).toBeNull()
    const group = document.querySelector('[role="group"][aria-label="Stav úkolu Poslat nabídku"]')!
    const pressed = [...group.querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed.map((b) => b.textContent)).toEqual(['Dělá se'])
    const chk = document.querySelector('button[aria-label="Označit jako hotové: Poslat nabídku"]')!
    expect(chk.getAttribute('aria-pressed')).toBe('false')
  })

  test('segment přesune úkol a Zpět ho vrátí', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)
    mount(<TaskBoard tasks={[TASK]} members={[]} updateStatus={updateStatus} today="2026-09-29" />)
    await clickButton('Dělá se')
    expect(updateStatus).toHaveBeenCalledWith(5, 'in_progress')
    await act(async () => { undoBtn()!.click() })
    expect(updateStatus).toHaveBeenLastCalledWith(5, 'todo')
  })

  test('stisk už platného stavu nic nevolá', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)
    mount(<TaskBoard tasks={[TASK]} members={[]} updateStatus={updateStatus} today="2026-09-29" />)
    await clickButton('K udělání')
    expect(updateStatus).not.toHaveBeenCalled()
  })

  test('hotový úkol nemá segment; zaškrtnutí ho vrátí mezi otevřené', async () => {
    const updateStatus = vi.fn().mockResolvedValue(undefined)
    mount(<TaskBoard tasks={[{ ...TASK, status: 'done' }]} members={[]} updateStatus={updateStatus} today="2026-09-29" />)
    expect(document.querySelector('[role="group"][aria-label^="Stav úkolu"]')).toBeNull()
    await clickButton('Vrátit mezi otevřené: Poslat nabídku')
    expect(updateStatus).toHaveBeenCalledWith(5, 'todo')
  })

  test('rychlé přidání je nahoře v prvním sloupci s kotvou #novy-ukol', () => {
    mount(<TaskBoard tasks={[]} members={[]} updateStatus={vi.fn()} today="2026-09-29" quickAdd={<form aria-label="Přidat úkol" />} />)
    const first = document.querySelector('section')!
    expect(first.querySelector('h2')!.textContent).toContain('K udělání')
    expect(first.querySelector('#novy-ukol form[aria-label="Přidat úkol"]')).not.toBeNull()
    expect(document.querySelectorAll('#novy-ukol')).toHaveLength(1)
  })
})

describe('termín úkolu přímo na kartě', () => {
  const DUE = { ...TASK, due_on: '2026-09-25' } as Task

  function setDate(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const dateField = () => document.querySelector<HTMLInputElement>('input[type="date"][aria-label="Termín úkolu: Poslat nabídku"]')!

  test('změna data zavolá akci, toast nabídne Zpět s původním termínem', async () => {
    const updateDueOn = vi.fn().mockResolvedValue({ success: true })
    mount(<TaskBoard tasks={[DUE]} members={[]} updateStatus={vi.fn()} updateDueOn={updateDueOn} today="2026-09-29" />)
    expect(dateField().value).toBe('2026-09-25')
    await act(async () => { setDate(dateField(), '2026-10-02') })
    expect(updateDueOn).toHaveBeenCalledWith(5, '2026-10-02')
    expect(region().textContent).toContain('Termín úkolu „Poslat nabídku“ je')
    expect(refresh).toHaveBeenCalled()
    await act(async () => { undoBtn()!.click() })
    expect(updateDueOn).toHaveBeenLastCalledWith(5, '2026-09-25')
  })

  test('smazání data = bez termínu, Zpět termín vrátí', async () => {
    const updateDueOn = vi.fn().mockResolvedValue({ success: true })
    mount(<TaskBoard tasks={[DUE]} members={[]} updateStatus={vi.fn()} updateDueOn={updateDueOn} today="2026-09-29" />)
    await act(async () => { setDate(dateField(), '') })
    expect(updateDueOn).toHaveBeenCalledWith(5, null)
    expect(region().textContent).toContain('je bez termínu')
    await act(async () => { undoBtn()!.click() })
    expect(updateDueOn).toHaveBeenLastCalledWith(5, '2026-09-25')
  })

  test('úkol bez termínu jde datem nastavit, Zpět ho zase smaže', async () => {
    const updateDueOn = vi.fn().mockResolvedValue({ success: true })
    mount(<TaskBoard tasks={[TASK]} members={[]} updateStatus={vi.fn()} updateDueOn={updateDueOn} today="2026-09-29" />)
    expect(dateField().value).toBe('')
    await act(async () => { setDate(dateField(), '2026-10-02') })
    await act(async () => { undoBtn()!.click() })
    expect(updateDueOn).toHaveBeenLastCalledWith(5, null)
  })

  test('chyba serveru řekne důvod bez Zpět a vrátí pole na původní datum', async () => {
    const updateDueOn = vi.fn().mockResolvedValue({ success: false, error: 'Úkol nebyl nalezen nebo k němu nemáš přístup.' })
    mount(<TaskBoard tasks={[DUE]} members={[]} updateStatus={vi.fn()} updateDueOn={updateDueOn} today="2026-09-29" />)
    await act(async () => { setDate(dateField(), '2026-10-02') })
    expect(region().textContent).toContain('nemáš přístup')
    expect(undoBtn()).toBeUndefined()
    expect(dateField().value).toBe('2026-09-25')
  })

  test('po termínu je označení viditelné; hotový úkol a karta bez akce mají jen text', () => {
    mount(<TaskBoard tasks={[DUE]} members={[]} updateStatus={vi.fn()} updateDueOn={vi.fn()} today="2026-09-29" />)
    expect(container.textContent).toContain('Po termínu')
    mount(<TaskBoard tasks={[{ ...DUE, status: 'done' } as Task]} members={[]} updateStatus={vi.fn()} updateDueOn={vi.fn()} today="2026-09-29" />)
    expect(document.querySelector('input[type="date"]')).toBeNull()
    mount(<TaskBoard tasks={[DUE]} members={[]} updateStatus={vi.fn()} today="2026-09-29" />)
    expect(document.querySelector('input[type="date"]')).toBeNull()
  })
})
