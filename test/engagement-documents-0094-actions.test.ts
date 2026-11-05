import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { graphTokenForCurrentUser } from '@/connectors/graph'
import {
  createEngagementDocument,
  refreshEngagementDocument,
  reapproveDocument,
  setDocumentStatus,
} from '@/domain/delivery/actions/documents'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Revize kap. 2E (0094): vložení odkazu doplní identitu a verzi, stav dokumentu
// (koncept → schváleno → odesláno), připíchnutá verze, obnova metadat. Graph je
// mockovaný přes globální fetch, DB přes supabaseFake, servisní klíč (verze)
// druhým fake klientem.

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/connectors/graph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/connectors/graph')>()),
  graphTokenForCurrentUser: vi.fn(),
}))

const SP_SHARE = 'https://mummiesdaddies.sharepoint.com/:w:/s/Projekt/EabCdEf?e=Xy'
const SP_ITEM = 'https://mummiesdaddies.sharepoint.com/sites/Projekt/Shared%20Documents/Nabidka.docx'
const DRIVE = 'b!drive-1'
const ITEM_ID = '01ABCDEF'

const graphItem = (c: string, e = `"e-${c}"`) => ({
  id: ITEM_ID,
  parentReference: { driveId: DRIVE },
  name: 'Nabídka.docx',
  webUrl: SP_ITEM,
  eTag: e,
  cTag: c,
  lastModifiedDateTime: '2026-09-27T12:30:00Z',
  lastModifiedBy: { user: { displayName: 'Jana Nováková' } },
})

let graphCalls: string[] = []
/** Graph: `versions` = seznam verzí (nebo null = 403), `item` = odpověď položky (status + tělo). */
function mockGraph(opts: { item?: [number, unknown]; versions?: { id: string }[] | null } = {}) {
  graphCalls = []
  const [status, body] = opts.item ?? [200, graphItem('c1')]
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    graphCalls.push(u)
    if (u.includes('/versions')) {
      return opts.versions === null
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ value: opts.versions ?? [{ id: '3.0', lastModifiedDateTime: '2026-09-27T12:30:00Z' }] }), { status: 200 })
    }
    return new Response(JSON.stringify(body), { status })
  }))
}

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

const ok = (data: unknown = null): QueryResult => ({ data, error: null })
const findCall = (calls: QueryCall[], table: string, op: string) => calls.find((c) => c.table === table && hasOp(c, op))

let admin: ReturnType<typeof createSupabaseFake>

