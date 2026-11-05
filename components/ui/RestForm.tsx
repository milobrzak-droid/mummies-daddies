import Link from 'next/link'
import type { ReactNode } from 'react'
import { buttonClass } from '@/components/ui/Button'

// Sdílené prvky formulářových stránek a vedlejších karet (klienti, partneři,
// kontakty, předplatné). Jen prezentace — žádný stav, žádné dotazy.

// Tlačítka jdou přes buttonClass() (components/ui/Button.tsx), ne ručně psané
// třídy: pilulka, výška 40 px (44 px na dotyku), stavy hover/focus/disabled
// z design systému (docs/PROVOZ.md §11).

/** Druhotné tlačítko (obrys) pro odkazy i `button`. */
export const REST_BTN_SOFT = buttonClass('outline')

/** Nebezpečná akce (ukončit, smazat): obrys s červeným textem. */
export const REST_BTN_DANGER = buttonClass('danger')

/** Hlavní akce (koral) pro odkazy. U tlačítek formuláře je `SubmitButton variant="coral"`. */
export const REST_BTN_CORAL = buttonClass('primary')

/** Bílá karta s jasným nadpisem a popiskem; uvnitř formulář nebo obsah. */
export function FormCard({
  title, description, children, className = '', id, tone = 'default',
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  className?: string
  id?: string
  /** `danger` = jemně červený okraj u nevratných akcí */
  tone?: 'default' | 'danger'
}) {
  const headId = id ? `${id}-title` : undefined
  return (
    <section
      id={id}
      aria-labelledby={headId}
      className={`bg-surface rounded-card shadow-card p-5 md:p-6 ${tone === 'danger' ? 'ring-1 ring-[color:color-mix(in_srgb,var(--c-neg)_25%,white)]' : ''} ${className}`}
    >
      <h2 id={headId} className="font-heading text-title2 font-bold m-0">{title}</h2>
      {description && <p className="text-sm text-muted mt-1.5 mb-0 max-w-xl">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  )
}

/** Odkaz „zpět" v hlavičce stránky: pilulka s obrysem. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className={REST_BTN_SOFT}>← {children}</Link>
}

/** Řádek s tlačítky pod formulářem. */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 pt-2">{children}</div>
}

/** Mřížka polí: jeden sloupec na mobilu, dva od `md`. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">{children}</div>
}

/** Nadpis sekce stránky (mono `.eyebrow`) nad kartou nebo tabulkou. */
export function SectionEyebrow({ children, id }: { children: ReactNode; id?: string }) {
  return <h2 id={id} className="eyebrow mt-8 mb-3 font-medium">{children}</h2>
}
