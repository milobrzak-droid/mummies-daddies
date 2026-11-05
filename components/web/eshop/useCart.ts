'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { getCartSnapshot, getServerCartSnapshot, subscribeCart, type CartState } from '@/lib/web/eshop/cart'

/**
 * Košík z localStorage pro klientské komponenty. Na serveru a při hydrataci je
 * prázdný (žádný nesoulad HTML); `ready` = už známe skutečný obsah z prohlížeče.
 */
export function useCart(): { cart: CartState; ready: boolean } {
  const cart = useSyncExternalStore(subscribeCart, getCartSnapshot, getServerCartSnapshot)
  const ready = useMounted()
  return { cart, ready }
}

export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}
