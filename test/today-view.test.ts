import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildTodaySources, daysAgoLabel, digestSourceTone, greeting, isoWeek, lastMonths, moneyParts,
  openStageSlices, plural, postponeTargets, sourcesWithProblem, splitFocus, todayEyebrow, webhookNote,
} from '@/domain/crm/today'
import type { ConnectorState } from '@/core/connectorState'
import { disabledMailWebhookHealth } from '@/domain/crm/mailWebhook'

const ROOT = join(__dirname, '..')
const NOW = new Date('2026-09-29T08:00:00.000Z') // úterý 29. 9. 2026, 10:00 v Praze

const state = (over: Partial<ConnectorState> = {}): ConnectorState => ({
  connector: 'outlook:inbox', cursor: null, last_success_at: '2026-09-29T05:00:00.000Z',
  last_error: null, last_error_at: null, consecutive_errors: 0, updated_at: '2026-09-29T05:00:00.000Z', ...over,
})

describe('Stav zdrojů dat: co je problém', () => {
  const row = (tone: 'done' | 'wait' | 'fail' | 'info', status: string) => ({ key: status, label: 'x', via: 'y', tone, status, detail: '' })
  test('chyba a zastaralá data ano, „Zatím nic“ a vypnuto ne', () => {
    const rows = [row('fail', 'Chyba'), row('wait', 'Zastaralé'), row('wait', 'Dávno bez zápisu'), row('wait', 'Zatím nic'), row('info', 'Vypnuto'), row('done', 'Přicházejí')]
    expect(sourcesWithProblem(rows).map((r) => r.status)).toEqual(['Chyba', 'Zastaralé', 'Dávno bez zápisu'])
  })
})

describe('posun termínu po termínu', () => {
  test('zítra a příští pondělí', () => {
    expect(postponeTargets('2026-09-29')).toEqual({ tomorrow: '2026-09-30', nextWeek: '2026-10-05' }) // úterý
    expect(postponeTargets('2026-09-28')).toEqual({ tomorrow: '2026-09-29', nextWeek: '2026-10-05' }) // pondělí
    expect(postponeTargets('2026-10-03')).toEqual({ tomorrow: '2026-10-04', nextWeek: '2026-10-05' }) // sobota
  })
  test('v neděli je pondělí zítra, příští týden je o týden dál', () => {
    expect(postponeTargets('2026-10-04')).toEqual({ tomorrow: '2026-10-05', nextWeek: '2026-10-12' })
  })
  test('přes konec měsíce a roku', () => {
    expect(postponeTargets('2026-12-31')).toEqual({ tomorrow: '2027-01-01', nextWeek: '2027-01-04' })
  })
})

describe('datum a pozdrav', () => {
  test('číslo týdne podle ISO 8601', () => {
    expect(isoWeek('2026-09-29')).toBe(40)
    expect(isoWeek('2026-01-01')).toBe(1)
    expect(isoWeek('2027-01-01')).toBe(53) // pátek 1. 1. 2027 patří do 53. týdne 2026
  })
  test('eyebrow: den v týdnu, datum, týden', () => {
    expect(todayEyebrow(NOW)).toBe('ÚTERÝ 29. 9. 2026 · TÝDEN 40')
  })
  test('pozdrav podle pražské hodiny', () => {
    expect(greeting(new Date('2026-09-29T05:00:00Z'))).toBe('Dobré ráno') // 7:00
    expect(greeting(NOW)).toBe('Dobrý den')
    expect(greeting(new Date('2026-09-29T19:30:00Z'))).toBe('Dobrý večer')
  })
  test('před N dny', () => {
    expect(daysAgoLabel(0)).toBe('dnes')
    expect(daysAgoLabel(1)).toBe('před 1 dnem')
    expect(daysAgoLabel(4)).toBe('před 4 dny')
  })
})

