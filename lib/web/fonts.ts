import { Cormorant_Garamond, Manrope } from 'next/font/google'

/**
 * Písma webu (next/font/google = self-hosting při buildu, prohlížeč nic nestahuje z Googlu).
 * latin-ext kvůli češtině. Proměnné se nastavují na obal webu v app/(web)/layout.tsx
 * a Tailwind je čte přes font-display / font-copy (lib/web/tokens.ts).
 */
export const displayFont = Cormorant_Garamond({
  subsets: ['latin', 'latin-ext'],
  weight: ['500', '600'],
  style: ['normal', 'italic'],
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
