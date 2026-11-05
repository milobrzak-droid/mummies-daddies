import { describe, expect, test, vi } from 'vitest'
import {
  DOC_SYNC_BATCH,
  MISSING_SCOPE_ERROR,
  SYSTEMIC_NO_ACCESS_ERROR,
  docSyncEnabledFromEnv,
  docSyncMemberFromEnv,
  runDocumentSync,
  type DocumentSyncDb,
  type DocumentSyncDeps,
  type SyncDoc,
  type SyncTask,
} from '@/domain/delivery/documentSync'
import type { SourceRead } from '@/domain/delivery/documentMetadata'
import type { FindingKind, VersionFacts } from '@/domain/delivery/documentWatch'
import type { DriveItemMetadata } from '@/connectors/graph'

// Denní kontrola dokumentů (0094): logika běhu nad falešnou DB a falešným
// Graphem. Hlídáme, že se nic nezakládá dokola, že chybějící právo není nález
// u každého souboru a že se nikde neobjeví obsah souboru.

const V1: VersionFacts = { eTag: '"e1"', cTag: 'c1', versionLabel: '1.0', modifiedAt: '2026-09-01T10:00:00Z', modifiedBy: 'Jana' }
const V2: VersionFacts = { eTag: '"e2"', cTag: 'c2', versionLabel: '2.0', modifiedAt: '2026-09-29T10:00:00Z', modifiedBy: 'Petr' }

const item = (webUrl = 'https://mummiesdaddies.sharepoint.com/sites/P/Nabidka.docx'): DriveItemMetadata => ({
  itemId: '01A', driveId: 'b!d', eTag: null, cTag: null, name: 'Nabídka.docx', webUrl, lastModifiedAt: null, lastModifiedBy: null, size: null, mimeType: null,
})
const okRead = (facts: VersionFacts, webUrl?: string): SourceRead => ({ outcome: { kind: 'ok', facts }, item: item(webUrl) })
const missingRead: SourceRead = { outcome: { kind: 'missing' }, item: null, raw: 'not_found' }
const noAccessRead: SourceRead = { outcome: { kind: 'no_access' }, item: null, raw: 'forbidden' }
const skipRead: SourceRead = { outcome: { kind: 'skip' }, item: null, raw: 'throttled' }

const doc = (over: Partial<SyncDoc> = {}): SyncDoc => ({
  id: 1, engagement_id: 10, title: 'Nabídka pro klienta', url: 'https://mummiesdaddies.sharepoint.com/sites/P/Nabidka.docx',
  status: 'approved', drive_id: 'b!d', item_id: '01A', current: V1, source_state: 'ok', approved_version_id: 100, ...over,
})

type Calls = {
  saved: { id: number; patch: Record<string, unknown> }[]
  versions: { id: number; facts: VersionFacts }[]
  opened: { docId: number; kind: FindingKind; versionId: number | null }[]
  tasks: SyncTask[]
  attached: { findingId: number; taskId: number }[]
  closed: { docId: number; kinds: readonly FindingKind[] }[]
}

function setup(opts: {
  docs: SyncDoc[]
  reads: Record<number, SourceRead>
  open?: Record<number, FindingKind[]>
  approved?: Record<number, VersionFacts>
  scopes?: string | null
  token?: { ok: true; accessToken: string } | { ok: false; error: string }
  owner?: { assigneeId: string | null; accountId: number | null }
  failSaveFor?: number
  clock?: () => number
}) {
  const calls: Calls = { saved: [], versions: [], opened: [], tasks: [], attached: [], closed: [] }
  const openNow = new Map<string, number>(Object.entries(opts.open ?? {}).flatMap(([id, kinds]) => kinds.map((k) => [`${id}:${k}`, 900] as const)))
  let seq = 0
  const db: DocumentSyncDb = {
    loadWatched: vi.fn(async () => opts.docs),
    loadVersions: vi.fn(async () => new Map(Object.entries(opts.approved ?? { 100: V1 }).map(([k, v]) => [Number(k), v]))),
    loadOpenFindings: vi.fn(async () => new Map(Object.entries(opts.open ?? {}).map(([k, v]) => [Number(k), v]))),
    loadOwner: vi.fn(async () => opts.owner ?? { assigneeId: 'owner-1', accountId: 5 }),
    async saveDocument(id, patch) {
      if (id === opts.failSaveFor) throw new Error('engagement_document.update: 500')
      calls.saved.push({ id, patch })
    },
    async recordVersion(id, facts) {
      calls.versions.push({ id, facts })
      return 700 + calls.versions.length
    },
    async openFinding(docId, kind, versionId) {
      if (openNow.has(`${docId}:${kind}`)) return null
      openNow.set(`${docId}:${kind}`, 1)
      calls.opened.push({ docId, kind, versionId })
      return 800 + ++seq
    },
    async createTask(t) {
      calls.tasks.push(t)
      return 300 + calls.tasks.length
    },
    async attachTask(findingId, taskId) {
      calls.attached.push({ findingId, taskId })
    },
    async closeFindings(docId, kinds) {
      calls.closed.push({ docId, kinds })
    },
  }
  const readMock = vi.fn(async (_t: string, _d: string, itemId: string) => opts.reads[Number(itemId.replace('item', ''))] ?? opts.reads[Number(itemId)] ?? skipRead)
  const tokenMock = vi.fn(async () => opts.token ?? { ok: true as const, accessToken: 'TOK' })
  const deps: DocumentSyncDeps = {
    db,
    grantedScopes: async () => (opts.scopes === undefined ? 'Calendars.ReadWrite Files.Read.All' : opts.scopes),
    token: tokenMock,
    read: async (t, d, i) => readMock(t, d, i),
    now: () => new Date(opts.clock ? opts.clock() : '2026-09-30T04:00:00Z'),
  }
  return { deps, calls, db, readMock, tokenMock }
}

