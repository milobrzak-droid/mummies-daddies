/**
 * Orientační ceník pro odhad ceny ve formuláři poptávky (jen od–do na osobu).
 *
 * Ceník spočítá server z cenové mapy firmy (domain/web/priceGuide.ts přes
 * core/standardOffer) a předá ho stránkám webu; prohlížeč z něj jen vybírá
 * podle typu akce a počtu osob. Do prohlížeče tak nejde konfigurace firmy,
 * jen hotová rozpětí. Dokud mapa není schválená (verze 'ilustracni-…'),
 * ceník nese jen obecné rozpětí z webu firmy (300–2 000 Kč na osobu).
 *
 * Bez závislostí → bezpečné pro klientské komponenty.
 */

export type PriceRange = { od: number; do: number }

export interface PriceGuide {
  basis: 'obvykle-rozpeti' | 'cateringova-mapa'
  /** Verze schválené mapy (null = žádná schválená). */
  mapVersion: string | null
  /** Obecné rozpětí na osobu (vč. DPH). */
  typical: PriceRange
  /** Rozpětí na osobu podle typu akce webu a segmentu (jen u schválené mapy). */
  byEventType: Partial<Record<string, Partial<Record<'b2b' | 'b2c', PriceRange>>>>
}

/** Obecné rozpětí z webu firmy („Obvykle 300 až 2 000 Kč na osobu“). */
export const TYPICAL_RANGE: PriceRange = { od: 300, do: 2000 }

export const FALLBACK_GUIDE: PriceGuide = { basis: 'obvykle-rozpeti', mapVersion: null, typical: TYPICAL_RANGE, byEventType: {} }

let current: PriceGuide = FALLBACK_GUIDE

/**
 * Nastaví ceník pro estimatePrice (volá PriceGuideProvider z layoutu webu).
 * Ceník je pro všechny návštěvníky stejný (konfigurace firmy), proto ho
 * smí sdílet i serverový render.
 */
export function setPriceGuide(guide: PriceGuide): void {
  current = guide
}

export function getPriceGuide(): PriceGuide {
  return current
}

/**
 * Orientační rozpětí pro formulář (kontrakt lib/web/api.ts#estimatePrice).
 * null = konzultace, „ještě nevím" (cenu bez zadání neodhadujeme).
 * U schválené mapy rozpětí typu akce a segmentu; když ho mapa nemá
 * (typ akce mimo mapu), obecné rozpětí. Nikdy cena konkrétního balíčku.
 */
export function estimateFromGuide(
  guide: PriceGuide,
  params: { eventType: string; guests?: number | null; customerKind?: string | null },
): { od: number; do: number; unit: 'osoba'; total: { od: number; do: number } | null; basis: PriceGuide['basis']; mapVersion: string | null; binding: false } | null {
  if (params.eventType === 'konzultace' || params.eventType === 'nevim') return null
  const segment = params.customerKind === 'soukrome' ? 'b2c' : params.customerKind ? 'b2b' : null
  const byType = guide.byEventType[params.eventType]
  const specific = byType ? (segment ? byType[segment] : byType.b2b ?? byType.b2c) : undefined
  const range = specific ?? guide.typical
  const basis = specific ? guide.basis : 'obvykle-rozpeti'
  const guests = params.guests && params.guests > 0 ? Math.floor(params.guests) : null
  return {
    od: range.od,
    do: range.do,
    unit: 'osoba',
    total: guests ? { od: range.od * guests, do: range.do * guests } : null,
    basis,
    mapVersion: specific ? guide.mapVersion : null,
    binding: false,
  }
}