/** Fake servisního klienta: select verze vrátí `latest` (nebo nic), insert vrátí id 5. */
function setupAdmin(latest: Record<string, unknown> | null = null) {
  admin = createSupabaseFake({
    resolve: (c) => (hasOp(c, 'insert') ? ok({ id: 5 }) : ok(latest ? [latest] : [])),
  })
  vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(graphTokenForCurrentUser).mockResolvedValue({ ok: true, accessToken: 'TOK' })
  vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', 'true')
  setupAdmin()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('vložení odkazu: identita a verze z Graphu', () => {
  test('uloží drive+item, eTag/cTag, číslo verze a typ; verzi zapíše servisním klíčem', async () => {
    mockGraph()
    const fake = createSupabaseFake({ resolve: (c) => (hasOp(c, 'insert') ? ok({ id: 41 }) : ok()) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'vystup', doc_type: 'nabidka' }))
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/Načteno ze SharePointu\./)
    expect(r.notice).toMatch(/Verze 3\.0\./)

    const row = (opArgs(findCall(fake.calls, 'engagement_document', 'insert')!, 'insert') as [Record<string, unknown>])[0]
    expect(row).toMatchObject({ engagement_id: 2, title: 'Nabídka.docx', url: SP_ITEM, kind: 'vystup', doc_type: 'nabidka' })
    // Autora a stav z klienta neposíláme (DB ho doplní).
    expect(row).not.toHaveProperty('created_by')
    expect(row).not.toHaveProperty('status')
    // 0095: identitu a verzi zdroje session člena nezapíše (DB by je odmítla),
    // doplní je servisní klíč po ověření člena.
    for (const col of ['drive_id', 'item_id', 'e_tag', 'c_tag', 'version_label', 'last_modified_at', 'last_modified_by', 'source_state', 'source_checked_at']) {
      expect(row, col).not.toHaveProperty(col)
    }
    const source = findCall(admin.calls, 'engagement_document', 'update')!
    expect(opArgs(source, 'update')![0]).toMatchObject({
      drive_id: DRIVE, item_id: ITEM_ID, e_tag: '"e-c1"', c_tag: 'c1', version_label: '3.0',
      last_modified_at: '2026-09-27T12:30:00Z', last_modified_by: 'Jana Nováková', source_state: 'ok',
    })
    expect(source.ops).toContainEqual({ method: 'eq', args: ['id', 41] })
    expect(source.ops).toContainEqual({ method: 'eq', args: ['engagement_id', 2] })

    const version = findCall(admin.calls, 'engagement_document_version', 'insert')!
    expect(opArgs(version, 'insert')![0]).toMatchObject({
      document_id: 41, c_tag: 'c1', e_tag: '"e-c1"', version_label: '3.0', modified_by: 'Jana Nováková',
      observed_by: 'user:user-1', reason: 'linked',
    })
    // Jen metadata: šla dvě volání (položka + verze), žádný obsah.
    expect(graphCalls).toHaveLength(2)
    expect(graphCalls.join(' ')).not.toMatch(/\/content|downloadUrl/)
  })

  test('typ dokumentu chybí ve formuláři → „Jiné"; neplatný typ je chyba', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await createEngagementDocument(1, 2, undefined, fd({ title: 'A', url: SP_ITEM, kind: 'jine' }))).toEqual({ success: true })
    expect(opArgs(findCall(fake.calls, 'engagement_document', 'insert')!, 'insert')![0]).toMatchObject({ doc_type: 'jine' })

    const bad = await createEngagementDocument(1, 2, undefined, fd({ title: 'A', url: SP_ITEM, kind: 'jine', doc_type: 'faktura' }))
    expect(bad.success).toBe(false)
    expect(bad.fieldErrors?.doc_type).toBeTruthy()
  })

  test('bez identity z Graphu (odpověď bez id) se uloží jako dřív a verze se nezapisuje', async () => {
    mockGraph({ item: [200, { name: 'a.docx', webUrl: SP_ITEM }] })
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'jine' }))
    expect(r.success).toBe(true)
    const row = (opArgs(findCall(fake.calls, 'engagement_document', 'insert')!, 'insert') as [Record<string, unknown>])[0]
    expect(row).not.toHaveProperty('drive_id')
    expect(findCall(admin.calls, 'engagement_document_version', 'insert')).toBeUndefined()
  })

  test('tentýž soubor podruhé (unikát dodávka+drive+item) → chyba u odkazu, řádek se vrátí, žádná verze', async () => {
    mockGraph()
    admin = createSupabaseFake({
      resolve: (c) => (c.table === 'engagement_document' && hasOp(c, 'update') ? { data: null, error: { code: '23505', message: 'duplicate' } } : ok()),
    })
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
    const fake = createSupabaseFake({ resolve: (c) => (hasOp(c, 'insert') ? ok({ id: 41 }) : ok()) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'jine' }))
    expect(r).toEqual({ success: false, fieldErrors: { url: 'Tenhle soubor už v dodávce je jako jiný dokument.' } })
    const rollback = findCall(fake.calls, 'engagement_document', 'delete')!
    expect(rollback.ops).toContainEqual({ method: 'eq', args: ['id', 41] })
    expect(findCall(admin.calls, 'engagement_document_version', 'insert')).toBeUndefined()
  })

  test('servisní zápis identity selže z jiného důvodu → odkaz zůstane a člen se to dozví', async () => {
    mockGraph()
    admin = createSupabaseFake({
      resolve: (c) => (c.table === 'engagement_document' && hasOp(c, 'update') ? { data: null, error: { code: '57014', message: 'timeout' } } : hasOp(c, 'insert') ? ok({ id: 5 }) : ok()),
    })
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
    const fake = createSupabaseFake({ resolve: (c) => (hasOp(c, 'insert') ? ok({ id: 41 }) : ok()) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'jine' }))
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/metadata ze SharePointu se nepodařilo zapsat/)
    expect(findCall(fake.calls, 'engagement_document', 'delete')).toBeUndefined()
  })

  test('migrace 0094 ještě neběžela → dokument se uloží bez nových sloupců a člen to ví', async () => {
    mockGraph()
    let inserts = 0
    const fake = createSupabaseFake({
      resolve: (c) => {
        if (!hasOp(c, 'insert')) return ok()
        return ++inserts === 1
          ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'doc_type' column of 'engagement_document' in the schema cache" } }
          : ok()
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'jine' }))
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/0094/)
    const inserted = fake.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'insert'))
    expect(inserted).toHaveLength(2)
    const legacy = (opArgs(inserted[1], 'insert') as [Record<string, unknown>])[0]
    expect(Object.keys(legacy).sort()).toEqual(['engagement_id', 'kind', 'milestone_id', 'title', 'url'])
    expect(admin.calls).toHaveLength(0)
  })
})

