import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { findAccountOptions } from '@/domain/crm/actions/accountPicker'
import { AccountPicker, type AccountOption } from '@/components/AccountPicker'

// Chování výběru firmy v prohlížeči (happy-dom): hledání se zpožděním,
// klávesnice (šipky, Enter, Escape), ARIA combobox, skryté pole pro
// formulář, validace nepotvrzeného textu a reset formuláře.

vi.mock('@/domain/crm/actions/accountPicker', () => ({ findAccountOptions: vi.fn() }))

const OPTIONS: AccountOption[] = [{ id: 1, name: 'Acme a.s.' }, { id: 2, name: 'Acme Group' }]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(findAccountOptions).mockResolvedValue({ ok: true, options: OPTIONS })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.clearAllMocks()
})

function mount(props: Parameters<typeof AccountPicker>[0] = {}) {
  act(() => {
    root.render(<form><AccountPicker {...props} /></form>)
  })
  const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"]')!
  const listbox = container.querySelector<HTMLUListElement>('[role="listbox"]')!
  return { input, hidden, listbox, form: container.querySelector('form')! }
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}

function key(input: HTMLInputElement, k: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

describe('AccountPicker', () => {
  test('ARIA: combobox ovládá listbox, zavřeno bez hledání', () => {
    const { input, listbox, hidden } = mount({ name: 'account_id' })
    expect(input.getAttribute('aria-controls')).toBe(listbox.id)
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(listbox.hidden).toBe(true)
    expect(hidden.name).toBe('account_id')
    expect(hidden.value).toBe('')
  })

  test('psaní → jedno hledání po prodlevě, výsledky jako options', async () => {
    const { input, listbox } = mount({ excludeId: 9 })
    await type(input, 'acme')
    expect(findAccountOptions).toHaveBeenCalledTimes(1)
    expect(findAccountOptions).toHaveBeenCalledWith('acme', 9)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    const opts = listbox.querySelectorAll('[role="option"]')
    expect([...opts].map((o) => o.textContent)).toEqual(['Acme a.s.', 'Acme Group'])
    expect(input.getAttribute('aria-activedescendant')).toBe(opts[0].id)
    expect(opts[0].getAttribute('aria-selected')).toBe('true')
  })

  test('šipka dolů + Enter vybere firmu, skryté pole nese id, onChange dostane volbu', async () => {
    const onChange = vi.fn()
    const { input, hidden, listbox } = mount({ onChange })
    await type(input, 'acme')
    key(input, 'ArrowDown')
    key(input, 'Enter')
    expect(hidden.value).toBe('2')
    expect(input.value).toBe('Acme Group')
    expect(listbox.hidden).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith({ id: 2, name: 'Acme Group' })
    expect(input.validationMessage).toBe('')
  })

  test('nepotvrzený text je neplatný (formulář se neodešle „bez klienta")', async () => {
    const { input, hidden } = mount()
    await type(input, 'acme')
    key(input, 'Escape')
    expect(hidden.value).toBe('')
    expect(input.validationMessage).toBe('Vyber firmu ze seznamu, nebo pole vymaž.')
  })

  test('přepsání vybrané firmy výběr zruší', async () => {
    const onChange = vi.fn()
    const { input, hidden } = mount({ initial: { id: 5, name: 'Beta' }, onChange })
    expect(hidden.value).toBe('5')
    await type(input, 'Bet')
    expect(hidden.value).toBe('')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  test('reset formuláře vrátí výchozí firmu; keepOnReset ji nechá', async () => {
    const first = mount({ initial: { id: 5, name: 'Beta' } })
    await type(first.input, 'acme')
    key(first.input, 'Enter')
    expect(first.hidden.value).toBe('1')
    act(() => first.form.reset())
    expect(first.hidden.value).toBe('5')
    expect(first.input.value).toBe('Beta')

    act(() => root.render(<form key="b"><AccountPicker keepOnReset /></form>))
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"]')!
    await type(input, 'acme')
    key(input, 'Enter')
    act(() => container.querySelector('form')!.reset())
    expect(hidden.value).toBe('1')
  })

  test('chyba hledání se ukáže a ohlásí, nic se nevybere', async () => {
    vi.mocked(findAccountOptions).mockResolvedValueOnce({ ok: false, error: 'Něco se pokazilo.' })
    const { input, hidden } = mount()
    await type(input, 'acme')
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe('Něco se pokazilo.')
    key(input, 'Enter')
    expect(hidden.value).toBe('')
  })

  test('tlačítko × zruší výběr', async () => {
    const { hidden } = mount({ initial: { id: 5, name: 'Beta' } })
    const clear = container.querySelector<HTMLButtonElement>('button[aria-label^="Zrušit výběr"]')!
    act(() => clear.click())
    expect(hidden.value).toBe('')
  })
})
