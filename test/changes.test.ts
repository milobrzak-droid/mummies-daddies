import { describe, expect, test } from 'vitest'
import {
  CHANGES_FIRST_VISIT_DAYS, CHANGES_MAX_LOOKBACK_DAYS, CHANGES_VISIT_GAP_MINUTES,
  buildChangeSections, changesSummary, changesTotal, decisionChanges, defaultWeek, deliveryChanges, emailChanges, intakeChanges, latestChanges,
  meetingChanges, milestoneChanges, mondayOf, moneyChanges, parseWeekChoice, resolveVisitWindow, stageChanges, stamp, weekWindow, whenLabel,
  workChanges, documentChanges,
  type ActorAuditRow, type DocumentFindingRow, type AuditRow, type ChangeItem, type DeliveryRow, type MeetingInfo, type MilestoneInfo,
} from '@/domain/crm/changes'

// „Co se změnilo": okno změn, převod surových řádků na položky s důkazem,
// oprávnění a klidné prázdné stavy. Čisté funkce, bez databáze.

const NOW = new Date('2026-09-29T06:30:00Z') // úterý 8:30 pražského času (léto)
const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NAMES = new Map([[ME, 'Viktor Kovář'], [OTHER, 'Lenka Horáková']])

describe('okno „od poslední návštěvy“', () => {
  test('první návštěva (žádný řádek): posledních 7 dní', () => {
    const w = resolveVisitWindow(null, NOW)
    expect(w.kind).toBe('first')
    expect(w.until).toEqual(NOW)
    expect(NOW.getTime() - w.since.getTime()).toBe(CHANGES_FIRST_VISIT_DAYS * 86_400_000)
    expect(w.label).toBe('za posledních 7 dní')
    expect(w.note).toMatch(/první návštěva/i)
  })

  test('tabulka se neukládá (chybí migrace 0075): stejné okno, vysvětlení lidsky bez čísla migrace', () => {
    const w = resolveVisitWindow(null, NOW, { tracked: false })
    expect(w.kind).toBe('first')
    expect(w.note).toMatch(/zatím neukládá/)
    expect(w.note).not.toMatch(/migrac|0075/)
  })

  test('nová návštěva po pauze: okno začíná posledním otevřením z minula', () => {
    const w = resolveVisitWindow({ baseline_at: '2026-09-24T06:15:00Z', last_open_at: '2026-09-28T13:00:00Z' }, NOW)
    expect(w.kind).toBe('visit')
    expect(w.since.toISOString()).toBe('2026-09-28T13:00:00.000Z')
    expect(w.label).toBe('od tvé poslední návštěvy (včera v 15:00)')
    expect(w.note).toBeNull()
  })

  test('obnovení stránky uvnitř návštěvy okno nepřesune (baseline zůstává)', () => {
    const w = resolveVisitWindow({ baseline_at: '2026-09-28T13:00:00Z', last_open_at: '2026-09-29T06:00:00Z' }, NOW)
    expect(w.since.toISOString()).toBe('2026-09-28T13:00:00.000Z')
    expect(w.kind).toBe('visit')
  })

  test('před zápisem i po něm stejné okno (pravidlo návštěvy je shodné s RPC)', () => {
    // Před otevřením: řádek z minulé návštěvy. Po otevření RPC: baseline = minulé last_open, last_open = teď.
    const before = resolveVisitWindow({ baseline_at: '2026-09-24T06:15:00Z', last_open_at: '2026-09-28T13:00:00Z' }, NOW)
    const after = resolveVisitWindow({ baseline_at: '2026-09-28T13:00:00Z', last_open_at: NOW.toISOString() }, new Date(NOW.getTime() + 60_000))
    expect(after.since).toEqual(before.since)
  })

  test('první otevření uvnitř návštěvy (baseline zatím není) nezapomene první návštěvu', () => {
    const w = resolveVisitWindow({ baseline_at: null, last_open_at: '2026-09-29T06:00:00Z' }, NOW)
    expect(w.kind).toBe('first')
  })

  test('hranice mezery návštěvy: přesně 240 minut je pořád jedna návštěva, o minutu víc už nová', () => {
    const last = new Date(NOW.getTime() - CHANGES_VISIT_GAP_MINUTES * 60_000)
    const same = resolveVisitWindow({ baseline_at: '2026-09-20T06:00:00Z', last_open_at: last.toISOString() }, NOW)
    expect(same.since.toISOString()).toBe('2026-09-20T06:00:00.000Z')
    const newer = resolveVisitWindow({ baseline_at: '2026-09-20T06:00:00Z', last_open_at: new Date(last.getTime() - 60_000).toISOString() }, NOW)
    expect(newer.since.getTime()).toBe(last.getTime() - 60_000)
  })

  test('dávná návštěva: nejvýš 30 dní zpět a řekne to', () => {
    const w = resolveVisitWindow({ baseline_at: null, last_open_at: '2026-06-01T08:00:00Z' }, NOW)
    expect(w.kind).toBe('capped')
    expect(NOW.getTime() - w.since.getTime()).toBe(CHANGES_MAX_LOOKBACK_DAYS * 86_400_000)
    expect(w.note).toMatch(/dávno/)
  })

  test('whenLabel: dnes, včera a starší den s dnem v týdnu', () => {
    expect(whenLabel(new Date('2026-09-29T05:15:00Z'), NOW)).toBe('dnes v 07:15')
    expect(whenLabel(new Date('2026-09-28T13:00:00Z'), NOW)).toBe('včera v 15:00')
    expect(whenLabel(new Date('2026-09-24T06:15:00Z'), NOW)).toBe('čt 24. 9. v 08:15')
  })
})

