import { Anton, Manrope } from 'next/font/google'

/**
 * Písma webu v2 (next/font/google = self-hosting při buildu, prohlížeč nic nestahuje z Googlu,
 * CSP font-src 'self' platí). latin-ext kvůli češtině. Proměnné se nastavují na obal webu
 * v app/(web)/layout.tsx a Tailwind je čte přes font-display / font-copy (lib/web/tokens.ts).
 *
 * - Anton 400 = nadpisy (velmi tučné úzké verzálky, jako v referenci). Má jen jeden řez:
 *   nikdy font-bold (falešné tučné), malá písmena Antonem nepsat, line-height ≥ 1.12.
 * - Manrope = text, UI, tlačítka.
 */
export const displayFont = Anton({
  subsets: ['latin', 'latin-ext'],
  weight: '400',
  display: 'swap',
  variable: '--font-md-display',
})

export const textFont = Manrope({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-md-text',
})

/** Třídy pro obal webu: nastaví CSS proměnné obou písem. */
export const webFontVariables = `${displayFont.variable} ${textFont.variable}`
