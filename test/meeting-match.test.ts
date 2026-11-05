import { expect, test } from 'vitest'
import {
  matchMeeting,
  matchPlannedMeeting,
  type ContactRef,
  type MatchTarget,
  type PlannedActivity,
} from '@/domain/crm/meetingMatch'

const OURS = 'mummiesdaddies.com'

const contacts: ContactRef[] = [
  { id: 1, email: 'milan.svejkovsky@cchellenic.com', account_id: 23, partner_id: null },
  { id: 2, email: 'lukas.pour@magna.com', account_id: 22, partner_id: null },
  { id: 3, email: 'roman.slobodnik@tdbetatrade.com', account_id: null, partner_id: 2 },
  { id: 4, email: 'chodora@centr.cz', account_id: 21, partner_id: null },
  { id: 5, email: 'marek.prach@gmail.com', account_id: null, partner_id: 11 },
]

test('matches a meeting with exactly one known company', () => {
  const r = matchMeeting(['milan.svejkovsky@cchellenic.com', 'viktor@mummiesdaddies.com'], contacts, OURS)
  expect(r).toEqual({ status: 'matched', target: { account_id: 23, partner_id: null, contact_id: 1 } })
})

test('matches a partner contact to the partner', () => {
  const r = matchMeeting(['roman.slobodnik@tdbetatrade.com', 'viktor@mummiesdaddies.com'], contacts, OURS)
  expect(r.status).toBe('matched')
  if (r.status === 'matched') expect(r.target.partner_id).toBe(2)
})

test('refuses to attribute when an unknown company is also present', () => {
  // Jednání o NUTRENDu, na kterém byl Roman z BETA TRADEu — nesmí spadnout
  // pod BETA TRADE jen proto, že je to jediná známá tvář.
  const r = matchMeeting(
    ['jan.pirkl@nutrend.cz', 'roman.slobodnik@tdbetatrade.com', 'viktor@mummiesdaddies.com'],
    contacts, OURS,
  )
  expect(r.status).toBe('ambiguous')
  if (r.status === 'ambiguous') {
    expect(r.known).toContain('tdbetatrade.com')
    expect(r.unknown).toContain('nutrend.cz')
  }
})

test('refuses a multi-company panel', () => {
  const r = matchMeeting(
    ['marecek@ssi.cz', 'stepanka.zdvorakova@schindler.com', 'chodora@centr.cz', 'viktor@mummiesdaddies.com'],
    contacts, OURS,
  )
  expect(r.status).toBe('ambiguous')
})

test('reports a meeting with only unknown companies', () => {
  const r = matchMeeting(['konopova@spolchemie.cz', 'viktor@mummiesdaddies.com'], contacts, OURS)
  expect(r).toEqual({ status: 'unknown', domains: ['spolchemie.cz'] })
})

test('treats an internal-only call as internal', () => {
  const r = matchMeeting(['jiri@mummiesdaddies.com', 'viktor@mummiesdaddies.com'], contacts, OURS)
  expect(r.status).toBe('internal')
})

test('matches a freemail address by exact address, not by domain', () => {
  const r = matchMeeting(['marek.prach@gmail.com', 'viktor@mummiesdaddies.com'], contacts, OURS)
  expect(r.status).toBe('matched')
  if (r.status === 'matched') expect(r.target.partner_id).toBe(11)
})

test('an unknown freemail guest does not make a meeting ambiguous', () => {
  // Soukromá adresa navíc nesmí zablokovat jinak jednoznačnou schůzku.
  const r = matchMeeting(
    ['lukas.pour@magna.com', 'nekdo@gmail.com', 'viktor@mummiesdaddies.com'],
    contacts, OURS,
  )
  expect(r.status).toBe('matched')
  if (r.status === 'matched') expect(r.target.account_id).toBe(22)
})

test('uses the manual domain map when no contact exists yet', () => {
  const r = matchMeeting(['l.galeta@climax.cz', 'viktor@mummiesdaddies.com'], contacts, OURS, {
    'climax.cz': { account_id: 7, partner_id: null, contact_id: null },
  })
  expect(r.status).toBe('matched')
  if (r.status === 'matched') expect(r.target.account_id).toBe(7)
})

test('is case-insensitive about addresses', () => {
  const r = matchMeeting(['Lukas.Pour@Magna.com', 'Viktor@MummiesDaddies.com'], contacts, OURS)
  expect(r.status).toBe('matched')
})

test('a client plus a channel partner on one call resolves to the client', () => {
  // Jak firma běžně prodává: BETA TRADE přivede klienta a je u jednání.
  // Schůzka je o klientovi, ne o kanálu.
  const withClient: ContactRef[] = [
    ...contacts,
    { id: 6, email: 'jan.pirkl@nutrend.cz', account_id: 36, partner_id: null },
  ]
  const r = matchMeeting(
    ['jan.pirkl@nutrend.cz', 'roman.slobodnik@tdbetatrade.com', 'viktor@mummiesdaddies.com'],
    withClient, OURS,
  )
  expect(r.status).toBe('matched')
  if (r.status === 'matched') expect(r.target.account_id).toBe(36)
})

