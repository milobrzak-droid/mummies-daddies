'use client'
import { useSyncExternalStore } from 'react'

/**
 * Platí teď media query? Pro klientské komponenty, které mají na úzkém
 * displeji jinou strukturu (ne jen jiné CSS) – např. formulářová pole, která
 * nesmí být v DOM dvakrát (stejné `id`). Na serveru a při hydrataci vrací
 * `serverValue` (výchozí `true` = širší rozvržení), pak skutečnou hodnotu.
 */
export function useMediaQuery(query: string, serverValue = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const mq = window.matchMedia(query)
      mq.addEventListener?.('change', onChange)
      return () => mq.removeEventListener?.('change', onChange)
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : serverValue),
    () => serverValue,
  )
}
