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
 * Patička (web v2, docs/web-v2-design.md §5.13): ink plocha, krémový text. Nahoře velký pruh
 * se stacked logem v inverzní variantě, claimem, CTA a kontakty velkým písmem; pod ním
 * orámovaná mřížka sloupců navigace a kontaktů na lidi; dole fakturační údaje (IČO, DIČ,
 * adresa, spisová značka), sítě a právní odkazy. Serverová komponenta.
 */
export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="md-on-dark mt-auto border-t-2 border-cocoa bg-cocoa text-cream" aria-labelledby="footer-title">
      <h2 id="footer-title" className="sr-only">
        Patička webu
      </h2>
      <Container width="wide" className="grid gap-10 border-b border-cream/20 py-section-sm lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-14">
        <Logo tone="light" variant="stacked" />
        <div>
          <p className="md-caps max-w-2xl text-[clamp(1.75rem,1.3rem+1.6vw,2.75rem)] leading-[1.15] text-cream">
            {CLAIM.replace(/ doma\.$/, ' ')}
            <span className="text-raspberry-onInk">doma.</span>
          </p>
          <ul role="list" className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-8">
            <li>
              <a href={COMPANY.phoneHref} className="md-focus-on-dark inline-flex min-h-11 items-center gap-3 font-copy text-[1.25rem] font-bold text-cream hover:underline sm:text-[1.375rem]">
                <IconPhone size={22} /> {COMPANY.phone}
              </a>
            </li>
            <li>
              <a href={`mailto:${COMPANY.email}`} className="md-focus-on-dark inline-flex min-h-11 items-center gap-3 break-all font-copy text-[1.125rem] font-bold text-cream hover:underline sm:text-[1.25rem]">
                <IconMail size={22} className="shrink-0" /> {COMPANY.email}
              </a>
            </li>
          </ul>
        </div>
        <div className="flex flex-col items-start gap-5 lg:items-end">
          <Button href={HEADER_CTA.href} variant="primary" size="lg" arrow className="md-focus-on-dark !border-cream !shadow-[4px_4px_0_0_#FBF3E6]">
            {HEADER_CTA.label}
          </Button>
          <ul className="flex flex-wrap gap-3" aria-label="Sociální sítě">
            {COMPANY.socials.map((s) => (
              <li key={s.href}>
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  title={s.label}
                  className="md-focus-on-dark grid h-11 w-11 place-items-center rounded-pill border-2 border-cream transition-colors hover:bg-cream hover:text-cocoa"
                >
                  {s.network === 'facebook' ? <IconFacebook /> : <IconInstagram />}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Container>

      <Container width="wide" className="grid grid-cols-2 gap-x-6 gap-y-10 py-12 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.3fr)] xl:gap-0 xl:divide-x xl:divide-cream/20">
        {FOOTER_COLUMNS.map((col, i) => (
          <nav key={col.title} aria-label={col.title} className={i === 0 ? 'row-span-2 xl:row-span-1 xl:pr-8' : 'xl:px-8'}>
            <h3 className="md-caps text-[1.5rem] leading-[1.2] text-cream">{col.title}</h3>
            <ul className="mt-4 space-y-1">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="md-focus-on-dark inline-flex min-h-9 items-center text-small text-cream/90 underline-offset-4 hover:text-cream hover:underline hover:decoration-raspberry-onInk hover:decoration-2">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}

        <div className="col-span-2 xl:col-span-1 xl:pl-8">
          <h3 className="md-caps text-[1.5rem] leading-[1.2] text-cream">Kontakt</h3>
          <ul className="mt-4 space-y-4 text-small">
            {COMPANY.people.map((p) => (
              <li key={p.name}>
                <p className="font-bold text-cream">{p.name}</p>
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
      </Container>

      <div className="border-t border-cream/20">
        <Container width="wide" className="grid gap-6 py-8 text-small text-cream/80 md:grid-cols-[2fr_1fr]">
          <address className="not-italic">
            <span className="font-bold text-cream">{COMPANY.legalName}</span>
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
        </Container>
      </div>
    </footer>
  )
}
