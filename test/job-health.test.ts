// Denní kontrola plánovaných úloh (job_run): selhání a visící běhy se ukážou
// v Nastavení (dlaždice Stav úloh) a ve „Stavu zdrojů" přehledu e-mailem;
// čerstvý problém spustí i ranní souhrn. Bez DB — čisté funkce, falešný klient.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  assessJobHealth, jobHealthStatus, loadJobHealth, runJobHealthCheck, type JobRunRow,
} from '@/domain/crm/jobHealth'
import { buildDigest } from '@/domain/crm/digest'
import { JobHealthCard } from '@/components/JobHealthCard'
import { createSupabaseFake } from './helpers/supabaseFake'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const NOW = new Date('2026-10-01T06:00:00Z')
const h = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
let nextId = 1
const run = (job: string, status: JobRunRow['status'], hoursAgo: number, o: Partial<JobRunRow> = {}): JobRunRow => ({
  id: nextId++, job_name: job, status, started_at: h(hoursAgo),
  finished_at: status === 'running' ? null : h(hoursAgo - 0.01),
  locked_until: status === 'running' ? h(hoursAgo - 0.03) : null,
  error: status === 'failed' ? 'try_acquire_job_lock: timeout' : null,
  ...o,
})

describe('assessJobHealth', () => {
  it('poslední dokončený běh rozhoduje: selhal = problém, uspěl = vyřešeno', () => {
    const health = assessJobHealth([
      run('outlook-mail-sync', 'failed', 2),
      run('outlook-mail-sync', 'succeeded', 26),
      run('ares-enrich', 'failed', 30),
      run('ares-enrich', 'succeeded', 3),
      run('weekly-digest', 'skipped', 1),
    ], NOW)
    expect(health.problems).toEqual([
      { job: 'outlook-mail-sync', label: 'Sync pošty', kind: 'failed', at: h(2), error: 'try_acquire_job_lock: timeout' },
    ])
    expect(health.failuresInWindow).toBe(2)
    expect(health.jobsSeen).toBe(2)
    expect(health.recentProblem).toBe(true)
  })

  it('running s vypršelým zámkem = visí; s platným zámkem = běží, žádný problém', () => {
    const health = assessJobHealth([
      run('weekly-digest', 'running', 5),
      run('follow-up-watch', 'running', 0.001, { locked_until: new Date(NOW.getTime() + 60_000).toISOString() }),
    ], NOW)
    expect(health.problems).toEqual([{ job: 'weekly-digest', label: 'Přehled e-mailem', kind: 'stuck', at: h(5), error: null }])
  })

  it('mimo okno 7 dní se nepočítá; starý problém ranní souhrn nespouští', () => {
    expect(assessJobHealth([run('idoklad-sync', 'failed', 24 * 8)], NOW).problems).toEqual([])
    const old = assessJobHealth([run('idoklad-sync', 'failed', 48)], NOW)
    expect(old.problems).toHaveLength(1)
    expect(old.recentProblem).toBe(false)
    expect(jobHealthStatus(old).alert).toBe(false)
  })

  it('dlouhá chyba se ořízne; neznámá úloha má své jméno', () => {
    const health = assessJobHealth([run('nova-uloha', 'failed', 1, { error: 'x'.repeat(400) })], NOW)
    expect(health.problems[0].label).toBe('nova-uloha')
    expect(health.problems[0].error).toHaveLength(160)
  })
})

