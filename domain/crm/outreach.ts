// Fronta k opětovnému oslovení — NENÍ totéž co pipeline.
//
// Pipeline (domain/crm/followUp.ts) hlídá otevřené obchody: má vlastníka, má
// termín, uplynutí eskaluje na nadřízeného. Tohle hlídá firmy, se kterými
// se teprve zjišťuje, jestli je o co stát — typicky žádný obchod ještě
// neexistuje (Spolchemie: poslal se návrh, přišlo "teď se nám to nehodí",
// obchod nikdy nevznikl). Kdyby tohle spadlo do stejné fronty jako
// uplynulý termín u rozjednaného obchodu, buď by to zbytečně zatěžovalo
// eskalaci, nebo by se člověk naučil frontu ignorovat.
//
// Proto: žádná eskalace, žádný vlastník, žádný termín — jen "kdo psal
// naposledy a jak dávno", a je na člověku, jestli to stojí za druhý pokus.

import { pragueToday, pragueDayOf, daysBetweenPragueDays } from '@/lib/pragueDate'
import type { AccountOptOut } from '@/domain/crm/outreachContacts'

export type OutreachAccount = {
  id: number
  name: string
  last_inbound_at: string | null
  last_outbound_at: string | null
  nudged_on: string | null
  snooze_until: string | null
  has_open_deal: boolean
}

export type OutreachCandidate = {
  account_id: number
  name: string
  /** kdo psal naposledy a kdy */
  last_direction: 'us' | 'them'
  last_at: string
  days_silent: number
  /**
   * Kolik lidí u firmy nesouhlasí s oslovením (0087 / poznámka) — jen když
   * aspoň jeden; firma, kde nesouhlasí všichni, se do fronty nedostane
   * (applyOutreachOptOut v outreachContacts.ts). dueForOutreach ho nevyplňuje.
   */
  opt_out?: AccountOptOut | null
}

/** Po kolika dnech ticha od NAŠÍ poslední zprávy dává smysl připomenout. */
export const SILENCE_THRESHOLD_DAYS = 21

export function dueForOutreach(accounts: OutreachAccount[], today: Date): OutreachCandidate[] {
  const todayStr = pragueToday(today) // snooze_until/nudged_on jsou pražské dny
  const out: OutreachCandidate[] = []

  for (const a of accounts) {
    // Obchod v pipeline se řídí domain/crm/followUp.ts — tady by byl duplicitní
    // signál se slabší logikou (bez vlastníka, bez eskalace).
    if (a.has_open_deal) continue
    if (a.snooze_until && a.snooze_until > todayStr) continue
    if (a.nudged_on === todayStr) continue
    if (!a.last_outbound_at) continue

    // Oni psali po nás naposled — dlužíme odpověď MY. To není "oslovit
    // znovu", to je "odpověz", a nepatří do týž fronty ani na týž seznam.
    if (a.last_inbound_at && a.last_inbound_at > a.last_outbound_at) continue

    // Rozhodnutí 2026-09-28: "dní ticha" se počítá jako pražské kalendářní
    // dny (stejně jako termíny u follow-upů), ne jako plovoucích 24hodinových
    // oken. Zpráva poslaná v pondělí 23:30 pražského času je "1 den stará"
    // v úterý po půlnoci, ne až po 24 hodinách reálného času — jinak by dvě
    // zprávy odeslané ve stejný pražský den (jedna těsně před, druhá těsně
    // po půlnoci) vypadaly jako by měly rozdílné stáří o skoro celý den.
    const daysSilent = daysBetweenPragueDays(pragueDayOf(a.last_outbound_at), todayStr)
    if (daysSilent < SILENCE_THRESHOLD_DAYS) continue

    out.push({
      account_id: a.id,
      name: a.name,
      last_direction: 'us',
      last_at: a.last_outbound_at,
      days_silent: daysSilent,
    })
  }
  return out.sort((a, b) => b.days_silent - a.days_silent)
}
