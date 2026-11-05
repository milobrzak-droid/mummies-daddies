import type { Config } from 'tailwindcss'
import { webTailwindExtend as web } from './lib/web/tokens'

// Tokeny design systému (docs/PROVOZ.md). Hodnoty žijí v app/globals.css
// jako CSS proměnné; tady jsou jen jejich jména pro utility třídy.
//
// Veřejný web (app/(web), components/web) má vlastní tokeny v lib/web/tokens.ts.
// Jména se s Cockpitem nepotkávají (cream, cocoa, raspberry, font-display…),
// proto se slučují po klíčích theme.extend. Jediný společný klíč je
// transitionDuration.base — Cockpit ho nepoužívá, platí hodnota webu.
type FontSizeValue = [fontSize: string, config: { lineHeight: string; letterSpacing?: string; fontWeight?: string }]

const cockpit = {
      colors: {
        navy:'var(--c-navy)', ink:'var(--c-ink)', slate:'var(--c-slate)',
        accent:'var(--c-accent)', 'accent-text':'var(--c-accent-text)', line:'var(--c-line)', soft:'var(--c-soft)',
        pos:'var(--c-pos)', warn:'var(--c-warn)', neg:'var(--c-neg)', info:'var(--c-info)',
        'pos-soft':'var(--c-pos-soft)', 'warn-soft':'var(--c-warn-soft)', 'neg-soft':'var(--c-neg-soft)', 'info-soft':'var(--c-info-soft)',
        brand: {
          graphite:'var(--brand-graphite)', turquoise:'var(--brand-turquoise)', blue:'var(--brand-blue)',
          violet:'var(--brand-violet)', yellow:'var(--brand-yellow)', red:'var(--brand-red)', white:'var(--brand-white)',
        },
        // odvozené tóny značky (docs/PROVOZ.md §4): plocha / data / text
        tone: {
          'p-turquoise':'var(--p-turquoise)', 'p-blue':'var(--p-blue)', 'p-violet':'var(--p-violet)', 'p-yellow':'var(--p-yellow)', 'p-red':'var(--p-red)',
          'd-turquoise':'var(--d-turquoise)', 'd-blue':'var(--d-blue)', 'd-violet':'var(--d-violet)', 'd-yellow':'var(--d-yellow)', 'd-red':'var(--d-red)',
          't-turquoise':'var(--t-turquoise)', 't-blue':'var(--t-blue)', 't-violet':'var(--t-violet)', 't-yellow':'var(--t-yellow)', 't-red':'var(--t-red)',
        },
        'ink-2':'var(--c-ink-2)',
        bg:'var(--bg)', fg:'var(--fg)', surface:'var(--surface)', border:'var(--border)', muted:'var(--muted)',
        'cta-bg':'var(--cta-bg)', 'cta-fg':'var(--cta-fg)',
      },
      fontFamily: { heading:['var(--font-heading)'], body:['var(--font-body)'], mono:['var(--font-mono)'] },
      // Typografická stupnice (§2). Nadpisy nesou písmo přes h1–h4 nebo font-heading.
      fontSize: {
        display:['2.125rem', { lineHeight:'1.06', letterSpacing:'-0.02em' }],
        title1:['1.5rem', { lineHeight:'1.17', letterSpacing:'-0.015em' }],
        title2:['1.125rem', { lineHeight:'1.28', letterSpacing:'-0.01em' }],
        headline:['0.9375rem', { lineHeight:'1.33', fontWeight:'600' }],
        body:['0.875rem', { lineHeight:'1.5' }],
        callout:['0.8125rem', { lineHeight:'1.46' }],
        footnote:['0.75rem', { lineHeight:'1.42' }],
      } satisfies Record<string, FontSizeValue> as Record<string, FontSizeValue>,
      borderRadius: {
        xs:'var(--radius-xs)', btn:'var(--radius-btn)', tile:'var(--radius-tile)', card:'var(--radius-card)',
      },
      boxShadow: {
        card:'var(--shadow-card)', 'card-hover':'var(--shadow-card-hover)',
        e1:'var(--shadow-1)', e2:'var(--shadow-2)', e3:'var(--shadow-3)',
      },
      transitionDuration: { press:'120ms', fast:'150ms', base:'220ms' },
      transitionTimingFunction: { standard:'cubic-bezier(.2,0,0,1)', press:'cubic-bezier(.3,.7,.3,1)' },
      maxWidth: { content:'1480px' },
}

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/web/**/*.{ts,tsx}'],
  theme: {
    extend: {
      ...web,
      colors: { ...cockpit.colors, ...web.colors },
      fontFamily: { ...cockpit.fontFamily, ...web.fontFamily },
      fontSize: { ...cockpit.fontSize, ...web.fontSize },
      spacing: web.spacing,
      maxWidth: { ...cockpit.maxWidth, ...web.maxWidth },
      borderRadius: { ...cockpit.borderRadius, ...web.borderRadius },
      boxShadow: { ...cockpit.boxShadow, ...web.boxShadow },
      transitionDuration: { ...cockpit.transitionDuration, ...web.transitionDuration },
      transitionTimingFunction: { ...cockpit.transitionTimingFunction, ...web.transitionTimingFunction },
    },
  },
} satisfies Config