describe('týden Po–Ne', () => {
  test('pondělí týdne', () => {
    expect(mondayOf('2026-09-29')).toBe('2026-09-28')
    expect(mondayOf('2026-09-28')).toBe('2026-09-28')
    expect(mondayOf('2026-10-04')).toBe('2026-09-28') // neděle patří k týdnu, který začal pondělím
  })

  test('minulý týden = předchozí Po–Ne v pražském čase (půlnoc–půlnoc)', () => {
    const w = weekWindow('2026-09-29', 'minuly')
    expect(w.kind).toBe('week')
    expect(w.since.toISOString()).toBe('2026-09-20T22:00:00.000Z') // po 21. 9. 00:00 CEST
    expect(w.until.toISOString()).toBe('2026-09-27T22:00:00.000Z') // po 28. 9. 00:00 CEST
    expect(w.label).toBe('za týden 39: po 21. 9. až ne 27. 9.')
  })

  test('tento týden začíná letošním pondělím', () => {
    const w = weekWindow('2026-09-29', 'tento')
    expect(w.since.toISOString()).toBe('2026-09-27T22:00:00.000Z')
    expect(w.until.toISOString()).toBe('2026-10-04T22:00:00.000Z')
  })

  test('změna letního času nerozbije hranici týdne (neděle 25. 10. 2026)', () => {
    const w = weekWindow('2026-10-28', 'minuly') // týden 19.–25. 10.
    expect(w.since.toISOString()).toBe('2026-10-18T22:00:00.000Z') // ještě CEST
    expect(w.until.toISOString()).toBe('2026-10-25T23:00:00.000Z') // už CET
  })

  test('výchozí týden podle dne: Po–Čt minulý (pondělní přehled), Pá–Ne probíhající (páteční)', () => {
    expect(defaultWeek('2026-09-28')).toBe('minuly')
    expect(defaultWeek('2026-10-01')).toBe('minuly')
    expect(defaultWeek('2026-10-02')).toBe('tento')
    expect(defaultWeek('2026-10-04')).toBe('tento')
  })

  test('parseWeekChoice: platná volba z adresy, jinak výchozí', () => {
    expect(parseWeekChoice('tento', '2026-09-29')).toBe('tento')
    expect(parseWeekChoice(['minuly'], '2026-10-02')).toBe('minuly')
    expect(parseWeekChoice('cokoli', '2026-09-29')).toBe('minuly')
    expect(parseWeekChoice(undefined, '2026-10-02')).toBe('tento')
  })
})

describe('e-maily od klientů', () => {
  const rows = [
    { id: 1, occurred_at: '2026-09-29T06:15:00Z', account_id: 7, account_name: 'ALFATECH' },
    { id: 2, occurred_at: '2026-09-28T09:00:00Z', account_id: 7, account_name: 'ALFATECH' },
    { id: 3, occurred_at: '2026-09-28T10:00:00Z', account_id: 9, account_name: null },
  ]

  test('jedna položka na klienta s počtem a odkazem na firmu', () => {
    const items = emailChanges(rows)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'email', title: 'ALFATECH', href: '/cockpit/clients/7', count: 2 })
    expect(items[0].detail).toBe('2 nové e-maily od klienta')
    expect(items[0].proof).toMatch(/přijat 29\. 9\. 0?8:15/)
    expect(items[1]).toMatchObject({ title: 'Klient', detail: '1 nový e-mail od klienta' })
  })

  test('součet v sekci počítá e-maily, ne klienty', () => {
    const [email] = buildChangeSections(emailChanges(rows), { canSeeSales: true }).filter((s) => s.kind === 'email')
    expect(email.total).toBe(3)
  })
})

