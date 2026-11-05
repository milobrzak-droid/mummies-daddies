import { describe, expect, test } from 'vitest'
import {
  REMINDER_TITLE_PREFIX, WAITING_QUIET_DAYS, WAITING_STATUSES, buildWaitingItems, lastStatusMoves, overdueLabel,
  reminderDraft, reminderMailto, reminderTaskDescription, reminderTaskTitle, waitingAgeLabel, waitingSummary,
  type WaitingMilestoneRow,
} from '@/domain/delivery/waiting'
import { MILESTONE_STATUSES } from '@/domain/delivery/milestone'

// Hlídání čekání: co čeká na klienta, od kdy, kdy je to po termínu nebo bez
// pohybu, a co se klientovi navrhne. Čisté funkce, bez databáze.

const TODAY = '2026-09-29'

const row = (over: Partial<WaitingMilestoneRow> = {}): WaitingMilestoneRow => ({
  id: 1, engagement_id: 3, title: 'Procesní mapa', owner_id: null, status: 'ceka_na_schvaleni', due_on: null,
  updated_at: '2026-09-28T08:00:00Z', created_at: '2026-09-01T08:00:00Z',
  engagement: { id: 3, account_id: 1, kind: 'it', phase: 'pilot', account_name: 'ALFATECH' },
  ...over,
})
const input = (milestones: WaitingMilestoneRow[], extra: Partial<Parameters<typeof buildWaitingItems>[0]> = {}) => ({
  milestones, moves: new Map<number, string>(), openReminders: new Map<number, Set<string>>(), contacts: new Map(), today: TODAY, ...extra,
})

