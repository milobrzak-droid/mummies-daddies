import { COMPANY } from '@/lib/web/company'
import { TOP_BAR_TEXT } from '@/lib/web/navigation'
import { Container } from '../Container'
import { IconPhone } from '../icons'

/** Horní lišta (docs §5.1): ink pruh, krémový text, rychlost odpovědi + telefon (tel: odkaz). */
export function TopBar() {
  return (
    <div className="md-on-dark bg-cocoa text-cream">
      <Container width="wide" className="flex min-h-9 items-center justify-center gap-3 py-1 text-center text-[0.8125rem] font-medium leading-snug sm:text-[0.875rem]">
        <p>{TOP_BAR_TEXT}</p>
        <span aria-hidden="true" className="max-sm:hidden">
          ·
        </span>
        <a href={COMPANY.phoneHref} className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap font-bold underline decoration-raspberry-onInk decoration-2 underline-offset-4">
          <IconPhone size={15} />
          <span className="max-sm:sr-only">{COMPANY.phone}</span>
          <span className="sm:hidden" aria-hidden="true">Zavolat</span>
        </a>
      </Container>
    </div>
  )
}