describe('posun fáze obchodu', () => {
  const deals = new Map([[5, { id: 5, title: 'AI agent', account_id: 3, account_name: 'ALFATECH' }]])
  const ev = (id: number, action: string, at: string, before: unknown, after: unknown, entity = 5): AuditRow =>
    ({ id, action, entity_id: entity, occurred_at: at, before, after })

  test('víc posunů téhož obchodu se sloučí: první „před“ → poslední „po“', () => {
    const items = stageChanges([
      ev(11, 'deal.stage_changed', '2026-09-28T08:00:00Z', { stage: 'kvalifikace' }, { stage: 'diagnostika' }),
      ev(12, 'deal.stage_changed', '2026-09-29T05:00:00Z', { stage: 'diagnostika' }, { stage: 'rozsah_nabidka' }),
    ], deals)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'stage', title: 'ALFATECH · AI agent', detail: 'Poptávka → Nabídka odeslána',
      href: '/cockpit/clients/3/deals/5', at: '2026-09-29T05:00:00Z',
    })
    expect(items[0].proof).toContain('Záznam v auditu č. 12')
  })

  test('fáze, která se vrátila tam, kde byla, není změna', () => {
    expect(stageChanges([
      ev(1, 'deal.stage_changed', '2026-09-28T08:00:00Z', { stage: 'diagnostika' }, { stage: 'rozhodovani' }),
      ev(2, 'deal.stage_changed', '2026-09-28T09:00:00Z', { stage: 'rozhodovani' }, { stage: 'diagnostika' }),
    ], deals)).toEqual([])
  })

  test('nový obchod se ukáže jako „Nový obchod“; jiné akce se ignorují', () => {
    const items = stageChanges([
      ev(1, 'deal.created', '2026-09-28T08:00:00Z', null, { stage: 'kvalifikace' }),
      ev(2, 'deal.amount_changed', '2026-09-28T09:00:00Z', { amount_one_time: 1 }, { amount_one_time: 2 }, 5),
    ], deals)
    expect(items).toHaveLength(1)
    expect(items[0].detail).toBe('Nový obchod')
  })

  test('starý klíč fáze se přeloží; neznámý obchod dostane číslo a odkaz na tabuli', () => {
    const items = stageChanges([
      ev(3, 'deal.stage_changed', '2026-09-28T08:00:00Z', { stage: 'nabídka' }, { stage: 'vyhráno' }, 99),
    ], deals)
    expect(items[0]).toMatchObject({ title: 'Obchod č. 99', detail: 'Nabídka odeslána → Vyhráno', href: '/cockpit/pipeline' })
  })
})

describe('rozhodnutí', () => {
  test('schválené i zamítnuté žádosti a rozhodnutí; kdo rozhodl podle jména', () => {
    const items = decisionChanges({
      approvals: [
        { id: 4, status: 'approved', decided_at: '2026-09-29T05:00:00Z', decided_by: `user:${ME}`, action_kind: 'external_commitment', case_id: 8, case_title: 'Follow-up: ALFATECH' },
        { id: 5, status: 'rejected', decided_at: '2026-09-28T05:00:00Z', decided_by: 'system:expiry', action_kind: 'send_offer', case_id: null, case_title: null },
        { id: 6, status: 'pending', decided_at: null, decided_by: null, action_kind: 'x', case_id: null, case_title: null },
        { id: 7, status: 'expired', decided_at: '2026-09-28T05:00:00Z', decided_by: null, action_kind: 'x', case_id: null, case_title: null },
      ],
      decisions: [
        { id: 2, question: 'Připravit technickou analýzu?', chosen: 'Ano', decided_at: '2026-09-27T05:00:00Z', decided_by: `user:${OTHER}`, case_id: 8, case_title: null },
        { id: 3, question: 'Otevřená otázka', chosen: null, decided_at: null, decided_by: null, case_id: 8, case_title: null },
      ],
    }, NAMES)
    expect(items.map((i) => i.key)).toEqual(['approval-4', 'approval-5', 'decision-2'])
    expect(items[0]).toMatchObject({ title: 'Follow-up: ALFATECH', detail: 'Schváleno · Viktor Kovář', href: '/cockpit/pripady/8' })
    expect(items[0].proof).toContain('č. 4')
    // send_offer je od 0084 druh akce → český název místo kódu.
    expect(items[1]).toMatchObject({ title: 'Odeslat nabídku klientovi', detail: 'Zamítnuto · systém', href: '/cockpit/rozhodnuti' })
    expect(items[2].detail).toBe('Rozhodnuto: Ano · Lenka Horáková')
  })
})

