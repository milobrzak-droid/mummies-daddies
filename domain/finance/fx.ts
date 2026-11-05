// Pravidla kolem přepočtu měn u obchodů. Živý kurz ČNB (síťové volání)
// je v connectors/cnb, tady zůstává jen čistá rozhodovací logika.

// Má se u obchodu v eurech ponechat kurz z doby uzavření?
//
// Ano, právě když je obchod uzavřený A eurová částka ani měna se nemění.
// Bez toho se historická hodnota přepočítávala při každém uložení dnešním
// kurzem — takže oprava překlepu v poznámce u loňského vyhraného obchodu
// tiše posunula vykázanou tržbu za uzavřený měsíc.
export type FrozenDealLike = {
  stage: string
  currency: string
  amount_one_time_original: number | string | null
} | null

export function shouldFreezeRate(
  existing: FrozenDealLike,
  next: { currency: string; amount_one_time_original: number | null },
): boolean {
  if (!existing) return false
  if (existing.stage !== 'vyhráno' && existing.stage !== 'prohráno') return false
  if (existing.currency !== next.currency) return false
  const prev = existing.amount_one_time_original
  const nxt = next.amount_one_time_original
  // null (nevyplněno) a 0 jsou různé hodnoty – nově zadaná 0 je změna.
  if (prev == null || nxt == null) return prev == null && nxt == null
  return Number(prev) === Number(nxt)
}
