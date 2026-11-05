// Staré fáze obchodu (před kapitolou 5) a jejich převod na nové.
//
// JEDINÉ místo v aplikačním kódu, kde smí stát staré klíče fází — hlídá to
// test/deal-stage-migration.test.ts. Migrace 0050 převede data v DB; tenhle
// převod při čtení je jen pojistka pro případ, že kód poběží nad daty, která
// migrací ještě neprošla (nebo je do DB zapíše něco mimo appku). Hodnoty
// enumu `deal_stage` v Postgresu zůstávají navždy (hodnotu enumu odebrat
// neumí), jen se nepoužívají.
//
// Mapování (rozhodnutí vedení 28. 9. 2026, stejné jako v 0050):
//   lead              → kvalifikace
//   proběhlo_jednání  → kvalifikace
//   nabídka           → rozsah_nabidka
//   vyjednávání       → rozhodovani
//   vyhráno / prohráno / odloženo beze změny
import type { DealStageKey } from '@/lib/domain'

export const LEGACY_DEAL_STAGE_MAP: Readonly<Record<string, DealStageKey>> = Object.freeze({
  lead: 'kvalifikace',
  'proběhlo_jednání': 'kvalifikace',
  'nabídka': 'rozsah_nabidka',
  'vyjednávání': 'rozhodovani',
})

// Výchozí pravděpodobnosti starých fází (před 0050). 0050 je u převáděných
// obchodů s prázdnou pravděpodobností zmrazí do probability_pct, aby se
// vážená pipeline převodem nepohnula.
export const LEGACY_DEAL_STAGE_PROBABILITY: Readonly<Record<string, number>> = Object.freeze({
  lead: 10,
  'proběhlo_jednání': 30,
  'nabídka': 55,
  'vyjednávání': 75,
})

export function isLegacyDealStage(stage: unknown): stage is string {
  return typeof stage === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_DEAL_STAGE_MAP, stage)
}

// Stará hodnota → nová; nová (nebo neznámá) hodnota projde beze změny.
export function normalizeDealStage(stage: string | null | undefined): string | null {
  if (stage == null) return null
  return isLegacyDealStage(stage) ? LEGACY_DEAL_STAGE_MAP[stage] : stage
}

// Řádek obchodu převedený stejně, jako ho převede 0050: nová fáze a u prázdné
// pravděpodobnosti (jen když řádek sloupec probability_pct nese) výchozí
// pravděpodobnost STARÉ fáze — vážená pipeline se převodem nepohne.
// Ostatní pole beze změny; řádek bez staré fáze se vrací tentýž (bez kopie).
export function normalizeDealRow<T>(row: T): T {
  if (row == null || typeof row !== 'object') return row
  const stage = (row as { stage?: unknown }).stage
  if (!isLegacyDealStage(stage)) return row
  const next: Record<string, unknown> = { ...row, stage: LEGACY_DEAL_STAGE_MAP[stage] }
  if ('probability_pct' in row && (row as { probability_pct?: unknown }).probability_pct == null) {
    next.probability_pct = LEGACY_DEAL_STAGE_PROBABILITY[stage]
  }
  return next as T
}

export function normalizeDealRows<T>(rows: T[]): T[] {
  return rows.map((row) => normalizeDealRow(row))
}

// Pro filtry v DB (`.in('stage', …)`): nové klíče plus staré, které se na
// ně převádějí — obchod se starou hodnotou tak z filtru nevypadne.
// Pozor: nové hodnoty v dotazu vyžadují aplikovanou migraci 0049, jinak
// Postgres dotaz odmítne (neplatná hodnota enumu).
export function withLegacyDealStages(keys: readonly string[]): string[] {
  const legacy = Object.entries(LEGACY_DEAL_STAGE_MAP)
    .filter(([, next]) => keys.includes(next))
    .map(([old]) => old)
  return [...keys, ...legacy]
}