describe('nové úkoly a případy', () => {
  const task = (over: Partial<Parameters<typeof workChanges>[0]['tasks'][number]> = {}) => ({
    id: 1, title: 'Poslat podklady', created_at: '2026-09-29T05:00:00Z', created_by: OTHER, assignee_id: ME,
    due_on: '2026-10-02', status: 'todo', account_name: 'ALFATECH', ...over,
  })
  const kase = (over: Partial<Parameters<typeof workChanges>[0]['cases'][number]> = {}) => ({
    id: 8, title: 'Follow-up: ALFATECH', created_at: '2026-09-29T04:00:00Z', created_by: 'system:follow-up-watch', status: 'open', account_name: 'ALFATECH', ...over,
  })

  test('úkol pro mě od někoho jiného a případ od systému', () => {
    const items = workChanges({ tasks: [task()], cases: [kase()] }, ME)
    expect(items.map((i) => i.key)).toEqual(['task-1', 'case-8'])
    expect(items[0]).toMatchObject({ detail: 'Nový úkol · termín 2. 10. · ALFATECH', href: '/cockpit/tasks' })
    expect(items[1]).toMatchObject({ detail: 'Nový případ · založil systém · ALFATECH', href: '/cockpit/pripady/8' })
    expect(items[1].proof).toContain('Případ č. 8')
  })

  test('co jsem založil já, úkoly někoho jiného, hotové a zrušené se nepočítají', () => {
    expect(workChanges({
      tasks: [task({ created_by: ME }), task({ id: 2, assignee_id: OTHER }), task({ id: 3, status: 'done' })],
      cases: [kase({ created_by: `user:${ME}` }), kase({ id: 9, status: 'cancelled' })],
    }, ME)).toEqual([])
  })

  test('úkol bez řešitele patří do přehledu každému', () => {
    expect(workChanges({ tasks: [task({ assignee_id: null })], cases: [] }, ME)).toHaveLength(1)
  })
})

describe('milníky dodávek', () => {
  const ms: MilestoneInfo[] = [
    { id: 1, title: 'Procesní mapa', status: 'ceka_na_schvaleni', updated_at: '2026-09-29T05:00:00Z', engagement_id: 3, account_id: 1, account_name: 'ALFATECH' },
    { id: 2, title: 'Workshop', status: 'v_praci', updated_at: '2026-09-28T09:00:00Z', engagement_id: 3, account_id: 1, account_name: 'ALFATECH' },
  ]
  const win = { since: new Date('2026-09-28T00:00:00Z'), until: NOW }
  const ev = (id: number, entity: number, action: string, at: string, before: unknown, after: unknown): AuditRow =>
    ({ id, action, entity_id: entity, occurred_at: at, before, after })

  test('stav a termín z auditu po 0064 (řádková změna se sloupci v _columns)', () => {
    const items = milestoneChanges({
      events: [
        ev(20, 1, 'engagement_milestone.updated', '2026-09-28T10:00:00Z', { status: 'v_praci' }, { status: 'ceka_na_vstup', _columns: ['status'] }),
        ev(21, 1, 'engagement_milestone.updated', '2026-09-29T05:00:00Z', { status: 'ceka_na_vstup', due_on: '2026-09-30' }, { status: 'ceka_na_schvaleni', due_on: '2026-10-07', _columns: ['due_on', 'status'] }),
      ],
      milestones: ms,
    }, win)
    const m = items.find((i) => i.key === 'milestone-1')!
    expect(m.title).toBe('Procesní mapa · ALFATECH')
    expect(m.detail).toBe('Stav: V práci → Čeká na schválení · Termín: 30. 9. → 7. 10.')
    expect(m.href).toBe('/cockpit/clients/1/engagements/3/edit?zalozka=milniky')
    expect(m.proof).toContain('Záznam v auditu č. 21')
  })

  test('posun milníku i obecná změna bez auditu nesou id dodávky', () => {
    const items = milestoneChanges({
      events: [ev(20, 1, 'engagement_milestone.updated', '2026-09-28T10:00:00Z', { status: 'v_praci' }, { status: 'ceka_na_vstup', _columns: ['status'] })],
      milestones: ms,
    }, win)
    expect(items.map((i) => [i.key, i.engagementId])).toEqual([['milestone-1', 3], ['milestone-2', 3]])
  })

  test('appkový audit před 0064 (milestone.status, milestone.accepted) se čte taky', () => {
    const items = milestoneChanges({
      events: [
        ev(30, 2, 'milestone.status', '2026-09-28T09:00:00Z', { status: 'pripraveno' }, { status: 'v_praci' }),
        ev(31, 2, 'milestone.accepted', '2026-09-29T04:00:00Z', { status: 'ceka_na_schvaleni' }, { status: 'prijato', accepted_at: '2026-09-29' }),
      ],
      milestones: ms,
    }, win)
    expect(items.find((i) => i.key === 'milestone-2')?.detail).toBe('Stav: Připraveno → Přijato')
  })

  test('změna mimo stav a termín (třeba vlastník) není „posun“; sloupce jen jménem se neukazují', () => {
    expect(milestoneChanges({
      events: [ev(40, 1, 'engagement_milestone.updated', '2026-09-29T05:00:00Z', { owner_id: 'a' }, { owner_id: 'b', _columns: ['owner_id'] })],
      milestones: ms,
    }, win).filter((i) => i.key === 'milestone-1' && i.proof.includes('č. 40'))).toEqual([])
  })

  test('milník změněný bez stopy v auditu se ukáže jen obecně podle updated_at, mimo okno ne', () => {
    const items = milestoneChanges({ events: [], milestones: [
      ms[1],
      { ...ms[0], id: 3, title: 'Dávný', updated_at: '2026-08-01T09:00:00Z' },
    ] }, win)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'milestone-2', detail: 'Změněn, teď: V práci' })
    expect(items[0].proof).toContain('Milník č. 2')
  })

  test('nový milník', () => {
    const items = milestoneChanges({
      events: [ev(50, 2, 'engagement_milestone.created', '2026-09-28T09:00:00Z', null, { status: 'pripraveno', _columns: ['status', 'title'] })],
      milestones: ms,
    }, win)
    expect(items.find((i) => i.key === 'milestone-2')?.detail).toContain('Nový milník')
  })

  test('milníky automaticky založené dodávky se po jednom nehlásí (vznik hlásí položka „Nové dodávky“)', () => {
    const created = [
      ev(50, 1, 'engagement_milestone.created', '2026-09-29T05:00:00Z', null, { status: 'pripraveno', _columns: ['status', 'title'] }),
      ev(51, 2, 'engagement_milestone.created', '2026-09-29T05:00:00Z', null, { status: 'pripraveno', _columns: ['status', 'title'] }),
    ]
    const both = ms.map((m) => ({ ...m, status: 'pripraveno' }))
    expect(milestoneChanges({ events: created, milestones: both, freshEngagementIds: new Set([3]) }, win)).toEqual([])
    // Bez auditu (před 0064) se nový milník ve stavu „připraveno“ taky přeskočí.
    expect(milestoneChanges({ events: [], milestones: both, freshEngagementIds: new Set([3]) }, win)).toEqual([])
    // Jiná dodávka se hlásí dál.
    expect(milestoneChanges({ events: created, milestones: both, freshEngagementIds: new Set([99]) }, win)).toHaveLength(2)
  })

  test('skutečný posun milníku nové automatické dodávky se ukáže', () => {
    const items = milestoneChanges({
      events: [
        ev(50, 1, 'engagement_milestone.created', '2026-09-29T04:00:00Z', null, { status: 'pripraveno', _columns: ['status', 'title'] }),
        ev(52, 1, 'engagement_milestone.updated', '2026-09-29T05:00:00Z', { status: 'pripraveno' }, { status: 'v_praci', _columns: ['status'] }),
      ],
      milestones: [{ ...ms[0], status: 'v_praci' }],
      freshEngagementIds: new Set([3]),
    }, win)
    expect(items).toHaveLength(1)
    expect(items[0].detail).toBe('Stav: Připraveno → V práci')
  })
})