describe('co čeká na klienta', () => {
  test('čekají jen dva stavy; ostatní stavy milníku ne', () => {
    expect([...WAITING_STATUSES]).toEqual(['ceka_na_vstup', 'ceka_na_schvaleni'])
    const others = MILESTONE_STATUSES.filter((s) => !(WAITING_STATUSES as readonly string[]).includes(s))
    const items = buildWaitingItems(input(others.map((status, i) => row({ id: i + 1, status }))))
    expect(items).toEqual([])
  })

  test('„odesláno ≠ přijato“: schválení klientem a podklady mají každé svou větu', () => {
    const items = buildWaitingItems(input([
      row({ id: 1, status: 'ceka_na_schvaleni' }),
      row({ id: 2, status: 'ceka_na_vstup', title: 'Podklady' }),
    ], { moves: new Map([[1, '2026-09-26T08:00:00Z'], [2, '2026-09-27T08:00:00Z']]) }))
    const byId = new Map(items.map((i) => [i.milestoneId, i]))
    expect(byId.get(1)).toMatchObject({ kind: 'approval', what: 'Odesláno klientovi 26. 9., zatím není přijato.' })
    expect(byId.get(2)).toMatchObject({ kind: 'input', what: 'Čekáme na podklady od klienta od 27. 9.' })
    expect(byId.get(1)?.href).toBe('/cockpit/clients/1/engagements/3/edit?zalozka=milniky')
    expect(byId.get(1)?.deliveryLabel).toBe('Akce')
  })

  test('kdy čekání začalo: čas posledního posunu stavu z auditu, jinak updated_at', () => {
    const [fromAudit] = buildWaitingItems(input([row()], { moves: new Map([[1, '2026-09-20T08:00:00Z']]) }))
    expect(fromAudit.since).toBe('2026-09-20T08:00:00Z')
    expect(fromAudit.daysWaiting).toBe(9)
    const [fallback] = buildWaitingItems(input([row()]))
    expect(fallback.since).toBe('2026-09-28T08:00:00Z')
    expect(fallback.daysWaiting).toBe(1)
  })

  test('bez jakéhokoli času se milník nevymýšlí', () => {
    expect(buildWaitingItems(input([row({ updated_at: null, created_at: null })]))).toEqual([])
  })

  test(`bez pohybu od ${WAITING_QUIET_DAYS} dní, po termínu podle due_on`, () => {
    const items = buildWaitingItems(input([
      row({ id: 1 }),
      row({ id: 2, due_on: '2026-09-26' }),
      row({ id: 3, due_on: '2026-09-29' }),
      row({ id: 4, due_on: '2026-10-05' }),
    ], { moves: new Map([[1, '2026-09-24T08:00:00Z'], [2, '2026-09-28T08:00:00Z'], [3, '2026-09-28T08:00:00Z'], [4, '2026-09-28T08:00:00Z']]) }))
    const by = new Map(items.map((i) => [i.milestoneId, i]))
    expect(by.get(1)).toMatchObject({ daysWaiting: 5, signals: ['quiet'], daysOverdue: null })
    expect(by.get(2)).toMatchObject({ signals: ['overdue'], daysOverdue: 3 })
    expect(by.get(3)?.signals).toEqual([]) // termín dnes ještě není po termínu
    expect(by.get(4)?.signals).toEqual([])
  })

  test('řazení: po termínu (nejdéle), pak bez pohybu (nejdéle), pak ostatní', () => {
    const moves = new Map([[1, '2026-09-28T08:00:00Z'], [2, '2026-09-10T08:00:00Z'], [3, '2026-09-20T08:00:00Z'], [4, '2026-09-27T08:00:00Z'], [5, '2026-09-27T08:00:00Z']])
    const items = buildWaitingItems(input([
      row({ id: 1 }),
      row({ id: 2 }),
      row({ id: 3, due_on: '2026-09-25' }),
      row({ id: 4, due_on: '2026-09-28' }),
      row({ id: 5 }),
    ], { moves }))
    expect(items.map((i) => i.milestoneId)).toEqual([3, 4, 2, 5, 1])
  })

  test('uzavřená dodávka a milník bez dodávky se nehlídají', () => {
    const items = buildWaitingItems(input([
      row({ id: 1, engagement: { id: 3, account_id: 1, kind: 'it', phase: 'uzavreno', account_name: 'ALFATECH' } }),
      row({ id: 2, engagement: null }),
    ]))
    expect(items).toEqual([])
  })

  test('otevřená připomínka se pozná podle názvu úkolu u stejné dodávky, u jiné dodávky ne', () => {
    const open = new Map([[3, new Set([reminderTaskTitle('Procesní mapa')])]])
    const [a] = buildWaitingItems(input([row()], { openReminders: open }))
    expect(a.reminderOpen).toBe(true)
    const [b] = buildWaitingItems(input([row({ engagement_id: 4, engagement: { id: 4, account_id: 1, kind: 'it', phase: 'pilot', account_name: 'ALFATECH' } })], { openReminders: open }))
    expect(b.reminderOpen).toBe(false)
  })

  test('kontakt klienta se přiloží podle dodávky; chybějící jméno klienta = „Klient“', () => {
    const [a] = buildWaitingItems(input([row({ engagement: { id: 3, account_id: 1, kind: 'edu', phase: 'pilot', account_name: null } })], {
      contacts: new Map([[3, { name: 'Jana Nováková', email: 'jana@firma.cz' }]]),
    }))
    expect(a.accountName).toBe('Klient')
    expect(a.contact).toEqual({ name: 'Jana Nováková', email: 'jana@firma.cz' })
  })
})

describe('audit: od kdy stav trvá', () => {
  const e = (entity_id: number, action: string, occurred_at: string, after: unknown = null) => ({ entity_id, action, occurred_at, after })

  test('bere poslední posun stavu, ne úpravu jiných sloupců', () => {
    const moves = lastStatusMoves([
      e(1, 'engagement_milestone.updated', '2026-09-20T08:00:00Z', { _columns: ['status'] }),
      e(1, 'engagement_milestone.updated', '2026-09-25T08:00:00Z', { _columns: ['due_on'] }),
      e(1, 'milestone.status', '2026-09-22T08:00:00Z'),
      e(2, 'engagement_milestone.created', '2026-09-01T08:00:00Z'),
      e(3, 'engagement_milestone.updated', '2026-09-25T08:00:00Z', { _columns: ['owner_id'] }),
      e(4, 'engagement_milestone.updated', 'nesmysl', { _columns: ['status'] }),
    ])
    expect(moves.get(1)).toBe('2026-09-22T08:00:00Z')
    expect(moves.get(2)).toBe('2026-09-01T08:00:00Z')
    expect(moves.has(3)).toBe(false)
    expect(moves.has(4)).toBe(false)
  })
})

