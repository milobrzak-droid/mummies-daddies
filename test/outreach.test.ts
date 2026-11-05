import { expect, test } from 'vitest'
import { dueForOutreach, SILENCE_THRESHOLD_DAYS, type OutreachAccount } from '@/domain/crm/outreach'

const base: OutreachAccount = {
  id: 1, name: 'Spolchemie', last_inbound_at: null, last_outbound_at: null,
  nudged_on: null, snooze_until: null, has_open_deal: false,
}
const TODAY = new Date('2026-09-28T09:00:00Z')
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000).toISOString()

test('a client with an open deal is never in this queue — that is pipeline, not outreach', () => {
  // Přesně tohle je ten omyl, kterému se má tahle fronta vyhnout.
  const r = dueForOutreach(
    [{ ...base, has_open_deal: true, last_outbound_at: daysAgo(90) }], TODAY,
  )
  expect(r).toEqual([])
})

test('Spolchemie-shaped case: we sent, they went quiet, no deal — flagged', () => {
  const r = dueForOutreach([{ ...base, last_outbound_at: daysAgo(56) }], TODAY)
  expect(r).toHaveLength(1)
  expect(r[0].days_silent).toBe(56)
})

test('too soon after our own message stays quiet', () => {
  const r = dueForOutreach([{ ...base, last_outbound_at: daysAgo(SILENCE_THRESHOLD_DAYS - 1) }], TODAY)
  expect(r).toEqual([])
})

test('they replied after our message — we owe the reply, not a nudge to re-engage', () => {
  const r = dueForOutreach([{
    ...base, last_outbound_at: daysAgo(60), last_inbound_at: daysAgo(50),
  }], TODAY)
  expect(r).toEqual([])
})

test('an out-of-office autoresponder is still "them replying" as far as this signal goes', () => {
  // Nezávisí na obsahu zprávy, jen na tom, kdo psal poslední — to je
  // záměrné zjednodušení, ne chyba.
  const r = dueForOutreach([{
    ...base, last_outbound_at: daysAgo(30), last_inbound_at: daysAgo(29),
  }], TODAY)
  expect(r).toEqual([])
})

test('snoozed account stays out until the date passes', () => {
  const r = dueForOutreach([{
    ...base, last_outbound_at: daysAgo(90), snooze_until: '2026-10-15',
  }], TODAY)
  expect(r).toEqual([])
})

test('already nudged today does not repeat', () => {
  const r = dueForOutreach([{
    ...base, last_outbound_at: daysAgo(90), nudged_on: '2026-09-28',
  }], TODAY)
  expect(r).toEqual([])
})

test('an account we never contacted is not a candidate', () => {
  expect(dueForOutreach([base], TODAY)).toEqual([])
})

test('most silent sorts first', () => {
  const r = dueForOutreach([
    { ...base, id: 1, name: 'A', last_outbound_at: daysAgo(30) },
    { ...base, id: 2, name: 'B', last_outbound_at: daysAgo(90) },
  ], TODAY)
  expect(r.map((x) => x.account_id)).toEqual([2, 1])
})

// Rozhodnutí 2026-09-28: days_silent se počítá jako pražské kalendářní dny
// (daysBetweenPragueDays), ne jako floor(rozdílu v ms / 86 400 000). Testy
// výše se offsety od TODAY (2026-09-28T09:00:00Z) drží v srpnu/září 2026 —
// beze změny letního/zimního času — takže na nich staré i nové počítání
// vychází stejně a nebylo je třeba upravovat. Následující dva případy jsou
// tam, kde se to rozchází.

test('zpráva odeslaná v pondělí 23:30 pražského času je 21 dní tichá přesně v pondělí o 3 týdny později v 00:30 pražského času', () => {
  // last_outbound: pondělí 2026-09-28 23:30 CEST = 21:30 UTC.
  const lastOutbound = '2026-09-28T21:30:00Z'
  // "dnes": pondělí 2026-10-19 00:30 CEST (stále léto, DST končí až 25. 10.) = 2026-10-18T22:30:00Z.
  const today = new Date('2026-10-18T22:30:00Z')
  // Reálně uplynulo jen 20 dní a 1 hodina (floor(ms/DAY) by dalo 20 — pod
  // prahem). Pražský kalendářní rozdíl je ale přesně 21 dní, protože se
  // počítá 28. 9. → 19. 10., ne surová délka intervalu.
  const r = dueForOutreach([{ ...base, last_outbound_at: lastOutbound }], today)
  expect(r).toHaveLength(1)
  expect(r[0].days_silent).toBe(21)
})

test('přes konec letního času (25. 10. 2026) se počítají kalendářní dny, ne hodiny', () => {
  // last_outbound: neděle 2026-10-18 23:30 CEST = 21:30 UTC.
  const lastOutbound = '2026-10-18T21:30:00Z'
  // "dnes": neděle 2026-11-08 00:30 CET (po přechodu na zimní čas) = 2026-11-07T23:30:00Z.
  const today = new Date('2026-11-07T23:30:00Z')
  // Reálný rozdíl je 20 dní + 2 hodiny (floor by dalo 20 — pod prahem),
  // protože přechod na zimní čas přidal hodinu navíc. Pražský kalendářní
  // rozdíl 18. 10. → 8. 11. je přesně 21 dní a na DST nezávisí.
  const r = dueForOutreach([{ ...base, last_outbound_at: lastOutbound }], today)
  expect(r).toHaveLength(1)
  expect(r[0].days_silent).toBe(21)
})