describe('nové dodávky (automaticky po vyhrání obchodu)', () => {
  const row = (p: Partial<DeliveryRow> = {}): DeliveryRow =>
    ({ id: 12, kind: 'it', created_at: '2026-09-29T05:40:00Z', account_id: 7, account_name: 'Servis Climax', ...p })

  test('položka s klientem a druhem, odkazem na dodávku a důkazem', () => {
    const [item] = deliveryChanges([row()])
    expect(item).toMatchObject({
      key: 'delivery-12', kind: 'delivery', at: '2026-09-29T05:40:00Z',
      title: 'Servis Climax · Akce',
      detail: 'Dodávka byla založena automaticky po vyhrání obchodu',
      href: '/cockpit/clients/7/engagements/12/edit',
    })
    expect(item.proof).toBe('Dodávka č. 12, založena 29. 9. 07:40')
  })

  test('bez firmy zůstane druh; bez účtu odkaz na úkoly; nejnovější první; žádné částky', () => {
    const items = deliveryChanges([
      row({ id: 1, created_at: '2026-09-28T05:00:00Z' }),
      row({ id: 2, account_name: null, account_id: null, kind: 'edu' }),
    ])
    expect(items.map((i) => i.key)).toEqual(['delivery-2', 'delivery-1'])
    expect(items[0]).toMatchObject({ title: 'Firemní akce', href: '/cockpit/tasks' })
    expect(JSON.stringify(items)).not.toMatch(/Kč|amount/)
  })

  test('položka nese id dodávky (provozní přehled podle něj páruje změny s dodávkou)', () => {
    expect(deliveryChanges([row()])[0].engagementId).toBe(12)
  })

  test('žádná dodávka = žádná položka', () => {
    expect(deliveryChanges([])).toEqual([])
  })
})