const byItem = (docs: SyncDoc[], reads: SourceRead[]) => {
  // Čte se podle item_id → mapa pro readMock.
  docs.forEach((d, i) => { d.item_id = String(i + 1) })
  return Object.fromEntries(reads.map((r, i) => [i + 1, r]))
}

describe('přepínače a členové', () => {
  test('SHAREPOINT_DOC_SYNC_ENABLED: jen přesně „true"; výchozí vypnuto', () => {
    expect(docSyncEnabledFromEnv({})).toBe(false)
    for (const v of ['1', 'TRUE', 'yes', ' true', '']) expect(docSyncEnabledFromEnv({ SHAREPOINT_DOC_SYNC_ENABLED: v }), v).toBe(false)
    expect(docSyncEnabledFromEnv({ SHAREPOINT_DOC_SYNC_ENABLED: 'true' })).toBe(true)
  })

  test('člen kontroly: vlastní proměnná, jinak člen pošty', () => {
    expect(docSyncMemberFromEnv({})).toBeNull()
    expect(docSyncMemberFromEnv({ OUTLOOK_MAIL_SYNC_MEMBER_ID: 'viktor' })).toBe('viktor')
    expect(docSyncMemberFromEnv({ OUTLOOK_MAIL_SYNC_MEMBER_ID: 'viktor', SHAREPOINT_DOC_SYNC_MEMBER_ID: ' jana ' })).toBe('jana')
  })
})

describe('bez čeho se do Graphu nechodí', () => {
  test('žádné sledované dokumenty → nic, ani token', async () => {
    const t = setup({ docs: [], reads: {} })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ state: 'nothing_to_check', docs: 0 })
    expect(t.tokenMock).not.toHaveBeenCalled()
  })

  test('členovi chybí Files.Read.All → stav missing_scope, žádný token, žádný Graph, žádný nález', async () => {
    const t = setup({ docs: [doc()], reads: {}, scopes: 'Calendars.ReadWrite Mail.Read' })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ state: 'missing_scope', accessError: MISSING_SCOPE_ERROR, docs: 1, opened: 0 })
    expect(t.tokenMock).not.toHaveBeenCalled()
    expect(t.readMock).not.toHaveBeenCalled()
    expect(t.calls.saved).toEqual([])
  })

  test('udělená práva neznáme (null) → zkusí se; Files.Read.All se pozná bez ohledu na velikost písmen', async () => {
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V1) }, scopes: null })
    expect((await runDocumentSync(t.deps)).state).toBe('ok')
    const u = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V1) }, scopes: 'files.read.all' })
    expect((await runDocumentSync(u.deps)).state).toBe('ok')
  })

  test('token nejde obnovit → no_token s větou pro stav konektoru, nic se nečte', async () => {
    const t = setup({ docs: [doc()], reads: {}, token: { ok: false, error: 'Obnova tokenu selhala' } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ state: 'no_token', accessError: 'Obnova tokenu selhala' })
    expect(t.readMock).not.toHaveBeenCalled()
  })
})