// --- Stav dokumentu -----------------------------------------------------------

type Doc = Partial<{ status: string; approved_version_id: number | null; drive_id: string | null; item_id: string | null }>
const docRow = (d: Doc = {}) => ({
  id: 9, engagement_id: 2, url: SP_ITEM, title: 'Nabídka', status: 'draft', approved_version_id: null, drive_id: DRIVE, item_id: ITEM_ID, ...d,
})

/** Fake session klienta: načtení dokumentu, verze (schválená) a volitelně otevřený nález. */
function setupSession(doc: Doc = {}, opts: { approvedVersion?: Record<string, unknown> | null; openChanged?: boolean; updated?: boolean } = {}) {
  const fake = createSupabaseFake({
    resolve: (c) => {
      if (c.table === 'engagement_document' && hasOp(c, 'update')) return ok(opts.updated === false ? [] : [{ id: 9 }])
      if (c.table === 'engagement_document') return ok(docRow(doc))
      if (c.table === 'engagement_document_version') return ok(opts.approvedVersion ?? null)
      if (c.table === 'engagement_document_finding' && !hasOp(c, 'update')) return ok(opts.openChanged ? [{ id: 1 }] : [])
      return ok()
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

describe('setDocumentStatus', () => {
  test('brána a validace: bez uživatele nic, neplatné id, neplatný cíl (přijato jen akceptací milníku)', async () => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const fake = setupSession()
    expect(await setDocumentStatus(1, 2, 9, 'approved')).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
    expect(await setDocumentStatus(1, 2, 0, 'approved')).toEqual({ success: false, error: 'Neplatné ID.' })
    expect((await setDocumentStatus(1, 2, 9, 'accepted')).success).toBe(false)
    expect((await setDocumentStatus(1, 2, 9, 'nesmysl')).success).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  test('schválení připíchne čerstvou verzi ze SharePointu a uzavře otevřené nálezy', async () => {
    mockGraph()
    const fake = setupSession({ status: 'draft' })
    const r = await setDocumentStatus(1, 2, 9, 'approved')
    expect(r).toEqual({ success: true })
    // Metadata se obnovila a verze zaznamenala (id 5 vrátil servisní klient).
    expect(opArgs(findCall(admin.calls, 'engagement_document_version', 'insert')!, 'insert')![0]).toMatchObject({ reason: 'approved', c_tag: 'c1' })
    // 0095: metadata zdroje zapisuje servisní klíč, session člena jen stav.
    const sourceUpdate = admin.calls.find((c) => c.table === 'engagement_document' && hasOp(c, 'update'))!
    expect((opArgs(sourceUpdate, 'update') as [Record<string, unknown>])[0]).toMatchObject({ c_tag: 'c1', version_label: '3.0', source_state: 'ok' })
    const updates = fake.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'update'))
    expect(updates).toHaveLength(1)
    const status = updates[0]
    expect((opArgs(status, 'update') as [Record<string, unknown>])[0]).toEqual({ status: 'approved', approved_version_id: 5 })
    // Souběžná změna stavu neprojde: update je podmíněný původním stavem.
    expect(status.ops).toContainEqual({ method: 'eq', args: ['status', 'draft'] })
    // Kdo a kdy se neposílá — doplní DB.
    expect(JSON.stringify(opArgs(status, 'update'))).not.toMatch(/status_changed|approved_by|approved_at/)
    const finding = findCall(fake.calls, 'engagement_document_finding', 'update')!
    expect((opArgs(finding, 'update') as [Record<string, unknown>])[0]).toMatchObject({ resolution: 'reapproved' })
  })

  test('Graph nedostupný (Outlook nepřipojený): schválí se poslední známá verze a člen dostane nápovědu', async () => {
    mockGraph()
    vi.mocked(graphTokenForCurrentUser).mockResolvedValue({ ok: false, error: 'Outlook není připojený. Připoj ho na dashboardu.' })
    const fake = setupSession({ status: 'draft' }, { approvedVersion: [{ id: 8, e_tag: 'e', c_tag: 'c0', version_label: '2.0', modified_at: null, modified_by: null }] as never })
    const r = await setDocumentStatus(1, 2, 9, 'approved')
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/Outlook není připojený/)
    expect(graphCalls).toHaveLength(0)
    const statusUpdate = fake.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'update')).at(-1)!
    expect((opArgs(statusUpdate, 'update') as [Record<string, unknown>])[0]).toEqual({ status: 'approved', approved_version_id: 8 })
  })

  test('dokument bez identity se schválí bez verze; změny se pak nehlídají a člen to ví', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    const fake = setupSession({ status: 'draft', drive_id: null, item_id: null })
    const r = await setDocumentStatus(1, 2, 9, 'approved')
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/nehlídají/)
    const update = fake.calls.find((c) => c.table === 'engagement_document' && hasOp(c, 'update'))!
    expect((opArgs(update, 'update') as [Record<string, unknown>])[0]).toEqual({ status: 'approved', approved_version_id: null })
  })

  test('soubor zmizel → schválit ani odeslat nejde, nic se nezapíše', async () => {
    mockGraph({ item: [404, {}] })
    const fake = setupSession({ status: 'draft' })
    const r = await setDocumentStatus(1, 2, 9, 'approved')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/už ve SharePointu není/)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('odeslání: soubor se od schválení změnil → zamítnuto (nejdřív znovu schválit)', async () => {
    mockGraph({ item: [200, graphItem('c2')], versions: [{ id: '4.0' }] })
    const fake = setupSession(
      { status: 'approved', approved_version_id: 8 },
      { approvedVersion: { id: 8, e_tag: '"e-c1"', c_tag: 'c1', version_label: '3.0', modified_at: null, modified_by: null } },
    )
    const r = await setDocumentStatus(1, 2, 9, 'sent')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/od schválení změnil.*verze 3\.0.*verze 4\.0/)
    // Status se nezměnil (jen obnovená metadata).
    const statusUpdates = fake.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'update'))
      .filter((c) => JSON.stringify(opArgs(c, 'update')).includes('"status"'))
    expect(statusUpdates).toHaveLength(0)
  })

  test('odeslání: stejná verze jako schválená → projde', async () => {
    mockGraph()
    const fake = setupSession(
      { status: 'approved', approved_version_id: 8 },
      { approvedVersion: { id: 8, e_tag: '"e-c1"', c_tag: 'c1', version_label: '3.0', modified_at: null, modified_by: null } },
    )
    expect(await setDocumentStatus(1, 2, 9, 'sent')).toEqual({ success: true })
    const status = fake.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'update')).at(-1)!
    expect((opArgs(status, 'update') as [Record<string, unknown>])[0]).toEqual({ status: 'sent' })
    expect(status.ops).toContainEqual({ method: 'eq', args: ['status', 'approved'] })
  })

  test('odeslání bez Graphu: otevřený nález „změnil se" ho zablokuje', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    const fake = setupSession({ status: 'approved', approved_version_id: 8 }, { openChanged: true })
    const r = await setDocumentStatus(1, 2, 9, 'sent')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/od schválení změnil/)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('zakázaný přechod (koncept → odesláno) a souběžná změna stavu', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    const a = setupSession({ status: 'draft' })
    const r = await setDocumentStatus(1, 2, 9, 'sent')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/Koncept.*Odesláno/)
    expect(a.calls.some((c) => hasOp(c, 'update'))).toBe(false)

    setupSession({ status: 'approved' }, { updated: false })
    expect(await setDocumentStatus(1, 2, 9, 'draft')).toEqual({ success: false, error: 'Dokument mezitím změnil stav. Načti prosím stránku znovu.' })
  })

  test('zpět do konceptu uzavře nálezy jako „draft"', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    const fake = setupSession({ status: 'sent', approved_version_id: 8 })
    expect(await setDocumentStatus(1, 2, 9, 'draft')).toEqual({ success: true })
    const finding = findCall(fake.calls, 'engagement_document_finding', 'update')!
    expect((opArgs(finding, 'update') as [Record<string, unknown>])[0]).toMatchObject({ resolution: 'draft' })
  })

  test('migrace 0094 ještě neběžela → klidná hláška', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42703', message: 'column engagement_document.status does not exist' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await setDocumentStatus(1, 2, 9, 'approved')).toEqual({ success: false, error: 'Stavy a verze dokumentů ještě nejsou dostupné — čekají na migraci 0094.' })
  })
})