describe('faktury a platby', () => {
  test('nová faktura a platba s částkou; zrušené a potenciál ne', () => {
    const items = moneyChanges([
      { id: 1, kind: 'invoiced', status: 'draft', amount: '121000', currency: 'CZK', created_at: '2026-09-29T05:00:00Z', account_name: 'ALFATECH' },
      { id: 2, kind: 'received', status: 'confirmed', amount: 1500, currency: 'EUR', created_at: '2026-09-28T05:00:00Z', account_name: 'ACME' },
      { id: 3, kind: 'invoiced', status: 'cancelled', amount: 1, currency: 'CZK', created_at: '2026-09-28T05:00:00Z', account_name: 'X' },
      { id: 4, kind: 'potential', status: 'draft', amount: 1, currency: 'CZK', created_at: '2026-09-28T05:00:00Z', account_name: 'X' },
    ])
    expect(items.map((i) => i.key)).toEqual(['money-1', 'money-2'])
    expect(items[0].detail).toBe('Návrh podkladu k faktuře · 121 000 Kč')
    expect(items[1].detail).toMatch(/^Přijatá platba · 1 500\s?€$/)
    expect(items[0]).toMatchObject({ href: '/cockpit/finance', title: 'ALFATECH' })
  })
})

describe('nové poptávky založené automaticky z e-mailu', () => {
  const row = (id: number, name: string | null, due: string | null, created = '2026-09-29T07:31:00Z') =>
    ({ id, account_id: 40 + id, created_at: created, occurred_at: '2026-09-29T07:30:00Z', account_name: name, next_step_due: due })

  test('položka nese název firmy, označení „vzniklo automaticky", termín a důkaz', () => {
    const items = intakeChanges([row(3, ' Acme Stroje ', '2026-09-30')])
    expect(items).toEqual([{
      key: 'intake-3', kind: 'intake', at: '2026-09-29T07:31:00Z',
      title: 'Nová poptávka: Acme Stroje',
      detail: 'Vzniklo automaticky z e-mailu · odpovědět do 30. 9.',
      href: '/cockpit/clients/43',
      proof: 'Automatické založení č. 3, e-mail přijat 29. 9. 09:30',
    }])
  })

  test('bez termínu i bez názvu je položka pořád čitelná; nesmyslný termín se ignoruje', () => {
    const [a, b] = intakeChanges([row(1, null, null), row(2, 'X', 'zítra')])
    expect(a.title).toBe('Nová poptávka: firma')
    expect(a.detail).toBe('Vzniklo automaticky z e-mailu')
    expect(b.detail).toBe('Vzniklo automaticky z e-mailu')
  })

  test('řadí od nejnovější', () => {
    const items = intakeChanges([row(1, 'A', null, '2026-09-29T05:00:00Z'), row(2, 'B', null, '2026-09-29T08:00:00Z')])
    expect(items.map((i) => i.key)).toEqual(['intake-2', 'intake-1'])
  })

  test('je to obchodní druh: jen s can_see_sales', () => {
    const s = buildChangeSections(intakeChanges([row(1, 'A', null)]), { canSeeSales: true })
    expect(s[0]).toMatchObject({ kind: 'intake', label: 'Nové poptávky', total: 1 })
    expect(buildChangeSections(intakeChanges([row(1, 'A', null)]), { canSeeSales: false }).some((x) => x.kind === 'intake')).toBe(false)
  })
})

