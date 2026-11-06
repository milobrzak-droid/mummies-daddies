'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { COMPANY } from '@/lib/web/company'
import { CATERING_MENU, HEADER_CTA, MAIN_NAV, isActive } from '@/lib/web/navigation'
import { Button } from './Button'
import { Container } from './Container'
import { IconArrowRight, IconBag, IconChevronDown, IconClose, IconMenu, IconPhone } from './icons'
import { Logo } from './Logo'
import { TopBar } from './v2/TopBar'
import { cx } from './cx'

/**
 * Header (web v2, docs/web-v2-design.md §5.1–5.2): ink horní lišta (TopBar), sticky krémový
 * pruh s 2px ink linkou dole (po odrolování papír), logo „sticker pills“, navigace
 * s malinovým podtržením, mega-menu Catering jako orámovaná mřížka (hover i klik, Esc zavře),
 * telefon, košík a pilulkové CTA „Chci nabídku“ s tvrdým stínem. Na mobilu (< xl) hamburger
 * + stále viditelné CTA „Nabídka“; menu je modální krémový panel s velkým CTA dole.
 */
export function Header() {
  const pathname = usePathname()
  const [megaOpen, setMegaOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileCatering, setMobileCatering] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [lastPath, setLastPath] = useState(pathname)
  const headerRef = useRef<HTMLElement>(null)
  const megaButtonRef = useRef<HTMLButtonElement>(null)
  const burgerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const megaId = useId()
  const mobileId = useId()

  // Zavřít menu po navigaci (bez efektu: porovnání při renderu).
  if (pathname !== lastPath) {
    setLastPath(pathname)
    setMegaOpen(false)
    setMobileOpen(false)
  }

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Mega-menu: Esc a klik mimo zavřou.
  useEffect(() => {
    if (!megaOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMegaOpen(false)
        megaButtonRef.current?.focus()
      }
    }
    const onPointer = (e: PointerEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMegaOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [megaOpen])

  const closeMobile = useCallback(() => {
    setMobileOpen(false)
    burgerRef.current?.focus()
  }, [])

  // Mobilní menu: zámek rolování, fokus do panelu, Esc, past na Tab.
  useEffect(() => {
    if (!mobileOpen) return
    const root = document.documentElement
    const prev = root.style.overflow
    root.style.overflow = 'hidden'
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMobile()
      if (e.key === 'Tab' && dialog) {
        const f = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((el) => el.offsetParent !== null)
        if (!f.length) return
        const first = f[0]
        const last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      root.style.overflow = prev
      document.removeEventListener('keydown', onKey)
    }
  }, [mobileOpen, closeMobile])

  const openMega = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setMegaOpen(true)
  }
  const scheduleCloseMega = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setMegaOpen(false), 160)
  }

  return (
    <>
      <TopBar />

      <header
        ref={headerRef}
        className={cx(
          'sticky top-0 z-40 border-b-2 border-cocoa transition-colors duration-base',
          scrolled || megaOpen ? 'bg-paper' : 'bg-cream',
        )}
      >
        <Container width="wide" className="flex h-16 items-center gap-2 sm:gap-3 lg:h-20 xl:gap-5">
          <Logo className="mr-auto xl:mr-2" />

          <nav aria-label="Hlavní navigace" className="hidden xl:block">
            <ul className="flex items-center">
              {MAIN_NAV.map((item) =>
                item.children ? (
                  <li key={item.href} onMouseEnter={openMega} onMouseLeave={scheduleCloseMega}>
                    <button
                      ref={megaButtonRef}
                      type="button"
                      aria-expanded={megaOpen}
                      aria-controls={megaId}
                      onClick={() => setMegaOpen((v) => !v)}
                      className={cx('relative inline-flex min-h-11 items-center gap-1 whitespace-nowrap px-2.5 font-copy text-[0.9375rem] font-semibold text-cocoa 2xl:px-3.5 2xl:text-copy after:absolute after:inset-x-2.5 after:bottom-1.5 after:h-[3px] after:rounded-pill after:bg-raspberry after:opacity-0 after:transition-opacity hover:after:opacity-100 2xl:after:inset-x-3.5', (megaOpen || isActive(item.href, pathname)) && 'after:opacity-100')}
                    >
                      {item.label}
                      <IconChevronDown size={16} className={cx('motion-safe:transition-transform', megaOpen && 'rotate-180')} />
                    </button>
                    <MegaMenu id={megaId} open={megaOpen} pathname={pathname} onNavigate={() => setMegaOpen(false)} />
                  </li>
                ) : (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={isActive(item.href, pathname) ? 'page' : undefined}
                      className={cx('relative inline-flex min-h-11 items-center gap-1 whitespace-nowrap px-2.5 font-copy text-[0.9375rem] font-semibold text-cocoa 2xl:px-3.5 2xl:text-copy after:absolute after:inset-x-2.5 after:bottom-1.5 after:h-[3px] after:rounded-pill after:bg-raspberry after:opacity-0 after:transition-opacity hover:after:opacity-100 2xl:after:inset-x-3.5', isActive(item.href, pathname) && 'after:opacity-100')}
                    >
                      {item.label}
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </nav>

          <div className="flex items-center gap-1 min-[380px]:gap-1.5 sm:gap-2.5 xl:ml-auto">
            <a
              href={COMPANY.phoneHref}
              aria-label={`Zavolat ${COMPANY.phone}`}
              className="hidden h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap rounded-pill border-2 border-cocoa bg-paper font-copy text-[0.9375rem] font-bold text-cocoa transition-colors hover:bg-butter xl:inline-flex 2xl:px-4"
            >
              <IconPhone size={19} />
              <span className="hidden 2xl:inline">{COMPANY.phone}</span>
            </a>
            <Link
              href="/kosik"
              aria-label="Košík"
              aria-current={isActive('/kosik', pathname) ? 'page' : undefined}
              className={cx('hidden h-11 w-11 place-items-center rounded-pill border-2 border-cocoa text-cocoa transition-colors hover:bg-butter sm:grid', isActive('/kosik', pathname) ? 'bg-butter' : 'bg-paper')}
            >
              <IconBag size={20} />
            </Link>
            <Button href={HEADER_CTA.href} variant="primary" size="sm" className="xl:hidden">
              {HEADER_CTA.mobileLabel}
            </Button>
            <Button href={HEADER_CTA.href} variant="primary" size="md" className="hidden xl:inline-flex">
              {HEADER_CTA.label}
            </Button>
            <button
              ref={burgerRef}
              type="button"
              aria-expanded={mobileOpen}
              aria-controls={mobileId}
              aria-label="Otevřít menu"
              onClick={() => setMobileOpen(true)}
              className="grid h-11 w-11 place-items-center rounded-pill border-2 border-cocoa bg-paper text-cocoa transition-colors hover:bg-butter xl:hidden"
            >
              <IconMenu size={22} />
            </button>
          </div>
        </Container>
      </header>

      {mobileOpen ? (
        <div
          ref={dialogRef}
          id={mobileId}
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="fixed inset-0 z-50 flex flex-col bg-cream motion-safe:animate-fade xl:hidden"
        >
          <div className="border-b-2 border-cocoa bg-cream">
            <Container className="flex h-16 items-center gap-2">
              <Logo className="mr-auto" onClick={() => setMobileOpen(false)} />
              <button
                type="button"
                data-autofocus
                aria-label="Zavřít menu"
                onClick={closeMobile}
                className="grid h-11 w-11 place-items-center rounded-pill border-2 border-cocoa bg-paper text-cocoa hover:bg-butter"
              >
                <IconClose size={22} />
              </button>
            </Container>
          </div>

          <nav aria-label="Hlavní navigace" className="flex-1 overflow-y-auto overscroll-contain">
            <Container as="ul" className="divide-y-2 divide-cocoa border-b-2 border-cocoa">
              {MAIN_NAV.map((item) =>
                item.children ? (
                  <li key={item.href}>
                    <button
                      type="button"
                      aria-expanded={mobileCatering}
                      onClick={() => setMobileCatering((v) => !v)}
                      className="md-caps flex min-h-16 w-full items-center justify-between py-2 text-left text-[2.25rem] leading-[1.15] text-cocoa"
                    >
                      {item.label}
                      <span className="grid h-11 w-11 place-items-center rounded-pill border-2 border-cocoa bg-paper">
                        <IconChevronDown size={20} className={cx('motion-safe:transition-transform', mobileCatering && 'rotate-180')} />
                      </span>
                    </button>
                    {mobileCatering ? (
                      <ul className="pb-4">
                        <li>
                          <Link href={item.href} className="md-link flex min-h-11 items-center gap-2 font-bold text-cocoa">
                            Přehled služeb a cen
                          </Link>
                        </li>
                        {item.children.map((c) => (
                          <li key={c.href}>
                            <Link
                              href={c.href}
                              aria-current={pathname === c.href ? 'page' : undefined}
                              className="flex min-h-11 items-center justify-between gap-3 text-cocoa"
                            >
                              <span className="font-bold">{c.label}</span>
                              {c.meta ? <span className="text-small text-cocoa-soft">{c.meta}</span> : null}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ) : (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={isActive(item.href, pathname) ? 'page' : undefined}
                      className={cx('md-caps flex min-h-16 items-center justify-between py-2 text-[2.25rem] leading-[1.15]', isActive(item.href, pathname) ? 'text-raspberry-ink' : 'text-cocoa')}
                    >
                      {item.label}
                      <IconArrowRight size={26} />
                    </Link>
                  </li>
                ),
              )}
              <li className="py-4">
                <a href={COMPANY.phoneHref} className="flex min-h-11 items-center gap-3 font-bold text-cocoa">
                  <IconPhone size={20} /> {COMPANY.phone}
                </a>
                <a href={`mailto:${COMPANY.email}`} className="flex min-h-11 items-center gap-3 text-cocoa-soft">
                  {COMPANY.email}
                </a>
                <Link href="/kosik" className="flex min-h-11 items-center gap-3 font-bold text-cocoa">
                  <IconBag size={20} /> Košík
                </Link>
              </li>
            </Container>
          </nav>

          <div className="border-t-2 border-cocoa bg-paper pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
            <Container>
              <Button href={HEADER_CTA.href} variant="primary" size="lg" fullWidth arrow onClick={() => setMobileOpen(false)}>
                {HEADER_CTA.label}
              </Button>
            </Container>
          </div>
        </div>
      ) : null}
    </>
  )
}

function MegaMenu({ id, open, pathname, onNavigate }: { id: string; open: boolean; pathname: string | null; onNavigate: () => void }) {
  return (
    <div id={id} hidden={!open} className="absolute inset-x-0 top-full pt-0 motion-safe:animate-fade">
      <Container width="wide">
        <div className="mt-3 grid border-2 border-cocoa bg-paper shadow-hard-lg lg:grid-cols-[3fr_1fr]">
          <ul className="md-grid grid-cols-2 border-y-0 xl:grid-cols-4">
            {CATERING_MENU.map((c) => (
              <li key={c.href} className="!bg-paper">
                <Link
                  href={c.href}
                  onClick={onNavigate}
                  aria-current={pathname === c.href ? 'page' : undefined}
                  className="group flex h-full flex-col p-5 transition-colors hover:bg-daddy-tint focus-visible:bg-daddy-tint"
                >
                  <span className="md-caps flex items-center justify-between gap-2 text-[1.5rem] leading-[1.2] text-cocoa">
                    {c.label}
                    <IconArrowRight size={18} className="shrink-0 -rotate-45 transition-transform group-hover:rotate-0" />
                  </span>
                  {c.description ? <span className="mt-1.5 block text-small text-cocoa-soft">{c.description}</span> : null}
                  {c.meta ? (
                    <span className="mt-3 inline-flex self-start rounded-pill border-2 border-cocoa bg-butter px-2.5 py-0.5 text-[0.8125rem] font-bold text-cocoa">{c.meta}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex flex-col justify-between gap-6 border-t-2 border-cocoa bg-raspberry-tint p-6 lg:border-l-2 lg:border-t-0">
            <div>
              <p className="md-caps text-[1.875rem] leading-[1.15] text-cocoa">
                <span className="md-accent">Svatby</span>
              </p>
              <p className="mt-2 text-small text-cocoa-soft">Svatební hostina podle vašeho příběhu. Konzultace zdarma.</p>
              <Link href="/catering/svatby" onClick={onNavigate} className="md-link mt-3 inline-flex min-h-11 items-center text-small font-bold">
                Svatební catering
              </Link>
            </div>
            <div className="flex flex-col items-start gap-3">
              <Link href="/catering" onClick={onNavigate} className="md-link inline-flex min-h-11 items-center text-small font-bold">
                Přehled služeb a cen
              </Link>
              <Button href={HEADER_CTA.href} variant="primary" size="sm" arrow onClick={onNavigate}>
                {HEADER_CTA.label}
              </Button>
            </div>
          </div>
        </div>
      </Container>
    </div>
  )
}
