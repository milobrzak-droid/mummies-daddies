import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { graphTokenForCurrentUser } from '@/connectors/graph'
import { createEngagementDocument } from '@/domain/delivery/actions/documents'
import { formatLastChange } from '@/domain/delivery/documentMetadata'
import { createSupabaseFake, hasOp, opArgs, type QueryCall } from './helpers/supabaseFake'

// Plan kap. 8 — vložený odkaz do dokumentů dodávky, metadata přes Graph
// (GET /shares/{u!…}/driveItem) s tokenem přihlášeného člena. Graph je
// mockovaný přes globální fetch; token přes graphTokenForCurrentUser.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(),
  tryRequireUser: vi.fn(),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/connectors/graph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/connectors/graph')>()),
  graphTokenForCurrentUser: vi.fn(),
}))

const SP_SHARE = 'https://mummiesdaddies.sharepoint.com/:w:/s/Projekt/EabCdEf?e=Xy'
const SP_ITEM = 'https://mummiesdaddies.sharepoint.com/sites/Projekt/Shared%20Documents/Nabidka.docx'
const ITEM = {
  name: 'Nabídka.docx',
  webUrl: SP_ITEM,
  lastModifiedDateTime: '2026-09-27T12:30:00Z',
  lastModifiedBy: { user: { displayName: 'Jana Nováková' } },
  size: 1234,
  file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '@microsoft.graph.downloadUrl': 'https://mummiesdaddies.sharepoint.com/download?SECRET',
}

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

let graphCalls: string[] = []
function mockGraph(status: number, body: unknown = ITEM) {
  graphCalls = []
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    graphCalls.push(u)
    return new Response(JSON.stringify(body), { status })
  }))
}

function insertedRow(calls: QueryCall[]): Record<string, unknown> {
  const call = calls.find((c) => c.table === 'engagement_document' && hasOp(c, 'insert'))!
  return (opArgs(call, 'insert') as [Record<string, unknown>])[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(graphTokenForCurrentUser).mockResolvedValue({ ok: true, accessToken: 'TOK' })
  vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', 'true')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('metadata načtená z Graphu', () => {
  test('prázdný název doplní z SharePointu, uloží kanonický webUrl a potvrdí poslední změnu', async () => {
    mockGraph(200)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'podklad' }))
    expect(r.success).toBe(true)
    expect(r.notice).toBe(`Načteno ze SharePointu. ${formatLastChange({ lastModifiedAt: ITEM.lastModifiedDateTime, lastModifiedBy: 'Jana Nováková' })}`)
    expect(r.notice).toContain('Jana Nováková')
    expect(insertedRow(fake.calls)).toEqual({ engagement_id: 2, milestone_id: null, title: 'Nabídka.docx', url: SP_ITEM, kind: 'podklad', doc_type: 'jine' })
    // Jeden požadavek, jen metadata.
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0]).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/shares\/u![A-Za-z0-9_-]+\/driveItem\?\$select=/)
    expect(graphCalls[0]).not.toMatch(/content/i)
    expect(JSON.stringify(fake.calls)).not.toContain('SECRET')
  })

  test('vyplněný název člena se nepřepíše', async () => {
    mockGraph(200)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await createEngagementDocument(1, 2, undefined, fd({ title: 'Nabídka v2', url: SP_SHARE, kind: 'jine' }))
    expect(insertedRow(fake.calls)).toMatchObject({ title: 'Nabídka v2', url: SP_ITEM })
  })

  test('soubor z Teams: do Graphu jde objectUrl, uloží se webUrl', async () => {
    mockGraph(200)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const teams = `https://teams.microsoft.com/l/file/ABC?fileType=docx&objectUrl=${encodeURIComponent(SP_ITEM)}`
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: teams, kind: 'jine' }))
    expect(r.success).toBe(true)
    const encoded = graphCalls[0].split('/shares/')[1].split('/driveItem')[0]
    const decoded = Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    expect(decoded).toBe(SP_ITEM)
    expect(insertedRow(fake.calls)).toMatchObject({ url: SP_ITEM })
  })

  test('Graph vrátí webUrl mimo firemní SharePoint → neuloží nic', async () => {
    mockGraph(200, { ...ITEM, webUrl: 'https://contoso.sharepoint.com/sites/x/a.docx' })
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.url).toMatch(/mimo firemní SharePoint/)
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })

  test('odkaz na cizí tenant se do Graphu vůbec nepošle a neuloží', async () => {
    mockGraph(200)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: 'https://contoso.sharepoint.com/:w:/s/x/Eab', kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.url).toMatch(/firemního SharePointu/)
    expect(graphCalls).toHaveLength(0)
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })
})

