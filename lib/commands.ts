// Příkazy palety ⌘K (components/CommandPalette.tsx): navigace na stránky menu
// a rychlé akce. Čistá data a funkce bez I/O, testované v test/commands.test.ts.
//
// Viditelnost příkazů kopíruje pravidla stránek: co stránka sama přesměruje
// pryč (obchody, finance, aktivity, schůzky jen pro obchodní role; tým jen pro
// správce), paleta vůbec nenabídne. Paleta nic nepovoluje, jen se tak nechová
// jako slepá ulička; oprávnění vždy hlídá server.

export type CommandGroup = 'action' | 'nav'

export interface Command {
  id: string
  group: CommandGroup
  label: string
  /** Krátký popis vpravo (kde to skončí). */
  hint?: string
  href: string
  /** Slova, podle kterých jde příkaz najít, i když nejsou v názvu. */
  keywords?: string
  /** SVG path (viewBox 24, lineární ikona tahem). */
  icon: string
  salesOnly?: boolean
  adminOnly?: boolean
}

const ICON = {
  plus: 'M12 5v14M5 12h14',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2',
  check: 'M20 6 9 17l-5-5',
  bag: 'M4 7h16v13H4ZM9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M4 13h16',
  building: 'M5 3h14v18H5ZM9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 21v-4h4v4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.6 2.9-5.5 6.5-5.5s6.5 1.9 6.5 5.5M17 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.7c1.9.7 3 2.3 3 5.3',
  columns: 'M4 4h6v16H4ZM14 4h6v9h-6Z',
  card: 'M3 6h18v12H3ZM3 10h18M7 14h3',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-3.5-3.5',
  calendar: 'M4 6h16v14H4ZM4 10h16M8 3v4M16 3v4',
  gauge: 'M4 18a8 8 0 1 1 16 0M12 18l4-6',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  send: 'm22 2-11 11M22 2l-7 20-4-9-9-4Z',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12',
  lock: 'M5 11h14v10H5ZM8 11V7a4 4 0 0 1 8 0v4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 2v3M12 19v3M2 12h3M19 12h3',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3',
} as const

export const COMMANDS: readonly Command[] = [
  // ── rychlé akce: vedou na existující stránku nebo formulář ─────────────
  { id: 'act-activity', group: 'action', label: 'Zapsat aktivitu', hint: 'Aktivity', href: '/cockpit/aktivity#nova-aktivita',
    keywords: 'poznámka hovor schůzka zaznamenat zapsat log', icon: ICON.edit, salesOnly: true },
  { id: 'act-task', group: 'action', label: 'Nový úkol', hint: 'Práce', href: '/cockpit/tasks#novy-ukol',
    keywords: 'založit přidat todo', icon: ICON.plus },
  { id: 'act-client', group: 'action', label: 'Nový klient', hint: 'Klienti', href: '/cockpit/clients/new',
    keywords: 'firma založit přidat', icon: ICON.plus },
  { id: 'act-deal', group: 'action', label: 'Nový obchod', hint: 'Obchody', href: '/cockpit/pipeline/new',
    keywords: 'deal příležitost založit přidat', icon: ICON.plus, salesOnly: true },
  { id: 'act-case', group: 'action', label: 'Nový případ', hint: 'Práce', href: '/cockpit/pripady/nova',
    keywords: 'case založit přidat', icon: ICON.plus },
  { id: 'act-partner', group: 'action', label: 'Nový partner', hint: 'Klienti', href: '/cockpit/partners/new',
    keywords: 'založit přidat', icon: ICON.plus },

  // ── přejít na ────────────────────────────────────────────────────────────
  { id: 'nav-today', group: 'nav', label: 'Dnes', hint: 'G D', href: '/cockpit', keywords: 'přehled domů úvod', icon: ICON.sun },
  { id: 'nav-week', group: 'nav', label: 'Týden', hint: 'Dnes', href: '/cockpit/prehled-tydne', keywords: 'přehled týdne', icon: ICON.calendar },
  { id: 'nav-approve', group: 'nav', label: 'Ke schválení', hint: 'G S', href: '/cockpit/rozhodnuti', keywords: 'rozhodnutí schvalování', icon: ICON.check },
  { id: 'nav-deals', group: 'nav', label: 'Obchody', hint: 'G O', href: '/cockpit/pipeline', keywords: 'pipeline tabule deal', icon: ICON.bag, salesOnly: true },
  { id: 'nav-deal-reports', group: 'nav', label: 'Reporty obchodů', hint: 'Obchody', href: '/cockpit/pipeline/reporty', keywords: 'report přehled žebříček obchodníci prognóza pipeline', icon: ICON.chart, salesOnly: true },
  { id: 'nav-targets', group: 'nav', label: 'Seznamy k oslovení', hint: 'Obchody', href: '/cockpit/cilove-seznamy', keywords: 'cílové seznamy', icon: ICON.list, salesOnly: true },
  { id: 'nav-outreach', group: 'nav', label: 'Oslovování', hint: 'Obchody', href: '/cockpit/oslovovani', keywords: 'outreach kontaktování', icon: ICON.send, salesOnly: true },
  { id: 'nav-clients', group: 'nav', label: 'Klienti', hint: 'G K', href: '/cockpit/clients', keywords: 'firmy účty', icon: ICON.building },
  { id: 'nav-partners', group: 'nav', label: 'Partneři', hint: 'Klienti', href: '/cockpit/partners', keywords: 'partner', icon: ICON.users },
  { id: 'nav-search', group: 'nav', label: 'Hledat', hint: 'Klienti', href: '/cockpit/hledat', keywords: 'najít vyhledávání', icon: ICON.search },
  { id: 'nav-tasks', group: 'nav', label: 'Úkoly', hint: 'G P', href: '/cockpit/tasks', keywords: 'práce todo', icon: ICON.columns },
  { id: 'nav-cases', group: 'nav', label: 'Případy', hint: 'Práce', href: '/cockpit/pripady', keywords: 'case', icon: ICON.columns },
  { id: 'nav-deliveries', group: 'nav', label: 'Dodávky', hint: 'Práce', href: '/cockpit/dodavky', keywords: 'projekty realizace', icon: ICON.columns },
  { id: 'nav-meetings', group: 'nav', label: 'Schůzky', hint: 'Práce', href: '/cockpit/schuzky', keywords: 'meeting kalendář', icon: ICON.calendar, salesOnly: true },
  { id: 'nav-capacity', group: 'nav', label: 'Kapacity', hint: 'Práce', href: '/cockpit/kapacity', keywords: 'vytížení alokace', icon: ICON.gauge },
  { id: 'nav-activities', group: 'nav', label: 'Aktivity', hint: 'Práce', href: '/cockpit/aktivity', keywords: 'historie', icon: ICON.edit, salesOnly: true },
  { id: 'nav-finance', group: 'nav', label: 'Finance', hint: 'G F', href: '/cockpit/finance', keywords: 'faktury platby', icon: ICON.card, salesOnly: true },
  { id: 'nav-team', group: 'nav', label: 'Tým a nastavení', hint: 'Správa', href: '/cockpit/tym', keywords: 'lidé role klíče', icon: ICON.sliders, adminOnly: true },
  { id: 'nav-settings', group: 'nav', label: 'Nastavení', hint: 'Účet', href: '/cockpit/nastaveni', keywords: 'účet', icon: ICON.gear },
  { id: 'nav-mfa', group: 'nav', label: 'Zabezpečení (2FA)', hint: 'Účet', href: '/auth/mfa/enroll', keywords: 'dvoufázové heslo', icon: ICON.lock },
]

