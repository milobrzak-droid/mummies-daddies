/**
 * Prostory (/prostory): mapování názvu z copy na slug (parametr `prostor`
 * v poptávce → WebInquiry.venue.venueSlug) a slot fotky. Bez JSON importů.
 */
export interface VenueConfig {
  slug: string
  /** Začátek názvu v copy.json (/prostory, sekce „prostory“). */
  match: string
  photoSlot: string | null
  /** false = spolupráce zatím nepotvrzená ([DOPLNÍ KLIENT]) → bez tlačítka poptávky. */
  confirmed: boolean
}

export const VENUES: readonly VenueConfig[] = [
  { slug: 'hudlicka-stodola', match: 'Hudlická Stodola', photoSlot: 'home.venues.hudlicka-stodola', confirmed: true },
  { slug: 'stary-tyn', match: 'Statek Starý Týn', photoSlot: 'prostory.stary-tyn', confirmed: true },
  { slug: 'u-dvou-stodol', match: 'Statek U Dvou Stodol', photoSlot: 'prostory.u-dvou-stodol', confirmed: true },
  { slug: 'na-veselce', match: 'Na Veselce', photoSlot: null, confirmed: false },
]

export function venueFor(name: string): VenueConfig | undefined {
  return VENUES.find((v) => name.startsWith(v.match))
}
