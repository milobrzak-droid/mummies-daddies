/**
 * Drobné texty rozhraní průvodce poptávkou, které copy.json NEMÁ
 * (navigace kroků, souhrn, štítek orientační ceny, skryté popisky).
 * Vše ostatní je doslova z copy.json (lib/web/poptavka/copy.ts).
 *
 * KE SCHVÁLENÍ copywriterem: jsou to jen funkční popisky, žádná fakta ani ceny.
 * Bez závislostí → bezpečné pro klienta.
 */
export const UI_TEXT = {
  /** Drobečková navigace /poptavka. */
  breadcrumb: 'Poptávka',
  /** Hlášení čtečce a nadtitulek kroku: „Krok 2 ze 7“. */
  stepOf: 'Krok {n} ze {total}',
  /** Navigace kroků (aria-label). */
  stepsNav: 'Kroky poptávky',
  /** Název posledního kroku. */
  summary: 'Souhrn',
  /** Tlačítko u řádku souhrnu. */
  edit: 'Upravit',
  /** Podtitulek volby „Vyplnit krátký formulář“ (stejná struktura jako u asistenta). */
  formHint: 'Krok za krokem, zhruba dvě minuty',
  /** Krok Formát servisu nemá povinná pole. */
  optionalStep: 'Nepovinné – můžete přeskočit.',
  skip: 'Přeskočit',
  switchToConsultation: 'Přepnout na Konzultaci nebo ochutnávku',
  /** Nevyplněná hodnota v souhrnu. */
  empty: '—',
  /** Časové pole „od“ / „do“ (skryté popisky). */
  timeFrom: 'Od',
  timeTo: 'Do',
  /** Orientační cena (karta vedle průvodce a v souhrnu). */
  estimateTitle: 'Orientačně',
  estimateTotal: 'Pro {n} {osob} zhruba {od}–{do}',
  estimateNote: 'Nezávazný odhad z obvyklého rozpětí, ne nabídka. Přesnou cenu uvidíte v nabídce.',
  /** Minimum osob u zvoleného typu akce (stejná formulace jako PriceTag). */
  minGuests: 'od {n} osob',
  /** Potvrzení: když chybí e-mail (návštěva bez odeslání v této záložce). */
  yourEmail: 'váš e-mail',
  /** Skrytá past na roboty (honeypot) – člověk ji nevidí. */
  honeypot: 'Tohle pole nechte prázdné',
  /** 404: navigace (aria-label). */
  notFoundNav: 'Hlavní stránky webu',
  /** Časté dotazy: obsah stránky (aria-label). */
  faqToc: 'Témata',
} as const

/** Nahradí {proměnné} (bez závislosti na content.ts → i pro klienta). */
export function fillText(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all))
}
