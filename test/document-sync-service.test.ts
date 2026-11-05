import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { createDocumentSyncDb, runDocumentSyncLive } from '@/domain/delivery/documentSyncService'
import { createSupabaseFake, hasOp, opArgs, type QueryResult } from './helpers/supabaseFake'

// Adaptér denní kontroly dokumentů nad Supabase (0094): filtry dotazů, tichá
// odezva bez migrace, dedupe nálezu, úkol od systému a stav konektoru.

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ createAuditedAdminClient: vi.fn() }))
vi.mock('@/core/connectorState', () => ({ recordConnectorError: vi.fn(), recordConnectorSuccess: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const ok = (data: unknown = null): QueryResult => ({ data, error: null })
const fail = (code: string, message = 'x'): QueryResult => ({ data: null, error: { code, message } })

describe('createDocumentSyncDb', () => {
  test('loadWatched čte jen schválené/odeslané/přijaté s identitou, nejstarší kontrola první', async () => {
    const read = createSupabaseFake({
      resolve: () => ok([
        { id: 1, engagement_id: 2, title: 'A', url: 'https://mummiesdaddies.sharepoint.com/a', status: 'approved', drive_id: 'b!d', item_id: 'I1', e_tag: 'e', c_tag: 'c', version_label: '2.0', last_modified_at: null, last_modified_by: null, source_state: 'ok', approved_version_id: 7 },
        // Koncept nebo bez identity by se sem nedostal, a kdyby ano (chyba filtru), adaptér ho zahodí.
        { id: 2, engagement_id: 2, title: 'B', url: 'u', status: 'draft', drive_id: 'b!d', item_id: 'I2', source_state: null, approved_version_id: null },
        { id: 3, engagement_id: 2, title: 'C', url: 'u', status: 'sent', drive_id: null, item_id: null, source_state: null, approved_version_id: null },
      ]),
    })
    const docs = await createDocumentSyncDb(read.client as never, createSupabaseFake().client as never).loadWatched(60)
    expect(docs.map((d) => d.id)).toEqual([1])
    expect(docs[0].current).toMatchObject({ eTag: 'e', cTag: 'c', versionLabel: '2.0' })
    const c = read.calls[0]
    expect(c.table).toBe('engagement_document')
    expect(c.ops).toEqual(expect.arrayContaining([
      { method: 'not', args: ['item_id', 'is', null] },
      { method: 'neq', args: ['status', 'draft'] },
      { method: 'order', args: ['source_checked_at', { ascending: true, nullsFirst: true }] },
      { method: 'limit', args: [60] },
    ]))
  })

  test('bez migrace 0094 (chybí tabulka nebo sloupec) není co kontrolovat a nic nespadne', async () => {
    for (const e of [fail('42P01', 'relation "engagement_document" does not exist'), fail('42703', 'column engagement_document.item_id does not exist')]) {
      const db = createDocumentSyncDb(createSupabaseFake({ resolve: () => e }).client as never, createSupabaseFake().client as never)
      expect(await db.loadWatched(10)).toEqual([])
    }
  })

  test('jiná chyba čtení = výjimka jen s kódem (bez hlášky z DB)', async () => {
    const db = createDocumentSyncDb(createSupabaseFake({ resolve: () => fail('500', 'hodnota z řádku') }).client as never, createSupabaseFake().client as never)
    await expect(db.loadWatched(10)).rejects.toThrow('engagement_document: 500')
    await expect(db.loadWatched(10)).rejects.not.toThrow(/hodnota/)
  })

  test('openFinding: unikátní klíč = už je otevřený (null), jinak id; jiná chyba vyhodí', async () => {
    const dup = createDocumentSyncDb(createSupabaseFake().client as never, createSupabaseFake({ resolve: () => fail('23505') }).client as never)
    expect(await dup.openFinding(1, 'changed', 7)).toBeNull()
    const created = createSupabaseFake({ resolve: () => ok({ id: 55 }) })
    const good = createDocumentSyncDb(createSupabaseFake().client as never, created.client as never)
    expect(await good.openFinding(1, 'missing', null)).toBe(55)
    expect(opArgs(created.calls[0], 'insert')![0]).toEqual({ document_id: 1, kind: 'missing', version_id: null })
    const broken = createDocumentSyncDb(createSupabaseFake().client as never, createSupabaseFake({ resolve: () => fail('500') }).client as never)
    await expect(broken.openFinding(1, 'changed', null)).rejects.toThrow('engagement_document_finding.insert: 500')
  })

  test('createTask: úkol od systému (created_by NULL, stav todo) navázaný na dodávku', async () => {
    const write = createSupabaseFake({ resolve: () => ok({ id: 9 }) })
    const db = createDocumentSyncDb(createSupabaseFake().client as never, write.client as never)
    const id = await db.createTask({ title: 'T', description: 'D', priority: 'high', assignee_id: 'u1', account_id: 5, engagement_id: 10, due_on: '2026-09-30' })
    expect(id).toBe(9)
    expect(opArgs(write.calls[0], 'insert')![0]).toEqual({
      title: 'T', description: 'D', priority: 'high', assignee_id: 'u1', account_id: 5, engagement_id: 10, due_on: '2026-09-30', status: 'todo', created_by: null,
    })
  })

  test('closeFindings zavře jen otevřené nálezy daných druhů jako „auto"', async () => {
    const write = createSupabaseFake()
    await createDocumentSyncDb(createSupabaseFake().client as never, write.client as never).closeFindings(4, ['changed', 'missing'])
    const c = write.calls[0]
    expect(opArgs(c, 'update')![0]).toMatchObject({ resolution: 'auto' })
    expect(c.ops).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['document_id', 4] },
      { method: 'in', args: ['kind', ['changed', 'missing']] },
      { method: 'is', args: ['resolved_at', null] },
    ]))
  })

  test('loadOwner: vlastník dodávky, jinak zástupce, jinak autor dokumentu; bez 0061 jen klient', async () => {
    const mk = (eng: QueryResult, doc: QueryResult = ok({ created_by: 'autor' })) =>
      createDocumentSyncDb(createSupabaseFake({ resolve: (c) => (c.table === 'engagement' ? eng : doc) }).client as never, createSupabaseFake().client as never)
    expect(await mk(ok({ account_id: 5, owner_id: 'vlastnik', deputy_id: 'zastupce' })).loadOwner(10, 1)).toEqual({ assigneeId: 'vlastnik', accountId: 5 })
    expect(await mk(ok({ account_id: 5, owner_id: null, deputy_id: 'zastupce' })).loadOwner(10, 1)).toEqual({ assigneeId: 'zastupce', accountId: 5 })
    expect(await mk(ok({ account_id: 5, owner_id: null, deputy_id: null })).loadOwner(10, 1)).toEqual({ assigneeId: 'autor', accountId: 5 })
    // Bez sloupců z 0061: první dotaz selže na chybějícím sloupci, druhý vrátí jen klienta.
    let n = 0
    const legacy = createDocumentSyncDb(createSupabaseFake({
      resolve: (c) => (c.table === 'engagement' ? (++n === 1 ? fail('42703', 'column engagement.owner_id does not exist') : ok({ account_id: 5 })) : ok({ created_by: 'autor' })),
    }).client as never, createSupabaseFake().client as never)
    expect(await legacy.loadOwner(10, 1)).toEqual({ assigneeId: 'autor', accountId: 5 })
  })

  test('recordVersion zapisuje jako systém kontroly (reason sync)', async () => {
    const write = createSupabaseFake({ resolve: (c) => (hasOp(c, 'insert') ? ok({ id: 31 }) : ok([])) })
    const id = await createDocumentSyncDb(createSupabaseFake().client as never, write.client as never)
      .recordVersion(1, { eTag: 'e', cTag: 'c', versionLabel: '2.0', modifiedAt: null, modifiedBy: null })
    expect(id).toBe(31)
    const insert = write.calls.find((c) => hasOp(c, 'insert'))!
    expect(opArgs(insert, 'insert')![0]).toMatchObject({ document_id: 1, reason: 'sync', observed_by: 'system:sharepoint-doc-sync' })
  })
})

