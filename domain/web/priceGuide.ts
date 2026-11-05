// Orientační ceník webu z cenové mapy firmy (jen od–do na osobu).
//
// Web ve formuláři poptávky ukazuje živý ORIENTAČNÍ odhad (lib/web/api.ts
// #estimatePrice). Rozpětí se počítá tady na serveru stejným výpočtem jako
// nabídka agenta (core/standardOffer#evaluateStandardOffer), aby web nikdy
// neslíbil cenu, kterou mapa nezná. Do prohlížeče jde jen hotový výsledek
// (lib/web/priceGuide.ts#PriceGuide), žádná konfigurace firmy.
//
// Dokud mapa není schválená (verze 'ilustracni-…'), ceník nese jen obecné
// rozpětí z webu firmy (300–2 000 Kč na osobu), nikdy ceny ilustračních
// balíčků.
import { COMPANY } from '@/config'
import { evaluateStandardOffer } from '@/core/standardOffer'
import type { PriceMapConfig } from '@/core/tenant'
import { EVENT_TYPES, type EventType } from '@/lib/web/options'
import { FALLBACK_GUIDE, TYPICAL_RANGE, type PriceGuide, type PriceRange } from '@/lib/web/priceGuide'
import { mapEventTypeKey } from './inquiry'

/** Ilustrační (neschválená) mapa: samostatné odeslání i ceny balíčků na webu jsou vypnuté. */
export function isIllustrativeMap(version: string): boolean {
  return version.startsWith('ilustracni')
}

/** Referenční počet hostů pro rozpětí na osobu (obsluha se dělí počtem hostů). */
const REFERENCE_GUESTS = 30

const DAY_MS = 86_400_000

/** První pracovní den aspoň `minDays` po `today` (bez víkendového příplatku). */
function referenceDate(today: string, minDays: number): string {
  const [y, m, d] = today.split('-').map(Number)
  let t = Date.UTC(y, m - 1, d) + minDays * DAY_MS
  while ([0, 6].includes(new Date(t).getUTCDay())) t += DAY_MS
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * Rozpětí na osobu (Kč vč. DPH) přes všechny balíčky typu akce mapy.
 * null = typ akce mapa nezná nebo žádný balíček nejde spočítat.
 */
export function rangeForEventType(map: PriceMapConfig, segment: string, eventTypeKey: string, today: string): PriceRange | null {
  const type = map.segments.find((s) => s.key === segment)?.eventTypes.find((t) => t.key === eventTypeKey)
  if (!type) return null
  const date = referenceDate(today, map.minLeadDays + 7)
  const perGuest: number[] = []
  for (const pkgKey of type.packages) {
    const pkg = map.packages.find((p) => p.key === pkgKey)
    if (!pkg) continue
    const guests = Math.min(pkg.maxGuests, Math.max(pkg.minGuests, REFERENCE_GUESTS))
    const r = evaluateStandardOffer({ priceMap: map }, {
      segment, eventType: eventTypeKey, packageKey: pkgKey, eventDate: date, guests,
      durationHours: null, distanceKm: 0, extras: [], dietary: [], specialRequests: null, vipContact: false,
    }, today)
    const quote = r.kind === 'standard' ? r.quote : r.kind === 'escalate' ? r.draft : null
    if (quote) perGuest.push(quote.total / quote.guests)
  }
  if (!perGuest.length) return null
  return { od: Math.floor(Math.min(...perGuest) / 10) * 10, do: Math.ceil(Math.max(...perGuest) / 10) * 10 }
}

/** Ceník pro web: u schválené mapy rozpětí podle typu akce, jinak obecné rozpětí. */
export function buildPriceGuide(map: PriceMapConfig | null | undefined, today: string): PriceGuide {
  if (!map || isIllustrativeMap(map.version) || today > map.validUntil) return FALLBACK_GUIDE
  const byEventType: PriceGuide['byEventType'] = {}
  for (const t of EVENT_TYPES) {
    for (const segment of ['b2b', 'b2c'] as const) {
      const key = mapEventTypeKey(t.value as EventType, segment, null)
      const range = key ? rangeForEventType(map, segment, key, today) : null
      if (range) (byEventType[t.value] ??= {})[segment] = range
    }
  }
  return { basis: 'cateringova-mapa', mapVersion: map.version, typical: TYPICAL_RANGE, byEventType }
}

/** Ceník firmy pro dnešek (volá layout webu). */
export function companyPriceGuide(today: string): PriceGuide {
  return buildPriceGuide(COMPANY.capabilities.standardOffer?.priceMap, today)
}
