// Pracovní dny v Česku: pondělí až pátek bez státních svátků (zákon
// č. 245/2000 Sb.: státní svátky a ostatní svátky, kdy se nepracuje).
//
// Pevné svátky + Velký pátek a Velikonoční pondělí, které se počítají
// z data Velikonoc (gregoriánský kalendář, „anonymní" algoritmus
// Meeus/Jones/Butcher). Všechno nad kalendářními dny YYYY-MM-DD (pražský
// den), nezávisle na pásmu runtime i na letním čase.
//
// Kopie oproti domain/crm/autoIntake.ts (addBusinessDays bez svátků):
// ten soubor vlastní jiný balík; sjednocení je pozdější úklid.

import { addDaysToPragueDay } from './pragueDate'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Pevné státní a ostatní svátky, kdy se nepracuje (MM-DD). */
export const CZ_FIXED_HOLIDAYS: readonly string[] = [
  '01-01', // Den obnovy samostatného českého státu, Nový rok
  '05-01', // Svátek práce
  '05-08', // Den vítězství
  '07-05', // Den slovanských věrozvěstů Cyrila a Metoděje
  '07-06', // Den upálení mistra Jana Husa
  '09-28', // Den české státnosti
  '10-28', // Den vzniku samostatného československého státu
  '11-17', // Den boje za svobodu a demokracii
  '12-24', // Štědrý den
  '12-25', // 1. svátek vánoční
  '12-26', // 2. svátek vánoční
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Velikonoční neděle daného roku (YYYY-MM-DD). */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${pad(month)}-${pad(day)}`
}

const cache = new Map<number, ReadonlySet<string>>()

/** Všechny dny volna (státní svátky) v daném roce jako YYYY-MM-DD. */
export function czechHolidays(year: number): ReadonlySet<string> {
  const hit = cache.get(year)
  if (hit) return hit
  const easter = easterSunday(year)
  const set = new Set<string>(CZ_FIXED_HOLIDAYS.map((md) => `${year}-${md}`))
  set.add(addDaysToPragueDay(easter, -2)) // Velký pátek (od 2016)
  set.add(addDaysToPragueDay(easter, 1)) // Velikonoční pondělí
  cache.set(year, set)
  return set
}

function assertDay(day: string): void {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(day))) throw new Error(`Neplatný den: ${day}`)
}

/** ISO den v týdnu (1 = pondělí … 7 = neděle). */
export function isoWeekday(day: string): number {
  assertDay(day)
  const w = new Date(`${day}T12:00:00Z`).getUTCDay()
  return w === 0 ? 7 : w
}

export function isCzechHoliday(day: string): boolean {
  assertDay(day)
  return czechHolidays(Number(day.slice(0, 4))).has(day)
}

/** Pracovní den = Po–Pá a ne státní svátek. */
export function isBusinessDay(day: string): boolean {
  return isoWeekday(day) <= 5 && !isCzechHoliday(day)
}

/**
 * Den posunutý o `n` pracovních dnů dopředu (n = 0 → stejný den). Výchozí den
 * se nepočítá: pátek + 1 = pondělí (není-li svátek).
 */
export function addBusinessDays(day: string, n: number): string {
  assertDay(day)
  let d = day
  let left = Math.max(0, Math.floor(n))
  while (left > 0) {
    d = addDaysToPragueDay(d, 1)
    if (isBusinessDay(d)) left--
  }
  return d
}
