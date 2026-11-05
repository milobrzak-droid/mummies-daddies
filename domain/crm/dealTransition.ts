import { normalizeDealStage } from '@/lib/dealStageLegacy'

// Povinná pole PŘI PŘECHODU fáze (kap. 5, rozhodnutí vlastníka 28. 9. 2026)
// — ne při založení a ne při úpravě obchodu, který ve fázi už je.
// Zrcadlí DB trigger deal_stage_transition_guard (migrace 0052), aby UI
// ukázalo důvod dřív, než se ukládá:
//   do 'rozhodovani' jen se známým rozhodovatelem a termínem rozhodnutí,
//   do 'prohráno'    jen s důvodem prohry.
//
// Tolerance k nenasazené 0052: pole, které v řádku úplně CHYBÍ (undefined —
// select('*') nad DB bez sloupce), se nekontroluje; DB ho v tu chvíli
// nevynucuje taky. Prázdná hodnota (null / '' / mezery) je porušení.
// lost_reason existuje od 0020, u něj undefined znamená „nevyplněno".

export type DealTransitionInput = {
  // Současná (uložená) fáze; null = nový obchod.
  stage?: string | null
  decision_maker?: string | null
  decision_due?: string | null
  lost_reason?: string | null
}

export type DealTransitionIssue = 'missing_decision_maker' | 'missing_decision_due' | 'missing_lost_reason'

export const DEAL_TRANSITION_MESSAGES: Record<DealTransitionIssue, string> = {
  missing_decision_maker: 'Do fáze Rozhodování chybí, kdo u klienta rozhoduje.',
  missing_decision_due: 'Do fáze Rozhodování chybí termín rozhodnutí.',
  missing_lost_reason: 'U prohraného obchodu doplň důvod prohry.',
}

// Pole formuláře, ke kterému se porušení váže (fieldErrors).
export const DEAL_TRANSITION_FIELDS: Record<DealTransitionIssue, 'decision_maker' | 'decision_due' | 'lost_reason'> = {
  missing_decision_maker: 'decision_maker',
  missing_decision_due: 'decision_due',
  missing_lost_reason: 'lost_reason',
}

const blank = (v: string | null | undefined) => v == null || v.trim() === ''

export function transitionIssues(deal: DealTransitionInput, toStage: string): DealTransitionIssue[] {
  // Stará hodnota se porovnává po převodu (vyjednávání = rozhodovani) —
  // stejně jako výjimka pro převod v triggeru.
  if (deal.stage != null && normalizeDealStage(deal.stage) === toStage) return []
  const out: DealTransitionIssue[] = []
  if (toStage === 'rozhodovani') {
    if (deal.decision_maker !== undefined && blank(deal.decision_maker)) out.push('missing_decision_maker')
    if (deal.decision_due !== undefined && blank(deal.decision_due)) out.push('missing_decision_due')
  }
  if (toStage === 'prohráno' && blank(deal.lost_reason)) out.push('missing_lost_reason')
  return out
}

export function transitionFieldErrors(issues: DealTransitionIssue[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of issues) out[DEAL_TRANSITION_FIELDS[issue]] = DEAL_TRANSITION_MESSAGES[issue]
  return out
}

// Stabilní SQLSTATE z triggeru 0052 → česká hláška pro uživatele.
export const DEAL_TRANSITION_DB_CODES: Readonly<Record<string, string>> = Object.freeze({
  CR001: 'Do fáze Rozhodování nejde obchod posunout bez známého rozhodovatele a termínu rozhodnutí. Doplň je v úpravě obchodu.',
  CR002: 'Prohraný obchod musí mít důvod prohry.',
})

// null = chyba nepochází z pravidel přechodu (řeší ji dbErrorMessage).
export function dealTransitionDbMessage(error: { code?: unknown } | null | undefined): string | null {
  const code = error?.code
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(DEAL_TRANSITION_DB_CODES, code)
    ? DEAL_TRANSITION_DB_CODES[code]
    : null
}
