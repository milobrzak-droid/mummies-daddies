import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getEngagementDocuments } from '@/domain/delivery/queries/documents'
import { getMilestoneAcceptedVersions } from '@/domain/delivery/queries/milestones'
import { createSupabaseFake, hasOp, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Čtení dokumentů dodávky (0094): sloupce podle migrace, výchozí hodnoty bez
// ní, připíchnutá verze, otevřené nálezy a „změnil se od schválení".

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const ok = (data: unknown): QueryResult => ({ data, error: null })
const base = { engagement_id: 2, milestone_id: null, url: 'https://mummiesdaddies.sharepoint.com/a', kind: 'vystup', created_by: null, created_at: '2026-09-20T10:00:00Z' }
const row = (over: Record<string, unknown> = {}) => ({
  ...base, id: 1, title: 'Nabídka', doc_type: 'nabidka', status: 'sent', status_changed_at: '2026-09-25T09:00:00Z', status_changed_by: 'u1',
  approved_at: '2026-09-24T09:00:00Z', approved_by: 'u1', approved_version_id: 70, drive_id: 'b!d', item_id: 'I1', e_tag: '"e2"', c_tag: 'c2',
  version_label: '4.0', last_modified_at: '2026-09-29T10:00:00Z', last_modified_by: 'Petr', source_state: 'ok', source_checked_at: '2026-09-30T04:00:00Z', ...over,
})
const approvedV = { id: 70, version_label: '3.0', modified_at: '2026-09-20T10:00:00Z', modified_by: 'Jana', e_tag: '"e1"', c_tag: 'c1' }

function setup(handlers: { docs: (c: QueryCall, n: number) => QueryResult; versions?: QueryResult; findings?: QueryResult }) {
  let docReads = 0
  const fake = createSupabaseFake({
    resolve: (c) => {
      if (c.table === 'engagement_document') return handlers.docs(c, ++docReads)
      if (c.table === 'engagement_document_version') return handlers.versions ?? ok([approvedV])
      if (c.table === 'engagement_document_finding') return handlers.findings ?? ok([])
      return ok(null)
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

describe('getEngagementDocuments', () => {
  test('dokument s identitou, verzí a nálezem; změna od schválení se pozná z uložených cTag', async () => {
    setup({ docs: () => ok([row()]), findings: ok([{ document_id: 1, kind: 'changed' }]) })
    const r = await getEngagementDocuments(2)
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.documents[0]).toMatchObject({
      id: 1, doc_type: 'nabidka', status: 'sent', has_identity: true, version_label: '4.0', source_state: 'ok',
      approved_version: { version_label: '3.0', modified_by: 'Jana' }, changed_since_approval: true, findings: ['changed'],
    })
  })

  test('stejná verze jako schválená → beze změny; koncept nebo bez připíchnuté verze se nehodnotí', async () => {
    setup({ docs: () => ok([row({ c_tag: 'c1', e_tag: '"e1"' }), row({ id: 2, status: 'draft', approved_version_id: null }), row({ id: 3, approved_version_id: null })]) })
    const r = await getEngagementDocuments(2)
    if (r.state !== 'ok') throw new Error('očekávám ok')
    expect(r.documents.map((d) => d.changed_since_approval)).toEqual([false, false, false])
    expect(r.documents[2].approved_version).toBeNull()
  })

  test('migrace 0094 ještě neběžela: načtou se původní sloupce a dokument je „Jiné" / „Koncept"', async () => {
    const fake = setup({
      docs: (_c, n) => (n === 1
        ? { data: null, error: { code: '42703', message: 'column engagement_document.doc_type does not exist' } }
        : ok([{ id: 5, ...base, title: 'Starý' }])),
    })
    const r = await getEngagementDocuments(2)
    if (r.state !== 'ok') throw new Error('očekávám ok')
    expect(r.documents[0]).toMatchObject({ id: 5, doc_type: 'jine', status: 'draft', has_identity: false, source_state: null, changed_since_approval: false, findings: [], approved_version: null })
    expect(fake.calls.filter((c) => c.table === 'engagement_document')).toHaveLength(2)
  })

  test('chybějící tabulka dokumentů = čeká na migraci; jiná chyba = error', async () => {
    setup({ docs: () => ({ data: null, error: { code: '42P01', message: 'relation "engagement_document" does not exist' } }) })
    expect(await getEngagementDocuments(2)).toEqual({ state: 'missing_migration' })
    setup({ docs: () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) })
    expect(await getEngagementDocuments(2)).toEqual({ state: 'error', message: 'boom' })
  })

  test('chyba čtení verzí nebo nálezů dokumenty neshodí', async () => {
    setup({
      docs: () => ok([row()]),
      versions: { data: null, error: { code: 'XX000', message: 'x' } },
      findings: { data: null, error: { code: '42P01', message: 'relation does not exist' } },
    })
    const r = await getEngagementDocuments(2)
    if (r.state !== 'ok') throw new Error('očekávám ok')
    expect(r.documents[0]).toMatchObject({ approved_version: null, findings: [], changed_since_approval: false })
  })

  test('jen čtení, nálezy jen otevřené, verze jen připíchnuté', async () => {
    const fake = setup({ docs: () => ok([row()]) })
    await getEngagementDocuments(2)
    expect(fake.calls.some((c) => hasOp(c, 'insert') || hasOp(c, 'update') || hasOp(c, 'delete'))).toBe(false)
    const f = fake.calls.find((c) => c.table === 'engagement_document_finding')!
    expect(f.ops).toContainEqual({ method: 'is', args: ['resolved_at', null] })
    const v = fake.calls.find((c) => c.table === 'engagement_document_version')!
    expect(v.ops).toContainEqual({ method: 'in', args: ['id', [70]] })
  })
})

describe('getMilestoneAcceptedVersions', () => {
  function milestones(handler: (c: QueryCall) => QueryResult) {
    const fake = createSupabaseFake({ resolve: handler })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    return fake
  }

  test('milník → číslo přijaté verze; jen milníky s vazbou na verzi', async () => {
    const fake = milestones((c) => (c.table === 'engagement_milestone'
      ? ok([{ id: 5, acceptance_document_version_id: 70 }, { id: 6, acceptance_document_version_id: 71 }])
      : ok([{ id: 70, version_label: '3.0' }, { id: 71, version_label: null }])))
    expect(await getMilestoneAcceptedVersions(2)).toEqual({ 5: '3.0', 6: null })
    const q = fake.calls[0]
    expect(q.ops).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['engagement_id', 2] },
      { method: 'not', args: ['acceptance_document_version_id', 'is', null] },
    ]))
  })

  test('bez migrace 0094 (chybí sloupec), chyba nebo žádná vazba = prázdné, nic nespadne', async () => {
    milestones(() => ({ data: null, error: { code: '42703', message: 'column does not exist' } }))
    expect(await getMilestoneAcceptedVersions(2)).toEqual({})
    milestones(() => ok([]))
    expect(await getMilestoneAcceptedVersions(2)).toEqual({})
  })

  test('chyba čtení čísel verzí: milník vazbu má, číslo ne', async () => {
    milestones((c) => (c.table === 'engagement_milestone'
      ? ok([{ id: 5, acceptance_document_version_id: 70 }])
      : { data: null, error: { code: 'XX000', message: 'x' } }))
    expect(await getMilestoneAcceptedVersions(2)).toEqual({ 5: null })
  })
})
