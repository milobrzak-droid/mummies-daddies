// Tlačítko „Změnit vlastníka" a jeho formulář (components/OwnerChange.tsx):
// oprávnění, výběr jen aktivních lidí, uvolnění zástupce, uložení s toastem
// „Zpět", chyby serveru. Akce je zamockovaná (její logiku zkouší
// test/owner-change.test.tsx, databázi test/owner-change-0093-pglite.test.ts).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { OwnerChange } from '@/components/OwnerChange'
import { UndoToastProvider } from '@/components/ui/Toast'
import { OWNER_CHANGE_ERRORS } from '@/lib/ownerChange'
import { changeWorkOwner } from '@/lib/actions/ownerChange'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock('@/lib/actions/ownerChange', () => ({ changeWorkOwner: vi.fn() }))

const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
const C = '44444444-4444-4444-8444-444444444444'

describe('OwnerChange (komponenta)', () => {
  let container: HTMLDivElement
  let root: Root
  const members = [
    { id: A, name: 'Petr', roleLabel: 'Projekťák / IT' },
    { id: B, name: 'Lenka', roleLabel: 'Vedení' },
  ]
  let act_: ReturnType<typeof vi.mocked<typeof changeWorkOwner>>
  const ownerSel = () => container.querySelector<HTMLSelectElement>('select[name="owner_id"]')!
  const deputySel = () => container.querySelector<HTMLSelectElement>('select[name="deputy_id"]')
  const btn = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    refresh.mockReset()
    act_ = vi.mocked(changeWorkOwner)
    act_.mockReset()
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function mount(props: Partial<React.ComponentProps<typeof OwnerChange>> = {}) {
    act(() => {
      root.render(
        <UndoToastProvider>
          <OwnerChange
            kind="pripady"
            itemId={5}
            itemLabel="Nabídka ALFATECH"
            owner={{ id: A, name: 'Petr' }}
            deputy={{ id: B, name: 'Lenka' }}
            members={members}
            {...props}
          />
        </UndoToastProvider>,
      )
    })
  }
  const open = () => act(() => { btn('Změnit vlastníka')!.click() })
  const choose = (sel: HTMLSelectElement, value: string) => act(() => {
    // React sleduje hodnotu přes nativní setter.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const submit = async () => {
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  test('bez oprávnění se nezobrazí nic', () => {
    mount({ canChange: false })
    expect(container.querySelector('button, form, select')).toBeNull()
  })

  test('tlačítko má přístupný název s věcí; otevře formulář se dvěma výběry', () => {
    mount()
    expect(btn('Změnit vlastníka')!.getAttribute('aria-label')).toBe('Změnit vlastníka: Nabídka ALFATECH')
    open()
    expect(container.querySelector('form')!.getAttribute('aria-label')).toBe('Změna vlastníka: Nabídka ALFATECH')
    expect(ownerSel().value).toBe(A)
    expect(deputySel()!.value).toBe(B)
  })

  test('obchod a cílový seznam zástupce nemají', () => {
    mount({ kind: 'obchody', deputy: undefined })
    open()
    expect(deputySel()).toBeNull()
  })

  test('deaktivovaný člověk se nenabízí, ale stávající držitel zůstane vidět s poznámkou', () => {
    mount({ owner: { id: C, name: 'Pryč' } })
    open()
    const labels = [...ownerSel().options].map((o) => o.textContent)
    expect(labels).toEqual(['Pryč (už není aktivní)', 'Petr · Projekťák / IT', 'Lenka · Vedení'])
    expect(labels.some((l) => l?.includes('Partner'))).toBe(false)
  })

  test('existujícího vlastníka jde jen předat (prázdná volba není), u věci bez vlastníka je', () => {
    mount()
    open()
    expect([...ownerSel().options].some((o) => o.value === '')).toBe(false)
    act(() => root.unmount())
    root = createRoot(container)
    mount({ owner: { id: null, name: null }, deputy: { id: null, name: null } })
    open()
    expect([...ownerSel().options][0].value).toBe('')
    expect(deputySel()!.disabled).toBe(true)
  })

  test('zástupce, který se stává vlastníkem, se uvolní a vlastník v seznamu zástupců nejde vybrat', () => {
    mount()
    open()
    choose(ownerSel(), B)
    expect(deputySel()!.value).toBe('')
    expect(container.textContent).toContain('Nový vlastník byl zástupcem')
    expect([...deputySel()!.options].find((o) => o.value === B)!.disabled).toBe(true)
  })

  test('uložení: zavolá akci s novým stavem a očekávaným původním, ukáže toast se Zpět a obnoví stránku', async () => {
    act_.mockResolvedValue({ success: true, changed: true, message: 'Vlastník případu: Petr → Lenka.', undo: { auditId: 77, owner: A, deputy: B } })
    mount()
    open()
    choose(ownerSel(), B)
    await submit()
    expect(act_).toHaveBeenCalledWith({
      kind: 'pripady', id: 5, owner_id: B, deputy_id: null, expect: { owner: A, deputy: B },
    })
    expect(document.querySelector('[role="status"]')!.textContent).toContain('Vlastník případu: Petr → Lenka.')
    expect(btn('Zpět')).toBeTruthy()
    expect(refresh).toHaveBeenCalled()
    // Formulář se zavřel a vrátilo se tlačítko.
    expect(container.querySelector('form')).toBeNull()
    expect(btn('Změnit vlastníka')).toBeTruthy()
  })

  test('Zpět zavolá tutéž akci s původními hodnotami a id záznamu auditu', async () => {
    act_.mockResolvedValueOnce({ success: true, changed: true, message: 'Vlastník případu: Petr → Lenka.', undo: { auditId: 77, owner: A, deputy: B } })
    act_.mockResolvedValueOnce({ success: true, changed: true, message: 'Vráceno zpět. Vlastník případu: Lenka → Petr.', undo: null })
    mount()
    open()
    choose(ownerSel(), B)
    await submit()
    await act(async () => { btn('Zpět')!.click() })
    expect(act_).toHaveBeenLastCalledWith({ kind: 'pripady', id: 5, owner_id: A, deputy_id: B, undo_of: 77 })
    expect(document.querySelector('[role="status"]')!.textContent).toContain('Vráceno zpět.')
  })

  test('chyba serveru se ukáže ve formuláři a formulář zůstane otevřený', async () => {
    act_.mockResolvedValue({ success: false, error: OWNER_CHANGE_ERRORS.OC006 })
    mount()
    open()
    choose(ownerSel(), B)
    await submit()
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(OWNER_CHANGE_ERRORS.OC006)
    expect(container.querySelector('form')).not.toBeNull()
    expect(document.querySelector('[role="status"]')!.textContent).toBe('')
  })

  test('chyba u pole se ukáže u výběru; Zrušit formulář zavře bez volání akce', async () => {
    act_.mockResolvedValue({ success: false, error: OWNER_CHANGE_ERRORS.OC007, fieldErrors: { owner_id: OWNER_CHANGE_ERRORS.OC007 } })
    mount()
    open()
    choose(ownerSel(), B)
    await submit()
    expect(container.textContent).toContain(OWNER_CHANGE_ERRORS.OC007)
    act(() => { btn('Zrušit')!.click() })
    expect(container.querySelector('form')).toBeNull()
    expect(act_).toHaveBeenCalledTimes(1)
  })

  test('onOpenChange hlásí otevření i zavření (karta na tabuli se nesmí táhnout)', () => {
    const seen: boolean[] = []
    mount({ onOpenChange: (o) => seen.push(o) })
    open()
    act(() => { btn('Zrušit')!.click() })
    expect(seen).toEqual([true, false])
  })
})
