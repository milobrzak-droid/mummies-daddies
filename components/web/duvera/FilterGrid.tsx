'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { cx } from '../cx'

export interface FilterOption {
  value: string
  label: string
}

export interface FilterItem {
  key: string
  /** Hodnoty filtrů (FilterOption.value), do kterých položka patří. */
  tags: readonly string[]
  node: ReactNode
}

/**
 * Mřížka s filtrem štítků (reference: Vše · Firemní · Svatby · Oslavy;
 * blog: Firemní akce · Svatby · …). Bez JavaScriptu se ukáže vše.
 * Zvolený filtr se propíše do URL (?stitek=…), aby šel sdílet, a při načtení
 * se z URL přečte. Tlačítka mají aria-pressed; skryté položky jsou display:none.
 */
export function FilterGrid({
  legend,
  allLabel,
  options,
  items,
  param = 'stitek',
  gridClassName,
  className,
}: {
  legend: string
  allLabel: string
  options: readonly FilterOption[]
  items: readonly FilterItem[]
  param?: string
  gridClassName?: string
  className?: string
}) {
  const id = useId()
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get(param)
      if (v && options.some((o) => o.value === v)) setActive(v)
    } catch {
      /* bez URL zůstane „vše“ */
    }
  }, [options, param])

  const choose = (value: string | null) => {
    setActive(value)
    try {
      const url = new URL(window.location.href)
      if (value) url.searchParams.set(param, value)
      else url.searchParams.delete(param)
      window.history.replaceState(window.history.state, '', url)
    } catch {
      /* URL se nezmění, filtr funguje i tak */
    }
  }

  const pill = (pressed: boolean) =>
    cx(
      'inline-flex min-h-11 items-center rounded-pill px-5 font-copy text-small font-semibold transition-colors duration-quick ease-md-out',
      pressed ? 'bg-cocoa text-cream' : 'bg-paper text-cocoa ring-1 ring-inset ring-hairline hover:ring-cocoa/40',
    )

  return (
    <div className={className}>
      <div role="group" aria-labelledby={`${id}-legend`} className="mb-8 flex flex-wrap items-center gap-2 sm:mb-10">
        <span id={`${id}-legend`} className="mr-2 font-copy text-eyebrow uppercase text-cocoa-soft">
          {legend}
        </span>
        <button type="button" aria-pressed={active === null} onClick={() => choose(null)} className={pill(active === null)}>
          {allLabel}
        </button>
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={active === o.value} onClick={() => choose(o.value)} className={pill(active === o.value)}>
            {o.label}
          </button>
        ))}
      </div>
      <ul role="list" className={gridClassName}>
        {items.map((it) => (
          <li key={it.key} className={cx(active && !it.tags.includes(active) ? 'hidden' : undefined)} data-tags={it.tags.join(' ')}>
            {it.node}
          </li>
        ))}
      </ul>
    </div>
  )
}
