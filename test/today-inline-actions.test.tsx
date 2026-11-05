import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UndoToastProvider } from '@/components/ui/Toast'
import { TodayTaskChecklist } from '@/components/ui/TodayTaskChecklist'
import { TodayOverdueList } from '@/components/ui/TodayOverdueList'

// Úpravy na místě na obrazovce Dnes: dokončení úkolu zaškrtnutím a posun
// termínu po termínu přímo v řádku. Akce se provede hned, toast nabídne Zpět,
// které volá tutéž serverovou akci s předchozí hodnotou.

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }))

let container: HTMLDivElement
let root: Root

function mount(children: React.ReactNode) {
  act(() => {
    root.render(<UndoToastProvider>{children}</UndoToastProvider>)
  })
}

const region = () => document.querySelector<HTMLElement>('[role="status"]')!
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)

beforeEach(() => {
  refresh.mockReset()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Co dnes udělat: dokončení úkolu zaškrtnutím', () => {
  const tasks = [{ id: 11, title: 'Poslat nabídku', sub: 'ALFATECH', status: 'in_progress' }]

  test('zaškrtnutí zavolá updateTaskStatus(done), toast nabídne Zpět s původním stavem', async () => {
    const complete = vi.fn(async () => {})
    mount(<TodayTaskChecklist tasks={tasks} complete={complete} />)
    const box = button('Hotovo: Poslat nabídku')!
    expect(box.getAttribute('aria-checked')).toBe('false')
    await act(async () => { box.click() })
    expect(complete).toHaveBeenCalledWith(11, 'done')
    expect(box.getAttribute('aria-checked')).toBe('true')
    expect(refresh).toHaveBeenCalled()
    expect(region().textContent).toContain('Úkol „Poslat nabídku“ je hotový.')
    await act(async () => { button('Zpět')!.click() })
    expect(complete).toHaveBeenLastCalledWith(11, 'in_progress')
    expect(button('Hotovo: Poslat nabídku')!.getAttribute('aria-checked')).toBe('false')
  })

  test('chyba serveru vrátí zaškrtnutí a řekne to v toastu (bez Zpět)', async () => {
    const complete = vi.fn(async () => { throw new Error('boom') })
    mount(<TodayTaskChecklist tasks={tasks} complete={complete} />)
    await act(async () => { button('Hotovo: Poslat nabídku')!.click() })
    expect(button('Hotovo: Poslat nabídku')!.getAttribute('aria-checked')).toBe('false')
    expect(region().textContent).toContain('Úkol se nepodařilo dokončit')
    expect(button('Zpět')).toBeUndefined()
  })
})