describe('čísla a skloňování', () => {
  test('moneyParts: hodnota a jednotka zvlášť', () => {
    expect(moneyParts(2_670_000)).toEqual({ value: '2,67', unit: 'mil. Kč' })
    expect(moneyParts(621_000)).toEqual({ value: '621', unit: 'tis. Kč' })
    expect(moneyParts(0)).toEqual({ value: '0', unit: 'Kč' })
    expect(moneyParts(999_999)).toEqual({ value: '1,00', unit: 'mil. Kč' })
  })
  test('plural', () => {
    expect([1, 2, 5].map((n) => plural(n, 'obchod', 'obchody', 'obchodů'))).toEqual(['obchod', 'obchody', 'obchodů'])
  })
  test('lastMonths přes přelom roku', () => {
    expect(lastMonths('2026-02-10', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })
})

describe('obchody podle fáze', () => {
  test('vrací všechny otevřené fáze, i prázdné, a počítá jen otevřené obchody', () => {
    const slices = openStageSlices([
      { stage: 'diagnostika', amount_one_time: 100 },
      { stage: 'diagnostika', amount_one_time: '50' },
      { stage: 'rozhodovani', amount_one_time: 10 },
      { stage: 'vyhráno', amount_one_time: 999 },
    ])
    expect(slices.map((s) => s.key)).toEqual(['kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani'])
    expect(slices.map((s) => s.count)).toEqual([0, 2, 0, 1])
    expect(slices[1].value).toBe(150)
  })
  test('splitFocus odděluje obchody po termínu', () => {
    const mk = (reason: string) => ({ reason }) as never
    const { todo, overdue } = splitFocus([mk('overdue'), mk('missing_next_step'), mk('stale')])
    expect(todo).toHaveLength(2)
    expect(overdue).toHaveLength(1)
  })
})

describe('stav zdrojů', () => {
  const mail = (over: Partial<Parameters<typeof buildTodaySources>[0]['mail']> = {}) =>
    ({ syncEnabled: true, inbox: state(), sent: state(), webhook: disabledMailWebhookHealth(), ...over })

  test('čerstvé zdroje běží, zápisy bez záznamu čekají', () => {
    const rows = buildTodaySources({ mail: mail(), calendar: state({ connector: 'graph_calendar' }), lastMeetingNoteAt: null, now: NOW })
    expect(rows.map((r) => [r.key, r.tone])).toEqual([['inbox', 'done'], ['sent', 'done'], ['calendar', 'done'], ['notes', 'wait']])
    expect(rows.find((r) => r.key === 'notes')?.detail).toBe('zatím žádné zápisy')
  })
  test('chyba a zastaralé se hlásí, vypnutá pošta je jen informace', () => {
    const rows = buildTodaySources({
      mail: mail({ inbox: state({ consecutive_errors: 2, last_error: 'x' }), sent: state({ last_success_at: '2026-09-20T05:00:00.000Z' }) }),
      calendar: null, lastMeetingNoteAt: '2026-09-28T10:00:00.000Z', now: NOW,
    })
    expect(rows.find((r) => r.key === 'inbox')?.tone).toBe('fail')
    expect(rows.find((r) => r.key === 'sent')?.tone).toBe('wait')
    expect(rows.find((r) => r.key === 'calendar')?.tone).toBe('wait')
    expect(rows.find((r) => r.key === 'notes')?.tone).toBe('done')
    const off = buildTodaySources({ mail: mail({ syncEnabled: false }), calendar: null, lastMeetingNoteAt: null, now: NOW })
    expect(off[0]).toMatchObject({ tone: 'info', status: 'Vypnuto' })
  })
  test('webhook: vypnutý mlčí, platný má datum, rozbitý je problém', () => {
    expect(webhookNote(disabledMailWebhookHealth())).toBeNull()
    const ok = { ...disabledMailWebhookHealth(), enabled: true, expiresAt: '2026-10-06T10:00:00.000Z' }
    expect(webhookNote(ok)).toEqual({ text: 'Okamžité upozornění na poštu platí do 6. 10.', problem: false })
    expect(webhookNote({ ...ok, broken: true, problems: ['vypršelo'] })?.problem).toBe(true)
  })
  test('řádky týdenního přehledu → tón pilulky', () => {
    expect(digestSourceTone('Outlook: 1. 9. 2026 — zastaralé')).toBe('wait')
    expect(digestSourceTone('Odesílání přehledu (graph_send): nikdy — chyba: x')).toBe('fail')
    expect(digestSourceTone('Outlook pošta: vypnuto')).toBe('info')
    expect(digestSourceTone('Outlook: 29. 9. 2026')).toBe('done')
  })
})

describe('obrazovka Dnes a Týden: záložky a role', () => {
  const dnes = readFileSync(join(ROOT, 'app/cockpit/page.tsx'), 'utf8')
  const tyden = readFileSync(join(ROOT, 'app/cockpit/prehled-tydne/page.tsx'), 'utf8')

  test('obě stránky mají záložky Dnes / Týden', () => {
    expect(dnes).toMatch(/<SectionTabs tabs=\{TODAY_TABS\}/)
    expect(tyden).toMatch(/<SectionTabs tabs=\{TODAY_TABS\}/)
  })
  test('záložky a obchodní čísla jsou až za větví pro role bez obchodu', () => {
    const branch = dnes.indexOf('if (!canSeeByznys)')
    expect(dnes.indexOf('<SectionTabs')).toBeGreaterThan(branch)
    expect(dnes.indexOf('buildSalesDashboard(')).toBeGreaterThan(branch)
    expect(dnes.indexOf('getDecisionInbox(')).toBeGreaterThan(branch)
  })
  test('hlavička Dnes: žádné vlastní pole hledání (nahrazuje ho ⌘K), jedna hlavní akce', () => {
    expect(dnes).not.toMatch(/role="search"|Hledat klienta/)
    const header = dnes.slice(dnes.indexOf('const header = ('), dnes.indexOf('const calendarCard'))
    expect(header.match(/buttonClass\('primary'/g)).toHaveLength(1)
    expect(dnes).not.toMatch(/btn-coral/)
    // Paleta má viditelný spouštěč na počítači i na mobilu (postranní panel / spodní lišta).
    const sidebar = readFileSync(join(ROOT, 'components/Sidebar.tsx'), 'utf8')
    expect(sidebar.match(/palette\.open\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(sidebar).toContain('Hledat…')
  })
  test('týdenní přehled zůstává jen pro obchodní role', () => {
    expect(tyden).toMatch(/if \(!await canCurrentUserSeeSales\(\)\) redirect\('\/cockpit'\)/)
  })
  test('v textech pro uživatele není pipeline ani digest', () => {
    for (const src of [dnes, tyden]) {
      const strings = [...src.matchAll(/>([^<>{}]*[A-Za-zÀ-ž][^<>{}]*)</g)].map((m) => m[1]).join(' ')
      expect(strings).not.toMatch(/pipeline|digest|engagement|MRR/i)
    }
  })
})