describe('posunuté a zrušené schůzky (audit sales_activity)', () => {
  const info = (over: Partial<MeetingInfo> = {}): MeetingInfo => ({
    id: 41, subject: 'Workshop AI', occurred_at: '2026-10-03T12:00:00+00:00', outcome: 'planned', account_id: 7, account_name: 'ALFATECH', ...over,
  })
  const ev = (over: Partial<ActorAuditRow> & { id: number; before: unknown; after: unknown }): ActorAuditRow => ({
    action: 'sales_activity.updated', entity_id: 41, occurred_at: '2026-09-29T06:05:00Z', actor_type: 'system', actor_id: 'calendar-sync', ...over,
  })
  const moved = ev({
    id: 900,
    before: { occurred_at: '2026-10-01T08:00:00+00:00', follow_up_on: '2026-10-11' },
    after: { occurred_at: '2026-10-03T12:00:00+00:00', follow_up_on: '2026-10-13', _columns: ['follow_up_on', 'occurred_at'] },
  })

  test('posun z Outlooku: odkud kam, klient, důkaz z auditu', () => {
    const [item] = meetingChanges([moved], new Map([[41, info()]]))
    expect(item).toEqual({
      key: 'meeting-41',
      kind: 'meeting',
      at: '2026-09-29T06:05:00Z',
      title: 'ALFATECH · Workshop AI',
      detail: 'Přesunuto: čt 1. 10. 10:00 → so 3. 10. 14:00 · podle Outlooku',
      href: '/cockpit/clients/7',
      proof: expect.stringMatching(/^Záznam v auditu č\. 900, 29\. 9\. 0?8:05$/),
    })
  })

  test('zrušení: kdy měla být; víc posunů jedné schůzky = jedna položka od prvního do posledního', () => {
    const cancel = ev({ id: 901, occurred_at: '2026-09-29T06:06:00Z', before: { outcome: 'planned' }, after: { outcome: 'cancelled', _columns: ['outcome'] } })
    const [c] = meetingChanges([cancel], new Map([[41, info({ outcome: 'cancelled', occurred_at: '2026-10-01T08:00:00+00:00' })]]))
    expect(c.detail).toBe('Zrušeno · bylo naplánováno na čt 1. 10. 10:00 · podle Outlooku')
    expect(c.proof).toContain('č. 901')

    const again = ev({
      id: 902, occurred_at: '2026-09-29T07:00:00Z',
      before: { occurred_at: '2026-10-03T12:00:00+00:00' }, after: { occurred_at: '2026-10-05T08:00:00+00:00', _columns: ['occurred_at'] },
    })
    const items = meetingChanges([again, moved], new Map([[41, info()]]))
    expect(items).toHaveLength(1)
    expect(items[0].detail).toBe('Přesunuto: čt 1. 10. 10:00 → po 5. 10. 10:00 · podle Outlooku')
  })

  test('posun sem a zpátky, zápis ke schůzce (planned → completed) a neviditelná schůzka se neukážou', () => {
    const back = ev({ id: 903, before: { occurred_at: '2026-10-03T12:00:00+00:00' }, after: { occurred_at: '2026-10-01T08:00:00+00:00', _columns: ['occurred_at'] } })
    expect(meetingChanges([moved, back], new Map([[41, info()]]))).toEqual([])
    const paired = ev({ id: 904, before: { outcome: 'planned', source: 'cockpit' }, after: { outcome: 'completed', source: 'wispr_flow', _columns: ['body', 'outcome', 'source'] } })
    expect(meetingChanges([paired], new Map([[41, info({ outcome: 'completed' })]]))).toEqual([])
    expect(meetingChanges([moved], new Map())).toEqual([])
  })

  test('změna od člověka nese jen „Přesunuto" bez „podle Outlooku"', () => {
    const [item] = meetingChanges([{ ...moved, actor_type: 'user', actor_id: ME }], new Map([[41, info({ account_id: null, account_name: null })]]))
    expect(item.detail).toBe('Přesunuto: čt 1. 10. 10:00 → so 3. 10. 14:00')
    expect(item).toMatchObject({ title: 'Workshop AI', href: '/cockpit/schuzky' })
  })
})

describe('sekce a oprávnění', () => {
  const item = (kind: ChangeItem['kind'], at: string, key = `${kind}-${at}`): ChangeItem =>
    ({ key, kind, at, title: 't', detail: 'd', href: '/x', proof: 'p' })
  const all = [
    item('intake', '2026-09-29T06:00:00Z'),
    item('email', '2026-09-29T05:00:00Z'), item('stage', '2026-09-29T04:00:00Z'), item('money', '2026-09-29T03:00:00Z'),
    item('decision', '2026-09-29T02:00:00Z'), item('work', '2026-09-29T01:00:00Z'), item('milestone', '2026-09-29T00:00:00Z'),
    item('delivery', '2026-09-28T23:00:00Z'), item('meeting', '2026-09-28T22:00:00Z'),
    item('handover', '2026-09-28T21:00:00Z'), item('document', '2026-09-28T20:00:00Z'),
  ]

  test('obchodní role dostane všech jedenáct druhů ve stálém pořadí (nové poptávky první)', () => {
    const s = buildChangeSections(all, { canSeeSales: true })
    expect(s.map((x) => x.kind)).toEqual(['intake', 'email', 'stage', 'meeting', 'delivery', 'decision', 'work', 'handover', 'milestone', 'document', 'money'])
    expect(changesTotal(s)).toBe(11)
  })

  test('bez can_see_sales se poptávky, pošta, fáze, schůzky a peníze nevrátí, ani když je někdo předá; dodávky, předání práce a dokumenty ano (bez částek)', () => {
    const s = buildChangeSections(all, { canSeeSales: false })
    expect(s.map((x) => x.kind)).toEqual(['delivery', 'decision', 'work', 'handover', 'milestone', 'document'])
    expect(JSON.stringify(s)).not.toMatch(/intake|email|stage|money|meeting/)
    expect(changesTotal(s)).toBe(6)
  })

  test('limit na sekci a počet skrytých; nejnovější nahoře', () => {
    const many = Array.from({ length: 5 }, (_, i) => item('work', `2026-09-29T0${i}:00:00Z`))
    const [work] = buildChangeSections(many, { canSeeSales: false, perSection: 2 }).filter((x) => x.kind === 'work')
    expect(work.items.map((i) => i.at)).toEqual(['2026-09-29T04:00:00Z', '2026-09-29T03:00:00Z'])
    expect(work.hidden).toBe(3)
    expect(work.total).toBe(5)
  })

  test('latestChanges řadí napříč sekcemi', () => {
    const s = buildChangeSections(all, { canSeeSales: true })
    expect(latestChanges(s, 3).map((i) => i.kind)).toEqual(['intake', 'email', 'stage'])
  })

  test('prázdný stav: nuly, žádné položky, věta „Nic se nezměnilo“', () => {
    const s = buildChangeSections([], { canSeeSales: true })
    expect(changesTotal(s)).toBe(0)
    expect(changesSummary(0)).toBe('Nic se nezměnilo')
    expect(changesSummary(1)).toBe('1 změna')
    expect(changesSummary(3)).toBe('3 změny')
    expect(changesSummary(7)).toBe('7 změn')
  })

  test('stamp: pražský čas s datem, neplatný vstup jako pomlčka', () => {
    expect(stamp('2026-09-29T06:15:00Z')).toMatch(/^29\. 9\. 0?8:15$/)
    expect(stamp(null)).toBe('—')
    expect(stamp('nesmysl')).toBe('—')
  })
})