test('two clients on one call stay ambiguous', () => {
  const r = matchMeeting(
    ['milan.svejkovsky@cchellenic.com', 'lukas.pour@magna.com', 'viktor@mummiesdaddies.com'],
    contacts, OURS,
  )
  expect(r.status).toBe('ambiguous')
})

test('two partners and no client stay ambiguous', () => {
  const twoPartners: ContactRef[] = [
    { id: 7, email: 'a@taupartner.cz', account_id: null, partner_id: 6 },
    { id: 8, email: 'b@tdbetatrade.com', account_id: null, partner_id: 2 },
  ]
  const r = matchMeeting(['a@taupartner.cz', 'b@tdbetatrade.com', 'viktor@mummiesdaddies.com'], twoPartners, OURS)
  expect(r.status).toBe('ambiguous')
})

// ---------------------------------------------------------------------------
// Doplnění naplánované schůzky zápisem z proběhlé schůzky

const planned = (over: Partial<PlannedActivity> & { id: number; occurred_at: string }): PlannedActivity => ({
  account_id: 23, partner_id: null, outcome: 'planned', ...over,
})

const CLIENT: MatchTarget = { account_id: 23, partner_id: null, contact_id: 1 }

test('fills in a planned meeting that started exactly on time', () => {
  const rows = [planned({ id: 100, occurred_at: '2026-03-10T09:00:00.000Z' })]
  const hit = matchPlannedMeeting('2026-03-10T09:00:00.000Z', CLIENT, rows)
  expect(hit?.id).toBe(100)
})

test('fills in a planned meeting moved by a couple of hours the same day', () => {
  // Schůzka se posunula z 9:00 na 11:20 — pořád je to ta samá schůzka.
  const rows = [planned({ id: 101, occurred_at: '2026-03-10T09:00:00.000Z' })]
  const hit = matchPlannedMeeting('2026-03-10T11:20:00.000Z', CLIENT, rows)
  expect(hit?.id).toBe(101)
})

test('does not match a planned meeting from a different day', () => {
  // Přesun na jiný den je v praxi jiná schůzka — původní termín zůstane nesplněný.
  const rows = [planned({ id: 102, occurred_at: '2026-03-09T09:00:00.000Z' })]
  expect(matchPlannedMeeting('2026-03-10T09:00:00.000Z', CLIENT, rows)).toBeNull()
})

test('does not match across midnight even when the clock time is close', () => {
  // 23:30 a 00:30 pražského času dělí jen hodina, ale jsou to jiné dny.
  const rows = [planned({ id: 103, occurred_at: '2026-03-10T22:30:00.000Z' })] // 23:30 Praha
  expect(matchPlannedMeeting('2026-03-10T23:30:00.000Z', CLIENT, rows)).toBeNull() // 00:30 Praha, 11. 3.
})

test('does not match a planned meeting of a different account', () => {
  const rows = [planned({ id: 104, account_id: 22, occurred_at: '2026-03-10T09:00:00.000Z' })]
  expect(matchPlannedMeeting('2026-03-10T09:00:00.000Z', CLIENT, rows)).toBeNull()
})

test('does not touch an activity that is already completed', () => {
  const rows = [planned({ id: 105, outcome: 'completed', occurred_at: '2026-03-10T09:00:00.000Z' })]
  expect(matchPlannedMeeting('2026-03-10T09:15:00.000Z', CLIENT, rows)).toBeNull()
})

test('leaves two equally close candidates unmatched', () => {
  // Dvě naplánované schůzky se stejným odstupem — netipujeme, radši duplicita.
  const rows = [
    planned({ id: 106, occurred_at: '2026-03-10T08:00:00.000Z' }),
    planned({ id: 107, occurred_at: '2026-03-10T10:00:00.000Z' }),
  ]
  expect(matchPlannedMeeting('2026-03-10T09:00:00.000Z', CLIENT, rows)).toBeNull()
})

test('picks the closer of two candidates on the same day', () => {
  const rows = [
    planned({ id: 108, occurred_at: '2026-03-10T08:00:00.000Z' }),
    planned({ id: 109, occurred_at: '2026-03-10T09:30:00.000Z' }),
  ]
  expect(matchPlannedMeeting('2026-03-10T09:00:00.000Z', CLIENT, rows)?.id).toBe(109)
})

test('matches a partner meeting against a partner-only planned activity', () => {
  const rows = [planned({ id: 110, account_id: null, partner_id: 2, occurred_at: '2026-03-10T09:00:00.000Z' })]
  const hit = matchPlannedMeeting(
    '2026-03-10T09:40:00.000Z',
    { account_id: null, partner_id: 2, contact_id: 3 },
    rows,
  )
  expect(hit?.id).toBe(110)
})
