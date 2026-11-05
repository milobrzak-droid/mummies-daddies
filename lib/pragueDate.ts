// Kalendářní dny v pásmu Europe/Prague — čisté pomocníky (závisí jen na konfiguraci firmy).
//
// `new Date().toISOString().slice(0, 10)` dává den v UTC, takže mezi půlnocí
// a 01:00 (zima) / 02:00 (léto) pražského času vrací včerejšek. Tady se den
// určuje přes Intl s timeZone Europe/Prague. (worker/pragueTime.ts dělá
// podobné věci, ale domain/ z worker/ importovat nesmí.)

import { COMPANY } from '@/config'

// Pásmo je konfigurace firmy (config/, kapitola 11); jméno konstanty zůstává.
export const PRAGUE_TZ = COMPANY.timeZone

const DAY_MS = 86_400_000

// en-CA formátuje jako YYYY-MM-DD.
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRAGUE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Pražský kalendářní den (YYYY-MM-DD) daného okamžiku. */
export function pragueDayOf(ts: Date | string | number): string {
  const d = ts instanceof Date ? ts : new Date(ts)
  const p: Record<string, string> = {}
  for (const part of dayFmt.formatToParts(d)) p[part.type] = part.value
  return `${p.year}-${p.month}-${p.day}`
}

/** Dnešní pražský den (YYYY-MM-DD). */
export function pragueToday(now: Date = new Date()): string {
  return pragueDayOf(now)
}

const dayNum = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS

/** Počet kalendářních dnů z `a` do `b` (oba YYYY-MM-DD); b > a → kladné. Nezávislé na DST. */
export function daysBetweenPragueDays(a: string, b: string): number {
  return Math.round(dayNum(b) - dayNum(a))
}

/** Kalendářní den posunutý o `n` dní (YYYY-MM-DD). */
export function addDaysToPragueDay(day: string, n: number): string {
  return new Date((dayNum(day) + n) * DAY_MS).toISOString().slice(0, 10)
}

// --- pražský místní čas ↔ UTC okamžik ---------------------------------
//
// Formuláře (např. <input type="datetime-local">) vrací „naivní" místní čas
// bez pásma, myšlený jako Europe/Prague. Naivní `new Date(hodnota)` ho ale
// parsuje v časovém pásmu serveru — na Vercelu (UTC) tak 10:00 pražského
// (léto: 08:00Z, zima: 09:00Z) skončí uloženo jako 10:00Z, tedy o 1–2 h vedle.
// worker/pragueTime.ts řeší totéž pro cron, ale domain/lib z worker/
// importovat nesmí — princip (Intl, dvojí přiblížení kvůli DST) je stejný,
// jen počítaný znovu tady jako čistá funkce bez závislostí.

const offsetPartsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PRAGUE_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
})

/** Posun Prahy proti UTC v minutách (60 v zimě, 120 v létě) pro daný okamžik. */
function pragueOffsetMinutes(date: Date): number {
  const p: Record<string, string> = {}
  for (const part of offsetPartsFmt.formatToParts(date)) p[part.type] = part.value
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute))
  const truncated = Math.floor(date.getTime() / 60000) * 60000
  return (asUtc - truncated) / 60000
}

/**
 * Pražský místní čas z formuláře („YYYY-MM-DDTHH:MM" nebo „…:SS", jak ho
 * dává `<input type="datetime-local">`) → okamžik UTC.
 *
 * Pro neexistující čas (jarní skok, např. 2026-03-29 02:30) vrací okamžik po
 * skoku; pro dvojznačný čas (podzimní přechod, např. 2026-10-25 02:30) první
 * výskyt (ještě v letním čase).
 */
export function pragueLocalToUtc(dateTimeLocal: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(dateTimeLocal)
  if (!m) throw new Error(`Neplatný místní čas: ${dateTimeLocal}`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = m[6] ? Number(m[6]) : 0
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const first = guess - pragueOffsetMinutes(new Date(guess)) * 60000
  const second_pass = guess - pragueOffsetMinutes(new Date(first)) * 60000
  return new Date(Math.min(first, second_pass))
}

const wallClockFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRAGUE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/**
 * Okamžik → pražský místní čas jako „YYYY-MM-DDTHH:MM:SS" bez pásma. Pro
 * Graph API pole `dateTime`, které se vždy posílá spolu s `timeZone`.
 */
export function pragueLocalString(date: Date): string {
  const p: Record<string, string> = {}
  for (const part of wallClockFmt.formatToParts(date)) p[part.type] = part.value
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}
