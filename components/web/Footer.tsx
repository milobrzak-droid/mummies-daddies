import Link from 'next/link'
import { COMPANY } from '@/lib/web/company'
import { FOOTER_COLUMNS, HEADER_CTA, LEGAL_LINKS } from '@/lib/web/navigation'
import { Button } from './Button'
import { Container } from './Container'
import { IconFacebook, IconInstagram, IconMail, IconPhone } from './icons'
import { Logo } from './Logo'
import { PlaceholderText } from './PlaceholderText'

/** Claim v patičce (copy: úvod › proc-my › body). */
const CLAIM = 'Vaříme jako v dobré restauraci a staráme se jako doma.'

/**
 * Patička: značka + CTA, navigace, kontakty na lidi, fakturační údaje
 * (IČO, DIČ, adresa, spisová značka), sítě a právní odkazy. Serverová komponenta.
 */
export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="mt-auto bg-cocoa text-cream" aria-labelledby="footer-title">
      <h2 id="footer-title" className="sr-only">
        Patička webu
      </h2>
      <Container className="py-section-sm">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <div className="max-w-sm">
            <Logo tone="light" />
            <p className="mt-5 text-lead text-cream/85">{CLAIM}</p>
            <div className="mt-8">
              <Button href={HEADER_CTA.href} variant="white" arrow className="md-focus-on-dark">
                {HEADER_CTA.label}
              </Button>
            </div>
            <ul className="mt-8 flex flex-wrap gap-3" aria-label="Sociální sítě">
              {COMPANY.socials.map((s) => (
                <li key={s.href}>
                  <a
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={s.label}
                    title={s.label}
                    className="md-focus-on-dark grid h-11 w-11 place-items-center rounded-pill ring-1 ring-cream/30 transition-colors hover:bg-cream hover:text-cocoa"
                  >
                    {s.network === 'facebook' ? <IconFacebook /> : <IconInstagram />}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.9fr)_minmax(0,1.45fr)]">
            {FOOTER_COLUMNS.map((col, i) => (
              <nav key={col.title} aria-label={col.title} className={i === 0 ? 'row-span-2 xl:row-span-1' : undefined}>
                <h3 className="font-copy text-eyebrow uppercase text-cream/70">{col.title}</h3>
                <ul className="mt-4 space-y-1">
                  {col.links.map((l) => (
                    <li key={l.href}>
                      <Link href={l.href} className="md-focus-on-dark inline-flex min-h-9 items-center text-small text-cream/90 underline-offset-4 hover:text-cream hover:underline">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}

            <div className="col-span-2 xl:col-span-1">
              <h3 className="font-copy text-eyebrow uppercase text-cream/70">Kontakt</h3>
              <ul className="mt-4 space-y-4 text-small">
                {COMPANY.people.map((p) => (
                  <li key={p.name}>
                    <p className="font-semibold text-cream">{p.name}</p>
                    <p className="text-cream/80">
                      <PlaceholderText text={p.role} />
                    </p>
                    <a href={p.phoneHref} className="md-focus-on-dark mt-1 inline-flex min-h-9 items-center gap-2 text-cream/90 hover:text-cream hover:underline">
                      <IconPhone size={16} /> {p.phone}
                    </a>
                  </li>
                ))}
                <li>
                  <a href={`mailto:${COMPANY.email}`} className="md-focus-on-dark inline-flex min-h-9 items-center gap-2 text-cream/90 hover:text-cream hover:underline">
                    <IconMail size={16} className="shrink-0" />
                    <span className="min-w-0">
                      {COMPANY.email.split('@')[0]}@<wbr />
                      {COMPANY.email.split('@')[1]}
                    </span>
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-14 grid gap-6 border-t border-cream/20 pt-8 text-small text-cream/80 md:grid-cols-[2fr_1fr]">
          <address className="not-italic">
            <span className="font-semibold text-cream">{COMPANY.legalName}</span>
            <span aria-hidden="true"> · </span>
            {COMPANY.street}, {COMPANY.zip} {COMPANY.city}
            <span aria-hidden="true"> · </span>
            IČO {COMPANY.ico}
            <span aria-hidden="true"> · </span>
            DIČ {COMPANY.dic}
            <br />
            {COMPANY.registry}
          </address>
          <div className="flex flex-col gap-2 md:items-end">
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              {LEGAL_LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="md-focus-on-dark inline-flex min-h-9 items-center underline-offset-4 hover:text-cream hover:underline">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
            <p>
              © {COMPANY.founded}–{year} {COMPANY.legalName}
            </p>
          </div>
        </div>
      </Container>
    </footer>
  )
}
