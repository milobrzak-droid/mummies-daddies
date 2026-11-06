import Image from 'next/image'
import { Fragment } from 'react'
import type { Photo } from '@/lib/web/photos'
import { FloatingTag, type FloatingTagTone } from './FloatingTag'
import { MotionToggle } from './MotionToggle'
import { cx } from '../cx'

/**
 * Obří typografický běžící pruh přes fotku (docs/web-v2-design.md §5.11), obdoba
 * „BENTO CAKE BENTO CAKE“ z reference. Fotka pod textem s 60% ink překryvem (čitelnost), slova
 * Antonem střídavě krémová a malinová, oddělovač • máslový. Štítky rozložené přes celý pruh. Obsah je v DOM dvakrát (druhá
 * kopie aria-hidden), celý pohyblivý pruh je aria-hidden a vedle je sr-only věta.
 * Pozastaví se na hover/focus a tlačítkem „Zastavit animaci“ (WCAG 2.2.2); při reduced motion
 * se místo pruhu ukáže statický zalomený nápis.
 * Štítky = jen fakta.
 */
const TAG_SPOT = ['sm:self-end', 'sm:self-start sm:mb-16', 'sm:self-end sm:mb-4', 'sm:self-start sm:mb-20']

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
          <span className={cx('px-[0.18em]', i % 2 === 1 && 'text-raspberry-onInk')}>{w}</span>
          <span className="px-[0.12em] text-butter">•</span>
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
        <div aria-hidden="true" className="absolute inset-0 bg-cocoa/60" />
        <div aria-hidden="true" className="md-marquee-run absolute inset-x-0 top-[34%] -translate-y-1/2 overflow-hidden pt-[0.18em] sm:top-[42%]">
          <div className="md-marquee-track md-caps whitespace-nowrap text-[4.5rem] leading-[1.15] text-cream sm:text-[clamp(4.5rem,1.6rem+11.7vw,12.35rem)]">
            {run(false)}
            {run(true)}
          </div>
        </div>
        {/* Při „omezit pohyb“: statický, zalomený nápis místo useknutého pruhu. */}
        <p aria-hidden="true" className="md-marquee-static md-caps absolute inset-x-0 top-[34%] hidden -translate-y-1/2 px-gutter text-center text-[clamp(3rem,1.5rem+7vw,8rem)] leading-[1.15] text-cream sm:top-[42%]">
          {words.map((w, i) => (
            <Fragment key={w}>
              {i ? <span className="px-[0.15em] text-butter">•</span> : null}
              <span className={cx('inline-block', i % 2 === 1 && 'text-raspberry-onInk')}>{w}</span>
            </Fragment>
          ))}
        </p>
        <p className="sr-only">{label}</p>
        <MotionToggle className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6" />
        {tags.length ? (
          <ul role="list" className="absolute bottom-6 left-4 right-4 flex flex-col items-start gap-2 sm:inset-x-[6%] sm:bottom-8 sm:flex-row sm:items-end sm:justify-between">
            {tags.map((t, i) => (
              <li key={t.text} className={cx(TAG_SPOT[i % TAG_SPOT.length], i >= 2 && 'max-sm:hidden')}>
                <FloatingTag tone={t.tone} rotate={[-4, 4, -3, 4][i % 4]} delay={i * -1.3}>
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
