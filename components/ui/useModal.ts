'use client'
import { useEffect, useRef, type RefObject } from 'react'

// Společné chování modálních vrstev (paleta příkazů, nápověda zkratek):
// fokus se při otevření přesune dovnitř, Tab kolem dokola nevyleze ven, Esc
// zavře, stránka pod vrstvou se neposouvá a po zavření se fokus vrátí tam, kde
// byl (docs/PROVOZ.md §11). Vrstva sama má role="dialog" a aria-modal.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModal(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const root = ref.current
    const first = initialFocus?.current ?? root?.querySelector<HTMLElement>(FOCUSABLE) ?? root
    first?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) { e.preventDefault(); return }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const active = document.activeElement
      const inside = active instanceof Node && ref.current.contains(active)
      if (e.shiftKey && (!inside || active === firstItem)) { e.preventDefault(); lastItem.focus() }
      else if (!e.shiftKey && (!inside || active === lastItem)) { e.preventDefault(); firstItem.focus() }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      // Vrátit fokus tam, odkud vrstva vzešla; když ten prvek zmizel (např.
      // po navigaci), na obsah stránky, ať klávesnice nezačíná od nuly.
      const target = opener && opener.isConnected && opener !== document.body ? opener : document.getElementById('main')
      target?.focus()
    }
  }, [open, ref, initialFocus])
}
