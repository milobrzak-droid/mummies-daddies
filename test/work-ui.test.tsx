import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildGantt, WorkGantt, type GanttMilestone } from '@/components/WorkGantt'
import { gaugeArcs, gaugeLabel } from '@/components/WorkGateGauge'
import { DeliveryGates } from '@/components/DeliveryGates'
import { HandoffChecklistCard } from '@/components/HandoffChecklistCard'
import { EngagementImpactSummary, pickHeadline, signedPct } from '@/components/EngagementImpactSummary'
import { buildTeamRows, EngagementTeamSummary } from '@/components/EngagementTeamSummary'
import { EngagementTabs, parseEngagementTab } from '@/components/EngagementTabs'
import { WorkCaseBoard, NodeTiles } from '@/components/WorkCaseBoard'
import { levelWords, WorkKpiStrip, WorkSegNav } from '@/components/WorkUi'
import type { MetricObservation } from '@/domain/delivery/queries/impact'
import type { AllocationListRow } from '@/components/AllocationTable'
import type { WorkCaseListItem } from '@/core/loopQueries'

// Prezentace sekce Práce a Dodávky: Gantt milníků, půlkruh bran, dopad,
// tým, předání a nástěnka případů. Jen skutečná data, klidné prázdné stavy.

const ms = (p: Partial<GanttMilestone> & { id: number }): GanttMilestone => ({
  title: `Milník ${p.id}`, status: 'v_praci', due_on: null, accepted_at: null, created_at: '2026-09-01T08:00:00Z', ...p,
})

describe('buildGantt', () => {
  test('bez milníků nevrací nic (stránka ukáže prázdný stav)', () => {
    expect(buildGantt([], { startedOn: null, dueOn: null, today: '2026-09-29' })).toBeNull()
  })

  test('osa začíná v pondělí, dnešek je uvnitř a řádky drží pořadí', () => {
    const g = buildGantt(
      [
        ms({ id: 1, status: 'prijato', due_on: '2026-09-11', accepted_at: '2026-09-10T10:00:00Z' }),
        ms({ id: 2, due_on: '2026-10-23', created_at: '2026-09-14T08:00:00Z' }),
      ],
      { startedOn: '2026-09-01', dueOn: '2026-11-06', today: '2026-09-29' },
    )!
    expect(g.rows.map((r) => r.id)).toEqual([1, 2])
    expect(g.rows[0].done).toBe(true)
    expect(g.rows[1].done).toBe(false)
    expect(g.ticks[0].label).toBe('31. 8.') // pondělí před 1. 9.
    expect(g.todayPct).not.toBeNull()
    expect(g.todayPct!).toBeGreaterThan(0)
    expect(g.todayPct!).toBeLessThan(100)
    // přijatý milník končí přijetím, ne termínem
    expect(g.rows[0].endDay).toBeLessThanOrEqual(g.rows[0].dueDay!)
  })

  test('milník bez termínu se táhne do dneška a nemá kosočtverec', () => {
    const g = buildGantt([ms({ id: 1 })], { startedOn: null, dueOn: null, today: '2026-09-29' })!
    expect(g.rows[0].dueDay).toBeNull()
    expect(g.rows[0].endDay).toBeGreaterThan(g.rows[0].startDay)
  })

  test('dlouhá dodávka přepne týdny na měsíce', () => {
    const g = buildGantt([ms({ id: 1, due_on: '2027-06-30' })], { startedOn: '2026-09-01', dueOn: '2027-06-30', today: '2026-09-29' })!
    expect(g.ticks.length).toBeLessThan(16)
    expect(g.ticks.some((t) => t.label.includes('led'))).toBe(true)
  })

  test('vykreslení: aria-label se souhrnem a stav slovy pro čtečku', () => {
    const g = buildGantt([ms({ id: 1, status: 'ceka_na_schvaleni', due_on: '2026-10-05' })], { startedOn: null, dueOn: null, today: '2026-09-29' })!
    const html = renderToStaticMarkup(<WorkGantt model={g} todayDay={29} />)
    expect(html).toContain('aria-label="Časová osa milníků: 1 milník, 0 přijato."')
    expect(html).toContain('Čeká na schválení')
    expect(html).toContain('termín 2026-10-05')
  })
})

