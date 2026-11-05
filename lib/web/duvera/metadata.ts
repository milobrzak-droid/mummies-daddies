/**
 * Metadata stránek důvěry: pageMetadata z copy + og:image stránky.
 * SERVER-ONLY (content.ts a photos.ts).
 *
 * pageMetadata vrací vlastní `openGraph`, který v Next nahradí celý openGraph
 * z layoutu (i s obrázkem) → obrázek doplňujeme tady.
 */
import type { Metadata } from 'next'
import { pageMetadata } from '../content'
import { ogImage } from '../photos'

export function duveraMetadata(
  path: string,
  { ogSlot = 'og.default', noindex = false, override = {} }: { ogSlot?: string; noindex?: boolean; override?: Partial<Metadata> } = {},
): Metadata {
  const base = pageMetadata(path)
  const og = ogImage(ogSlot) ?? ogImage('og.default')
  return {
    ...base,
    openGraph: { ...base.openGraph, ...(og ? { images: [og] } : {}), ...(override.openGraph ?? {}) },
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
    ...Object.fromEntries(Object.entries(override).filter(([k]) => k !== 'openGraph')),
  }
}
