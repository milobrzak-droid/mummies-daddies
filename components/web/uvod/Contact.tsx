import type { ReactNode } from 'react'
import type { PastelTone } from '@/lib/web/tokens'
import { IconFacebook, IconInstagram, IconMail, IconPhone } from '../icons'
import { PlaceholderText } from '../PlaceholderText'
import { TONE_BG } from '../tones'
import { cx } from '../cx'
import type { ContactLine } from './copy-helpers'

/** Karta člověka: jméno, role a zaměření, telefon a e-mail jako odkazy. */
export function ContactPersonCard({ name, lines, tone = 'sage' }: { name: string; lines: ContactLine[]; tone?: PastelTone }) {
  const texts = lines.filter((l) => l.kind === 'text')
  const links = lines.filter((l): l is Exclude<ContactLine, { kind: 'text' }> => l.kind !== 'text')
  return (
    <article className={cx('flex h-full flex-col rounded-frame p-6 sm:p-8', TONE_BG[tone])}>
      <h3 className="md-caps text-h3 text-cocoa">{name}</h3>
      {texts.length ? (
        <ul role="list" className="mt-3 space-y-1 text-copy text-cocoa-soft">
          {texts.map((t) => (
            <li key={t.text}>
              <PlaceholderText text={t.text} />
            </li>
          ))}
        </ul>
      ) : null}
      {links.length ? (
        <ul role="list" className="mt-auto space-y-1 pt-6">
          {links.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="inline-flex min-h-11 items-center gap-3 font-copy text-[1.0625rem] font-bold text-cocoa hover:underline">
                {l.kind === 'phone' ? <IconPhone size={20} className="shrink-0" /> : <IconMail size={20} className="shrink-0" />}
                <span className="min-w-0">{l.kind === 'email' ? withBreakAfterAt(l.text) : l.text}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

/** E-mail se může zalomit jen za zavináčem (ne uprostřed domény). */
function withBreakAfterAt(email: string) {
  const i = email.indexOf('@')
  return i < 0 ? email : (
    <>
      {email.slice(0, i + 1)}
      <wbr />
      {email.slice(i + 1)}
    </>
  )
}

/** Panel se svým nadpisem (h2) – fakturace, provozovna, sítě, rychlá poptávka. */
export function ContactPanel({
  id,
  heading,
  body,
  tone,
  className,
  children,
}: {
  id: string
  heading: string
  body?: string | null
  tone?: PastelTone | 'paper'
  className?: string
  children?: ReactNode
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={cx('rounded-soft p-6 sm:p-8', tone ? TONE_BG[tone] : 'bg-paper ring-2 ring-cocoa', className)}>
      <h2 id={`${id}-title`} className="md-caps text-h3 text-cocoa">
        {heading}
      </h2>
      {body ? (
        <p className="md-pretty mt-3 text-copy text-cocoa-soft">
          <PlaceholderText text={body} />
        </p>
      ) : null}
      {children ? <div className="mt-6">{children}</div> : null}
    </section>
  )
}

export interface SocialLink {
  network: string
  label: string
  text: string
  href: string | null
}

/** Seznam sociálních sítí; síť bez odkazu (LinkedIn) zůstane jako zástupce. */
export function SocialList({ items }: { items: SocialLink[] }) {
  return (
    <ul role="list" className="space-y-1">
      {items.map((s) => {
        const Icon = s.network === 'instagram' ? IconInstagram : s.network === 'facebook' ? IconFacebook : null
        const inner = (
          <>
            {Icon ? <Icon size={20} className="shrink-0" /> : <span aria-hidden="true" className="inline-block w-5" />}
            <span>
              <span className="font-bold">{s.label}:</span> <PlaceholderText text={s.text} />
            </span>
          </>
        )
        return (
          <li key={`${s.label}-${s.text}`}>
            {s.href ? (
              <a href={s.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-3 font-copy text-copy text-cocoa hover:underline">
                {inner}
                <span className="sr-only">(otevře se v novém okně)</span>
              </a>
            ) : (
              <span className="inline-flex min-h-11 items-center gap-3 font-copy text-copy text-cocoa">{inner}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
