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
  /** Podklad stránky (krémová kuchyňská tabule, web v2). */
  cream: '#FBF3E6',
  /** Karty, pole formuláře, buňky mřížky, které mají „vystoupit“. */
  paper: '#FFFDF8',
  /** „Ink“: text, nadpisy, VŠECHNY linky (2 px), obrysy a tvrdé offset stíny. Tmavé kakao. */
  cocoa: {
    DEFAULT: '#2B1810',
    /** Sekundární text (perexy, popisky). AA na všech tintech. */
    soft: '#5E4636',
  },
  /** Linky mřížky = ink (v2 nemá šedé hairline, vše je 2px kakaová linka). */
  hairline: '#2B1810',
  /**
   * Zpětně kompatibilní jména ploch z v1, namapovaná na paletu v2 (docs/web-v2-design.md §1, §7.1):
   * blush → rasp-tint (Mummy), sage → blue-tint (Daddy), vanilla → butter, pistachio → původní světle modrá klienta.
   * Text na nich je vždy cocoa / cocoa-soft.
   */
  blush: { DEFAULT: '#F7D6DF', soft: '#FBE8ED', deep: '#F0BFCD' },
  sage: { DEFAULT: '#D3E0F2', soft: '#E7EEF8', deep: '#BBCDE8' },
  vanilla: { DEFAULT: '#F9E8B9', soft: '#FCF2D6', deep: '#F4DB95' },
  pistachio: { DEFAULT: '#C9D8ED', soft: '#E2EAF6', deep: '#B5C8E5' },
  /**
   * Malina = „Mummy“ a AKCE (primární CTA, ceny, akcentové slovo v nadpisu).
   * DEFAULT (#D23F6B) jen velký text ≥ 24 px a grafika (4,09 : 1 na krému);
   * `ink` (#A3284F) = pozadí primárního tlačítka s krémovým textem a malinový text < 24 px
   * (AA ≥ 4,5 : 1 i na tintech karet: blush, sage, pistachio, butter);
   * `deep` = hover/active; `tint` = růžová plocha; `onInk` = malina na tmavé patičce.
   */
  raspberry: { DEFAULT: '#D23F6B', ink: '#A3284F', deep: '#962248', tint: '#F7D6DF', onInk: '#F48AA8' },
  /**
   * Modrá = „Daddy“ (původní barva loga M&D, #4669A6). Druhý hlas: akcentové slovo,
   * sekundární tlačítko, fokus. Nikdy primární CTA. `tint` = pruhy nadpisů sekcí.
   */
  daddy: { DEFAULT: '#4669A6', ink: '#36568F', deep: '#27406E', tint: '#D3E0F2', onInk: '#A9C2EA' },
  /** Máslová sušenka (korpus cheesecaku): doplňková barva štítků, nikdy velké plochy. */
  butter: '#F6DF9E',
  /** Stavy formulářů. */
  danger: '#A3261F',
  success: '#2F6B4F',
  warning: '#8A5A00',
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
  /** Anton: velmi tučné úzké verzálky (jen 400, jen verzálky, line-height ≥ 1.12). */
  display: ['var(--font-md-display)', 'Anton', 'Bebas Neue', 'Arial Narrow', 'Impact', 'sans-serif'],
  text: ['var(--font-md-text)', 'Manrope', 'system-ui', 'sans-serif'],
} as const

/**
 * Typografická stupnice (fluidní, 360 px → 1440 px).
 * Titulky (mega, hero, h1, h2, h3) jsou Anton verzálkami (třída `md-caps`); line-height ≥ 1.2,
 * jinak se háčky nad Ř/Ž/Ď srazí s řádkem nad nimi (docs/web-v2-design.md §3.2).
 */
type FontSizeToken = [size: string, config: { lineHeight: string; letterSpacing?: string; fontWeight?: string }]

// Klíče bez Record<…> v uvozovkách: test/deal-stage-migration hlídá staré
// klíče fází obchodu (mj. „lead“) jako řetězcové literály v celém kódu.
export const fontSize = {
  mega: ['clamp(3.25rem, 1.4rem + 7vw, 8rem)', { lineHeight: '1.2', letterSpacing: '0.005em', fontWeight: '400' }],
  hero: ['clamp(2.75rem, 1.2rem + 6.4vw, 7rem)', { lineHeight: '1.2', letterSpacing: '0.005em', fontWeight: '400' }],
  h1: ['clamp(2.5rem, 1.4rem + 4.8vw, 5.5rem)', { lineHeight: '1.2', letterSpacing: '0.005em', fontWeight: '400' }],
  h2: ['clamp(2rem, 1.3rem + 3vw, 4rem)', { lineHeight: '1.2', letterSpacing: '0.005em', fontWeight: '400' }],
  h3: ['clamp(1.375rem, 1.15rem + 1vw, 1.875rem)', { lineHeight: '1.22', letterSpacing: '0.005em', fontWeight: '400' }],
  lead: ['clamp(1.0625rem, 1rem + 0.35vw, 1.3125rem)', { lineHeight: '1.55' }],
  copy: ['1rem', { lineHeight: '1.65' }],
  small: ['0.875rem', { lineHeight: '1.5' }],
  eyebrow: ['0.8125rem', { lineHeight: '1.2', letterSpacing: '0.08em', fontWeight: '700' }],
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
  /** Čitelná šířka textu (62ch). */
  'web-prose': '42rem',
} as const

export const radius = {
  /** Tlačítka, štítky. */
  pill: '9999px',
  /** Buňky mřížky a fotky v mřížce: ostré jako v referenci. */
  frame: '0',
  /** Pole formuláře, menší karty. */
  soft: '0.75rem',
  /** Fotky „samolepky“ a výřezy. */
  sticker: '1.25rem',
} as const

/** Tvrdé offset stíny (neo-brutalist), vždy v ink. Žádné rozmazané stíny. */
export const shadow = {
  'hard-sm': '3px 3px 0 0 #2B1810',
  hard: '4px 4px 0 0 #2B1810',
  'hard-md': '6px 6px 0 0 #2B1810',
  'hard-lg': '8px 8px 0 0 #2B1810',
  /** Zpětná kompatibilita v1: karty na hover → hard-md. */
  lift: '6px 6px 0 0 #2B1810',
  /** Zpětná kompatibilita v1: plovoucí panely (formulář, mega-menu) → hard-lg. */
  float: '8px 8px 0 0 #2B1810',
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
    // Levitace výřezů: každý prvek má vlastní --r (natočení) a zpoždění.
    'md-float': {
      '0%, 100%': { transform: 'translateY(0) rotate(var(--r, 0deg))' },
      '50%': { transform: 'translateY(-10px) rotate(calc(var(--r, 0deg) + 1.5deg))' },
    },
    'md-marquee': { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
  },
  animation: {
    rise: 'md-rise 700ms cubic-bezier(.2,.7,.2,1) both',
    fade: 'md-fade 500ms ease-out both',
    lift: 'md-lift 800ms cubic-bezier(.2,.7,.2,1) both',
    float: 'md-float 6s ease-in-out infinite',
    marquee: 'md-marquee 28s linear infinite',
  },
}
