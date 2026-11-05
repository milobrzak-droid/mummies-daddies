import { describe, expect, test } from 'vitest'
import { NODES } from '@/core/workCase'
import type { LoopNodeRow } from '@/core/authority'
import {
  APPROVAL_FORBIDDEN_MESSAGE,
  CASE_TEMPLATES,
  DECISION_FORBIDDEN_MESSAGE,
  MIGRATION_PENDING_MESSAGE,
  NODE_LABELS,
  actorName,
  actorOf,
  defaultLeadOwner,
  findTemplate,
  loopRpcErrorMessage,
  nextStepPosition,
  parseCaseFilter,
  parseOptions,
  pragueDayEnd,
  statusesForFilter,
  templateStepRows,
  viewerCanDecide,
} from '@/core/workCaseFlow'

const VIKTOR = '11111111-1111-4111-8111-111111111111'
const ANNA = '22222222-2222-4222-8222-222222222222'
const rows: LoopNodeRow[] = NODES.map((node) => ({ node, owner_id: VIKTOR, deputy_id: node === 'obchod' ? ANNA : null }))

describe('šablona nestandardní poptávka → nabídka na míru', () => {
  const t = findTemplate('nestandardni_nabidka')!
  test('tři kroky v pořadí a jedno rozhodnutí ano/ne', () => {
    expect(t.steps).toEqual(['Posoudit výjimku', 'Připravit nabídku na míru', 'Schválit a odeslat'])
    expect(t.decisions).toEqual([{ question: 'Nabídnout mimo standardní mapu?', options: ['ano', 'ne'] }])
  })
  test('řádky kroků s pozicemi od 1 a stavem todo', () => {
    expect(templateStepRows(t, 7)).toEqual([
      { case_id: 7, position: 1, title: 'Posoudit výjimku', status: 'todo' },
      { case_id: 7, position: 2, title: 'Připravit nabídku na míru', status: 'todo' },
      { case_id: 7, position: 3, title: 'Schválit a odeslat', status: 'todo' },
    ])
  })
  test('neznámá / prázdná šablona = null; šablony mají unikátní id a platný uzel', () => {
    expect(findTemplate('nic')).toBeNull()
    expect(findTemplate('')).toBeNull()
    expect(new Set(CASE_TEMPLATES.map((x) => x.id)).size).toBe(CASE_TEMPLATES.length)
    for (const x of CASE_TEMPLATES) if (x.suggestedNode) expect(NODES).toContain(x.suggestedNode)
  })
})

describe('pomocníci', () => {
  test('každý uzel má popisek', () => {
    expect(Object.keys(NODE_LABELS).sort()).toEqual([...NODES].sort())
  })
  test('nextStepPosition', () => {
    expect(nextStepPosition([])).toBe(1)
    expect(nextStepPosition([{ position: 3 }, { position: 1 }])).toBe(4)
  })
  test('parseOptions: čárky i řádky, bez prázdných a duplicit', () => {
    expect(parseOptions(' ano , ne,\nano,, možná ')).toEqual(['ano', 'ne', 'možná'])
    expect(parseOptions('')).toEqual([])
  })
  test('výchozí vlastník = vlastník uzlu, explicitní vyhrává', () => {
    expect(defaultLeadOwner('vedeni', null, rows)).toBe(VIKTOR)
    expect(defaultLeadOwner('vedeni', ANNA, rows)).toBe(ANNA)
    expect(defaultLeadOwner('vedeni', null, [])).toBeNull()
  })
  test('actorName', () => {
    const names = new Map([[VIKTOR, 'Viktor']])
    expect(actorName(actorOf(VIKTOR), names)).toBe('Viktor')
    expect(actorName(actorOf(ANNA), names)).toBe('neznámý uživatel')
    expect(actorName('system:job', names)).toBe('systém (job)')
    expect(actorName(null, names)).toBe('—')
  })
  test('pragueDayEnd: půlnoc následujícího pražského dne (léto i zima)', () => {
    expect(pragueDayEnd('2026-09-30').toISOString()).toBe('2026-09-30T22:00:00.000Z')
    expect(pragueDayEnd('2026-12-01').toISOString()).toBe('2026-12-01T23:00:00.000Z')
    // přechod na zimní čas 25. 10. 2026
    expect(pragueDayEnd('2026-10-24').toISOString()).toBe('2026-10-24T22:00:00.000Z')
    expect(pragueDayEnd('2026-10-25').toISOString()).toBe('2026-10-25T23:00:00.000Z')
  })
})

describe('filtr seznamu', () => {
  test('výchozí = aktivní, všechny uzly', () => {
    expect(parseCaseFilter({})).toEqual({ node: null, status: 'active' })
  })
  test('platné hodnoty projdou, neplatné spadnou na výchozí', () => {
    expect(parseCaseFilter({ node: 'vedeni', status: 'done' })).toEqual({ node: 'vedeni', status: 'done' })
    expect(parseCaseFilter({ node: 'x', status: 'drop table' })).toEqual({ node: null, status: 'active' })
    expect(parseCaseFilter({ node: ['obchod', 'x'], status: 'all' })).toEqual({ node: 'obchod', status: 'all' })
  })
  test('statusesForFilter', () => {
    expect(statusesForFilter('all')).toBeNull()
    expect(statusesForFilter('active')).toEqual(['open', 'in_progress', 'waiting'])
    expect(statusesForFilter('waiting')).toEqual(['waiting'])
  })
})

