// Časové pomocníky v pásmu Europe/Prague (kapitola 9: plánovač v čase Prahy).
//
// Cron na Vercelu běží v UTC; o tom, zda úloha „má teď běžet", rozhoduje
// pražský místní čas, aby přechod na letní/zimní čas nic neposunul. Počítáme
// přes Intl (bez knihovny), takže platí aktuální pravidla IANA z runtime.

import { COMPANY } from '@/config'

// Pásmo je konfigurace firmy (config/, kapitola 11); jméno konstanty zůstává.
export const PRAGUE_TZ = COMPANY.timeZone

export interface PragueParts {
  year: number
  month: number // 1–12
  day: number
  hour: number
  minute: number
  weekday: number // 0 = neděle … 6 = sobota
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PRAGUE_TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'short',
  hourCycle: 'h23',
})

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function pragueParts(date: Date): PragueParts {
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf(p.weekday),
  }
}

/** Posun Prahy proti UTC v minutách (60 v zimě, 120 v létě) pro daný okamžik. */
function offsetMinutes(date: Date): number {
  const p = pragueParts(date)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  const truncated = Math.floor(date.getTime() / 60000) * 60000
  return (asUtc - truncated) / 60000
}

/**
 * Pražský místní čas → okamžik UTC. Pro neexistující čas (jarní skok) vrací
 * okamžik po skoku; pro dvojznačný (podzimní) první výskyt. 07:00 se DST
 * přechodů netýká (ty jsou 02:00–03:00).
 */
export function pragueLocalToUtc(
  year: number, month: number, day: number, hour: number, minute = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const first = guess - offsetMinutes(new Date(guess)) * 60000
  const second = guess - offsetMinutes(new Date(first)) * 60000
  return new Date(Math.min(first, second))
}

export interface PragueWindow {
  /** Dny v týdnu (0 = neděle). Prázdné / chybějící = každý den. */
  weekdays?: readonly number[]
  /** Začátek včetně, „HH:MM" v pražském čase. */
  start: string
  /** Konec bez, „HH:MM". Konec < začátek = okno přes půlnoc. */
  end: string
}

function toMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) throw new Error(`Neplatný čas: ${hhmm}`)
  return Number(m[1]) * 60 + Number(m[2])
}

export function isWithinPragueWindow(date: Date, window: PragueWindow): boolean {
  const p = pragueParts(date)
  if (window.weekdays && window.weekdays.length > 0 && !window.weekdays.includes(p.weekday)) {
    return false
  }
  const now = p.hour * 60 + p.minute
  const start = toMinutes(window.start)
  const end = toMinutes(window.end)
  return start <= end ? now >= start && now < end : now >= start || now < end
}

/** Nejbližší pondělí 07:00 pražského času ostře po `from`. */
export function nextMondayPrague0700(from: Date): Date {
  const p = pragueParts(from)
  // Kalendářní datum v Praze jako UTC půlnoc — jen pro aritmetiku dnů.
  const base = Date.UTC(p.year, p.month - 1, p.day)
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base + i * 86_400_000)
    if (d.getUTCDay() !== 1) continue
    const candidate = pragueLocalToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 7)
    if (candidate.getTime() > from.getTime()) return candidate
  }
  throw new Error('unreachable')
}
