// Limity importu z PDF: denní strop volání modelu na člověka (počítadlo
// v audit_event), strop čekání na Anthropic ≤ 50 s, velikost souborů = strop
// těla Server Action (4 MB) a maxDuration 60 u obou stránek importu; počty
// v historii dávek po stránkách a úklid návrhů bez pevného stropu 2 000.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseFake, hasOp, opArgs } from './helpers/supabaseFake'
import {
  AI_PDF_ACTION, AI_PDF_DAILY_LIMIT_DEFAULT, AI_QUOTA_MESSAGES, aiPdfDailyLimitFromEnv, takeAiPdfQuota,
} from '@/domain/crm/aiQuota'
import { OFFER_PDF_TIMEOUT_MS, extractOfferFromPdf } from '@/connectors/anthropic'
import { OFFER_UPLOAD_MAX_BYTES, SERVER_ACTION_BODY_LIMIT_BYTES } from '@/domain/crm/offerProposal'
import { BULK_MAX_PDF_BYTES } from '@/domain/crm/bulkImport'
import { purgeStaleOfferProposals, type PurgeDb } from '@/domain/crm/bulkImportService'
import { listImportBatches } from '@/domain/crm/queries/importBatches'
import { createClient } from '@/lib/supabase/server'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const USER = '11111111-1111-4111-8111-111111111111'

describe('konfigurace a stránky', () => {
  it('strop velikosti PDF = bodySizeLimit Server Actions (next.config.ts)', () => {
    const cfg = readFileSync('next.config.ts', 'utf8')
    const mb = Number(/bodySizeLimit:\s*["'](\d+)mb["']/.exec(cfg)?.[1])
    expect(mb * 1024 * 1024).toBe(SERVER_ACTION_BODY_LIMIT_BYTES)
    expect(OFFER_UPLOAD_MAX_BYTES).toBeLessThan(SERVER_ACTION_BODY_LIMIT_BYTES)
    expect(BULK_MAX_PDF_BYTES).toBeLessThanOrEqual(SERVER_ACTION_BODY_LIMIT_BYTES)
  })

  it('obě stránky importu mají maxDuration 60 a volání modelu se do něj vejde', () => {
    for (const page of ['app/cockpit/nabidka/import/page.tsx', 'app/cockpit/import/zakazky/page.tsx']) {
      expect(readFileSync(page, 'utf8')).toMatch(/export const maxDuration = 60\b/)
    }
    expect(OFFER_PDF_TIMEOUT_MS).toBeLessThanOrEqual(50_000)
  })
})

describe('extractOfferFromPdf — strop čekání', () => {
  beforeEach(() => vi.stubEnv('ANTHROPIC_API_KEY', 'test-key'))
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([[undefined, 50_000], [120_000, 50_000], [20_000, 20_000]])('timeoutMs %s → %s ms', async (asked, used) => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'tool_use', name: 'extract_offer', input: { account_name: 'X', currency: 'CZK' } }],
    }), { status: 200 })))
    await extractOfferFromPdf('JVBERi0=', asked === undefined ? {} : { timeoutMs: asked })
    expect(spy).toHaveBeenCalledWith(used)
  })
})

describe('takeAiPdfQuota — denní strop na člověka', () => {
  const NOW = new Date('2026-10-01T10:00:00Z')

  it('AI_PDF_DAILY_LIMIT: celé číslo 1–1000, jinak výchozí', () => {
    expect(aiPdfDailyLimitFromEnv({})).toBe(AI_PDF_DAILY_LIMIT_DEFAULT)
    expect(aiPdfDailyLimitFromEnv({ AI_PDF_DAILY_LIMIT: '12' })).toBe(12)
    for (const bad of ['0', '-3', '1001', 'deset', '1.5']) expect(aiPdfDailyLimitFromEnv({ AI_PDF_DAILY_LIMIT: bad })).toBe(AI_PDF_DAILY_LIMIT_DEFAULT)
  })

  it('pod limitem: spočítá dnešní (pražský den) volání člověka a zapíše nové PŘED voláním modelu', async () => {
    const fake = createSupabaseFake({ resolve: (c) => (hasOp(c, 'insert') ? { data: null, error: null } : { data: null, error: null, count: 3 }) })
    const res = await takeAiPdfQuota(fake.client as never, USER, 'offer_import', { now: NOW, limit: 5 })
    expect(res).toEqual({ ok: true, used: 4, limit: 5 })
    const [count, insert] = fake.calls
    expect(count.table).toBe('audit_event')
    expect(count.ops).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['entity_table', 'team_member'] },
      { method: 'eq', args: ['entity_ref', USER] },
      { method: 'eq', args: ['action', AI_PDF_ACTION] },
      // Půlnoc v Praze (letní čas, UTC+2) = 22:00 UTC předchozího dne.
      { method: 'gte', args: ['occurred_at', '2026-09-30T22:00:00.000Z'] },
    ]))
    expect(opArgs(insert, 'insert')?.[0]).toEqual({
      actor_type: 'user', actor_id: USER, action: AI_PDF_ACTION, entity_table: 'team_member', entity_id: null,
      entity_ref: USER, before: null, after: { source: 'offer_import' },
    })
  })

  it('na limitu: odmítne a nic nezapíše', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null, count: 5 }) })
    expect(await takeAiPdfQuota(fake.client as never, USER, 'bulk_import', { now: NOW, limit: 5 }))
      .toEqual({ ok: false, error: AI_QUOTA_MESSAGES.exhausted(5) })
    expect(fake.calls.filter((c) => hasOp(c, 'insert'))).toHaveLength(0)
  })

  it('počítadlo nejde přečíst nebo zapsat → fail closed (model se nevolá)', async () => {
    const readFail = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42501', message: 'x' } }) })
    expect(await takeAiPdfQuota(readFail.client as never, USER, 'offer_import', { now: NOW, limit: 5 }))
      .toEqual({ ok: false, error: AI_QUOTA_MESSAGES.unavailable })
    const writeFail = createSupabaseFake({
      resolve: (c) => (hasOp(c, 'insert') ? { data: null, error: { code: '23514', message: 'x' } } : { data: null, error: null, count: 0 }),
    })
    expect(await takeAiPdfQuota(writeFail.client as never, USER, 'offer_import', { now: NOW, limit: 5 }))
      .toEqual({ ok: false, error: AI_QUOTA_MESSAGES.unavailable })
  })
})

