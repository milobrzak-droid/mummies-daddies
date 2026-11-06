import Image from 'next/image'
import { Fragment } from 'react'
import type { Photo } from '@/lib/web/photos'
import { FloatingTag, type FloatingTagTone } from './FloatingTag'
import { cx } from '../cx'

/**
 * Obří typografický běžící pruh přes fotku (docs/web-v2-design.md §5.11), obdoba
 * „BENTO CAKE BENTO CAKE“ z reference. Fotka pod textem s 35% ink překryvem, slova Antonem
 * v krémové, každé druhé obrysem, oddělovač • v malině. Obsah je v DOM dvakrát (druhá
 * kopie aria-hidden), celý pohyblivý pruh je aria-hidden a vedle je sr-only věta.
 * Pozastaví se na hover/focus, při reduced motion je statický a zalomený.
 * Štítky = jen fakta.
 */
export function BigMarquee({
  words,
  label,
  photo,
  tags = [],
  id,
}: {
  words: string[]
  /** Věta pro čtečky (sr-only). */
  label: string
  photo: Photo | null
  tags?: { text: string; tone: FloatingTagTone }[]
  id?: string
}) {
  const run = (copy: boolean) => (
    <span className={cx('flex shrink-0 items-center', copy && 'md-marquee-copy')} aria-hidden={copy || undefined}>
      {[...words, ...words].map((w, i) => (
        <Fragment key={`${w}-${i}`}>
          <span className={cx('px-[0.18em]', i % 2 === 1 && 'md-outline-text')}>{w}</span>
          <span className="px-[0.12em] text-raspberry-onInk">•</span>
        </Fragment>
      ))}
    </span>
  )
  return (
    <section id={id} aria-label={label} className="md-marquee relative isolate overflow-hidden border-t-2 border-cocoa bg-cocoa">
      <div className="relative h-[19rem] sm:h-[clamp(18rem,12rem+20vw,34rem)]">
        {photo?.src ? (
          <div aria-hidden="true" className="absolute inset-0">
            <Image src={photo.src} alt="" fill sizes="100vw" quality={60} className="object-cover" style={photo.position ? { objectPosition: photo.position } : undefined} />
          </div>
        ) : null}
        <div aria-hidden="true" className="absolute inset-0 bg-cocoa/45" />
        <div aria-hidden="true" className="absolute inset-x-0 top-[34%] -translate-y-1/2 overflow-hidden pt-[0.18em] sm:top-1/2">
          <div className="md-marquee-track md-caps whitespace-nowrap text-[4.5rem] leading-[1.15] text-cream sm:text-[clamp(4.5rem,1.6rem+11.7vw,12.35rem)]">
            {run(false)}
            {run(true)}
          </div>
        </div>
        <p className="sr-only">{label}</p>
        {tags.length ? (
          <ul role="list" className="absolute bottom-4 left-4 right-4 flex flex-col items-start gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:flex-row sm:flex-wrap sm:justify-end lg:bottom-10 lg:right-10">
            {tags.map((t, i) => (
              <li key={t.text} className={cx(i >= 2 && 'max-sm:hidden')}>
                <FloatingTag tone={t.tone} rotate={[-4, 3, -2, 5][i % 4]} delay={i * -1.3}>
                  {t.text}
                </FloatingTag>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  )
}
