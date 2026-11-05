// Výběr důvodu prohry (P5): kódy z COMPANY.lostReasons, hodnota „kod: poznámka"
// ve skrytém poli formuláře, starý volný text zůstane v poznámce, bez
// nastavených důvodů jen volný text.
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LostReasonSelect, lostReasonComplete } from '@/components/LostReasonSelect'
import { COMPANY } from '@/config'

let container: HTMLDivElement
let root: Root
let last = ''

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  last = ''
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function Harness({ initial = '', reasons }: { initial?: string; reasons?: { key: string; label: string }[] }) {
  const [v, setV] = useState(initial)
  const change = (next: string) => { last = next; setV(next) }
  return <form><LostReasonSelect name="lost_reason" value={v} onChange={change} reasons={reasons} /></form>
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event: 'input' | 'change') {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(event, { bubbles: true }))
}

const hidden = () => container.querySelector<HTMLInputElement>('input[type="hidden"][name="lost_reason"]')!

describe('LostReasonSelect', () => {
  test('nabídne důvody firmy a složí „kod: poznámka"', () => {
    act(() => root.render(<Harness />))
    const select = container.querySelector('select')!
    expect([...select.options].map((o) => o.value)).toEqual(['', ...COMPANY.lostReasons.map((r) => r.key)])
    expect(hidden().value).toBe('')
    act(() => setValue(select, 'cena', 'change'))
    expect(last).toBe('cena')
    expect(hidden().value).toBe('cena')
    const note = container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!
    act(() => setValue(note, 'konkurence o 10 % levnější', 'input'))
    expect(last).toBe('cena: konkurence o 10 % levnější')
    expect(hidden().value).toBe('cena: konkurence o 10 % levnější')
  })

  test('starý volný text: kód se vybere znovu, text zůstane v poznámce', () => {
    act(() => root.render(<Harness initial="Rozpočet přesunut" />))
    expect(container.querySelector('select')!.value).toBe('')
    expect(container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!.value).toBe('Rozpočet přesunut')
    expect(hidden().value).toBe('')
    act(() => setValue(container.querySelector('select')!, 'termin', 'change'))
    expect(last).toBe('termin: Rozpočet přesunut')
  })

  test('uložený kód se předvyplní', () => {
    act(() => root.render(<Harness initial="kapacita: plno" />))
    expect(container.querySelector('select')!.value).toBe('kapacita')
    expect(container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!.value).toBe('plno')
  })

  test('bez nastavených důvodů jen volný text', () => {
    act(() => root.render(<Harness reasons={[]} />))
    expect(container.querySelector('select')).toBeNull()
    const input = container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!
    act(() => setValue(input, 'Vyhrál interní tým', 'input'))
    expect(hidden().value).toBe('Vyhrál interní tým')
  })

  test('kompletnost: kód povinný, u „Jiné" i poznámka', () => {
    expect(lostReasonComplete('')).toBe(false)
    expect(lostReasonComplete('volný text')).toBe(false)
    expect(lostReasonComplete('cena')).toBe(true)
    expect(lostReasonComplete('jine')).toBe(false)
    expect(lostReasonComplete('jine: klient zrušil akci')).toBe(true)
    expect(lostReasonComplete('volný text', [])).toBe(true)
  })
})