describe('historie dávek: počty po stránkách, ne .limit(20000)', () => {
  it('položky se čtou po 1000, dokud stránka není kratší', async () => {
    const items = Array.from({ length: 2300 }, (_, i) => ({ batch_id: 1, entity_table: i < 2000 ? 'deal' : 'account', entity_id: i }))
    const fake = createSupabaseFake({
      resolve: (c) => {
        if (c.table === 'import_batch') return { data: [{ id: 1, kind: 'csv', label: null, status: 'open', created_by: null, created_at: '2026-10-01', reverted_at: null }], error: null }
        if (c.table === 'import_batch_item') {
          const [from, to] = opArgs(c, 'range') as [number, number]
          return { data: items.slice(from, to + 1), error: null }
        }
        return { data: [], error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const res = await listImportBatches()
    expect(res).toMatchObject({ state: 'ok', batches: [{ id: 1, deals: 2000, accountsCreated: 300 }] })
    const ranges = fake.calls.filter((c) => c.table === 'import_batch_item').map((c) => opArgs(c, 'range'))
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
    expect(fake.calls.some((c) => c.table === 'import_batch_item' && hasOp(c, 'limit'))).toBe(false)
  })
})

describe('úklid nepotvrzených návrhů bez stropu 2 000 souborů', () => {
  const NOW = new Date('2026-09-30T12:00:00Z')
  const uuid = (i: number) => `${i.toString(16).padStart(8, '0')}-6a1c-4c53-8d6f-1f1f1f1f1f1f`

  it('za 3 000 starými potvrzenými PDF najde i starý nepotvrzený návrh; u čerstvých přestane číst', async () => {
    // Od nejstarších: 3 000 potvrzených (obchod na ně odkazuje), pak 1 starý
    // nepotvrzený, pak čerstvé.
    const files = [
      ...Array.from({ length: 3000 }, (_, i) => ({ name: `${uuid(i)}.pdf`, created_at: '2026-08-01T00:00:00Z' })),
      { name: `${uuid(9999)}.pdf`, created_at: '2026-09-01T00:00:00Z' },
      { name: `${uuid(9999)}.navrh.json`, created_at: '2026-09-01T00:00:00Z' },
      ...Array.from({ length: 500 }, (_, i) => ({ name: `${uuid(20000 + i)}.pdf`, created_at: '2026-09-29T00:00:00Z' })),
    ]
    const listed: number[] = []
    const removed: string[][] = []
    const db = {
      from: () => ({
        select: () => ({
          in: async (_c: string, paths: string[]) => ({
            data: paths.filter((p) => !p.includes(uuid(9999))).map((p) => ({ source_pdf_path: p })), error: null,
          }),
        }),
      }),
      storage: {
        from: () => ({
          list: vi.fn(async (_p: string, o: { limit: number; offset: number }) => {
            listed.push(o.offset)
            return { data: files.slice(o.offset, o.offset + o.limit), error: null }
          }),
          remove: vi.fn(async (paths: string[]) => { removed.push(paths); return { error: null } }),
        }),
      },
    } as unknown as PurgeDb
    expect(await purgeStaleOfferProposals(db, NOW)).toBe(2)
    expect(removed).toEqual([[`offers/${uuid(9999)}.pdf`, `offers/${uuid(9999)}.navrh.json`]])
    // Přečetlo se přes hranici 2 000 a skončilo na prvním čerstvém souboru.
    expect(Math.max(...listed)).toBe(3000)
  })

  it('dlouhý výpis omezí čas, ne počet souborů', async () => {
    let t = 0
    const db = {
      from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
      storage: {
        from: () => ({
          list: vi.fn(async () => {
            t += 5_000
            return { data: Array.from({ length: 200 }, () => ({ name: 'cizi.txt', created_at: '2026-01-01T00:00:00Z' })), error: null }
          }),
          remove: vi.fn(),
        }),
      },
    } as unknown as PurgeDb
    expect(await purgeStaleOfferProposals(db, NOW, () => t)).toBe(0)
    expect(t).toBe(15_000)
  })
})
