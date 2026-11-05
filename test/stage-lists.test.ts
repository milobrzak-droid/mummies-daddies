import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEAL_STAGES, OPEN_DEAL_STAGE_KEYS } from '@/lib/domain'
import { OPEN_DEAL_STAGES, OPEN_DEAL_STAGE_FILTER, isOpenDeal } from '@/domain/crm/sales'

// Kapitola 5 (rozhodnutí 28. 9. 2026): otevřené fáze jsou čtyři nové;
// `odloženo` zůstává zavřená. Před změnou to byly lead, proběhlo_jednání,
// nabídka, vyjednávání — převod je v lib/dealStageLegacy.ts.
const OPEN = ['kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani']
const CLOSED = ['vyhráno', 'prohráno', 'odloženo']
const root = join(__dirname, '..')
const src = (p: string) => readFileSync(join(root, p), 'utf8')
// Natvrdo psaný seznam otevřených fází (nový i starý tvar).
const HARDCODED_OPEN = /\[\s*'(kvalifikace|lead)',\s*'(diagnostika|proběhlo_jednání)'/

describe('open deal stages — one source of truth', () => {
  it('derived open set is the four new open stages (odloženo stays closed)', () => {
    expect([...OPEN_DEAL_STAGE_KEYS]).toEqual(OPEN)
    expect([...OPEN_DEAL_STAGES]).toEqual(OPEN)
    expect(isOpenDeal('odloženo')).toBe(false)
  })

  it('DB filter = open stages + legacy values that map onto them', () => {
    expect(OPEN_DEAL_STAGE_FILTER.slice(0, 4)).toEqual(OPEN)
    expect(OPEN_DEAL_STAGE_FILTER).not.toContain('odloženo')
    expect(OPEN_DEAL_STAGE_FILTER).not.toContain('vyhráno')
    expect(OPEN_DEAL_STAGE_FILTER).toHaveLength(8)
  })

  it('every stage carries an open flag', () => {
    for (const s of DEAL_STAGES) expect(typeof s.open).toBe('boolean')
  })

  it.each([
    'domain/crm/actions/planMeeting.ts',
    'domain/crm/queries/followUps.ts',
    'domain/crm/queries/outreach.ts',
    'domain/crm/digestDelivery.ts',
  ])('%s uses OPEN_DEAL_STAGE_FILTER and no hardcoded list', (file) => {
    const code = src(file)
    expect(code).toContain('OPEN_DEAL_STAGE_FILTER')
    expect(code).not.toMatch(HARDCODED_OPEN)
  })
})

describe('pipeline/clients pages — derived stage sets', () => {
  it('pipeline page has no hardcoded closed list and derives it from DEAL_STAGES', () => {
    // Filtry tabule žijí od P9 v domain/crm/pipelineFilter.ts (sdílí je stránka i export).
    const page = src('app/cockpit/pipeline/page.tsx')
    expect(page).not.toMatch(/'vyhráno',\s*'prohráno'/)
    expect(page).toContain("from '@/domain/crm/pipelineFilter'")
    const code = src('domain/crm/pipelineFilter.ts')
    expect(code).not.toMatch(/'vyhráno',\s*'prohráno'/)
    expect(code).toContain('DEAL_STAGES.filter((s) => !s.open)')
  })

  it('derived closed set and "all" set', () => {
    const closed = DEAL_STAGES.filter((s) => !s.open).map((s) => s.key)
    expect(closed).toEqual(CLOSED)
    expect([...OPEN_DEAL_STAGES, ...closed]).toEqual([...OPEN, ...CLOSED])
    expect(['open', 'all', ...closed]).toEqual(['open', 'all', 'vyhráno', 'prohráno', 'odloženo'])
  })

  it('clients pages use OPEN_DEAL_STAGES and no hardcoded open list', () => {
    for (const f of ['app/cockpit/clients/page.tsx', 'app/cockpit/clients/[id]/page.tsx']) {
      expect(src(f)).not.toMatch(HARDCODED_OPEN)
      expect(src(f)).not.toMatch(/'vyhráno',\s*'prohráno'/)
    }
    expect(src('app/cockpit/clients/page.tsx')).toContain('OPEN_DEAL_STAGES.includes(deal.stage)')
  })
})
