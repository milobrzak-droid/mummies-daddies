// Konfigurace firmy (jediná instance CompanyConfig): tvar, hodnoty, které
// mají kopie v SQL a v jiných vrstvách, a čisté core/.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import type { CompanyConfig } from '@/core/tenant'
import { MODULE_KEYS, isModuleOn } from '@/core/modules'
import { priceMapProblems } from '@/core/standardOffer'
import { NODES } from '@/core/workCase'
import { CASE_TEMPLATES, NODE_LABELS } from '@/core/workCaseFlow'
import { DEAL_STAGES, DELIVERY_TEAMS, PHASES, PILLARS, REVENUE_LINES, isPillar } from '@/lib/domain'
import { revenueLine as revenueLineSchema, categoryForLine } from '@/lib/validation/schemas'
import { PRAGUE_TZ } from '@/lib/pragueDate'
import { PRAGUE_TZ as WORKER_TZ } from '@/worker/pragueTime'
import { OUR_DOMAIN } from '@/domain/crm/mailMatch'
import { DEFAULT_DIGEST_SENDER, DIGEST_RECIPIENT_DOMAIN } from '@/domain/crm/digestDelivery'
import { SHAREPOINT_URL_RE } from '@/domain/delivery/documents'

const sorted = (xs: Iterable<string>) => [...xs].sort()
const cfg: CompanyConfig = COMPANY