describe('půlkruh bran', () => {
  test('šest oblouků, první začíná vlevo a poslední končí vpravo', () => {
    const arcs = gaugeArcs([true, true, false, null, true, null])
    expect(arcs).toHaveLength(6)
    expect(arcs[0].d.startsWith('M26 108')).toBe(true)
    expect(arcs[5].d.endsWith('194 108')).toBe(true)
  })

  test('popis pro čtečku rozlišuje nesplněno a nehodnoceno', () => {
    expect(gaugeLabel([true, false, null, null], 'bran')).toBe('1 z 4 bran splněno, 1 nesplněno, 2 nehodnoceno')
  })

  test('DeliveryGates: text stavu je i bez barvy', () => {
    const html = renderToStaticMarkup(
      <DeliveryGates
        engagement={{ gate_outputs_captured: true, gate_safety_followed: false }}
        milestones={[{ status: 'ceka_na_schvaleni', accepted_at: null }]}
      />,
    )
    expect(html).toContain('Neprošlo — 1× nesplněno')
    expect(html).toContain('splněno')
    expect(html).toContain('nesplněno')
    expect(html).toContain('nehodnoceno')
    expect(html).toContain('role="img"')
    expect(html).toContain('čeká na akceptaci klienta')
  })
})

describe('dopad na klienta', () => {
  const obs = (p: Partial<MetricObservation> & { id: number }): MetricObservation => ({
    engagement_id: 1, metric_key: null, metric: 'Doba zpracování objednávky', unit: 'min', baseline: 18, actual: 4,
    observed_on: '2026-09-28', evidence_id: null, note: null, created_at: '2026-09-28T08:00:00Z', evidence_link: null, ...p,
  })

  test('titulní je nejnovější měření s oběma hodnotami', () => {
    const h = pickHeadline([obs({ id: 1, observed_on: '2026-09-01', baseline: 10, actual: 5 }), obs({ id: 2, baseline: 18, actual: 4 }), obs({ id: 3, observed_on: '2026-10-01', baseline: 7, actual: null })])!
    expect(h.obs.id).toBe(2)
    expect(h.changePct).toBeCloseTo(-77.8, 1)
    expect(h.beforePct).toBe(100)
    expect(h.afterPct).toBeCloseTo(22.2, 1)
    expect(signedPct(-77.8)).toBe('−77,8 %')
  })

  test('bez měření klidný prázdný stav, žádná vymyšlená čísla', () => {
    const html = renderToStaticMarkup(<EngagementImpactSummary observations={[]} state="ok" tabHref="/x" />)
    expect(html).toContain('Zatím žádné měření')
    expect(html).not.toContain('big-num')
  })

  test('s měřením: před, po a změna', () => {
    const html = renderToStaticMarkup(<EngagementImpactSummary observations={[obs({ id: 1 })]} state="ok" tabHref="/x" />)
    expect(html).toContain('Výchozí stav (před)')
    expect(html).toContain('Výsledek (po)')
    expect(html).toContain('−77,8 %')
    expect(html).not.toMatch(/baseline/i)
  })

  test('před migrací hláška', () => {
    const html = renderToStaticMarkup(<EngagementImpactSummary observations={[]} state="missing_migration" />)
    expect(html).toContain('Tahle část se připravuje.')
    expect(html).not.toContain('0061')
  })
})

describe('tým a vytížení', () => {
  const A = 'a', B = 'b'
  const alloc = (p: Partial<AllocationListRow> & { id: number; member_id: string }) =>
    ({ engagement_id: 3, work_case_id: null, hours_per_week: 10, starts_on: '2026-09-01', ends_on: null, substitute_id: null, note: null, created_at: '', memberName: p.member_id, substituteName: null, target: { label: 'x', href: null }, status: 'active', canEnd: true, ...p }) as AllocationListRow

  test('vlastník a zástupce jsou vidět i bez alokace, hodiny jen z běžících', () => {
    const rows = buildTeamRows({
      allocations: [alloc({ id: 1, member_id: A, hours_per_week: 14 }), alloc({ id: 2, member_id: A, hours_per_week: 6, status: 'planned' })],
      people: [{ id: A, full_name: 'Alena' }, { id: B, full_name: 'Bořek' }],
      capacity: new Map([[A, 40]]),
      ownerId: A,
      deputyId: B,
    })
    expect(rows.map((r) => r.name)).toEqual(['Alena', 'Bořek'])
    expect(rows[0]).toMatchObject({ hours: 14, plannedHours: 6, pct: 35, role: 'Vlastník dodávky' })
    expect(rows[1]).toMatchObject({ hours: 0, pct: null })
  })

  test('vykreslení: přetížení nese text, prázdný stav klidný', () => {
    const rows = buildTeamRows({
      allocations: [alloc({ id: 1, member_id: A, hours_per_week: 45 })],
      people: [{ id: A, full_name: 'Alena' }],
      capacity: new Map([[A, 40]]),
      ownerId: null,
      deputyId: null,
    })
    expect(renderToStaticMarkup(<EngagementTeamSummary rows={rows} state="ok" />)).toContain('přetížení')
    expect(renderToStaticMarkup(<EngagementTeamSummary rows={[]} state="ok" />)).toContain('Na dodávce zatím nikdo není')
  })
})