describe('reapproveDocument', () => {
  test('připíchne aktuální verzi jako novou schválenou a uzavře jen nález „změnil se"; stav zůstává', async () => {
    mockGraph({ item: [200, graphItem('c2')], versions: [{ id: '4.0' }] })
    const fake = setupSession({ status: 'sent', approved_version_id: 8 })
    const r = await reapproveDocument(1, 2, 9)
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/verze 4\.0/)
    const status = fake.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'update')).at(-1)!
    expect((opArgs(status, 'update') as [Record<string, unknown>])[0]).toEqual({ approved_version_id: 5 })
    expect(status.ops).toContainEqual({ method: 'eq', args: ['status', 'sent'] })
    const finding = findCall(fake.calls, 'engagement_document_finding', 'update')!
    expect(finding.ops).toContainEqual({ method: 'in', args: ['kind', ['changed']] })
  })

  test('koncept se neschvaluje znovu; bez ověřitelné verze se nic nepřipíchne', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    setupSession({ status: 'draft' })
    expect((await reapproveDocument(1, 2, 9)).success).toBe(false)
    const fake = setupSession({ status: 'approved', approved_version_id: 8 })
    const r = await reapproveDocument(1, 2, 9)
    expect(r.success).toBe(false)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })
})

describe('refreshEngagementDocument', () => {
  test('starší dokument bez identity: dohledá se přes odkaz a doplní se drive+item', async () => {
    mockGraph()
    const fake = setupSession({ drive_id: null, item_id: null })
    const r = await refreshEngagementDocument(1, 2, 9)
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/Načteno ze SharePointu\./)
    expect(graphCalls[0]).toMatch(/\/shares\/u!/)
    const update = admin.calls.find((c) => c.table === 'engagement_document' && hasOp(c, 'update'))!
    expect((opArgs(update, 'update') as [Record<string, unknown>])[0]).toMatchObject({ drive_id: DRIVE, item_id: ITEM_ID, c_tag: 'c1' })
    // Člen z vlastní session identitu ani verzi zdroje nezapisuje.
    expect(fake.calls.some((c) => c.table === 'engagement_document' && hasOp(c, 'update'))).toBe(false)
  })

  test('dokument s identitou se čte přímo přes drive+item', async () => {
    mockGraph()
    setupSession()
    await refreshEngagementDocument(1, 2, 9)
    expect(graphCalls[0]).toBe(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(DRIVE)}/items/${ITEM_ID}?$select=${'id,name,webUrl,lastModifiedDateTime,lastModifiedBy,size,file,eTag,cTag,parentReference'}`)
  })

  test('tentýž soubor už je jako jiný dokument → identita se nepřepíše, člen to ví', async () => {
    mockGraph()
    let updates = 0
    admin = createSupabaseFake({
      resolve: (c) => {
        if (c.table === 'engagement_document' && hasOp(c, 'update')) {
          return ++updates === 1 ? { data: null, error: { code: '23505', message: 'dup' } } : ok([{ id: 9 }])
        }
        return hasOp(c, 'insert') ? ok({ id: 5 }) : ok([])
      },
    })
    vi.mocked(createAdminClient).mockReturnValue(admin.client as never)
    setupSession({ drive_id: null, item_id: null })
    const r = await refreshEngagementDocument(1, 2, 9)
    expect(r.notice).toMatch(/už v dodávce je jako jiný dokument/)
    const second = admin.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'update'))[1]
    expect(JSON.stringify(opArgs(second, 'update'))).not.toContain('drive_id')
  })

  test('soubor zmizel → stav zdroje „missing"; přepínač vypnutý → chyba a nic se nečte', async () => {
    mockGraph({ item: [404, {}] })
    const fake = setupSession()
    const r = await refreshEngagementDocument(1, 2, 9)
    expect(r).toEqual({ success: true, notice: 'Soubor už ve SharePointu není.' })
    expect((opArgs(findCall(admin.calls, 'engagement_document', 'update')!, 'update') as [Record<string, unknown>])[0]).toMatchObject({ source_state: 'missing' })
    expect(fake.calls.some((c) => c.table === 'engagement_document' && hasOp(c, 'update'))).toBe(false)

    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    mockGraph()
    setupSession()
    expect((await refreshEngagementDocument(1, 2, 9)).success).toBe(false)
    expect(graphCalls).toHaveLength(0)
  })

  test('brána', async () => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const fake = setupSession()
    expect(await refreshEngagementDocument(1, 2, 9)).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
  })
})