describe('řádek ve Stavu zdrojů (přehled)', () => {
  it('v pořádku — bez alertu; s dřívějším selháním to řekne', () => {
    expect(jobHealthStatus(assessJobHealth([run('ares-enrich', 'succeeded', 1)], NOW)))
      .toEqual({ line: 'Plánované úlohy: v pořádku', alert: false })
    expect(jobHealthStatus(assessJobHealth([run('ares-enrich', 'failed', 30), run('ares-enrich', 'succeeded', 2)], NOW)).line)
      .toBe('Plánované úlohy: v pořádku (za 7 dní 1× selhání, poslední běhy v pořádku)')
  })

  it('čerstvé selhání a visící běh → řádek s detailem a alert (spustí ranní souhrn)', () => {
    const health = assessJobHealth([run('outlook-mail-sync', 'failed', 2), run('weekly-digest', 'running', 3)], NOW)
    const s = jobHealthStatus(health)
    expect(s.alert).toBe(true)
    expect(s.line).toMatch(/^Plánované úlohy: Sync pošty selhal .* \(try_acquire_job_lock: timeout\); Přehled e-mailem visí od .* — detail v Nastavení$/)
  })

  it('buildDigest: řádek je poslední ve Stavu zdrojů a počítá se do sourceAlerts', () => {
    const health = assessJobHealth([run('outlook-mail-sync', 'failed', 2)], NOW)
    const base = {
      followUps: [], outreach: [], blockedDeals: [], lastMeetingNoteAt: null, outlookMailSyncEnabled: false, generatedAt: NOW,
      connectorStates: { graphCalendar: null, outlookMailInbox: null, outlookMailSent: null, graphSend: null },
    }
    const without = buildDigest(base)
    const withHealth = buildDigest({ ...base, jobHealth: health })
    expect(withHealth.sources.lines.at(-1)).toMatch(/^Plánované úlohy: Sync pošty selhal/)
    expect(withHealth.sourceAlerts).toBe(without.sourceAlerts + 1)
    expect(buildDigest({ ...base, jobHealth: null }).sources.lines).toEqual(without.sources.lines)
  })
})

describe('načtení a denní kontrola', () => {
  it('loadJobHealth čte jen okno bez přeskočených; chybějící tabulka = null', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [run('ares-enrich', 'failed', 1)], error: null }) })
    const health = await loadJobHealth(fake.client as never, NOW)
    expect(health?.problems).toHaveLength(1)
    const ops = fake.calls[0].ops.map((o) => o.method)
    expect(ops).toEqual(expect.arrayContaining(['select', 'gte', 'neq', 'order', 'limit']))
    const missing = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42P01', message: 'nope' } }) })
    expect(await loadJobHealth(missing.client as never, NOW)).toBeNull()
  })

  it('runJobHealthCheck: nejdřív uzavře visící běhy (0100), pak čte; bez 0100 jen čte, nikdy nevyhodí', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: [], error: null }),
      rpc: () => ({ data: 2, error: null }),
    })
    expect(await runJobHealthCheck(fake.client as never, NOW)).toMatchObject({ closed: 2, health: { problems: [] } })
    expect(fake.rpc).toHaveBeenCalledWith('close_stale_job_runs', { p_grace_seconds: 300 })
    const old = createSupabaseFake({
      resolve: () => ({ data: [], error: null }),
      rpc: () => ({ data: null, error: { code: 'PGRST202', message: 'chybí' } }),
    })
    expect(await runJobHealthCheck(old.client as never, NOW)).toMatchObject({ closed: null, health: { problems: [] } })
    const broken = { rpc: async () => { throw new Error('síť') }, from: () => { throw new Error('síť') } }
    expect(await runJobHealthCheck(broken as never, NOW)).toEqual({ closed: null, health: null })
  })
})

describe('JobHealthCard (Nastavení)', () => {
  it('v pořádku / problém / nenačteno', () => {
    const ok = renderToStaticMarkup(JobHealthCard({ health: assessJobHealth([run('ares-enrich', 'succeeded', 1)], NOW) }))
    expect(ok).toContain('Stav úloh')
    expect(ok).toContain('V pořádku')
    const bad = renderToStaticMarkup(JobHealthCard({ health: assessJobHealth([run('weekly-digest', 'running', 3)], NOW) }))
    expect(bad).toContain('Problém')
    expect(bad).toContain('Přehled e-mailem')
    expect(bad).toContain('visí od')
    expect(renderToStaticMarkup(JobHealthCard({ health: null }))).toContain('nepodařilo načíst')
  })
})
