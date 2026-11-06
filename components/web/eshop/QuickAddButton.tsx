'use client'

import Link from 'next/link'
import { useState } from 'react'
import { addItem, updateCart } from '@/lib/web/eshop/cart'
import type { CheesecakeSlug } from '@/lib/web/options'
import { Button } from '../Button'
import { IconBag } from '../icons'
import { cx } from '../cx'

/**
 * „Přidat do košíku“ přímo z karty katalogu (1 kus, bez nápisu). Leží nad
 * roztaženým odkazem karty (relative z-10), takže karta zůstane klikací a tlačítko
 * není vnořené v odkazu. Mini cheesecaky ho nemají – příchutě se vybírají na detailu.
 */
export function QuickAddButton({
  slug,
  name,
  label,
  added,
  cart,
  className,
}: {
  slug: CheesecakeSlug
  /** Název produktu pro čtečky (6 tlačítek „Přidat do košíku“ by jinak znělo stejně). */
  name?: string
  label: string
  /** „Přidáno do košíku. Dobrá volba!“ */
  added: string
  /** Odkaz „Přejít do košíku“. */
  cart: { label: string; href: string }
  className?: string
}) {
  const [done, setDone] = useState(false)
  return (
    <div className={cx('relative z-10 mt-5', className)}>
      <Button
        variant="white"
        size="sm"
        icon={<IconBag size={18} />}
        onClick={() => {
          updateCart((s) => addItem(s, { slug, quantity: 1 }))
          setDone(true)
        }}
      >
        {label}
        {name ? <span className="sr-only">: {name}</span> : null}
      </Button>
      {/* Prázdný stav bez okraje: jinak by mt-3 posunul tlačítko nad šipkou karty
          a obě by neseděla na jedné lince. */}
      <p role="status" aria-live="polite" className="mt-3 min-h-0 font-copy text-small text-cocoa empty:mt-0">
        {done ? (
          <>
            <span className="font-bold">{added}</span>{' '}
            <Link href={cart.href} className="md-link whitespace-nowrap">
              {cart.label}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  )
}
