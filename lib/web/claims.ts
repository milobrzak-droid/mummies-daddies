/**
 * Slib „nabídka do pár minut" na webu (balík P6, nález nezávislého ověření).
 *
 * Nabídku do pár minut pošle jen agent, který standardní nabídky odesílá sám
 * (schválená cenová mapa a zapnuté samostatné odeslání). Do té doby web
 * uvádí reálnou lhůtu odpovědi. Přepínač je veřejný (NEXT_PUBLIC_…), protože
 * texty vykreslují i klientské komponenty; mění se jen spolu s nasazením.
 * Výchozí vypnuto.
 *
 * Bez závislostí → bezpečné pro klientské komponenty.
 */

export const INSTANT_OFFER_CLAIM = process.env.NEXT_PUBLIC_WEB_INSTANT_OFFER_CLAIM === 'true'

/** Reálná lhůta, dokud agent nabídky sám neposílá. */
export const REALISTIC_RESPONSE = 'do 1 pracovního dne'

const INSTANT = /do pár minut/g

/** Text webu se slibem rychlé nabídky podle přepínače. */
export function withResponseClaim(text: string, instant: boolean = INSTANT_OFFER_CLAIM): string {
  return instant ? text : text.replace(INSTANT, REALISTIC_RESPONSE)
}

/** Totéž pro celý strom textů (stránky z copy.json). */
export function withResponseClaimDeep<T>(value: T, instant: boolean = INSTANT_OFFER_CLAIM): T {
  if (instant) return value
  if (typeof value === 'string') return withResponseClaim(value, false) as T
  if (Array.isArray(value)) return value.map((v) => withResponseClaimDeep(v, false)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withResponseClaimDeep(v, false)])) as T
  }
  return value
}