describe('viewerCanDecide (tlačítka v inboxu)', () => {
  const req = (over: Partial<{ requested_by: string; requested_level: string; case_node: string | null }> = {}) => ({
    requested_by: actorOf(ANNA), requested_level: 'L2', case_node: 'vedeni', ...over,
  })
  test('vlastník uzlu schvaluje cizí požadavek do L4', () => {
    expect(viewerCanDecide(req({ requested_level: 'L4' }), { id: VIKTOR, teamRole: 'obchodnik' }, rows)).toBe(true)
  })
  test('vlastní požadavek nikdy (čtyři oči)', () => {
    expect(viewerCanDecide(req({ requested_by: actorOf(VIKTOR) }), { id: VIKTOR, teamRole: 'vedeni' }, rows)).toBe(false)
  })
  test('zástupce uzlu do L2, výš ne', () => {
    const anna = { id: ANNA, teamRole: 'obchodnik' }
    const other = '33333333-3333-4333-8333-333333333333'
    expect(viewerCanDecide(req({ requested_by: actorOf(other), case_node: 'obchod' }), anna, rows)).toBe(true)
    expect(viewerCanDecide(req({ requested_by: actorOf(other), case_node: 'obchod', requested_level: 'L3' }), anna, rows)).toBe(false)
  })
  test('řadový člen L2 neschvaluje; vedení ano i bez uzlu', () => {
    const other = '33333333-3333-4333-8333-333333333333'
    expect(viewerCanDecide(req(), { id: other, teamRole: 'obchodnik' }, rows)).toBe(false)
    expect(viewerCanDecide(req({ case_node: null }), { id: other, teamRole: 'vedeni' }, rows)).toBe(true)
  })
  test('bez přihlášení nebo s neplatnou úrovní nic', () => {
    expect(viewerCanDecide(req(), null, rows)).toBe(false)
    expect(viewerCanDecide(req({ requested_level: 'L9' }), { id: VIKTOR, teamRole: 'vedeni' }, rows)).toBe(false)
  })
})

describe('loopRpcErrorMessage: chyby RPC 0039 česky', () => {
  test.each([
    [{ code: '42501', message: 'Vlastní požadavek nelze schválit ani zamítnout' }, 'Vlastní požadavek nemůžete schválit ani zamítnout (čtyři oči).'],
    [{ code: '22023', message: 'Požadavek už není čekající (stav approved)' }, 'O požadavku už bylo rozhodnuto.'],
    [{ code: '22023', message: 'Požadavek vypršel' }, 'Požadavek vypršel, už o něm nejde rozhodnout.'],
    [{ code: 'P0002', message: 'Požadavek 12 neexistuje' }, 'Požadavek nebyl nalezen.'],
    [{ code: '22023', message: 'Rozhodnutí 3 neexistuje nebo už je rozhodnuté' }, 'Rozhodnutí už je rozhodnuté nebo neexistuje.'],
    [{ code: '42501', message: 'Vyžadováno dvoufázové ověření (AAL2)' }, 'Vyžadováno dvoufázové ověření.'],
    [{ code: '42501', message: 'Jen pro člena týmu' }, 'Tuto akci může provést jen přihlášený člen týmu.'],
    [{ code: '42501', message: 'role member nesmí schvalovat L2' }, APPROVAL_FORBIDDEN_MESSAGE],
    [{ code: 'PGRST202', message: 'Could not find the function public.decide_approval' }, MIGRATION_PENDING_MESSAGE],
    [{ code: '23514', message: 'violates check constraint' }, 'Neplatná hodnota.'],
    [{ code: '22023', message: 'Neplatná úroveň (povoleno L1–L4)' }, 'Neplatná úroveň schválení (povolené jsou L1–L4).'],
    [{ code: '22023', message: 'Chybí rozhodnutí (approve true/false)' }, 'Vyberte, zda požadavek schvalujete, nebo zamítáte.'],
  ])('%j', (err, expected) => {
    expect(loopRpcErrorMessage(err)).toBe(expected)
  })
  test('42501 u rozhodnutí má vlastní větu', () => {
    expect(loopRpcErrorMessage({ code: '42501', message: 'x' }, 'decision')).toBe(DECISION_FORBIDDEN_MESSAGE)
  })
  test('neznámá chyba = null (volající zaloguje a vrátí obecnou)', () => {
    expect(loopRpcErrorMessage({ code: 'XX000', message: 'boom' })).toBeNull()
    expect(loopRpcErrorMessage(null)).toBeNull()
  })
})