describe('Po termínu: posun termínu a dokončení přímo v řádku', () => {
  const targets = { tomorrow: '2026-09-30', nextWeek: '2026-10-05' }
  const dealRow = {
    key: 'd7', href: '/cockpit/clients/3/deals/7/edit', title: 'Poslat rozsah', sub: 'ALFATECH', late: 'před 4 dny', severe: true,
    kind: 'deal' as const, dealId: 7, nextStep: 'Poslat rozsah', due: '2026-09-25',
  }
  const taskRow = { key: 't5', href: '/cockpit/tasks', title: 'Zavolat', sub: 'KAPPA', late: 'před 1 dnem', severe: false, kind: 'task' as const, taskId: 5, taskStatus: 'todo' }

  test('Zítra posune termín obchodu, Zpět vrátí původní termín i text kroku', async () => {
    const postpone = vi.fn(async () => ({ success: true }))
    mount(<TodayOverdueList items={[dealRow]} targets={targets} postpone={postpone} />)
    await act(async () => { button('Zítra: posunout „Poslat rozsah“ na 30. 9.')!.click() })
    expect(postpone).toHaveBeenCalledWith(7, 'Poslat rozsah', '2026-09-30')
    expect(container.textContent).toContain('Posunuto na 30. 9.')
    expect(region().textContent).toContain('Termín „Poslat rozsah“ je posunutý na 30. 9.')
    expect(refresh).toHaveBeenCalled()
    await act(async () => { button('Zpět')!.click() })
    expect(postpone).toHaveBeenLastCalledWith(7, 'Poslat rozsah', '2026-09-25')
    expect(container.textContent).not.toContain('Posunuto na')
  })

  test('Příští týden posune na pondělí; chyba serveru se řekne a nic se neoznačí', async () => {
    const postpone = vi.fn(async () => ({ success: false, error: 'Nemáš přístup k sales CRM.' }))
    mount(<TodayOverdueList items={[dealRow]} targets={targets} postpone={postpone} />)
    await act(async () => { button('Příští týden: posunout „Poslat rozsah“ na 5. 10.')!.click() })
    expect(postpone).toHaveBeenCalledWith(7, 'Poslat rozsah', '2026-10-05')
    expect(region().textContent).toContain('Nemáš přístup k sales CRM.')
    expect(container.textContent).not.toContain('Posunuto na')
  })

  test('obchod bez vyplněného kroku posun nenabízí (server by ho odmítl), jen odkaz', () => {
    mount(<TodayOverdueList items={[{ ...dealRow, nextStep: null }]} targets={targets} postpone={vi.fn()} />)
    expect(button('Zítra: posunout „Poslat rozsah“ na 30. 9.')).toBeUndefined()
    expect(container.querySelector('a[href="/cockpit/clients/3/deals/7/edit"]')).not.toBeNull()
  })

  test('úkol po termínu jde odškrtnout jako hotový, Zpět vrátí stav', async () => {
    const complete = vi.fn(async () => {})
    mount(<TodayOverdueList items={[taskRow]} targets={targets} completeTask={complete} />)
    await act(async () => { button('Hotovo: Zavolat')!.click() })
    expect(complete).toHaveBeenCalledWith(5, 'done')
    expect(region().textContent).toContain('Úkol „Zavolat“ je hotový.')
    await act(async () => { button('Zpět')!.click() })
    expect(complete).toHaveBeenLastCalledWith(5, 'todo')
  })

  const dueTask = { ...taskRow, due: '2026-09-25' }

  test('úkol: Zítra posune jeho termín, Zpět vrátí původní termín stejnou akcí', async () => {
    const postponeTask = vi.fn(async () => ({ success: true }))
    mount(<TodayOverdueList items={[dueTask]} targets={targets} postponeTask={postponeTask} />)
    await act(async () => { button('Zítra: posunout „Zavolat“ na 30. 9.')!.click() })
    expect(postponeTask).toHaveBeenCalledWith(5, '2026-09-30')
    expect(container.textContent).toContain('Posunuto na 30. 9.')
    expect(region().textContent).toContain('Termín úkolu „Zavolat“ je posunutý na 30. 9.')
    expect(refresh).toHaveBeenCalled()
    await act(async () => { button('Zpět')!.click() })
    expect(postponeTask).toHaveBeenLastCalledWith(5, '2026-09-25')
    expect(container.textContent).not.toContain('Posunuto na')
  })

  test('úkol: Příští týden posune na pondělí; chyba (oprávnění) se řekne a nic se neoznačí', async () => {
    const postponeTask = vi.fn(async () => ({ success: false, error: 'Úkol nebyl nalezen nebo k němu nemáš přístup.' }))
    mount(<TodayOverdueList items={[dueTask]} targets={targets} postponeTask={postponeTask} />)
    await act(async () => { button('Příští týden: posunout „Zavolat“ na 5. 10.')!.click() })
    expect(postponeTask).toHaveBeenCalledWith(5, '2026-10-05')
    expect(region().textContent).toContain('nemáš přístup')
    expect(container.textContent).not.toContain('Posunuto na')
    expect(button('Zpět')).toBeUndefined()
  })

  test('úkol s posunem i dokončením nabízí obojí; bez akce posunu jen Hotovo', async () => {
    mount(<TodayOverdueList items={[dueTask]} targets={targets} postponeTask={vi.fn()} completeTask={vi.fn()} />)
    expect(button('Zítra: posunout „Zavolat“ na 30. 9.')).toBeDefined()
    expect(button('Hotovo: Zavolat')).toBeDefined()
    act(() => root.render(<UndoToastProvider><TodayOverdueList items={[dueTask]} targets={targets} completeTask={vi.fn()} /></UndoToastProvider>))
    expect(button('Zítra: posunout „Zavolat“ na 30. 9.')).toBeUndefined()
    expect(button('Hotovo: Zavolat')).toBeDefined()
  })

  test('bez akcí (jen čtení) jsou řádky jen odkazem', () => {
    mount(<TodayOverdueList items={[dealRow, taskRow]} />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('a')).toHaveLength(2)
  })
})