describe('bez metadat — odkaz se uloží tak, jak je, s nápovědou', () => {
  test('403 (chybí Files.Read.All / bez přístupu)', async () => {
    mockGraph(403, { error: { code: 'accessDenied' } })
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'Smlouva', url: SP_SHARE, kind: 'smlouva' }))
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/Files\.Read\.All/)
    expect(r.notice).toMatch(/uložený tak, jak jsi ho vložil/)
    expect(insertedRow(fake.calls)).toMatchObject({ title: 'Smlouva', url: SP_SHARE })
  })

  test('Outlook nepřipojený → Graph se nevolá', async () => {
    mockGraph(200)
    vi.mocked(graphTokenForCurrentUser).mockResolvedValue({ ok: false, error: 'Outlook není připojený. Připoj ho na dashboardu.' })
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: SP_SHARE, kind: 'jine' }))
    expect(r.success).toBe(true)
    expect(r.notice).toMatch(/Outlook není připojený/)
    expect(graphCalls).toHaveLength(0)
  })

  test('bez metadat a bez názvu → chyba u názvu s vysvětlením', async () => {
    mockGraph(404, { error: { code: 'itemNotFound' } })
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: SP_SHARE, kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.title).toMatch(/načíst nepodařilo/)
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })

  test('přepínač vypnutý → žádný Graph, žádná nápověda (chování jako dřív)', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    mockGraph(200)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: SP_SHARE, kind: 'jine' }))
    expect(r).toEqual({ success: true })
    expect(graphCalls).toHaveLength(0)
    expect(graphTokenForCurrentUser).not.toHaveBeenCalled()
  })

  test('Teams soubor bez Graphu → uloží se vnitřní SharePoint odkaz', async () => {
    vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', '')
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const teams = `https://teams.microsoft.com/l/file/ABC?objectUrl=${encodeURIComponent(SP_ITEM)}`
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: teams, kind: 'jine' }))
    expect(r).toEqual({ success: true })
    expect(insertedRow(fake.calls)).toMatchObject({ url: SP_ITEM })
  })

  test('osobní OneDrive se neuloží (DB povoluje jen firemní SharePoint)', async () => {
    mockGraph(200)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: 'https://1drv.ms/w/s!AbC', kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.url).toMatch(/Osobní OneDrive/)
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
    // webUrl osobního OneDrivu by DB stejně neuložila — Graph se nevolá.
    expect(graphCalls).toHaveLength(0)
  })

  test('obcházení hostu se do Graphu vůbec nedostane', async () => {
    mockGraph(200)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: 'https://mummiesdaddies.sharepoint.com@evil.example/a', kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.url).toBeTruthy()
    expect(graphCalls).toHaveLength(0)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('vazba na milník', () => {
  beforeEach(() => vi.stubEnv('GRAPH_FILES_SCOPE_ENABLED', ''))

  test('milník téže dodávky → uloží se milestone_id', async () => {
    const fake = createSupabaseFake({
      resolve: (c) => (c.table === 'engagement_milestone' ? { data: { id: 7 }, error: null } : { data: null, error: null }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: SP_ITEM, kind: 'vystup', milestone_id: '7' }))
    expect(r).toEqual({ success: true })
    const check = fake.calls.find((c) => c.table === 'engagement_milestone')!
    expect(check.ops).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', 7] },
      { method: 'eq', args: ['engagement_id', 2] },
    ]))
    expect(insertedRow(fake.calls)).toMatchObject({ milestone_id: 7 })
  })

  test('cizí milník → chyba, žádný insert', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: SP_ITEM, kind: 'vystup', milestone_id: '99' }))
    expect(r).toEqual({ success: false, fieldErrors: { milestone_id: 'Milník nepatří k této dodávce.' } })
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })

  test('milníky ještě bez migrace 0042 → klidná hláška', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: SP_ITEM, kind: 'vystup', milestone_id: '7' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.milestone_id).toMatch(/0042/)
  })
})

describe('formatLastChange', () => {
  test('datum a kdo; bez autora jen datum; bez data null', () => {
    expect(formatLastChange({ lastModifiedAt: '2026-09-27T12:30:00Z', lastModifiedBy: 'Jana' })).toMatch(/^Poslední změna: .+2026, Jana$/)
    expect(formatLastChange({ lastModifiedAt: '2026-09-27T12:30:00Z', lastModifiedBy: null })).toMatch(/^Poslední změna: .+2026$/)
    expect(formatLastChange({ lastModifiedAt: null, lastModifiedBy: 'Jana' })).toBeNull()
  })
})
