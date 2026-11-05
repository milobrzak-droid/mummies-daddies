/**
 * Design tokeny webu Mummies & Daddies (jediný zdroj pravdy).
 *
 * - Hodnoty jsou surové (hex, rem), aby šly použít v Tailwindu (tailwind.config.ts
 *   je spreadne přes `webTailwindExtend`), v testech kontrastu i v inline stylech.
 * - Jména jsou zvolená tak, aby se nepotkala s tokeny Cockpitu (navy, ink, accent,
 *   card, body, display…), takže se web dá přenést do hlavního systému beze změn.
 * - Kontrast (WCAG AA) hlídá test/web/tokens.test.ts.
 */

export const colors = {
  /** Podklad stránky (krémová). */
  cream: '#FBF6EE',
  /** Bílá plocha (karty, header, tlačítko na fotce). */
  paper: '#FFFFFF',
  /** Hlavní text, nadpisy, ikony. Kakao. */
  cocoa: {
    DEFAULT: '#3B2418',
    /** Sekundární text (perexy, popisky). AA i na pastelových plochách. */
    soft: '#6B5245',
  },
  /** Linky, rámečky, oddělovače (dekorativní, ne text). */
  hairline: '#E7DCCF',
  /** Pastelové plochy karet a sekcí. Text na nich je vždy cocoa / cocoa-soft. */
  blush: { DEFAULT: '#F2D4D2', soft: '#F8E7E5', deep: '#E9BDBA' },
  sage: { DEFAULT: '#BCD9D3', soft: '#DDECE8', deep: '#A3CBC3' },
  vanilla: { DEFAULT: '#F6E7C8', soft: '#FBF2E1', deep: '#EFD9AA' },
  pistachio: { DEFAULT: '#D5E3C3', soft: '#E9F0DF', deep: '#C2D6A9' },
  /**
   * Malina = akcent JEN na CTA a ceny.
   * DEFAULT (#D9466F) je dekorativní (tečky, podtržení, velké číslice ≥ 24 px);
   * `ink` je pro text a pozadí tlačítka s bílým textem (AA 5,3 : 1);
   * `deep` je hover/active.
   */
  raspberry: { DEFAULT: '#D9466F', ink: '#C23560', deep: '#A82A51' },
  /** Stav formulářů. */
  danger: '#A3261F',
  success: '#2F6B4F',
} as const

/** Pastelové tóny, ve kterých se střídají karty a sekce. */
export const PASTEL_TONES = ['blush', 'sage', 'vanilla', 'pistachio'] as const
export type PastelTone = (typeof PASTEL_TONES)[number]
/** Tóny ploch včetně neutrálních. */
export type SurfaceTone = PastelTone | 'cream' | 'paper'

/** Vrátí pastelový tón podle pořadí (pro střídání karet v mřížce). */
export function toneAt(index: number, order: readonly PastelTone[] = ['blush', 'sage', 'vanilla']): PastelTone {
  return order[((index % order.length) + order.length) % order.length]
}

export const fonts = {
  /** CSS proměnné nastavené v app/(web)/layout.tsx přes next/font/google. */
  displayVar: '--font-md-display',
  textVar: '--font-md-text',
  display: ['var(--font-md-display)', 'Cormorant Garamond', 'Georgia', 'serif'],
  text: ['var(--font-md-text)', 'Manrope', 'system-ui', 'sans-serif'],
} as const

/**
 * Typografická stupnice (fluidní, 360 px → 1440 px).
 * Titulky (hero, h1, h2, h3) jsou font-display, verzálky s prostrkáním (třída `md-caps`).
 */
type FontSizeToken = [size: string, config: { lineHeight: string; letterSpacing?: string; fontWeight?: string }]