describe('změna od schválení', () => {
  test('stejná verze jako schválená: uloží se stav zdroje, žádný nález ani úkol, žádná nová verze', async () => {
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V1) } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ state: 'ok', ok: 1, opened: 0, tasks: 0, closed: 0 })
    expect(t.calls.saved).toHaveLength(1)
    expect(t.calls.saved[0].patch).toMatchObject({ source_state: 'ok', source_checked_at: '2026-09-30T04:00:00.000Z', c_tag: 'c1' })
    expect(t.calls.versions).toEqual([])
    expect(t.calls.opened).toEqual([])
  })

  test('jiná verze: nová verze do historie, nález, úkol vlastníkovi (vysoká priorita, dnes), nález navázaný na úkol', async () => {
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V2) } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ ok: 1, opened: 1, tasks: 1 })
    expect(t.calls.versions).toEqual([{ id: 1, facts: V2 }])
    expect(t.calls.opened).toEqual([{ docId: 1, kind: 'changed', versionId: 701 }])
    expect(t.calls.saved[0].patch).toMatchObject({ c_tag: 'c2', version_label: '2.0', last_modified_by: 'Petr' })
    expect(t.calls.tasks).toHaveLength(1)
    expect(t.calls.tasks[0]).toMatchObject({
      title: 'Dokument se změnil od schválení: Nabídka pro klienta',
      priority: 'high', assignee_id: 'owner-1', account_id: 5, engagement_id: 10, due_on: '2026-09-30',
    })
    expect(t.calls.tasks[0].description).toMatch(/schválená verze 1\.0, nyní verze 2\.0/)
    expect(t.calls.attached).toEqual([{ findingId: 801, taskId: 301 }])
  })

  test('nález už je otevřený → nic se nezakládá dokola (ani úkol)', async () => {
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V2) }, open: { 1: ['changed'] } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ opened: 0, tasks: 0 })
    expect(t.calls.opened).toEqual([])
    expect(t.calls.tasks).toEqual([])
  })

  test('dvě po sobě jdoucí kontroly téhož stavu: nález i úkol jen jednou', async () => {
    // Druhá kontrola: dokument už nese verzi V2 z první, nález je otevřený.
    const first = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V2) } })
    await runDocumentSync(first.deps)
    const second = setup({ docs: [doc({ item_id: '1', current: V2 })], reads: { 1: okRead(V2) }, open: { 1: ['changed'] } })
    const s = await runDocumentSync(second.deps)
    expect(s).toMatchObject({ opened: 0, tasks: 0 })
    expect(second.calls.versions).toEqual([])
  })

  test('verze se vrátila na schválenou → nález se sám zavře', async () => {
    const t = setup({ docs: [doc({ item_id: '1', current: V2 })], reads: { 1: okRead(V1) }, open: { 1: ['changed'] } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ opened: 0, closed: 1 })
    expect(t.calls.closed).toEqual([{ docId: 1, kinds: ['changed'] }])
  })

  test('schváleno bez známé verze (žádný základ): změna se nehlásí, jen se ukládá stav', async () => {
    const t = setup({ docs: [doc({ item_id: '1', approved_version_id: null })], reads: { 1: okRead(V2) } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ ok: 1, opened: 0 })
  })

  test('sledují se i odeslané a přijaté dokumenty', async () => {
    const docs = [doc({ id: 1, item_id: '1', status: 'sent' }), doc({ id: 2, item_id: '2', status: 'accepted' })]
    const t = setup({ docs, reads: { 1: okRead(V2), 2: okRead(V2) } })
    const s = await runDocumentSync(t.deps)
    expect(s.opened).toBe(2)
    expect(t.calls.tasks[0].description).toMatch(/dokument je odesláno/)
    expect(t.calls.tasks[1].description).toMatch(/dokument je přijato klientem/)
  })

  test('přesunutý soubor: odkaz se srovná podle identity, jen když míří do firemního SharePointu', async () => {
    const moved = 'https://mummiesdaddies.sharepoint.com/sites/Jiny/Nabidka.docx'
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V1, moved) } })
    await runDocumentSync(t.deps)
    expect(t.calls.saved[0].patch.url).toBe(moved)

    const foreign = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V1, 'https://contoso.sharepoint.com/x.docx') } })
    await runDocumentSync(foreign.deps)
    expect(foreign.calls.saved[0].patch).not.toHaveProperty('url')
  })
})

