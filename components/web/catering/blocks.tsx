import type { ReactNode } from 'react'
import { parseItem, type ParsedItem } from '@/lib/web/content'
import type { Photo } from '@/lib/web/photos'
import { toneAt, type SurfaceTone } from '@/lib/web/tokens'
import { Badge } from '../Badge'
import { PastelCard } from '../PastelCard'
import { PhotoFrame, type PhotoAspect } from '../PhotoFrame'
import { PriceTag } from '../PriceTag'
import { cx } from '../cx'
import { IconCheck, Ornament } from './icons'
import { splitPriceFacts, splitStepNumber } from './parse'
import { RichText } from './RichText'

/*
 * Stavební bloky stránek cateringu. Všechno jsou serverové komponenty bez stavu;
 * texty přicházejí doslova z copy.json, tady se jen rozkládají do layoutu.
 */

// ── cena a minimum ──────────────────────────────────────────────────────────

/** Cena od (malinově) a minimum osob (štítek). Nic nevykreslí, když chybí obojí. */
export function FactsRow({ price, guests, size = 'md', className }: { price: string | null; guests: string | null; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  if (!price && !guests) return null
  return (
    <div className={cx('flex flex-wrap items-center gap-x-4 gap-y-2', className)}>
      {price ? <PriceTag text={price} size={size} /> : null}
      {guests ? (
        <Badge tone="paper">
          <RichText text={guests} />
        </Badge>
      ) : null}
    </div>
  )
}

// ── nadpis sekce s textem (cena/minimum z textu se zvýrazní) ────────────────

export function SectionIntro({
  id,
  title,
  body,
  align = 'left',
  className,
  children,
}: {
  id: string
  title: string
  body?: string | null
  align?: 'left' | 'center'
  className?: string
  children?: ReactNode
}) {
  const facts = body ? splitPriceFacts(body) : null
  const center = align === 'center'
  return (
    <div className={cx('mb-10 max-w-3xl sm:mb-12', center && 'mx-auto text-center', className)}>
      <h2 id={id} className="md-caps text-h2 text-cocoa">
        {title}
      </h2>
      {facts?.rest ? (
        <p className={cx('md-pretty mt-5 text-lead text-cocoa-soft', center && 'mx-auto max-w-2xl')}>
          <RichText text={facts.rest} />
        </p>
      ) : null}
      {facts ? <FactsRow price={facts.price} guests={facts.guests} size="lg" className={cx('mt-5', center && 'justify-center')} /> : null}
      {children}
    </div>
  )
}

// ── seznamy ─────────────────────────────────────────────────────────────────

export function ChipList({ items, className }: { items: string[]; className?: string }) {
  if (!items.length) return null
  return (
    <ul className={cx('flex flex-wrap gap-2.5 sm:gap-3', className)}>
      {items.map((it, i) => (
        <li key={i} className="rounded-pill bg-paper px-4 py-2.5 font-copy text-copy font-medium leading-snug text-cocoa ring-1 ring-inset ring-hairline sm:px-5">
          <RichText text={it} />
        </li>
      ))}
    </ul>
  )
}

export function CheckList({ items, columns = 1, className }: { items: string[]; columns?: 1 | 2; className?: string }) {
  if (!items.length) return null
  return (
    <ul className={cx('grid gap-x-10 gap-y-4', columns === 2 && 'sm:grid-cols-2', className)}>
      {items.map((raw, i) => {
        const it = parseItem(raw)
        return (
          <li key={i} className="flex items-start gap-3 text-copy text-cocoa">
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-pill bg-sage text-cocoa">
              <IconCheck size={14} />
            </span>
            <span className="md-pretty">
              {it.label ? <span className="font-semibold">{it.label}: </span> : it.title ? <span className="font-semibold">{it.title} — </span> : null}
              <RichText text={it.label || it.title ? it.text : raw} />
            </span>
          </li>
        )
      })}
    </ul>
  )
}

// ── ukázkové menu jako tištěná karta ────────────────────────────────────────

export function MenuCard({ items, fallback, className }: { items: string[]; fallback?: string | null; className?: string }) {
  return (
    <div className={cx('mx-auto w-full max-w-2xl rounded-frame bg-paper p-2.5 shadow-float sm:p-3', className)}>
      <div className="rounded-[2px] border border-hairline px-5 py-10 text-center sm:px-12 sm:py-14">
        <Ornament className="mx-auto text-cocoa/40" />
        {items.length ? (
          <ul className="mt-8 space-y-7 sm:space-y-8">
            {items.map((raw, i) => {
              const it = parseItem(raw)
              const heading = it.label ?? it.title
              return (
                <li key={i}>
                  {heading ? <p className="mb-2 font-copy text-eyebrow uppercase text-cocoa-soft">{heading}</p> : null}
                  <p className="md-balance font-display text-[1.375rem] font-medium leading-snug text-cocoa sm:text-[1.5rem]">
                    <RichText text={heading ? it.text : raw} />
                  </p>
                </li>
              )
            })}
          </ul>
        ) : fallback ? (
          <p className="md-pretty mt-8 text-lead text-cocoa-soft">
            <RichText text={fallback} />
          </p>
        ) : null}
        <Ornament className="mx-auto mt-10 text-cocoa/40" />
      </div>
    </div>
  )
}

// ── číslované kroky ─────────────────────────────────────────────────────────

export function Steps({ items, className }: { items: string[]; className?: string }) {
  if (!items.length) return null
  return (
    <ol className={cx('grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {items.map((raw, i) => {
        const it = parseItem(raw)
        const step = it.title ? splitStepNumber(it.title) : splitStepNumber(raw)
        const n = step.n ?? i + 1
        return (
          <li key={i} className="border-t border-cocoa/20 pt-5">
            <span aria-hidden="true" className="block font-display text-[2.75rem] font-medium leading-none text-cocoa/70">
              {String(n).padStart(2, '0')}
            </span>
            {it.title ? (
              <>
                <h3 className="md-caps mt-4 text-h3 text-cocoa">{step.title}</h3>
                <p className="md-pretty mt-3 text-copy text-cocoa-soft">
                  <RichText text={it.text} />
                </p>
              </>
            ) : (
              <p className="md-pretty mt-4 text-lead text-cocoa">
                <RichText text={step.title} />
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ── balíčky / formáty jako karty ────────────────────────────────────────────

const GRID_COLS: Record<number, string> = {
  1: 'max-w-xl',
  2: 'sm:grid-cols-2 lg:max-w-5xl',
  4: 'sm:grid-cols-2',
}

/**
 * Položky „Název — popis s cenou“ jako karty; položky bez názvu jako štítky
 * pod mřížkou; „Štítek: text“ jako poznámka.
 */
export function PackageGrid({ items, headingLevel = 'h3' }: { items: string[]; headingLevel?: 'h2' | 'h3' }) {
  const parsed = items.map(parseItem)
  const cards = parsed.filter((p) => p.title)
  const chips = parsed.filter((p) => !p.title && !p.label)
  const notes = parsed.filter((p) => !p.title && p.label)
  return (
    <>
      {cards.length ? (
        <ul className={cx('grid gap-5 sm:gap-6', GRID_COLS[cards.length] ?? 'sm:grid-cols-2 lg:grid-cols-3')}>
          {cards.map((it, i) => (
            <li key={i}>
              <PackageCard item={it} tone={toneAt(i)} headingLevel={headingLevel} />
            </li>
          ))}
        </ul>
      ) : null}
      {chips.length ? <ChipList items={chips.map((c) => c.raw)} className={cards.length ? 'mt-8' : undefined} /> : null}
      {notes.length ? (
        <div className="mt-8 space-y-2">
          {notes.map((n, i) => (
            <p key={i} className="text-copy text-cocoa-soft">
              <span className="font-semibold text-cocoa">{n.label}: </span>
              <RichText text={n.text} />
            </p>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function PackageCard({ item, tone, headingLevel = 'h3' }: { item: ParsedItem; tone: SurfaceTone; headingLevel?: 'h2' | 'h3' }) {
  const facts = splitPriceFacts(item.text)
  return (
    <PastelCard
      title={item.title ?? item.text}
      tone={tone}
      headingLevel={headingLevel}
      meta={<FactsRow price={facts.price} guests={facts.guests} />}
    >
      {facts.rest ? (
        <p className="md-pretty mt-3 text-copy text-cocoa-soft">
          <RichText text={facts.rest} />
        </p>
      ) : null}
    </PastelCard>
  )
}

/** Krátká sekce (nadpis + text s cenou a minimem) jako karta; sousední se skládají do mřížky. */
export function FormatCard({ id, title, body, tone }: { id: string; title: string; body: string; tone: SurfaceTone }) {
  const facts = splitPriceFacts(body)
  return (
    <article aria-labelledby={id} className={cx('flex h-full flex-col rounded-frame p-6 sm:p-8', TONE_CARD[tone])}>
      <h2 id={id} className="md-caps text-h3 text-cocoa">
        {title}
      </h2>
      {facts.rest ? (
        <p className="md-pretty mt-4 text-copy text-cocoa-soft">
          <RichText text={facts.rest} />
        </p>
      ) : null}
      <FactsRow price={facts.price} guests={facts.guests} className="mt-auto pt-6" />
    </article>
  )
}

const TONE_CARD: Record<SurfaceTone, string> = {
  blush: 'bg-blush',
  sage: 'bg-sage',
  vanilla: 'bg-vanilla',
  pistachio: 'bg-pistachio',
  cream: 'bg-cream',
  paper: 'bg-paper',
}

// ── fotky ───────────────────────────────────────────────────────────────────

/** Poměr rámu podle fotky (na výšku 4:5, čtverec, jinak 3:2). */
export function aspectFor(photo: Photo | null | undefined, fallback: PhotoAspect = 'landscape'): PhotoAspect {
  if (!photo?.width || !photo.height) return fallback
  const r = photo.width / photo.height
  if (r < 0.9) return 'portrait'
  if (r < 1.15) return 'square'
  return 'landscape'
}

/** Mřížka fotek (galerie, pás mezi sekcemi). Zástupce bez fotky vynechá. */
export function PhotoGrid({ photos, tone = 'blush', className }: { photos: Photo[]; tone?: SurfaceTone; className?: string }) {
  const real = photos.filter((p) => !p.placeholder && p.src)
  if (!real.length) return null
  const n = real.length
  const cols = n === 1 ? '' : n === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'
  const aspect: PhotoAspect = n === 1 ? 'wide' : n === 2 ? 'square' : 'portrait'
  const sizes = n === 1 ? '(min-width: 1280px) 1200px, 100vw' : n === 2 ? '(min-width: 1280px) 600px, (min-width: 640px) 50vw, 100vw' : '(min-width: 1280px) 400px, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw'
  return (
    <ul className={cx('grid gap-4 sm:gap-6', cols, className)}>
      {real.map((p, i) => (
        <li key={`${p.slot}-${i}`} className={cx(n === 3 && i === 2 && 'sm:col-span-2 lg:col-span-1')}>
          <PhotoFrame photo={p} aspect={n === 3 && i === 2 ? 'portrait' : aspect} sizes={sizes} tone={toneAt(i)} className={cx(n === 3 && i === 2 && 'sm:aspect-[16/9] lg:aspect-[4/5]')} />
        </li>
      ))}
    </ul>
  )
}
