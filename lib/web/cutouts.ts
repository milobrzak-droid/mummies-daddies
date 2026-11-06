/**
 * Výřezy produktů bez pozadí (public/web/cutouts, WebP s alfou; popis a zdroje v README.md tamtéž).
 * Rozměry jsou pevné (žádný posun layoutu). Čistá data → bezpečné i pro klientské komponenty.
 * Pozor na omezení: mini-cheesecake-kosicek jen do ~140 px, avokado-plnene do ~400 px,
 * lesni-ovoce-okraj jen přes okraj panelu (boky jsou useknuté rámem fotky).
 */
export const CUTOUTS = {
  'cheesecake-cokoladovo-liskooriskovy': { width: 900, height: 877, alt: 'Čokoládovo-lískooříškový cheesecake Daddy shora, s lískovými ořechy, borůvkami a ostružinami' },
  'cheesecake-pistaciovo-malinovy': { width: 800, height: 825, alt: 'Pistáciovo-malinový cheesecake Daddy shora s vykrojeným dílkem' },
  'mini-cheesecake-cokoladovy': { width: 749, height: 900, alt: 'Mini čokoládový cheesecake s čokoládovými hoblinami' },
  'cupcake-malina-boruvka': { width: 486, height: 900, alt: 'Cupcake s krémem, malinou a borůvkou' },
  'svatebni-dort-patrovy': { width: 467, height: 900, alt: 'Třípatrový bílý svatební dort s růžemi' },
  'mini-cheesecake-kosicek': { width: 280, height: 264, alt: 'Mini cheesecake v papírovém košíčku' },
  'avokado-plnene': { width: 824, height: 900, alt: 'Půlka avokáda plněná tatarem a cottage' },
  'lesni-ovoce-okraj': { width: 900, height: 636, alt: 'Maliny a borůvky z vrchu cheesecaku' },
} as const

export type CutoutSlug = keyof typeof CUTOUTS

export interface Cutout {
  slug: CutoutSlug
  src: string
  width: number
  height: number
  alt: string
}

export function cutout(slug: CutoutSlug): Cutout {
  return { slug, src: `/web/cutouts/${slug}.webp`, ...CUTOUTS[slug] }
}

/** Výřez k cheesecaku podle slugu produktu (lib/web/options.ts › CHEESECAKES), pokud existuje. */
export const CHEESECAKE_CUTOUT: Partial<Record<string, CutoutSlug>> = {
  'daddy-pistaciovo-malinovy': 'cheesecake-pistaciovo-malinovy',
  'daddy-cokoladovo-liskooriskovy': 'cheesecake-cokoladovo-liskooriskovy',
  'mini-cheesecaky-10-ks': 'mini-cheesecake-cokoladovy',
}
