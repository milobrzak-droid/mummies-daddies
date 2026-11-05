import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createEngagementDocument, deleteEngagementDocument } from '@/domain/delivery/actions/documents'
import { createSupabaseFake, hasOp, opArgs } from './helpers/supabaseFake'

// domain/delivery/actions/documents.ts — server akce pro dokumenty
// engagementu (0051_engagement_document.sql). Hlídáme: AAL2 bránu na obou
// akcích, validaci ID, URL validaci (jen SharePoint), 404 na smazání cizího/
// neexistujícího dokumentu a klidnou hlášku, když migrace 0051 ještě neběžela.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(),
  tryRequireUser: vi.fn(),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

describe('brána (AAL2) — bez uživatele nic nezapíše', () => {
  test('createEngagementDocument', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: 'https://mummiesdaddies.sharepoint.com/a', kind: 'jine' }))
    expect(r).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
  })

  test('deleteEngagementDocument', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await deleteEngagementDocument(1, 2, 3)
    expect(r).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('createEngagementDocument — validace', () => {
  beforeEach(() => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  })

  test('neplatné accountId/engagementId se vůbec nedotkne DB', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(0, 2, undefined, fd({ title: 'X', url: 'https://mummiesdaddies.sharepoint.com/a', kind: 'jine' }))
    expect(r).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(fake.calls).toHaveLength(0)
  })

  test('odkaz mimo sharepoint.com je odmítnutý, žádný insert', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: 'https://teams.microsoft.com/l/x', kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.url).toBeTruthy()
    expect(fake.calls).toHaveLength(0)
  })

  test('L4: odkaz na cizí SharePoint tenant je odmítnutý, žádný insert', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: 'https://firma.sharepoint.com/a', kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.url).toBeTruthy()
    expect(fake.calls).toHaveLength(0)
  })

  test('L2: podvržené created_by z formuláře se do insertu nedostane', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [{ id: 9 }], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({
      title: 'X', url: 'https://mummiesdaddies.sharepoint.com/a', kind: 'jine', created_by: '00000000-0000-0000-0000-000000000000',
    }))
    expect(r).toEqual({ success: true })
    const [row] = opArgs(fake.calls[0], 'insert') as [Record<string, unknown>]
    expect(row).not.toHaveProperty('created_by')
  })

  test('chybějící název je odmítnutý, žádný insert', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: '', url: 'https://mummiesdaddies.sharepoint.com/a', kind: 'jine' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.title).toBeTruthy()
    expect(fake.calls).toHaveLength(0)
  })

  test('platná data se vloží a stránka se revaliduje', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [{ id: 9 }], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'Smlouva', url: 'https://mummiesdaddies.sharepoint.com/a', kind: 'smlouva' }))
    expect(r).toEqual({ success: true })
    const insertCall = fake.calls.find((c) => c.table === 'engagement_document')!
    expect(hasOp(insertCall, 'insert')).toBe(true)
    // L2: created_by neposíláme — doplní ho DB z auth.uid() (0053).
    const [row] = opArgs(insertCall, 'insert') as [Record<string, unknown>]
    expect(row).not.toHaveProperty('created_by')
    expect(row).toMatchObject({ engagement_id: 2, title: 'Smlouva', kind: 'smlouva' })
    expect(fake.getUser).not.toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1/engagements/2/edit')
  })

  test('migrace 0051 ještě neběžela → klidná hláška, ne pád', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: null, error: { code: '42P01', message: 'relation "engagement_document" does not exist' } }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createEngagementDocument(1, 2, undefined, fd({ title: 'X', url: 'https://mummiesdaddies.sharepoint.com/a', kind: 'jine' }))
    expect(r).toEqual({ success: false, error: 'Dokumenty ještě nejsou dostupné — čekají na migraci 0051.' })
  })
})

describe('deleteEngagementDocument', () => {
  beforeEach(() => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  })

  test('neplatné id se vůbec nedotkne DB', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await deleteEngagementDocument(1, 2, 0)).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(fake.calls).toHaveLength(0)
  })

  test('dokument nenalezen (jiný engagement / už smazaný) → chyba', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await deleteEngagementDocument(1, 2, 3)
    expect(r).toEqual({ success: false, error: 'Dokument nebyl nalezen.' })
  })

  test('smazání zapíše delete s eq na id i engagement_id a revaliduje stránku', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [{ id: 3 }], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await deleteEngagementDocument(1, 2, 3)
    expect(r).toEqual({ success: true })
    const call = fake.calls.find((c) => c.table === 'engagement_document')!
    expect(hasOp(call, 'delete')).toBe(true)
    expect(call.ops).toContainEqual({ method: 'eq', args: ['id', 3] })
    expect(call.ops).toContainEqual({ method: 'eq', args: ['engagement_id', 2] })
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1/engagements/2/edit')
  })

  test('migrace 0051 ještě neběžela → klidná hláška, ne pád', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: null, error: { code: 'PGRST205', message: 'could not find the table' } }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await deleteEngagementDocument(1, 2, 3)
    expect(r).toEqual({ success: false, error: 'Dokumenty ještě nejsou dostupné — čekají na migraci 0051.' })
  })
})
