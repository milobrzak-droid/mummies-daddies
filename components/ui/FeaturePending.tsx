'use client'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { AccessProvider, useAccess } from '@/components/AccessContext'
import { buttonClass } from '@/components/ui/Button'
import { CARD } from '@/components/ui/Card'

// Část aplikace, kterou databáze ještě neumí (chybí migrace). Uživatel dostane
// lidskou větu „Tahle část se připravuje.“ a případně cestu dál; číslo
// migrace je technický detail jen pro vedení a správce (drobně pod textem).
// Kdo detail vidí, nastavuje layout přes AccessContext (showTechDetail v
// AppProviders); mimo něj (testy, samostatné renderování) se detail neukazuje.

export const FEATURE_PENDING_TITLE = 'Tahle část se připravuje.'

/** Přepíše jen `showTechDetail` ve sdíleném AccessContext (testy, izolované části). */
export function FeaturePendingDetailProvider({ show, children }: { show: boolean; children: ReactNode }) {
  const access = useAccess()
  return <AccessProvider value={{ ...access, showTechDetail: show }}>{children}</AccessProvider>
}

/** Vidí aktuální člověk technický detail (číslo migrace)? */
export function useFeaturePendingDetail(): boolean {
  return useAccess().showTechDetail
}

function Detail({ migration, className = '' }: { migration?: string; className?: string }) {
  const show = useFeaturePendingDetail()
  if (!show || !migration) return null
  return <span className={`text-footnote text-muted ${className}`}>Technicky: chybí migrace {migration}</span>
}

/**
 * Část, která se připravuje.
 * - `block` (výchozí): prázdný stav v kartě (ikona, věta, volitelná akce).
 * - `compact`: menší prázdný stav (uvnitř karty).
 * - `inline`: jedna věta v textu (štítek, řádek formuláře).
 */
export function FeaturePending({
  migration, children, action, variant = 'block', title = FEATURE_PENDING_TITLE, card = false, className = '',
}: {
  /** Číslo migrace (např. „0062“) — uvidí jen vedení a správce. */
  migration?: string
  /** Volitelná jedna věta, co tu pak půjde dělat (bez technických slov). */
  children?: ReactNode
  /** Volitelná cesta dál. */
  action?: { href: string; label: string }
  variant?: 'block' | 'compact' | 'inline'
  /** Výjimečně jiná lidská věta (např. „Připravuje se“ ve štítku). */
  title?: string
  /** Zabalit do bílé karty (samostatný blok na stránce). */
  card?: boolean
  className?: string
}) {
  if (variant === 'inline') {
    return (
      <span className={className}>
        {title}{children ? <> {children}</> : null}
        <Detail migration={migration} className="ml-1" />
      </span>
    )
  }
  const compact = variant === 'compact'
  const body = (
    <div className={`flex flex-col items-center text-center ${compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-10'} ${className}`}>
      <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-full bg-[color:var(--c-soft)] text-[color:var(--c-slate)]">
        <ClockGlyph />
      </span>
      <div className="max-w-sm">
        <p className="m-0 text-headline text-ink">{title}</p>
        {children && <p className="m-0 mt-1 text-callout text-muted">{children}</p>}
        <Detail migration={migration} className="mt-1 block" />
      </div>
      {action && (
        <Link href={action.href} className={buttonClass('outline', 'sm', 'mt-1')}>{action.label}</Link>
      )}
    </div>
  )
  return card ? <div className={CARD}>{body}</div> : body
}

function ClockGlyph() {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
}
