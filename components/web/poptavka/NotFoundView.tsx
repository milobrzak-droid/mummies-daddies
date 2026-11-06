import { FloatingCutout } from '../v2/FloatingCutout'
import { MAIN_NAV } from '@/lib/web/navigation'
import { UI_TEXT } from '@/lib/web/poptavka/ui-text'
import { Button } from '../Button'
import { Container } from '../Container'
import { AccentTitle } from '@/components/web/AccentTitle'

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
    <section aria-labelledby="nenalezeno-title" className="overflow-x-clip bg-blush-soft py-section">
      <Container width="prose" className="text-center">
        <div className="relative mx-auto w-48 sm:w-56">
          <FloatingCutout slug="mini-cheesecake-cokoladovy" rotate={-8} sizes="224px" />
          <span aria-hidden="true" className="md-caps absolute -right-16 top-6 rotate-6 rounded-pill border-2 border-cocoa bg-butter px-4 py-1 text-[2.5rem] leading-[1.15] text-cocoa shadow-hard-sm">
            404
          </span>
        </div>
        <h1 id="nenalezeno-title" className="md-caps mt-4 text-h1 text-cocoa"><AccentTitle title={heading} /></h1>
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
          <nav aria-label={UI_TEXT.notFoundNav} className="mt-12 border-t-2 border-cocoa pt-8">
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
