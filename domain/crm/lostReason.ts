// Důvod prohry obchodu (P5). Schéma se nemění: kód z COMPANY.lostReasons se
// ukládá jako předpona textu v deal.lost_reason ve tvaru „kod: poznámka"
// (nebo jen „kod"). Starší záznamy jsou volný text; parseLostReason je umí
// zařadit, když se text shoduje s popiskem důvodu („Cena"), jinak zůstanou
// bez kódu.
import { COMPANY } from '@/config'

export type LostReasonOption = { key: string; label: string }

/** Důvody prohry firmy; prázdné pole = jen volný text. */
export const LOST_REASONS: readonly LostReasonOption[] = COMPANY.lostReasons ?? []

export type ParsedLostReason = {
  /** Kód důvodu, nebo null u volného textu bez kódu. */
  key: string | null
  /** Poznámka za kódem (u volného textu celý text). */
  note: string
}

const norm = (s: string) => s.normalize('NFC').trim().toLocaleLowerCase('cs')

/** Rozloží uložený text na kód a poznámku. */
export function parseLostReason(
  text: string | null | undefined,
  reasons: readonly LostReasonOption[] = LOST_REASONS,
): ParsedLostReason {
  const raw = (text ?? '').trim()
  if (!raw) return { key: null, note: '' }
  const m = /^([a-z0-9_]+)\s*(?::\s*([\s\S]*))?$/.exec(raw)
  if (m && reasons.some((r) => r.key === m[1])) return { key: m[1], note: (m[2] ?? '').trim() }
  // Starý volný text: shoda s popiskem („Cena") nebo popisek s poznámkou („Cena: drahé").
  const labelHit = reasons.find((r) => norm(raw) === norm(r.label) || norm(raw).startsWith(`${norm(r.label)}:`))
  if (labelHit) return { key: labelHit.key, note: raw.slice(labelHit.label.length).replace(/^\s*:\s*/, '').trim() }
  return { key: null, note: raw }
}

/** Složí hodnotu pro deal.lost_reason z kódu a poznámky. Neznámý kód = jen poznámka. */
export function formatLostReason(
  key: string | null | undefined,
  note: string | null | undefined,
  reasons: readonly LostReasonOption[] = LOST_REASONS,
): string {
  const n = (note ?? '').replace(/\s+/g, ' ').trim()
  const k = key && reasons.some((r) => r.key === key) ? key : null
  if (!k) return n
  return n ? `${k}: ${n}` : k
}

/** Čitelný text důvodu pro detail obchodu („Cena — klient šel jinam"). */
export function lostReasonText(
  text: string | null | undefined,
  reasons: readonly LostReasonOption[] = LOST_REASONS,
): string {
  const p = parseLostReason(text, reasons)
  const label = p.key ? reasons.find((r) => r.key === p.key)?.label ?? p.key : null
  if (label && p.note) return `${label} — ${p.note}`
  return label ?? p.note
}

/**
 * Normalizace důvodu ze serverové akce: kód z výběru se zachová, volný text
 * projde beze změny (jen ořez). Neznámý kód v předponě („xyz: …") se nebere
 * jako kód — zůstane celý jako volný text.
 */
export function normalizeLostReason(
  text: string | null | undefined,
  reasons: readonly LostReasonOption[] = LOST_REASONS,
): string {
  const raw = (text ?? '').trim()
  const m = /^([a-z0-9_]+)\s*(?::\s*([\s\S]*))?$/.exec(raw)
  if (m && reasons.some((r) => r.key === m[1])) return formatLostReason(m[1], m[2], reasons)
  return raw
}