export interface CommandAccess { canSeeSales: boolean; isAdmin: boolean }

/** Příkazy, které smí tenhle člověk vidět. */
export function visibleCommands({ canSeeSales, isAdmin }: CommandAccess): Command[] {
  return COMMANDS.filter((c) => (!c.salesOnly || canSeeSales) && (!c.adminOnly || isAdmin))
}

/** Malá písmena bez diakritiky: „uk“ najde „Úkoly“, „schuzky“ najde „Schůzky“. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Filtr příkazů: každé slovo dotazu musí být začátkem některého slova názvu
 * nebo klíčových slov, případně podřetězcem názvu. Nejdřív příkazy, jejichž
 * název začíná dotazem, pak zbytek v původním pořadí. Prázdný dotaz vrací vše.
 */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const q = foldText(query).trim()
  if (!q) return [...commands]
  const tokens = q.split(/\s+/)
  const scored: { c: Command; rank: number; i: number }[] = []
  commands.forEach((c, i) => {
    const label = foldText(c.label)
    const haystack = `${label} ${foldText(c.keywords ?? '')}`
    const words = haystack.split(/[^a-z0-9]+/).filter(Boolean)
    const matches = tokens.every((t) => words.some((w) => w.startsWith(t)) || label.includes(t))
    if (matches) scored.push({ c, rank: label.startsWith(q) ? 0 : 1, i })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((s) => s.c)
}

/** Klávesa po „G“ → cíl (docs/PROVOZ.md §11). */
export const GO_SHORTCUTS: readonly { key: string; href: string; label: string; salesOnly?: boolean }[] = [
  { key: 'd', href: '/cockpit', label: 'Dnes' },
  { key: 's', href: '/cockpit/rozhodnuti', label: 'Ke schválení' },
  { key: 'o', href: '/cockpit/pipeline', label: 'Obchody', salesOnly: true },
  { key: 'k', href: '/cockpit/clients', label: 'Klienti' },
  { key: 'p', href: '/cockpit/tasks', label: 'Práce' },
  { key: 'f', href: '/cockpit/finance', label: 'Finance', salesOnly: true },
]

/** Cíl zkratky „G + klávesa“ pro daného člověka, nebo null. */
export function goTarget(key: string, canSeeSales: boolean): string | null {
  const hit = GO_SHORTCUTS.find((s) => s.key === key.toLowerCase())
  if (!hit || (hit.salesOnly && !canSeeSales)) return null
  return hit.href
}

/**
 * Bereme zkratku, když člověk píše? Zkratky bez modifikátoru (`/`, `?`, `G…`,
 * `C`) se v polích, výběrech a editovatelném obsahu nikdy nespouštějí.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false
  const el = target as HTMLElement
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true'
}
