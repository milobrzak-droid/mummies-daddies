'use client'

import { useEffect, useState } from 'react'
import { cx } from '../cx'

const KEY = 'md-motion-paused'

/**
 * Tlačítko „Zastavit animaci“ (WCAG 2.2.2): přepne třídu `md-paused` na obalu webu (.md-web),
 * která zastaví běžící pruh i levitaci výřezů a štítků. Volba se pamatuje v localStorage
 * (jen pohodlí návštěvníka; bez úložiště se prostě nezapamatuje). Při „omezit pohyb“ se nic
 * nehýbe, tlačítko je proto skryté.
 */
export function MotionToggle({ className }: { className?: string }) {
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    let stored = false
    try {
      stored = window.localStorage.getItem(KEY) === '1'
    } catch {
      /* úložiště nedostupné */
    }
    if (stored) {
      document.querySelector('.md-web')?.classList.add('md-paused')
      setPaused(true)
    }
  }, [])

  const toggle = () => {
    const next = !paused
    setPaused(next)
    document.querySelector('.md-web')?.classList.toggle('md-paused', next)
    try {
      window.localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      /* úložiště nedostupné */
    }
  }

  return (
    <button
      type="button"
      aria-pressed={paused}
      onClick={toggle}
      className={cx(
        'md-focus-on-dark inline-flex min-h-11 items-center gap-2 rounded-pill border-2 border-cream bg-cocoa/80 px-4 font-copy text-small font-bold text-cream transition-colors hover:bg-cocoa motion-reduce:hidden',
        className,
      )}
    >
      <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 items-center justify-center gap-[3px]">
        {paused ? (
          <span className="h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-cream" />
        ) : (
          <>
            <span className="h-3.5 w-[4px] bg-cream" />
            <span className="h-3.5 w-[4px] bg-cream" />
          </>
        )}
      </span>
      {paused ? 'Spustit animaci' : 'Zastavit animaci'}
    </button>
  )
}
