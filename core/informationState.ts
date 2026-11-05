// Čtyři rozlišené stavy údaje (kapitola 3 plánu přestavby, cílový dokument:
// „první test kvality schématu") a čisté funkce nad nimi. Bez I/O — žádný
// import z lib/ ani z domain/, aby šel modul použít z libovolné vrstvy.
//
//   source_fact      fakt převzatý ze zdroje (e-mail, schůzka, soubor)
//   ai_suggestion    návrh modelu; nic víc, dokud ho nepotvrdí člověk
//   human_confirmed  člověk údaj potvrdil (nebo ho sám zadal)
//   actual_result    skutečný výsledek pozorovaný ve světě
//
// Hodnoty musí sedět s CHECKem audit_event_info_state_check v migraci 0038.
// Pár testu v test/information-state.test.ts hlídá, že seznam nikdo
// neupraví jen na jedné straně.

export const INFORMATION_STATES = [
  'source_fact',
  'ai_suggestion',
  'human_confirmed',
  'actual_result',
] as const

export type InformationState = (typeof INFORMATION_STATES)[number]

export function isInformationState(value: unknown): value is InformationState {
  return typeof value === 'string' && (INFORMATION_STATES as readonly string[]).includes(value)
}

// Povolené přechody. Všechno, co tu není, je zakázané.
//
// - ai_suggestion → human_confirmed: člověk návrh potvrdil. Jediná cesta ven.
// - ai_suggestion → source_fact je ZÁMĚRNĚ zakázané: návrh AI se nesmí
//   potichu vydávat za fakt ze zdroje. Když zdroj návrh později skutečně
//   podpoří, vzniká NOVÝ údaj (nový řádek s vlastní evidencí), ne přechod.
// - source_fact → human_confirmed: člověk ověřil fakt ze zdroje.
// - human_confirmed → actual_result: potvrzený plán/závazek se ukázal jako
//   skutečný výsledek. Zpět na ai_suggestion ani source_fact ne — potvrzení
//   se nedá potichu „odpotvrdit"; opravu dělá nový údaj s novým aktérem.
// - actual_result je konečný stav.
// - Skok přes potvrzení (source_fact/ai_suggestion → actual_result) je
//   zakázaný: skutečný výsledek má stát na někom, kdo ho potvrdil.
const ALLOWED_TRANSITIONS: Record<InformationState, readonly InformationState[]> = {
  ai_suggestion: ['human_confirmed'],
  source_fact: ['human_confirmed'],
  human_confirmed: ['actual_result'],
  actual_result: [],
}

/** Stavy, do kterých se z `from` smí přejít (prázdné pole = konečný stav). */
export function nextStates(from: InformationState): readonly InformationState[] {
  return ALLOWED_TRANSITIONS[from]
}

/** Smí údaj přejít ze stavu `from` do `to`? Stejný stav není přechod (false). */
export function canTransition(from: InformationState, to: InformationState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

/** Jako canTransition, ale vyhodí srozumitelnou chybu (pro server kód). */
export function assertTransition(from: InformationState, to: InformationState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Nepovolený přechod stavu údaje: ${from} -> ${to}`)
  }
}

/**
 * Musí údaj v tomhle stavu odkazovat na evidenci (zdroj)?
 * - source_fact: ano, fakt „ze zdroje" bez zdroje je jen tvrzení;
 * - actual_result: ano, výsledek se dokládá (e-mail, schůzka, účetní záznam);
 * - ai_suggestion: ne, návrh může vzniknout z celkového kontextu;
 * - human_confirmed: ne, oporou je potvrzující aktér (audit_event.actor_*).
 * DB to nevynucuje (evidence_id je nullable a stávající řádky ho nemají),
 * je to pravidlo pro nové zapisovače.
 */
export function stateRequiresEvidence(state: InformationState): boolean {
  return state === 'source_fact' || state === 'actual_result'
}

// ---------------------------------------------------------------------------
// Odkaz na zdroj (řádek tabulky evidence z migrace 0038): jen ukazatel,
// nikdy obsah. Validace je tady čistá, aby zapisovač zahodil nesmysl dřív,
// než ho odmítne CHECK v databázi.

export const EVIDENCE_KINDS = ['email_message', 'meeting', 'file', 'url'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export type EvidenceRef = {
  kind: EvidenceKind
  /** Id ve zdrojovém systému (Graph message id, id schůzky, id/cesta souboru, URL). */
  sourceId: string
  /** Volitelný hluboký odkaz (https), např. Graph webLink. */
  webLink?: string | null
}

export const EVIDENCE_SOURCE_ID_MAX = 512
export const EVIDENCE_WEB_LINK_MAX = 2048

/** Chyby validace odkazu na zdroj; prázdné pole = v pořádku. */
export function evidenceRefIssues(ref: EvidenceRef): string[] {
  const issues: string[] = []
  if (!(EVIDENCE_KINDS as readonly string[]).includes(ref.kind)) {
    issues.push(`neznámý druh zdroje: ${String(ref.kind)}`)
  }
  const id = ref.sourceId
  if (typeof id !== 'string' || id.trim() === '') {
    issues.push('sourceId je prázdné')
  } else if (id.length > EVIDENCE_SOURCE_ID_MAX) {
    // Dlouhý řetězec je skoro jistě zkopírovaný obsah, ne identifikátor.
    issues.push(`sourceId je delší než ${EVIDENCE_SOURCE_ID_MAX} znaků (evidence drží ukazatel, ne obsah)`)
  }
  if (ref.webLink != null) {
    if (!/^https:\/\//i.test(ref.webLink)) {
      issues.push('webLink musí začínat https://')
    } else if (ref.webLink.length > EVIDENCE_WEB_LINK_MAX) {
      issues.push(`webLink je delší než ${EVIDENCE_WEB_LINK_MAX} znaků`)
    }
  }
  return issues
}

export function isValidEvidenceRef(ref: EvidenceRef): boolean {
  return evidenceRefIssues(ref).length === 0
}
