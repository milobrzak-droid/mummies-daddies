'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { Photo } from '@/lib/web/photos'
import type { Cutout } from '@/lib/web/cutouts'
import { IconArrowRight } from '../icons'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'
import { FloatingTag, type FloatingTagTone } from './FloatingTag'

/**
 * Seznam vlevo + velký produkt vpravo (docs/web-v2-design.md §5.8 FormatExplorer a §5.9
 * CheesecakeExplorer), obdoba sekce „Awesome flavors“ z reference.
 *
 * Přístupnost: tablist (role=tablist, aria-orientation) s taby a panely, ovládání šipkami
 * ↑/↓/←/→, Home/End (roving tabindex). Všechny panely jsou v DOM (SSR, bez JS je vidět první),
 * neaktivní mají `hidden`.
 * Desktop (lg+): svislý seznam řádků s Anton názvem a šipkou, aktivní řádek plný (malina,
 * u Daddy modrá). Mobil: vodorovný pás pilulek (scroll-snap, fade na okrajích).
 * Štítky kolem fotky = JEN fakta (z navigation/facts nebo odvozené z názvu příchuti).
 */
export interface ExplorerItem {
  id: string
  label: string
  /** Barva řady: raspberry = Mummy (výchozí), blue = Daddy. */
  tone?: 'raspberry' | 'blue' | 'butter'
  /** Malý popisek nad názvem v panelu (např. „Řada Daddy“). */
  kicker?: string
  photo: Photo | null
  /** Výřez bez pozadí na kruhovém „talíři“ (má přednost před fotkou). */
  cutout?: Cutout | null
  tags: string[]
  description?: string | null
  /** Cena / minimum pod produktem (už naformátovaný uzel). */
  meta?: ReactNode
  links: { label: string; href: string; primary?: boolean }[]
}

const TAG_TONES: FloatingTagTone[] = ['vanilla', 'paper', 'sage', 'blush']
const TAG_POS = ['lg:-left-6 lg:top-[8%]', 'lg:-right-4 lg:top-[30%]', 'lg:-left-3 lg:bottom-[22%]', 'lg:right-[6%] lg:-bottom-3']

const ACTIVE: Record<NonNullable<ExplorerItem['tone']>, string> = {
  raspberry: 'aria-selected:bg-raspberry-ink lg:aria-selected:bg-raspberry-ink',
  blue: 'aria-selected:bg-daddy-ink lg:aria-selected:bg-daddy-ink',
  butter: 'aria-selected:bg-raspberry-ink lg:aria-selected:bg-raspberry-ink',
}
const DOT: Record<NonNullable<ExplorerItem['tone']>, string> = { raspberry: 'bg-raspberry', blue: 'bg-daddy', butter: 'bg-butter' }
const PLATE: Record<NonNullable<ExplorerItem['tone']>, string> = { raspberry: 'bg-raspberry-tint', blue: 'bg-daddy-tint', butter: 'bg-butter' }

export function Explorer({ items, label, showDots = false }: { items: ExplorerItem[]; label: string; showDots?: boolean }) {
  const [active, setActive] = useState(0)
  const [scrolled, setScrolled] = useState(false)
  const base = useId()
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  const focusTab = (i: number) => {
    const n = (i + items.length) % items.length
    setActive(n)
    tabs.current[n]?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const map: Record<string, number> = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }
    if (e.key in map) {
      e.preventDefault()
      focusTab(map[e.key])
    }
  }

  return (
    <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="vertical"
        data-scrolled={scrolled}
        onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 4)}
        className="md-scroll-fade flex snap-x gap-2 overflow-x-auto px-gutter pb-5 pt-1 lg:mx-0 lg:block lg:snap-none lg:overflow-visible lg:border-r-2 lg:border-cocoa lg:p-0"
      >
        {items.map((it, i) => {
          const tone = it.tone ?? 'raspberry'
          return (
            <button
              key={it.id}
              ref={(el) => {
                tabs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${base}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              onKeyDown={(e) => onKey(e, i)}
              className={cx(
                'group flex shrink-0 snap-start items-center gap-2.5 text-left text-cocoa transition-colors duration-quick aria-selected:text-cream',
                // mobil: pilulky
                'min-h-11 rounded-pill border-2 border-cocoa bg-paper px-4 font-copy text-small font-bold shadow-hard-sm',
                // desktop: řádky seznamu s 2px linkami
                'lg:min-h-[4.75rem] lg:w-full lg:justify-between lg:rounded-none lg:border-0 lg:border-b-2 lg:bg-cream lg:px-6 lg:shadow-none lg:[&:not([aria-selected=true]):hover]:bg-raspberry-tint xl:px-8',
                ACTIVE[tone],
              )}
            >
              <span className="flex items-center gap-3">
                {showDots ? <span aria-hidden="true" className={cx('h-3 w-3 shrink-0 rounded-pill border-2 border-cocoa group-aria-selected:border-cream group-aria-selected:bg-cream', DOT[tone])} /> : null}
                <span className="lg:font-display lg:text-h3 lg:uppercase">{it.label}</span>
              </span>
              <IconArrowRight
                size={26}
                className="hidden shrink-0 -rotate-45 transition-transform duration-base group-hover:rotate-0 group-aria-selected:rotate-0 lg:block"
              />
            </button>
          )
        })}
      </div>

      {items.map((it, i) => (
        <div
          key={it.id}
          role="tabpanel"
          id={`${base}-panel-${i}`}
          aria-labelledby={`${base}-tab-${i}`}
          hidden={i !== active}
          tabIndex={0}
          className="min-w-0 px-gutter pb-10 pt-2 outline-offset-[-3px] motion-safe:animate-fade lg:flex lg:items-center lg:px-10 lg:py-12 xl:pl-14 xl:pr-10 [&[hidden]]:hidden"
        >
          <Panel item={it} />
        </div>
      ))}
    </div>
  )
}

