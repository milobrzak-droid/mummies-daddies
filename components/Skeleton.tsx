/**
 * Lightweight loading-skeleton primitives for loading.tsx files.
 *
 * - Respects prefers-reduced-motion via motion-safe:animate-pulse (no pulse
 *   at all when the user has reduced motion on).
 * - `LoadingStatus` is the single a11y wrapper every loading.tsx should use:
 *   role="status" + aria-live="polite" + a visually-hidden "Načítám…" label,
 *   so screen readers announce the loading state once without reading out
 *   every individual skeleton block.
 * - `SkeletonHeader` mirrors PageHeader's box model (same margin/
 *   text sizes) so swapping loading → real content never shifts layout.
 */
import type { ReactNode } from 'react'
import { CARD } from '@/components/ui/Card'

export function LoadingStatus({ children, label = 'Načítám…' }: { children: ReactNode; label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  // Vlastní zaoblení v `className` (rounded-full…) nahradí výchozí rounded-card.
  const round = /\brounded/.test(className) ? '' : 'rounded-card'
  // Průhledný grafit: je vidět na ploše (--bg) i na bílé kartě.
  return <div className={`bg-[color:rgba(23,32,46,.07)] ${round} motion-safe:animate-pulse ${className}`} />
}

/** Mirrors PageHeader's markup so the header never jumps when content lands. */
export function SkeletonHeader({ eyebrow = false, subtitle = false, actions = false }: {
  eyebrow?: boolean
  subtitle?: boolean
  actions?: boolean
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 w-full max-w-sm">
        {eyebrow && <Skeleton className="mb-2 h-[12px] w-24 rounded-full" />}
        <Skeleton className="h-[30px] w-56 rounded-btn md:h-[36px]" />
        {subtitle && <Skeleton className="mt-2 h-4 w-72 max-w-full rounded-full" />}
      </div>
      {actions && (
        <div className="flex items-center gap-2 pb-0.5">
          <Skeleton className="h-10 w-36 rounded-full" />
        </div>
      )}
    </div>
  )
}

/** A DataTable-shaped skeleton: header row + N pulsing rows. */
export function SkeletonTable({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="flex gap-4 border-b border-border bg-[color:var(--c-soft)] px-5 py-3.5">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1 rounded-full" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-12 items-center gap-4 border-b border-[color:var(--c-line-2)] px-5 last:border-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1 rounded-full" />
          ))}
        </div>
      ))}
    </div>
  )
}

/** A generic card skeleton (ProjectCard shaped). */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`${CARD} p-5 ${className}`}>
      <Skeleton className="h-3 w-20 mb-3 rounded-full" />
      <Skeleton className="h-6 w-28 rounded-full" />
    </div>
  )
}