describe('runDocumentSyncLive', () => {
  const saved: Record<string, string | undefined> = {}
  const KEYS = ['SHAREPOINT_DOC_SYNC_MEMBER_ID', 'OUTLOOK_MAIL_SYNC_MEMBER_ID'] as const
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  })

  test('bez člena kontrola neví, čí přístup použít: věta pro stav konektoru, žádný dotaz do DB', async () => {
    const s = await runDocumentSyncLive()
    expect(s.state).toBe('no_token')
    expect(s.accessError).toMatch(/SHAREPOINT_DOC_SYNC_MEMBER_ID/)
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  test('bez sledovaných dokumentů: stav konektoru se nemění, zápisy jdou jako system:sharepoint-doc-sync', async () => {
    process.env.OUTLOOK_MAIL_SYNC_MEMBER_ID = 'member-1'
    vi.mocked(createAdminClient).mockReturnValue(createSupabaseFake({ resolve: () => ok([]) }).client as never)
    vi.mocked(createAuditedAdminClient).mockReturnValue(createSupabaseFake().client as never)
    const s = await runDocumentSyncLive()
    expect(s.state).toBe('nothing_to_check')
    expect(createAuditedAdminClient).toHaveBeenCalledWith({ actor: { type: 'system', id: 'sharepoint-doc-sync' }, infoState: 'source_fact' })
    expect(recordConnectorError).not.toHaveBeenCalled()
    expect(recordConnectorSuccess).not.toHaveBeenCalled()
  })

  test('člen bez Files.Read.All: chyba do stavu konektoru graph_files, nic se nečte', async () => {
    process.env.SHAREPOINT_DOC_SYNC_MEMBER_ID = 'member-2'
    const docRow = { id: 1, engagement_id: 2, title: 'A', url: 'https://mummiesdaddies.sharepoint.com/a', status: 'approved', drive_id: 'b!d', item_id: 'I1', source_state: 'ok', approved_version_id: null }
    vi.mocked(createAdminClient).mockReturnValue(createSupabaseFake({
      resolve: (c) => (c.table === 'calendar_token' ? ok({ granted_scopes: 'Calendars.ReadWrite Mail.Read' }) : ok([docRow])),
    }).client as never)
    vi.mocked(createAuditedAdminClient).mockReturnValue(createSupabaseFake().client as never)
    const s = await runDocumentSyncLive()
    expect(s.state).toBe('missing_scope')
    expect(recordConnectorError).toHaveBeenCalledWith('graph_files', expect.stringMatching(/Files\.Read\.All/))
  })
})