function Panel({ item }: { item: ExplorerItem }) {
  const tone = item.tone ?? 'raspberry'
  return (
    <div className="grid w-full gap-8 xl:grid-cols-[minmax(0,55%)_minmax(0,1fr)] xl:items-center xl:gap-12">
      <div className="relative mx-auto w-full max-w-[30rem] xl:max-w-none">
        {item.cutout ? (
          <div className={cx('relative aspect-square rounded-full border-2 border-cocoa shadow-hard-md', PLATE[tone])}>
            <span className="md-float absolute inset-[7%] block" style={{ '--r': '-6deg' } as CSSProperties}>
              <Image src={item.cutout.src} alt={item.cutout.alt} width={item.cutout.width} height={item.cutout.height} sizes="(min-width: 1024px) 420px, 80vw" loading="lazy" className="h-full w-full object-contain drop-shadow-[6px_8px_0_rgba(43,24,16,0.22)]" />
            </span>
          </div>
        ) : (
          <div className="motion-safe:-rotate-2">
            <div className="md-sticker relative aspect-[4/3] shadow-hard-lg sm:aspect-square">
              {item.photo?.src ? (
                <Image
                  src={item.photo.src}
                  {...(item.photo.blur ? { placeholder: 'blur' as const, blurDataURL: item.photo.blur } : {})}
                  alt={item.photo.alt}
                  fill
                  sizes="(min-width: 1280px) 440px, (min-width: 1024px) 40vw, 92vw"
                  className="object-cover"
                  style={item.photo.position ? { objectPosition: item.photo.position } : undefined}
                />
              ) : null}
            </div>
          </div>
        )}
        {item.tags.length ? (
          <ul role="list" className="mt-6 flex flex-wrap gap-x-2 gap-y-3 lg:mt-0 lg:block">
            {item.tags.slice(0, 4).map((t, i) => (
              <li key={t} className={cx('lg:absolute lg:z-10', TAG_POS[i])}>
                <FloatingTag tone={TAG_TONES[i % TAG_TONES.length]} rotate={[-3, 3, -2, 3][i]} delay={i * -1.6}>
                  {t}
                </FloatingTag>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        {item.kicker ? <p className="font-copy text-eyebrow uppercase text-cocoa-soft">{item.kicker}</p> : null}
        <p className="md-caps mt-1 text-[clamp(1.875rem,1.4rem+1.6vw,2.75rem)] leading-[1.2] text-cocoa">{item.label}</p>
        {item.description ? (
          <p className="md-pretty mt-3 text-copy text-cocoa-soft">
            <PlaceholderText text={item.description} />
          </p>
        ) : null}
        {item.meta ? <div className="mt-4">{item.meta}</div> : null}
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          {item.links.map((l) =>
            l.primary ? (
              <Link
                key={l.href}
                href={l.href}
                className="md-press group inline-flex min-h-12 items-center gap-2 rounded-pill border-[2.5px] border-cocoa bg-raspberry-ink px-6 font-copy font-bold text-cream shadow-hard hover:bg-raspberry-deep"
              >
                {l.label}
                <IconArrowRight size={18} className="motion-safe:transition-transform motion-safe:group-hover:translate-x-1" />
              </Link>
            ) : (
              <Link key={l.href} href={l.href} className="md-link inline-flex min-h-11 items-center gap-2 font-copy font-bold text-cocoa">
                {l.label} <IconArrowRight size={18} />
              </Link>
            ),
          )}
        </div>
      </div>
    </div>
  )
}