describe('texty karty', () => {
  test('stáří a termín česky se správným skloňováním', () => {
    expect(waitingAgeLabel(0)).toBe('Čeká od dneška')
    expect(waitingAgeLabel(1)).toBe('Čeká už 1 den')
    expect(waitingAgeLabel(3)).toBe('Čeká už 3 dny')
    expect(waitingAgeLabel(8)).toBe('Čeká už 8 dní')
    expect(overdueLabel(1)).toBe('Po termínu o 1 den')
    expect(overdueLabel(5)).toBe('Po termínu o 5 dní')
  })

  test('shrnutí: klidné, když nic; jinak počty po termínu a bez pohybu', () => {
    expect(waitingSummary([])).toBe('Nic nečeká na klienta')
    const items = buildWaitingItems(input([
      row({ id: 1, due_on: '2026-09-20' }), row({ id: 2 }), row({ id: 3 }),
    ], { moves: new Map([[1, '2026-09-28T08:00:00Z'], [2, '2026-09-20T08:00:00Z'], [3, '2026-09-28T08:00:00Z']]) }))
    expect(waitingSummary(items)).toBe('3 věci čekají na klienta · 1 po termínu, 1 bez pohybu')
    expect(waitingSummary(items.slice(0, 1))).toBe('1 věc čeká na klienta · 1 po termínu')
  })
})

describe('Připomenout klientovi: úkol a návrh e-mailu (nic se neodesílá)', () => {
  const [item] = buildWaitingItems(input([row()], { moves: new Map([[1, '2026-09-22T08:00:00Z']]) }))

  test('název úkolu je stálý (idempotence) a začíná pevnou předponou', () => {
    expect(reminderTaskTitle('Procesní mapa')).toBe(`${REMINDER_TITLE_PREFIX}Procesní mapa`)
    expect(reminderTaskTitle('  Procesní mapa ')).toBe(reminderTaskTitle('Procesní mapa'))
    expect(reminderTaskTitle('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })

  test('návrh pro schválení klientem: odkud čekáme, prosba o potvrzení, bez oslovení jménem', () => {
    const d = reminderDraft(item)
    expect(d.subject).toBe('Připomenutí: Procesní mapa')
    expect(d.body).not.toContain('..')
    expect(d.body).toContain('Dobrý den,')
    expect(d.body).toContain('které jsme Vám poslali 22. září. Zatím u nás není potvrzené.')
    expect(d.body).toContain('potvrdíte')
    expect(d.body).not.toMatch(/Dobrý den, \S/)
  })

  test('návrh pro podklady se ptá na podklady', () => {
    const [inp] = buildWaitingItems(input([row({ status: 'ceka_na_vstup', title: 'Data k analýze' })], { moves: new Map([[1, '2026-09-22T08:00:00Z']]) }))
    const d = reminderDraft(inp)
    expect(d.body).toContain('potřebujeme od Vás podklady')
    expect(d.body).toContain('Čekáme na ně od 22. září.')
    expect(d.body).not.toContain('..')
  })

  test('popis úkolu nese návrh i upozornění, že se nic samo neodešle', () => {
    const text = reminderTaskDescription(reminderDraft(item), item)
    expect(text).toContain('ALFATECH')
    expect(text).toContain('nic se neodesílá automaticky')
    expect(text).toContain('Předmět: Připomenutí: Procesní mapa')
  })

  test('mailto: adresa jen platná, předmět i text zakódované, žádné skryté příjemce', () => {
    const d = reminderDraft(item)
    const ok = reminderMailto(d, 'jana@firma.cz')
    expect(ok.startsWith('mailto:jana@firma.cz?subject=')).toBe(true)
    expect(ok).toContain(encodeURIComponent(d.subject))
    expect(ok).not.toContain('\n')
    expect(reminderMailto(d, null).startsWith('mailto:?subject=')).toBe(true)
    // Cizí obsah v adrese (víc příjemců, hlavičky) se zahodí.
    for (const evil of ['a@b.cz,c@d.cz', 'a@b.cz?bcc=x@y.cz', 'a@b.cz\nBcc: x@y.cz', 'není adresa']) {
      expect(reminderMailto(d, evil).startsWith('mailto:?subject=')).toBe(true)
    }
  })
})
