import Link from 'next/link'
import { Button } from '../Button'
import { Container } from '../Container'
import { IconMail, IconPhone } from '../icons'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'

export interface AssistantChip {
  label: string
  href: string
}

/**
 * Závěrečná poptávka (sytě růžový blok). Vlevo výzva a kontakt na živého
 * člověka, vpravo okno digitálního asistenta: úvodní zpráva asistenta
 * (mikrotext) a rychlé volby typu akce jako odkazy s předvyplněním
 * (/poptavka?typ=…). Funguje bez JS; živý chat napojí agent poptávky.
 */
export function FinalInquiry({
  heading,
  body,
  chatTitle,
  greeting,
  chips,
  assistantNote,
  formLabel,
  formHref,
  primary,
  phone,
  email,
  id = 'zaverecna-poptavka',
}: {
  heading: string
  body?: string | null
  /** „Chat s digitálním asistentem“ */
  chatTitle: string
  /** ASISTENT — úvodní zpráva */
  greeting: string
  chips: AssistantChip[]
  /** POPTÁVKA — informace o asistentovi */
  assistantNote?: string | null
  /** „Krátký formulář“ */
  formLabel: string
  formHref: string
  primary: { label: string; href: string }
  phone?: { text: string; href: string } | null
  email?: { text: string; href: string } | null
  id?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="bg-blush py-section">
      <Container className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-16">
        <div>
          <h2 id={`${id}-title`} className="md-caps text-h1 text-cocoa">
            {heading}
          </h2>
          {body ? (
            <p className="md-pretty mt-6 max-w-xl text-lead text-cocoa">
              <PlaceholderText text={body} />
            </p>
          ) : null}
          <div className="mt-8">
            <Button href={primary.href} variant="primary" size="lg" arrow>
              {primary.label}
            </Button>
          </div>
          {phone || email ? (
            <ul role="list" className="mt-8 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-8">
              {phone ? (
                <li>
                  <a href={phone.href} className="inline-flex min-h-11 items-center gap-3 font-copy text-[1.125rem] font-semibold text-cocoa hover:underline">
                    <IconPhone size={20} />
                    {phone.text}
                  </a>
                </li>
              ) : null}
              {email ? (
                <li>
                  <a href={email.href} className="inline-flex min-h-11 items-center gap-3 font-copy text-[1.125rem] font-semibold text-cocoa hover:underline">
                    <IconMail size={20} />
                    {email.text}
                  </a>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>

        <div className="rounded-soft bg-paper shadow-float ring-1 ring-cocoa/5">
          <div className="flex items-center gap-3 border-b border-hairline px-5 py-4 sm:px-6">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-pill bg-success" />
            <h3 className="font-copy text-copy font-semibold text-cocoa">{chatTitle}</h3>
          </div>
          <div className="space-y-5 px-5 py-6 sm:px-6">
            <p className="max-w-[28rem] rounded-soft rounded-tl-frame bg-sage-soft px-4 py-3 text-copy text-cocoa">{greeting}</p>
            <ul role="list" aria-label={chatTitle} className="flex flex-wrap gap-2">
              {chips.map((c) => (
                <li key={c.href}>
                  <Link
                    href={c.href}
                    className={cx(
                      'inline-flex min-h-11 items-center rounded-pill bg-paper px-4 font-copy text-small font-semibold text-cocoa ring-1 ring-inset ring-cocoa/30',
                      'transition-colors duration-quick ease-md-out hover:bg-raspberry-ink hover:text-paper hover:ring-transparent',
                    )}
                  >
                    {c.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-4 border-t border-hairline px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            {assistantNote ? <p className="text-small text-cocoa-soft">{assistantNote}</p> : null}
            <Button href={formHref} variant="outline" size="sm" className="shrink-0 self-start sm:self-auto">
              {formLabel}
            </Button>
          </div>
        </div>
      </Container>
    </section>
  )
}
