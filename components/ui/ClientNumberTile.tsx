import Link from 'next/link'
import type { ReactNode } from 'react'

export type TileTone = 'peach' | 'sky' | 'pink' | 'mint' | 'lav' | 'sun'

// Celé názvy tříd (ne skládané): Tailwind jinak třídy z @layer components odstraní.
const TONE_CLASS: Record<TileTone, string> = {
  peach: 'tile tile-peach', sky: 'tile tile-sky', pink: 'tile tile-pink',
  mint: 'tile tile-mint', lav: 'tile tile-lav', sun: 'tile tile-sun',
}

export type TileCell = { label: string; value: string }

// Pastelová číselná dlaždice: jedno velké číslo, věta pod ním a až tři malé
// údaje. S `href` je celá dlaždice odkaz (aria-label říká, kam vede).
export function ClientNumberTile({
  label, value, caption, strong, cells = [], href, ariaLabel, tone = 'peach', icon,
}: {
  label: string
  value: string
  /** věta vedle čísla („otevřený obchod") */
  caption?: string
  /** tučný řádek pod větou (částka, „Teď: …") */
  strong?: string
  cells?: TileCell[]
  href?: string
  ariaLabel?: string
  tone?: TileTone
  icon?: ReactNode
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 rounded-full bg-white pl-1.5 pr-3 py-1 text-[13px] font-bold shadow-[0_1px_2px_rgba(20,25,34,.08)]">
          {icon && (
            <span className="inline-grid h-[22px] w-[22px] place-items-center rounded-full bg-[var(--c-navy)] text-white" aria-hidden="true">
              {icon}
            </span>
          )}
          {label}
        </span>
        {href && (
          <span className="inline-grid h-7 w-7 place-items-center rounded-full bg-white/70 text-ink" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
          </span>
        )}
      </div>
      <div className="mt-3 flex items-end gap-3">
        <span className="big-num text-[52px] md:text-[56px] tabular-nums">{value}</span>
        {(caption || strong) && (
          <div className="pb-1 text-[13px] leading-snug text-ink-2 min-w-0">
            {caption}
            {strong && <b className="block text-[14px] text-ink truncate">{strong}</b>}
          </div>
        )}
      </div>
      {cells.length > 0 && (
        <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }}>
          {cells.map((c) => (
            <div key={c.label} className="rounded-[14px] bg-white/60 px-2.5 py-2 text-[11.5px] text-ink-2 min-w-0">
              {c.label}
              <b className="block text-[13px] text-ink truncate">{c.value}</b>
            </div>
          ))}
        </div>
      )}
    </>
  )
  const cls = `${TONE_CLASS[tone]} flex flex-col p-4 no-underline text-ink`
  return href ? (
    <Link href={href} aria-label={ariaLabel} className={`${cls} hover:text-ink`}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  )
}