describe('dokumenty dodávek (nálezy denní kontroly, 0094)', () => {
  const row = (over: Partial<DocumentFindingRow> = {}): DocumentFindingRow => ({
    id: 31, kind: 'changed', detected_at: '2026-09-29T04:05:00Z', resolved_at: null, document_id: 9, title: 'Nabídka pro ALFATECH',
    status: 'sent', engagement_id: 4, account_id: 7, account_name: 'ALFATECH', seen_version: '4.0', approved_version: '3.0', ...over,
  })

  test('změnil se od schválení: klient a dokument v názvu, verze ve větě, důkaz = nález a čas kontroly', () => {
    const [it] = documentChanges([row()])
    expect(it).toMatchObject({
      key: 'document-31',
      kind: 'document',
      at: '2026-09-29T04:05:00Z',
      title: 'ALFATECH · Nabídka pro ALFATECH',
      href: '/cockpit/clients/7/engagements/4/edit?zalozka=dokumenty',
      engagementId: 4,
    })
    expect(it.detail).toBe('Od schválení se změnil (dokument je odesláno): schválená verze 3.0, nyní verze 4.0.')
    expect(it.proof).toMatch(/^Nález kontroly dokumentu č\. 31, 29\. 9\. /)
  })

  test('zmizel, bez přístupu; zavřený nález má v detailu „Už vyřešeno"', () => {
    const items = documentChanges([
      row({ id: 1, kind: 'missing', status: 'approved', seen_version: null, approved_version: null }),
      row({ id: 2, kind: 'no_access', status: 'accepted', resolved_at: '2026-09-29T05:00:00Z' }),
    ])
    expect(items.find((i) => i.key === 'document-1')!.detail).toBe('Soubor ze SharePointu zmizel (dokument je schváleno).')
    const noAccess = items.find((i) => i.key === 'document-2')!
    expect(noAccess.detail).toMatch(/nemá k souboru přístup/)
    expect(noAccess.detail).toMatch(/Už vyřešeno\.$/)
  })

  test('bez známých čísel verzí je to „jiná verze"; neznámý druh nálezu se přeskočí; bez klienta je název dokumentu', () => {
    const [it] = documentChanges([row({ seen_version: null, approved_version: null, account_name: null, account_id: null })])
    expect(it.detail).toMatch(/jiná verze než schválená/)
    expect(it.title).toBe('Nabídka pro ALFATECH')
    expect(it.href).toBe('/cockpit/clients?stav=aktivni')
    expect(documentChanges([row({ kind: 'neznamy' })])).toEqual([])
  })

  test('položka nenese obsah souboru ani nic mimo název, stav a verze', () => {
    expect(JSON.stringify(documentChanges([row()]))).not.toMatch(/sharepoint|eTag|cTag|drive/i)
  })

  test('nejnovější nahoře; jedna sekce „Dokumenty dodávek" bez obchodního oprávnění', () => {
    const items = documentChanges([row({ id: 1, detected_at: '2026-09-28T04:00:00Z' }), row({ id: 2, detected_at: '2026-09-29T04:00:00Z' })])
    expect(items.map((i) => i.key)).toEqual(['document-2', 'document-1'])
    const s = buildChangeSections(items, { canSeeSales: false }).find((x) => x.kind === 'document')!
    expect(s).toMatchObject({ label: 'Dokumenty dodávek', total: 2 })
  })
})