describe('zmizel soubor a chybějící přístup', () => {
  test('404: nález „missing" + úkol; stav zdroje missing; verze se nepřepisuje', async () => {
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: missingRead } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ missing: 1, opened: 1, tasks: 1 })
    expect(t.calls.saved[0].patch).toEqual({ source_state: 'missing', source_checked_at: '2026-09-30T04:00:00.000Z' })
    expect(t.calls.opened).toEqual([{ docId: 1, kind: 'missing', versionId: null }])
    expect(t.calls.tasks[0]).toMatchObject({ title: 'Dokument zmizel ze SharePointu: Nabídka pro klienta', priority: 'high' })
  })

  test('zmizel a nález už je otevřený → ticho; soubor je zpátky → nález se zavře', async () => {
    const again = setup({ docs: [doc({ item_id: '1', source_state: 'missing' })], reads: { 1: missingRead }, open: { 1: ['missing'] } })
    expect((await runDocumentSync(again.deps)).opened).toBe(0)

    const back = setup({ docs: [doc({ item_id: '1', source_state: 'missing' })], reads: { 1: okRead(V1) }, open: { 1: ['missing'] } })
    const s = await runDocumentSync(back.deps)
    expect(s.closed).toBe(1)
    expect(back.calls.closed).toEqual([{ docId: 1, kinds: ['missing'] }])
    expect(back.calls.saved[0].patch).toMatchObject({ source_state: 'ok' })
  })

  test('403 u jednoho dokumentu (jiné se čtou) → nález „no_access" s běžnou prioritou', async () => {
    const docs = [doc({ id: 1 }), doc({ id: 2 })]
    const reads = byItem(docs, [noAccessRead, okRead(V1)])
    const t = setup({ docs, reads })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ noAccess: 1, ok: 1, opened: 1, systemicNoAccess: false })
    expect(t.calls.opened).toEqual([{ docId: 1, kind: 'no_access', versionId: null }])
    expect(t.calls.tasks[0]).toMatchObject({ priority: 'normal', title: 'Nemáme přístup k dokumentu: Nabídka pro klienta' })
    expect(t.calls.tasks[0].description).toMatch(/Files\.Read\.All/)
  })

  test('403 u všech přečtených (aspoň dvou) = chybí právo, ne nález u každého souboru', async () => {
    const docs = [doc({ id: 1 }), doc({ id: 2 }), doc({ id: 3 })]
    const reads = byItem(docs, [noAccessRead, noAccessRead, skipRead])
    const t = setup({ docs, reads })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ systemicNoAccess: true, noAccess: 2, skipped: 1, opened: 0, tasks: 0, accessError: SYSTEMIC_NO_ACCESS_ERROR })
    expect(t.calls.saved).toEqual([])
    expect(t.calls.opened).toEqual([])
  })

  test('nezjistitelné odpovědi (429, chyba) nic nemění a nezakládají nález', async () => {
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: skipRead } })
    const s = await runDocumentSync(t.deps)
    expect(s).toMatchObject({ skipped: 1, ok: 0, opened: 0 })
    expect(t.calls.saved).toEqual([])
  })
})

describe('odolnost', () => {
  test('chyba zápisu u jednoho dokumentu neshodí ostatní', async () => {
    const docs = [doc({ id: 1 }), doc({ id: 2 })]
    const reads = byItem(docs, [okRead(V2), okRead(V2)])
    const t = setup({ docs, reads, failSaveFor: 1 })
    const s = await runDocumentSync(t.deps)
    expect(s.errors).toBe(1)
    expect(t.calls.opened.map((o) => o.docId)).toEqual([2])
  })

  test('rozpočet: co se nestihne, se odloží na příští běh', async () => {
    let now = Date.parse('2026-09-30T04:00:00Z')
    const docs = [doc({ id: 1 }), doc({ id: 2 }), doc({ id: 3 })]
    const reads = byItem(docs, [okRead(V1), okRead(V1), okRead(V1)])
    const t = setup({ docs, reads, clock: () => now })
    t.readMock.mockImplementation(async (_t, _d, itemId) => {
      now += 6_000
      return reads[Number(itemId)]
    })
    const s = await runDocumentSync(t.deps, { budgetMs: 10_000 })
    expect(s).toMatchObject({ docs: 3, ok: 2, deferred: 1 })
  })

  test('výchozí dávka je omezená (cron má minutu)', async () => {
    const t = setup({ docs: [], reads: {} })
    await runDocumentSync(t.deps)
    expect(t.db.loadWatched).toHaveBeenCalledWith(DOC_SYNC_BATCH)
    expect(DOC_SYNC_BATCH).toBeLessThanOrEqual(100)
  })

  test('statistika ani úkol neobsahují nic než počty, název dokumentu a verze — žádný obsah, žádné tokeny', async () => {
    const t = setup({ docs: [doc({ item_id: '1' })], reads: { 1: okRead(V2) } })
    const s = await runDocumentSync(t.deps)
    expect(JSON.stringify(s)).not.toMatch(/Nabídka|TOK|sharepoint/i)
    expect(JSON.stringify(t.calls.tasks)).not.toMatch(/TOK|b!d|01A/)
  })
})
