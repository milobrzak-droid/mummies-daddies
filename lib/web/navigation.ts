/**
 * Navigace webu (header, mega-menu Catering, patička). Popisky podle
 * strategy.homepage (Header) a copy.json (karty typů akcí na úvodu).
 * Čistá data → bezpečné pro klientské komponenty.
 */

export interface NavLink {
  label: string
  href: string
  /** Krátký popis v mega-menu (doslova z karty typu akce na úvodu). */
  description?: string
  /** Minimum osob z copy (jen text, např. „od 4 osob“). */
  meta?: string
}

export interface NavGroup {
  label: string
  href: string
  children?: NavLink[]
}

/** Položky mega-menu Catering (strategy.homepage › Header). */
export const CATERING_MENU: NavLink[] = [
  { label: 'Firemní', href: '/catering/firemni', description: 'Obědy do kanceláře, porady, konference i večírky.', meta: 'od 4 osob' },
  { label: 'Snídaně', href: '/catering/snidane', description: 'Snídaňový bufet, plná americká nebo zdravá snídaně.', meta: 'od 2 osob' },
  { label: 'Coffee break', href: '/catering/coffee-break', description: 'Minisendviče, mini dezerty, skvělá káva. A když chcete, i rolování sushi.', meta: 'od 15 osob' },
  { label: 'Obědy', href: '/catering/obedy', description: 'Bufet, Šéfkuchařovo menu nebo saláty a sendviče grab-and-go.', meta: 'minimum podle objednávky' },
  { label: 'Večeře a bankety', href: '/catering/vecere-a-bankety', description: 'Teplý a studený bufet, banket nebo sharing table.', meta: 'od 8 osob' },
  { label: 'Společenské akce', href: '/catering/spolecenske-akce', description: 'Raut, jednohubky a finger food na opening, galavečer i networking.', meta: 'od 15 osob' },
  { label: 'Teambuilding', href: '/catering/teambuilding', description: 'Vaření se šéfkuchařem, sushi workshop, BBQ venku.', meta: 'od 8 osob' },
  { label: 'Oslavy a piknik', href: '/catering/oslavy-a-piknik', description: 'Narozeniny, křtiny, garden party, BBQ i piknikový koš.', meta: 'od 2 osob' },
]

/** Hlavní navigace (pořadí ze strategie). */
export const MAIN_NAV: NavGroup[] = [
  { label: 'Catering', href: '/catering', children: CATERING_MENU },
  { label: 'Svatby', href: '/catering/svatby' },
  { label: 'Reference', href: '/reference' },
  { label: 'Prostory', href: '/prostory' },
  { label: 'Cheesecaky', href: '/cheesecaky' },
  { label: 'O nás', href: '/o-nas' },
]

/** Hlavní CTA v headeru (mikrotexty HEADER — tlačítko / mobil CTA). */
export const HEADER_CTA = { label: 'Chci nabídku', mobileLabel: 'Nabídka', href: '/poptavka' } as const

/** Horní lišta (mikrotext HEADER — horní lišta). */
export const TOP_BAR_TEXT = 'Nabídku cateringu dostanete do pár minut'

export const FOOTER_COLUMNS: { title: string; links: NavLink[] }[] = [
  {
    title: 'Catering',
    links: [{ label: 'Přehled služeb a cen', href: '/catering' }, ...CATERING_MENU.map(({ label, href }) => ({ label, href })), { label: 'Svatby', href: '/catering/svatby' }],
  },
  {
    title: 'Mummies & Daddies',
    links: [
      { label: 'Reference', href: '/reference' },
      { label: 'Prostory', href: '/prostory' },
      { label: 'Vánoce', href: '/vanoce' },
      { label: 'O nás', href: '/o-nas' },
      { label: 'Inspirace a rady', href: '/blog' },
      { label: 'Časté dotazy', href: '/caste-dotazy' },
      { label: 'Kontakt', href: '/kontakt' },
    ],
  },
  {
    title: 'Cheesecaky',
    links: [
      { label: 'Všechny cheesecaky', href: '/cheesecaky' },
      { label: 'Dárkový poukaz', href: '/darkovy-poukaz' },
      { label: 'Košík', href: '/kosik' },
    ],
  },
]

export const LEGAL_LINKS: NavLink[] = [
  { label: 'Obchodní podmínky', href: '/obchodni-podminky' },
  { label: 'Ochrana osobních údajů', href: '/ochrana-osobnich-udaju' },
  { label: 'Cookies', href: '/cookies' },
]

/** Je odkaz aktivní pro danou cestu? (/catering aktivní i pro /catering/…, kromě svateb). */
export function isActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false
  if (href === '/') return pathname === '/'
  if (href === '/catering') return pathname === '/catering' || (pathname.startsWith('/catering/') && !pathname.startsWith('/catering/svatby'))
  return pathname === href || pathname.startsWith(`${href}/`)
}
