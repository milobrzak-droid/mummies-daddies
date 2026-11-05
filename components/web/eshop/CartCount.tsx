'use client'

import { cartCount } from '@/lib/web/eshop/cart'
import { cx } from '../cx'
import { useCart } from './useCart'

/**
 * Odznak s počtem kusů v košíku (pro ikonu košíku v hlavičce). Při prázdném
 * košíku a před načtením z localStorage nevykreslí nic. Číslo je jen vizuální;
 * odkaz košíku má vlastní popisek.
 * Napojení do Header.tsx je na základovém agentovi (sdílený soubor).
 */
export function CartCount({ className }: { className?: string }) {
  const { cart, ready } = useCart()
  const n = ready ? cartCount(cart) : 0
  if (!n) return null
  return (
    <span
      aria-hidden="true"
      className={cx(
        'pointer-events-none grid h-5 min-w-5 place-items-center rounded-pill bg-raspberry-ink px-1 font-copy text-[0.6875rem] font-bold leading-none text-paper tabular-nums',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}
