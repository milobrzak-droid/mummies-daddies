'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { COMPANY } from '@/lib/web/company'
import { CATERING_MENU, HEADER_CTA, MAIN_NAV, TOP_BAR_TEXT, isActive } from '@/lib/web/navigation'
import { Button } from './Button'
import { Container } from './Container'
import { IconArrowRight, IconBag, IconChevronDown, IconClose, IconMenu, IconPhone } from './icons'
import { Logo } from './Logo'
import { cx } from './cx'

/**
 * Header: tenká horní lišta (nabídka do pár minut + telefon), sticky bílý pruh
 * s logem, navigací, mega-menu Catering (hover i klik, Esc zavře), telefonem,
 * košíkem a CTA „Chci nabídku“. Na mobilu (< xl, 1280 px) hamburger + stále viditelné
 * CTA „Nabídka“; menu je modální panel s trvalým CTA dole.
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
      <div className="bg-vanilla-soft text-cocoa">
        <Container className="flex min-h-9 items-center justify-center py-1.5 text-center text-[0.8125rem] font-medium leading-snug">
          <p>
            {TOP_BAR_TEXT}
            <span aria-hidden="true"> · </span>
            <a href={COMPANY.phoneHref} className="whitespace-nowrap font-semibold underline-offset-4 hover:underline">
              {COMPANY.phone}
            </a>
          </p>
        </Container>
      </div>

      <header
        ref={headerRef}
        className={cx(
          'sticky top-0 z-40 border-b bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/85',
          scrolled || megaOpen ? 'border-hairline shadow-[0_8px_30px_-24px_rgba(59,36,24,0.5)]' : 'border-transparent',
          'transition-shadow duration-base',
        )}
      >
        <Container className="flex h-16 items-center gap-2 sm:gap-3 lg:h-header xl:gap-6">
          <Logo className="mr-auto xl:mr-4" />

          <nav aria-label="Hlavní navigace" className="hidden xl:block">
            <ul className="flex items-center 2xl:gap-1">
              {MAIN_NAV.map((item) =>
                item.children ? (
                  <li key={item.href} onMouseEnter={openMega} onMouseLeave={scheduleCloseMega}>
                    <button
                      ref={megaButtonRef}
                      type="button"
                      aria-expanded={megaOpen}
                      aria-controls={megaId}
                      onClick={() => setMegaOpen((v) => !v)}
                      className={cx(
                        'inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-pill px-3 font-copy text-[0.9375rem] font-semibold text-cocoa transition-colors hover:bg-blush-soft',
                        (megaOpen || isActive(item.href, pathname)) && 'bg-blush-soft',
                      )}
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
                      className={cx(
                        'inline-flex min-h-11 items-center whitespace-nowrap rounded-pill px-3 font-copy text-[0.9375rem] font-semibold text-cocoa transition-colors hover:bg-blush-soft',
                        isActive(item.href, pathname) && 'bg-blush-soft',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </nav>

          <div className="flex items-center gap-1 sm:gap-2 xl:ml-auto">
            <a
              href={COMPANY.phoneHref}
              aria-label={`Zavolat ${COMPANY.phone}`}
              className="hidden h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap rounded-pill font-copy text-[0.9375rem] font-semibold text-cocoa hover:bg-blush-soft xl:inline-flex 2xl:px-3"
            >
              <IconPhone size={20} />
              <span className="hidden 2xl:inline">{COMPANY.phone}</span>
            </a>
            <Link
              href="/kosik"
              aria-label="Košík"
              className={cx('hidden h-11 w-11 place-items-center rounded-pill text-cocoa hover:bg-blush-soft sm:grid', isActive('/kosik', pathname) && 'bg-blush-soft')}
            >
              <IconBag size={22} />
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
              className="grid h-11 w-11 place-items-center rounded-pill text-cocoa hover:bg-blush-soft xl:hidden"
            >
              <IconMenu size={24} />
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
          <div className="border-b border-hairline bg-paper">
            <Container className="flex h-16 items-center gap-2">
              <Logo className="mr-auto" onClick={() => setMobileOpen(false)} />
              <button
                type="button"
                data-autofocus
                aria-label="Zavřít menu"
                onClick={closeMobile}
                className="grid h-11 w-11 place-items-center rounded-pill text-cocoa hover:bg-blush-soft"
              >
                <IconClose size={24} />
              </button>
            </Container>
          </div>

          <nav aria-label="Hlavní navigace" className="flex-1 overflow-y-auto overscroll-contain">
            <Container as="ul" className="divide-y divide-hairline py-2">
              {MAIN_NAV.map((item) =>
                item.children ? (
                  <li key={item.href}>
                    <button
                      type="button"
                      aria-expanded={mobileCatering}
                      onClick={() => setMobileCatering((v) => !v)}
                      className="flex min-h-14 w-full items-center justify-between font-display text-[1.5rem] font-semibold uppercase tracking-[0.06em] text-cocoa"
                    >
                      {item.label}
                      <IconChevronDown size={22} className={cx('motion-safe:transition-transform', mobileCatering && 'rotate-180')} />
                    </button>
                    {mobileCatering ? (
                      <ul className="pb-4">
                        <li>
                          <Link href={item.href} className="flex min-h-11 items-center gap-2 font-semibold text-cocoa underline decoration-raspberry underline-offset-4">
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
                              <span className="font-semibold">{c.label}</span>
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
                      className="flex min-h-14 items-center font-display text-[1.5rem] font-semibold uppercase tracking-[0.06em] text-cocoa"
                    >
                      {item.label}
                    </Link>
                  </li>
                ),
              )}
              <li className="py-4">
                <a href={COMPANY.phoneHref} className="flex min-h-11 items-center gap-3 font-semibold text-cocoa">
                  <IconPhone size={20} /> {COMPANY.phone}
                </a>
                <a href={`mailto:${COMPANY.email}`} className="flex min-h-11 items-center gap-3 text-cocoa-soft">
                  {COMPANY.email}
                </a>
                <Link href="/kosik" className="flex min-h-11 items-center gap-3 font-semibold text-cocoa">
                  <IconBag size={20} /> Košík
                </Link>
              </li>
            </Container>
          </nav>

          <div className="border-t border-hairline bg-paper pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
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
    <div
      id={id}
      hidden={!open}
      className="absolute inset-x-0 top-full border-b border-hairline bg-paper shadow-float motion-safe:animate-fade"
    >
      <Container className="grid gap-8 py-8 lg:grid-cols-[3fr_1fr] xl:py-10">
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 xl:grid-cols-4">
          {CATERING_MENU.map((c) => (
            <li key={c.href}>
              <Link
                href={c.href}
                onClick={onNavigate}
                aria-current={pathname === c.href ? 'page' : undefined}
                className="group block rounded-soft p-3 transition-colors hover:bg-blush-soft focus-visible:bg-blush-soft"
              >
                <span className="flex items-center gap-1.5 font-display text-[1.25rem] font-semibold uppercase leading-tight tracking-[0.05em] text-cocoa">
                  {c.label}
                  <IconArrowRight size={16} className="opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
                {c.description ? <span className="mt-1 block text-small text-cocoa-soft">{c.description}</span> : null}
                {c.meta ? <span className="mt-1.5 block text-[0.8125rem] font-semibold text-cocoa">{c.meta}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex flex-col justify-between gap-6 rounded-soft bg-sage-soft p-6">
          <div>
            <p className="font-display text-[1.375rem] font-semibold uppercase leading-tight tracking-[0.05em] text-cocoa">Svatby</p>
            <p className="mt-2 text-small text-cocoa-soft">Svatební hostina podle vašeho příběhu. Konzultace zdarma.</p>
            <Link href="/catering/svatby" onClick={onNavigate} className="md-link mt-3 inline-flex min-h-11 items-center text-small font-semibold">
              Svatební catering
            </Link>
          </div>
          <div className="flex flex-col items-start gap-2">
            <Link href="/catering" onClick={onNavigate} className="md-link inline-flex min-h-11 items-center text-small font-semibold">
              Přehled služeb a cen
            </Link>
            <Button href={HEADER_CTA.href} variant="primary" size="sm" arrow onClick={onNavigate}>
              {HEADER_CTA.label}
            </Button>
          </div>
        </div>
      </Container>
    </div>
  )
}
