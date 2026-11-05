import { MAIN_NAV } from '@/lib/web/navigation'
import { UI_TEXT } from '@/lib/web/poptavka/ui-text'
import { Button } from '../Button'
import { Container } from '../Container'
import { IconPlate } from '../icons'

/**
 * Stránka 404 (mikrotexty 404 — …): nadpis, text, „Na úvod“ / „Chci nabídku“
 * a hlavní položky menu („Zkuste menu“). Texty dodává stránka (copy.ts).
 */
export function NotFoundView({
  heading,
  text,
  home,
  inquiry,
  inquiryHref,
}: {
  heading: string
  text: string
  home: string
  inquiry: string
  inquiryHref: string
}) {
  const links = MAIN_NAV.flatMap((g) => (g.href ? [{ label: g.label, href: g.href }] : []))
  return (
    <section aria-labelledby="nenalezeno-title" className="bg-blush-soft py-section">
      <Container width="prose" className="text-center">
        <span aria-hidden="true" className="mx-auto grid h-20 w-20 place-items-center rounded-pill bg-blush text-cocoa motion-safe:animate-rise">
          <IconPlate size={36} />
        </span>
        <p className="mt-6 font-display text-[4.5rem] italic leading-none text-cocoa-soft">404</p>
        <h1 id="nenalezeno-title" className="md-caps mt-4 text-h1 text-cocoa">
          {heading}
        </h1>
        <p className="md-pretty mx-auto mt-5 max-w-xl text-lead text-cocoa-soft">{text}</p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/" variant="outline" size="lg">
            {home}
          </Button>
          <Button href={inquiryHref} variant="primary" size="lg" arrow>
            {inquiry}
          </Button>
        </div>
        {links.length ? (
          <nav aria-label={UI_TEXT.notFoundNav} className="mt-12 border-t border-cocoa/10 pt-8">
            <ul role="list" className="flex flex-wrap justify-center gap-x-6 gap-y-2">
              {links.map((l) => (
                <li key={l.href}>
                  <Button href={l.href} variant="ghost" size="sm">
                    {l.label}
                  </Button>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </Container>
    </section>
  )
}
