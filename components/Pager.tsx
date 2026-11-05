import Link from 'next/link'
import { pagerItems } from '@/domain/crm/accountList'

// Stránkování odkazy (bez JS): každá stránka má vlastní URL, takže jde
// sdílet, vrátit se zpět a funguje i bez hydratace. Aktuální stránka nese
// aria-current="page", neaktivní „Předchozí/Další" jsou jen text
// s aria-disabled (odkaz, který nikam nevede, by čtečka ohlásila zbytečně).
// Vzhled (docs/PROVOZ.md): tiché kulaté pilulky, aktuální stránka je
// grafitová; „Předchozí/Další“ jako obrysová tlačítka.
export function Pager({
  page, pageCount, hrefFor, label,
}: { page: number; pageCount: number; hrefFor: (page: number) => string; label: string }) {
  if (pageCount <= 1) return null
  const base = 'inline-flex min-w-11 h-11 md:min-w-9 md:h-9 items-center justify-center rounded-full px-3 text-callout font-semibold tabular-nums no-underline transition-colors duration-fast'
  const idle = `${base} text-ink hover:bg-[color:rgba(23,32,46,.06)] hover:text-ink`
  const step = `${base} bg-surface text-ink shadow-[inset_0_0_0_1px_var(--c-line)] hover:bg-[color:var(--c-soft)] hover:text-ink`
  const disabled = `${base} bg-surface text-muted opacity-50 shadow-[inset_0_0_0_1px_var(--c-line)]`
  return (
    <nav aria-label={label} className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p className="eyebrow m-0">Stránka {page} z {pageCount}</p>
      <ul className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
        <li>
          {page > 1
            ? <Link href={hrefFor(page - 1)} rel="prev" className={step}>← Předchozí</Link>
            : <span aria-disabled="true" className={disabled}>← Předchozí</span>}
        </li>
        {pagerItems(page, pageCount).map((n, i) => (
          <li key={n ?? `gap-${i}`}>
            {n === null ? (
              <span aria-hidden="true" className="px-1 text-muted">…</span>
            ) : n === page ? (
              <span aria-current="page" className={`${base} bg-[color:var(--c-navy)] text-white`}>
                <span className="sr-only">Stránka </span>{n}
              </span>
            ) : (
              <Link href={hrefFor(n)} className={idle}>
                <span className="sr-only">Stránka </span>{n}
              </Link>
            )}
          </li>
        ))}
        <li>
          {page < pageCount
            ? <Link href={hrefFor(page + 1)} rel="next" className={step}>Další →</Link>
            : <span aria-disabled="true" className={disabled}>Další →</span>}
        </li>
      </ul>
    </nav>
  )
}
