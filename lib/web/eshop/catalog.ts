/**
 * E-shop cheesecaků: cesty, tóny karet a pomocné dotazy nad číselníkem
 * CHEESECAKES (lib/web/options.ts). Bez JSON a node:fs → bezpečné pro klienta.
 * Ceny a názvy jsou jen v options.ts (z podkladů BRIEF/copy), tady se nic nevymýšlí.
 */
import { CHEESECAKES, cheesecakeOf, MINI_FLAVORS, type Cheesecake, type CheesecakeSlug, type MiniFlavor } from '../options'
import type { PastelTone } from '../tokens'

export const CHEESECAKE_PATH = '/cheesecaky'
export const CART_PATH = '/kosik'
export const VOUCHER_PATH = '/darkovy-poukaz'

export const CHEESECAKE_SLUGS = CHEESECAKES.map((c) => c.slug) as readonly CheesecakeSlug[]

export function productPath(slug: CheesecakeSlug): string {
  return `${CHEESECAKE_PATH}/${slug}`
}

export function isCheesecakeSlug(value: unknown): value is CheesecakeSlug {
  return typeof value === 'string' && CHEESECAKE_SLUGS.includes(value as CheesecakeSlug)
}

/**
 * Pastelová karta v barvě příchuti (jako v referenci: produkt na pastelu).
 * vanilka → vanilková, pistácie → pistáciová, lesní plody / mix → pudrová,
 * čokoláda a vánoční pomeranč → šalvějová (klidné pozadí pro tmavší dort).
 */
export const PRODUCT_TONE: Record<CheesecakeSlug, PastelTone> = {
  'daddy-vanilkovy': 'vanilla',
  'daddy-pistaciovo-malinovy': 'pistachio',
  'daddy-cokoladovo-liskooriskovy': 'sage',
  'daddy-vanilkovo-karamelovy': 'vanilla',
  'mummy-vanilkovo-ovocny': 'blush',
  'mummy-vanilkovo-pomerancovy-vanocni': 'sage',
  'mini-cheesecaky-10-ks': 'blush',
}

/** Slot fotky produktu (pick v content.json): cheesecaky.<slug>.main. */
export function productPhotoSlot(slug: CheesecakeSlug): string {
  return `cheesecaky.${slug}.main`
}

export function isMini(slug: CheesecakeSlug): boolean {
  return cheesecakeOf(slug)?.line === 'mini'
}

/** Nápis na přání jde jen na Daddy vanilkový (copy /cheesecaky › na-prani). */
export function allowsInscription(slug: CheesecakeSlug): boolean {
  return cheesecakeOf(slug)?.inscription === true
}

export function productByName(name: string): Cheesecake | undefined {
  const n = name.trim().toLowerCase()
  return CHEESECAKES.find((c) => c.name.toLowerCase() === n)
}

/** Počty kusů podle příchutě z pole 10 příchutí (pořadí MINI_FLAVORS). */
export function flavorCounts(flavors: readonly MiniFlavor[] | null | undefined): Record<MiniFlavor, number> {
  const out = Object.fromEntries(MINI_FLAVORS.map((f) => [f, 0])) as Record<MiniFlavor, number>
  for (const f of flavors ?? []) if (f in out) out[f] += 1
  return out
}

/** Opak flavorCounts: { jahoda: 3, … } → ['jahoda','jahoda','jahoda', …] v pořadí MINI_FLAVORS. */
export function flavorsFromCounts(counts: Partial<Record<MiniFlavor, number>>): MiniFlavor[] {
  return MINI_FLAVORS.flatMap((f) => Array.from({ length: Math.max(0, Math.floor(counts[f] ?? 0)) }, () => f))
}

/** Nahradí {proměnná} v mikrotextu (klientská obdoba interpolate z content.ts). */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all))
}
