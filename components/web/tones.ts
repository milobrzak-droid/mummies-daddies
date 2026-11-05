import type { SurfaceTone } from '@/lib/web/tokens'

/** Pozadí podle tónu (celé názvy tříd kvůli Tailwind JIT). */
export const TONE_BG: Record<SurfaceTone, string> = {
  blush: 'bg-blush',
  sage: 'bg-sage',
  vanilla: 'bg-vanilla',
  pistachio: 'bg-pistachio',
  cream: 'bg-cream',
  paper: 'bg-paper',
}

/** Světlejší varianta tónu (sekce, pozadí za kartami). */
export const TONE_BG_SOFT: Record<SurfaceTone, string> = {
  blush: 'bg-blush-soft',
  sage: 'bg-sage-soft',
  vanilla: 'bg-vanilla-soft',
  pistachio: 'bg-pistachio-soft',
  cream: 'bg-cream',
  paper: 'bg-paper',
}

/** Sytější varianta (zástupce fotky na kartě daného tónu). */
export const TONE_BG_DEEP: Record<SurfaceTone, string> = {
  blush: 'bg-blush-deep',
  sage: 'bg-sage-deep',
  vanilla: 'bg-vanilla-deep',
  pistachio: 'bg-pistachio-deep',
  cream: 'bg-vanilla',
  paper: 'bg-blush-soft',
}
