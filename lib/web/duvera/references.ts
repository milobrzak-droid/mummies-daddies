/**
 * Případové studie (/reference/[slug]). Texty jsou v copy.json (stránky
 * /reference/<slug>); tady je jen to, co copy nemá: fotky (sloty z výběru
 * fotek) a kontext pro poptávku. Bez JSON importů → bezpečné i pro klienta.
 *
 * Galerie používá jen fotky z TÉŽE akce (podle pick.slots[].note u cover slotu),
 * které už mají ořez v manifestu. Souhlas páru / klienta s publikací je stále
 * [DOPLNÍ KLIENT] a stránka ho viditelně ukazuje.
 */
import type { EventType } from '../options'

export interface ReferenceCase {
  slug: string
  path: `/reference/${string}`
  /** Štítek filtru na /reference (Firemní · Svatby · Oslavy). */
  filter: string
  eventType: EventType
  coverSlot: string
  /** Sloty fotek z téže akce: [slot, index v galerii]. */
  gallery: readonly (readonly [string, number])[]
}

export const REFERENCE_CASES = [
  {
    slug: 'bvlgari-luxury-party',
    path: '/reference/bvlgari-luxury-party',
    filter: 'Firemní',
    eventType: 'spolecenska-akce',
    coverSlot: 'reference.bvlgari.cover',
    gallery: [],
  },
  {
    slug: 'svatba-jitka-a-rostislav',
    path: '/reference/svatba-jitka-a-rostislav',
    filter: 'Svatby',
    eventType: 'svatba',
    coverSlot: 'reference.jitka-rostislav.cover',
    // pick: „Galerie case study: 9a57444, 97a7dc15, ac3dd34d, 7b4ebe41 …“
    gallery: [
      ['home.hero.mobile', 0],
      ['home.references.jitka-rostislav', 0],
      ['home.kitchen.2', 0],
      ['home.kitchen.5', 0],
    ],
  },
  {
    slug: 'svatba-katka-a-jirka',
    path: '/reference/svatba-katka-a-jirka',
    filter: 'Svatby',
    eventType: 'svatba',
    coverSlot: 'reference.katka-jirka.cover',
    // pick: „Galerie: a2438cd2, 72884343 …“
    gallery: [
      ['home.references.katka-jirka', 0],
      ['home.kitchen.6', 0],
    ],
  },
] as const satisfies readonly ReferenceCase[]

export type ReferenceSlug = (typeof REFERENCE_CASES)[number]['slug']

export function referenceCase(slug: string): ReferenceCase | undefined {
  return REFERENCE_CASES.find((c) => c.slug === slug)
}

/** Slug případovky z odkazu v copy („… → /reference/bvlgari-luxury-party“). */
export function referenceSlugFromHref(href: string | null | undefined): string | null {
  const m = /^\/reference\/([a-z0-9-]+)$/.exec(href ?? '')
  return m ? m[1] : null
}
