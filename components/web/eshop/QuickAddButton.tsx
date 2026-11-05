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
  label,
  added,
  cart,
  className,
}: {
  slug: CheesecakeSlug
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
      </Button>
      <p role="status" aria-live="polite" className="mt-3 min-h-0 font-copy text-small text-cocoa">
        {done ? (
          <>
            <span className="font-semibold">{added}</span>{' '}
            <Link href={cart.href} className="md-link whitespace-nowrap">
              {cart.label}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  )
}