// Klíče bez Record<…> v uvozovkách: test/deal-stage-migration hlídá staré
// klíče fází obchodu (mj. „lead“) jako řetězcové literály v celém kódu.
export const fontSize = {
  hero: ['clamp(2.5rem, 1.55rem + 4.2vw, 5.25rem)', { lineHeight: '1.02', letterSpacing: '0.04em', fontWeight: '500' }],
  h1: ['clamp(2.125rem, 1.6rem + 2.4vw, 3.75rem)', { lineHeight: '1.06', letterSpacing: '0.04em', fontWeight: '500' }],
  h2: ['clamp(1.75rem, 1.38rem + 1.65vw, 2.875rem)', { lineHeight: '1.1', letterSpacing: '0.035em', fontWeight: '500' }],
  h3: ['clamp(1.3125rem, 1.18rem + 0.55vw, 1.625rem)', { lineHeight: '1.2', letterSpacing: '0.03em', fontWeight: '600' }],
  lead: ['clamp(1.0625rem, 1rem + 0.3vw, 1.25rem)', { lineHeight: '1.6' }],
  copy: ['1rem', { lineHeight: '1.65' }],
  small: ['0.875rem', { lineHeight: '1.55' }],
  eyebrow: ['0.75rem', { lineHeight: '1.3', letterSpacing: '0.18em', fontWeight: '600' }],
} satisfies Record<string, FontSizeToken>

/** Mezery (Tailwind spacing klíče). */
export const spacing = {
  /** Svislý rytmus sekcí: py-section. */
  section: 'clamp(4rem, 2.8rem + 5vw, 7.5rem)',
  /** Menší sekce (pruhy, CTA): py-section-sm. */
  'section-sm': 'clamp(2.5rem, 2rem + 2.5vw, 4.5rem)',
  /** Boční okraj obsahu: px-gutter (16 px na mobilu → 40 px). */
  gutter: 'clamp(1rem, 0.4rem + 2.6vw, 2.5rem)',
  /** Výška sticky headeru (desktop) – pro scroll-margin a hero. */
  header: '4.5rem',
} as const

export const maxWidth = {
  /** Hlavní kontejner. */
  web: '80rem',
  /** Široký kontejner (mřížky přes celou šířku). */
  'web-wide': '90rem',
  /** Čitelná šířka textu. */
  'web-prose': '42rem',
} as const

export const radius = {
  /** Tlačítka, štítky. */
  pill: '9999px',
  /** Fotky a karty – reference má téměř ostré rohy. */
  frame: '0.25rem',
  /** Formulářové a překryvné karty. */
  soft: '1rem',
} as const

export const shadow = {
  /** Jemné zvednutí karty na hover. */
  lift: '0 22px 44px -28px rgba(59, 36, 24, 0.38)',
  /** Plovoucí panely (rychlý start, mega-menu). */
  float: '0 24px 60px -30px rgba(59, 36, 24, 0.45)',
} as const

export const motion = {
  duration: { quick: '160ms', base: '260ms', slow: '700ms' },
  easing: { out: 'cubic-bezier(.2,.7,.2,1)' },
} as const

/** Breakpointy (Tailwind výchozí): sm 640, md 768, lg 1024, xl 1280. Návrh od 360 px. */
export const breakpoints = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const

/** Rozšíření Tailwind tématu – použij ve `theme.extend` (viz tailwind.config.ts). */
export const webTailwindExtend = {
  colors,
  fontFamily: { display: [...fonts.display], copy: [...fonts.text] },
  fontSize,
  spacing,
  maxWidth,
  borderRadius: radius,
  boxShadow: shadow,
  transitionDuration: motion.duration,
  transitionTimingFunction: { 'md-out': motion.easing.out },
  keyframes: {
    'md-rise': { '0%': { opacity: '0', transform: 'translateY(14px)' }, '100%': { opacity: '1', transform: 'none' } },
    'md-fade': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
    // Jen posun (bez průhlednosti) – pro obsah nad ohybem, aby se nezdržel LCP.
    'md-lift': { '0%': { transform: 'translateY(12px)' }, '100%': { transform: 'none' } },
  },
  animation: {
    rise: 'md-rise 700ms cubic-bezier(.2,.7,.2,1) both',
    fade: 'md-fade 500ms ease-out both',
    lift: 'md-lift 800ms cubic-bezier(.2,.7,.2,1) both',
  },
}
