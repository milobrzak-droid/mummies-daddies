import Link from 'next/link'
import type { ReactNode } from 'react'
import { buttonClass } from '@/components/ui/Button'

// Prázdný stav (docs/PROVOZ.md §9): ikona v kroužku, jedna věta, co tu
// bude, a cesta dál. Žádné slepé uličky: když jde prázdno změnit, nabídni akci.
export function EmptyState({
  title, children, icon, action, tone = 'neutral', compact = false, className = '',
}: {
  title: string
  /** Jedna věta: co se tu objeví, nebo proč je prázdno. */
  children?: ReactNode
  icon?: ReactNode
  /** Cesta dál, např. { href: '/cockpit/tasks#novy-ukol', label: 'Založit úkol' }. */
  action?: { href: string; label: string }
  /** `calm` = prázdno, protože je hotovo (zelené zaškrtnutí). */
  tone?: 'neutral' | 'calm'
  compact?: boolean
  className?: string
}) {
  const ring = tone === 'calm' ? 'bg-[color:var(--c-pos-soft)] text-pos' : 'bg-[color:var(--c-soft)] text-[color:var(--c-slate)]'
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-10'} ${className}`}>
      <span aria-hidden="true" className={`grid h-11 w-11 place-items-center rounded-full ${ring}`}>
        {icon ?? (tone === 'calm' ? <CheckGlyph /> : <InboxGlyph />)}
      </span>
      <div className="max-w-sm">
        <p className="m-0 text-headline text-ink">{title}</p>
        {children && <p className="m-0 mt-1 text-callout text-muted">{children}</p>}
      </div>
      {action && (
        <Link href={action.href} className={buttonClass('outline', 'sm', 'mt-1')}>{action.label}</Link>
      )}
    </div>
  )
}

function CheckGlyph() {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
}
function InboxGlyph() {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /></svg>
}