describe('tvar CompanyConfig', () => {
  test('identita a e-mail', () => {
    expect(cfg.id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(cfg.name.trim()).not.toBe('')
    expect(cfg.productName.trim()).not.toBe('')
    expect(cfg.emailDomain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
    expect(cfg.digestSender.endsWith(`@${cfg.emailDomain}`)).toBe(true)
  })

  test('časové pásmo je platné IANA pásmo', () => {
    expect(() => new Intl.DateTimeFormat('en', { timeZone: cfg.timeZone })).not.toThrow()
  })

  test('SharePoint hosty jsou jen DNS labely', () => {
    for (const h of cfg.sharepointHosts) expect(h).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
  })

  test('uzly: neprázdné, unikátní, každý má popisek, šablony míří na existující uzel', () => {
    expect(new Set(cfg.nodes).size).toBe(cfg.nodes.length)
    expect(sorted(Object.keys(cfg.nodeLabels))).toEqual(sorted(cfg.nodes))
    for (const t of cfg.caseTemplates) {
      if (t.suggestedNode) expect(cfg.nodes).toContain(t.suggestedNode)
      expect(t.steps.length).toBeGreaterThan(0)
    }
    expect(new Set(cfg.caseTemplates.map((t) => t.id)).size).toBe(cfg.caseTemplates.length)
  })

  test('schopnosti míří na existující uzel a mapa je bez chyb', () => {
    const c = cfg.capabilities
    for (const n of [c.mailToCase?.node, c.mailContent?.node, c.mailContent?.dealNode, c.autoIntake?.node,
      c.standardOffer?.escalationNode, c.inquiryAgent?.escalationNode, c.followUpCadence?.escalateNode,
      cfg.approvalActions?.sendOffer.node, cfg.followUpNode, ...(cfg.autoDelivery?.deputyNodes ?? [])]) {
      if (n) expect(cfg.nodes).toContain(n)
    }
    expect(priceMapProblems(c.standardOffer!.priceMap)).toEqual([])
  })

  test('pilíře: fáze a vyhrané fáze pro každý pilíř, vyhrané ⊆ fáze', () => {
    const keys = cfg.pillars.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(sorted(Object.keys(cfg.phases))).toEqual(sorted(keys))
    expect(sorted(Object.keys(cfg.wonPhases))).toEqual(sorted(keys))
    for (const k of keys) {
      const phaseKeys = cfg.phases[k].map((p) => p.key)
      for (const w of cfg.wonPhases[k]) expect(phaseKeys).toContain(w)
    }
  })

  test('follow-up cadence: šablony existují, důvod prohry je v číselníku', () => {
    const f = cfg.capabilities.followUpCadence!
    for (const s of f.steps) expect(Object.keys(f.templates)).toContain(s.template)
    expect(cfg.lostReasons!.map((r) => r.key)).toContain(f.lostReasonKey)
    expect(f.sendWindow.fromHour).toBeLessThan(f.sendWindow.toHour)
  })

  test('e-shop: unikátní klíče produktů, kladné ceny', () => {
    const keys = cfg.shop!.products.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of cfg.shop!.products) {
      expect(p.key).toMatch(/^[a-z][a-z0-9_]{0,39}$/)
      expect(p.priceCzk).toBeGreaterThan(0)
    }
  })
})

describe('Mummies and Daddies: jediná firma a její kopie hodnot', () => {
  test('firma a pošta', () => {
    expect(COMPANY.id).toBe('mummiesdaddies')
    expect(COMPANY.emailDomain).toBe('mummiesdaddies.com')
    expect(OUR_DOMAIN).toBe('mummiesdaddies.com')
    expect(DIGEST_RECIPIENT_DOMAIN).toBe('mummiesdaddies.com')
    expect(DEFAULT_DIGEST_SENDER).toBe(COMPANY.digestSender)
  })

  test('časové pásmo', () => {
    expect(COMPANY.timeZone).toBe('Europe/Prague')
    expect(PRAGUE_TZ).toBe('Europe/Prague')
    expect(WORKER_TZ).toBe('Europe/Prague')
  })

  test('SharePoint regex z hostů firmy', () => {
    expect(SHAREPOINT_URL_RE.source).toBe(/^https:\/\/(mummiesdaddies|mummiesdaddies-my)\.sharepoint\.com\//.source)
  })

  test('Loop Core uzly, popisky a šablony', () => {
    expect([...NODES]).toEqual(['obchod', 'eventy', 'vedeni'])
    expect(NODE_LABELS.obchod).toBe(COMPANY.nodeLabels.obchod)
    expect(CASE_TEMPLATES.map((t) => t.id)).toEqual(['nestandardni_nabidka', 'realizace_akce'])
  })

  test('pilíře, týmy a linky v lib/domain jsou ty z konfigurace', () => {
    expect(PILLARS).toBe(COMPANY.pillars)
    expect(PHASES).toBe(COMPANY.phases)
    expect(DELIVERY_TEAMS).toBe(COMPANY.deliveryTeams)
    expect(PILLARS.map((p) => p.key)).toEqual(['b2b_akce', 'b2c_oslavy', 'cheesecaky'])
    expect(isPillar('b2b_akce')).toBe(true)
    expect(isPillar('Firemní akce')).toBe(false)
    expect(REVENUE_LINES).toBe(COMPANY.revenueLines)
  })

  test('obchodní linky: zod enum a kategorie sedí s konfigurací', () => {
    expect([...revenueLineSchema.options]).toEqual(COMPANY.revenueLines.map((l) => l.key))
    for (const l of COMPANY.revenueLines) expect(categoryForLine[l.key as keyof typeof categoryForLine]).toBe(l.category)
  })

  test('popisky fází obchodu z konfigurace, klíče enumu beze změny', () => {
    expect(DEAL_STAGES.map((s) => s.key)).toEqual(['kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani', 'vyhráno', 'prohráno', 'odloženo'])
    for (const s of DEAL_STAGES) expect(s.label).toBe(COMPANY.dealStageLabels[s.key])
  })

  test('SQL kopie: pilíře, týmy a enum linek v migracích', () => {
    const m0010 = readFileSync('supabase/migrations/0010_project_pillars.sql', 'utf8')
    expect(m0010).toContain(`CHECK (pillar IN (${COMPANY.pillars.map((p) => `'${p.key}'`).join(', ')}))`)
    expect(m0010).toContain(`CHECK (delivery_team IN (${COMPANY.deliveryTeams.map((t) => `'${t.key}'`).join(', ')}))`)
    const m0001 = readFileSync('supabase/migrations/0001_base_schema.sql', 'utf8')
    const enumBody = /CREATE TYPE revenue_line AS ENUM \(([\s\S]*?)\);/.exec(m0001)![1]
    expect([...enumBody.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(COMPANY.revenueLines.map((l) => l.key))
  })

  test('moduly: každý klíč má hodnotu; vypnuté moduly firmy', () => {
    for (const k of MODULE_KEYS) expect(typeof COMPANY.modules[k]).toBe('boolean')
    expect(isModuleOn(COMPANY.modules, 'partners')).toBe(false)
    expect(isModuleOn(COMPANY.modules, 'web')).toBe(true)
    expect(isModuleOn(undefined, 'partners')).toBe(true)
  })

  test('mapa je ilustrační — samostatné odeslání zůstává technicky blokované', () => {
    expect(COMPANY.capabilities.standardOffer.priceMap.version.startsWith('ilustracni')).toBe(true)
  })
})

// Loop Core nesmí znát konkrétní firmu. Lint (eslint.config.mjs) hlídá
// řetězcové literály; tenhle sken hlídá celý text včetně komentářů.
describe('core/ neobsahuje hodnoty konkrétní firmy', () => {
  const FORBIDDEN = /mummiesdaddies|Mummies|Europe\/Prague|'obchod'|'eventy'/i

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? files(p) : [p]
    })
  }

  const coreFiles = files('core').filter((f) => /\.(ts|tsx)$/.test(f))

  test('core/ má soubory', () => expect(coreFiles.length).toBeGreaterThan(5))

  test.each(coreFiles)('%s', (f) => {
    const text = readFileSync(f, 'utf8')
    const hit = text.split('\n').findIndex((line) => FORBIDDEN.test(line))
    expect(hit === -1 ? null : `${f}:${hit + 1}: ${text.split('\n')[hit]}`).toBeNull()
  })

  test('core/ importuje konfiguraci jen přes @/config', () => {
    for (const f of coreFiles) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '@\/config\//)
  })
})