describe('předání, záložky a případy', () => {
  test('předání: hotové zeleně, chybějící bíle, počet nahoře', () => {
    const html = renderToStaticMarkup(
      <HandoffChecklistCard
        showHints
        items={[
          { key: 'goal', label: 'Cíl', ok: true, hint: 'Vyplň v balíčku níže.' },
          { key: 'scope', label: 'Rozsah', ok: false, hint: 'Vyplň v balíčku níže.' },
        ]}
      />,
    )
    expect(html).toContain('card-deep')
    expect(html).toContain('1 z 2 hotovo')
    expect(html).toContain('in-pill g')
    expect(html).toContain('in-pill w')
    expect(html).toContain('Chybí 1 z 2 položek balíčku.')
  })

  test('záložky dodávky: neznámá hodnota → přehled, aktivní nese aria-current', () => {
    expect(parseEngagementTab('nesmysl')).toBe('prehled')
    expect(parseEngagementTab(['tym'])).toBe('tym')
    const html = renderToStaticMarkup(<EngagementTabs basePath="/cockpit/clients/1/engagements/3/edit" current="dopad" />)
    expect(html).toContain('href="/cockpit/clients/1/engagements/3/edit?zalozka=dopad"')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  const c = (p: Partial<WorkCaseListItem> & { id: number }): WorkCaseListItem => ({
    title: `Případ ${p.id}`, node: 'obchod', status: 'open', updated_at: '2026-09-28T08:00:00Z',
    lead_owner_name: 'Viktor Kovář', account_id: 1, account_name: 'ALFATECH', steps_total: 4, steps_done: 1, ...p,
  })

  test('nástěnka: sloupce podle filtru, postup kroků, bez slova uzel', () => {
    const html = renderToStaticMarkup(<WorkCaseBoard cases={[c({ id: 1 }), c({ id: 2, status: 'waiting', steps_total: 0, steps_done: 0 })]} statusFilter="active" />)
    expect(html).toContain('Otevřený')
    expect(html).toContain('Čeká')
    expect(html).not.toMatch(/Hotovo<span class="sr-only">/)
    expect(html).toContain('Otevřený<span class="sr-only">, 1</span></h2>')
    expect(html).toContain('Kroky 1/4')
    expect(html).toContain('25 %')
    expect(html).toContain('/cockpit/pripady/1')
    expect(html.toLowerCase()).not.toContain('uzel')
  })

  test('nástěnka bez případů: klidný prázdný stav s cestou dál', () => {
    const html = renderToStaticMarkup(<WorkCaseBoard cases={[]} statusFilter="active" />)
    expect(html).toContain('Žádné případy pro tento výběr')
    expect(html).toContain('href="/cockpit/pripady/nova"')
    expect(html).toContain('Založit případ')
  })

  test('dlaždice oblastí jsou odkazy s počty', () => {
    const html = renderToStaticMarkup(<NodeTiles cases={[c({ id: 1 }), c({ id: 2 })]} hrefFor={(n) => (n ? `/cockpit/pripady?node=${n}` : '/cockpit/pripady')} activeNode={null} />)
    expect(html).toContain('Všechny oblasti')
    expect(html).toContain('href="/cockpit/pripady?node=obchod"')
  })

  test('stupně pravomoci se v textech neukazují jako L1–L4', () => {
    expect(levelWords('L2')).toBe('připraví ke schválení')
    expect(levelWords('L9')).toBe('L9')
  })
})

describe('klidná čísla a segmenty (vlna 2)', () => {
  test('KPI v jedné kartě: popisek, číslo, bez barevných ploch', () => {
    const html = renderToStaticMarkup(
      <WorkKpiStrip label="Aktivity za posledních 7 dní" items={[
        { key: 'call', label: 'Telefonáty', value: 3, hint: 'za 7 dní' },
        { key: 'email', label: 'E-maily', value: 0, hint: 'za 7 dní' },
        { key: 'meeting', label: 'Schůzky', value: 1 },
        { key: 'note', label: 'Poznámky', value: 2 },
      ]} />,
    )
    expect(html).toContain('aria-label="Aktivity za posledních 7 dní"')
    expect(html.match(/<dt/g)).toHaveLength(4)
    expect(html).toContain('>Telefonáty</dt>')
    expect(html).not.toMatch(/tile-(peach|sky|lav|sun)/)
  })

  test('segment: aktivní položka nese aria-current, počet je u položky', () => {
    const html = renderToStaticMarkup(
      <WorkSegNav label="Čí úkoly" items={[{ href: '/a', label: 'Moje', active: true, count: 2 }, { href: '/b', label: 'Tým', active: false }]} />,
    )
    expect(html).toContain('aria-label="Čí úkoly"')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('Moje<span class="seg-count tabular-nums">2</span>')
  })
})
