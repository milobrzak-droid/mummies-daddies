'use client'

import { setPriceGuide, type PriceGuide } from '@/lib/web/priceGuide'

/**
 * Předá orientační ceník (spočítaný na serveru z cenové mapy firmy,
 * domain/web/priceGuide.ts) do lib/web/api.ts#estimatePrice. Nic nevykresluje.
 * Ceník je pro všechny návštěvníky stejný, proto ho smí nastavit i render.
 */
export function PriceGuideProvider({ guide }: { guide: PriceGuide }) {
  setPriceGuide(guide)
  return null
}
