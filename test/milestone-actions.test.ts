import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { recordEvidence } from '@/core/evidence'
import { recordAudit } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import {
  acceptMilestone,
  completeHandoff,
  createMilestone,
  deleteMilestone,
  saveHandoff,
  setMilestoneStatus,
} from '@/domain/delivery/actions/milestones'
import { createSupabaseFake, hasOp, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// domain/delivery/actions/milestones.ts — milníky (0042) a předávací balíček
// (0054). Hlídáme: AAL2 bránu na každé akci, přechody jen podle grafu,
// „odesláno ≠ přijato" (přijetí jen s dokladem → evidence přes service role),
// vazbu dokumentu/kontaktu na dodávku a klidnou hlášku před migrací.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(),
  tryRequireUser: vi.fn(),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }))
vi.mock('@/core/evidence', () => ({ recordEvidence: vi.fn() }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const USER = { id: '00000000-0000-4000-8000-000000000001' }
const DOC_URL = 'https://mummiesdaddies.sharepoint.com/sites/x/Akceptace.pdf'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue(USER as never)
  vi.mocked(recordEvidence).mockResolvedValue({ ok: true, id: 77 })
  vi.mocked(dbAuditActive).mockResolvedValue(false)
})

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

type Route = (call: QueryCall) => QueryResult | undefined
function fakeWith(...routes: Route[]) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      for (const r of routes) {
        const out = r(call)
        if (out) return out
      }
      return { data: null, error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const isRead = (c: QueryCall) => !hasOp(c, 'update') && !hasOp(c, 'insert') && !hasOp(c, 'delete')
const engagementOf = (accountId: number): Route => (c) =>
  c.table === 'engagement' && isRead(c) ? { data: { id: 2, account_id: accountId }, error: null } : undefined
const milestoneIn = (status: string, extra: Record<string, unknown> = {}): Route => (c) =>
  c.table === 'engagement_milestone' && isRead(c)
    ? {
        data: { id: 3, status, accepted_at: null, accepted_by_contact_id: null, acceptance_evidence_id: null, ...extra },
        error: null,
      }
    : undefined
const updateOk: Route = (c) => (hasOp(c, 'update') || hasOp(c, 'delete') ? { data: [{ id: 3 }], error: null } : undefined)

describe('AAL2 brána — bez uživatele se nic nezapíše', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['createMilestone', () => createMilestone(1, 2, undefined, fd({ title: 'X' }))],
    ['setMilestoneStatus', () => setMilestoneStatus(1, 2, 3, 'v_praci')],
    ['acceptMilestone', () => acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-01-01' }))],
    ['deleteMilestone', () => deleteMilestone(1, 2, 3)],
    ['saveHandoff', () => saveHandoff(1, 2, undefined, fd({ goal: 'x' }))],
    ['completeHandoff', () => completeHandoff(1, 2)],
  ]
  for (const [name, run] of calls) {
    test(name, async () => {
      vi.mocked(tryRequireUser).mockResolvedValue(null)
      const fake = fakeWith()
      expect(await run()).toEqual({ success: false, error: 'auth' })
      expect(fake.calls).toHaveLength(0)
      expect(recordEvidence).not.toHaveBeenCalled()
      expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    })
  }
})

describe('createMilestone', () => {
  test('neplatná ID a prázdný název se DB nedotknou', async () => {
    const fake = fakeWith()
    expect(await createMilestone(0, 2, undefined, fd({ title: 'X' }))).toEqual({ success: false, error: 'Neplatné ID.' })
    const r = await createMilestone(1, 2, undefined, fd({ title: '  ' }))
    expect(r.fieldErrors?.title).toBeTruthy()
    expect(fake.calls).toHaveLength(0)
  })

  test('zástupce nesmí být vlastník', async () => {
    fakeWith()
    const r = await createMilestone(1, 2, undefined, fd({ title: 'Mapa', owner_id: USER.id, deputy_id: USER.id }))
    expect(r.fieldErrors?.deputy_id).toBeTruthy()
  })

  test('cizí dodávka (jiná firma) → nenalezeno, žádný insert', async () => {
    const fake = fakeWith(engagementOf(99))
    const r = await createMilestone(1, 2, undefined, fd({ title: 'Mapa' }))
    expect(r).toEqual({ success: false, error: 'Dodávka nebyla nalezena.' })
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })

  test('platný milník se vloží do dodávky a stránka se revaliduje', async () => {
    const fake = fakeWith(engagementOf(1))
    const r = await createMilestone(1, 2, undefined, fd({ title: 'Procesní mapa', due_on: '2026-10-15', owner_id: USER.id }))
    expect(r).toEqual({ success: true })
    const ins = fake.calls.find((c) => c.table === 'engagement_milestone' && hasOp(c, 'insert'))!
    expect(ins.ops.find((o) => o.method === 'insert')!.args[0]).toMatchObject({
      engagement_id: 2,
      title: 'Procesní mapa',
      owner_id: USER.id,
      deputy_id: null,
      due_on: '2026-10-15',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/1/engagements/2/edit')
  })

  test('migrace 0042 ještě neběžela → klidná hláška', async () => {
    fakeWith(engagementOf(1), (c) =>
      c.table === 'engagement_milestone' ? { data: null, error: { code: '42P01', message: 'relation does not exist' } } : undefined,
    )
    const r = await createMilestone(1, 2, undefined, fd({ title: 'Mapa' }))
    expect(r).toEqual({ success: false, error: 'Milníky ještě nejsou dostupné — čekají na migraci 0042.' })
  })
})

describe('setMilestoneStatus — přechody podle grafu', () => {
  test('povolený přechod zapíše update s optimistickým zámkem na původní stav', async () => {
    const fake = fakeWith(milestoneIn('pripraveno'), updateOk)
    expect(await setMilestoneStatus(1, 2, 3, 'v_praci')).toEqual({ success: true })
    const upd = fake.calls.find((c) => hasOp(c, 'update'))!
    expect(upd.ops).toContainEqual({ method: 'update', args: [{ status: 'v_praci' }] })
    expect(upd.ops).toContainEqual({ method: 'eq', args: ['status', 'pripraveno'] })
    expect(upd.ops).toContainEqual({ method: 'eq', args: ['engagement_id', 2] })
    expect(recordAudit).toHaveBeenCalled()
  })

  test('po migraci 0064 zapisuje změnu stavu DB trigger → appka audit nepíše', async () => {
    vi.mocked(dbAuditActive).mockResolvedValue(true)
    const fake = fakeWith(milestoneIn('pripraveno'), updateOk)
    expect(await setMilestoneStatus(1, 2, 3, 'v_praci')).toEqual({ success: true })
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(true)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('nepovolený přechod (přeskočení schválení) se nezapíše', async () => {
    const fake = fakeWith(milestoneIn('v_praci'))
    const r = await setMilestoneStatus(1, 2, 3, 'uzavreno')
    expect(r.success).toBe(false)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('do Přijato touto cestou nejde nikdy — jen s dokladem', async () => {
    const fake = fakeWith(milestoneIn('ceka_na_schvaleni'))
    const r = await setMilestoneStatus(1, 2, 3, 'prijato')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/dokladem/)
    expect(fake.calls).toHaveLength(0)
  })

  test('uzavření přijatého milníku s akceptací projde', async () => {
    fakeWith(milestoneIn('prijato', { accepted_at: '2026-09-01T12:00:00Z', acceptance_evidence_id: 7 }), updateOk)
    expect(await setMilestoneStatus(1, 2, 3, 'uzavreno')).toEqual({ success: true })
  })

  test('neznámý stav a neplatné ID se DB nedotknou', async () => {
    const fake = fakeWith()
    expect((await setMilestoneStatus(1, 2, 3, 'hotovo')).success).toBe(false)
    expect((await setMilestoneStatus(1, 2, -3, 'v_praci')).error).toBe('Neplatné ID.')
    expect(fake.calls).toHaveLength(0)
  })

  test('souběžná změna stavu (update nic nezměnil) → hláška, žádný audit', async () => {
    fakeWith(milestoneIn('pripraveno'), (c) => (hasOp(c, 'update') ? { data: [], error: null } : undefined))
    const r = await setMilestoneStatus(1, 2, 3, 'v_praci')
    expect(r.success).toBe(false)
    expect(recordAudit).not.toHaveBeenCalled()
  })
})

describe('acceptMilestone — odesláno ≠ přijato', () => {
  const docRoute: Route = (c) =>
    c.table === 'engagement_document' && isRead(c)
      ? { data: { id: 5, url: DOC_URL, milestone_id: null }, error: null }
      : undefined

  test('bez dokladu (žádný dokument ani odkaz) neprojde a nic nezapíše', async () => {
    const fake = fakeWith()
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ accepted_on: '2026-09-01' }))
    expect(r.fieldErrors?.document_id).toBeTruthy()
    expect(fake.calls).toHaveLength(0)
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  test('nový odkaz mimo SharePoint je odmítnutý', async () => {
    fakeWith()
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ new_title: 'Mail', new_url: 'https://evil.example/x', accepted_on: '2026-09-01' }))
    expect(r.fieldErrors?.new_url).toBeTruthy()
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  test('datum akceptace v budoucnosti je odmítnuté', async () => {
    fakeWith()
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2999-01-01' }))
    expect(r.fieldErrors?.accepted_on).toBeTruthy()
  })

  test('milník, který nečeká na schválení, přijmout nejde', async () => {
    fakeWith(engagementOf(1), milestoneIn('v_praci'), docRoute)
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
    expect(r.success).toBe(false)
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  test('dokument jiné dodávky → chyba, žádná evidence', async () => {
    fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), (c) =>
      c.table === 'engagement_document' ? { data: null, error: null } : undefined,
    )
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
    expect(r.fieldErrors?.document_id).toBeTruthy()
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  test('kontakt jiné firmy → chyba, žádná evidence', async () => {
    fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), docRoute, (c) =>
      c.table === 'contact' ? { data: null, error: null } : undefined,
    )
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01', accepted_by_contact_id: '9' }))
    expect(r.fieldErrors?.accepted_by_contact_id).toBeTruthy()
    expect(recordEvidence).not.toHaveBeenCalled()
  })

  test('vybraný dokument → evidence (service role, file, id dokumentu) → přijato s evidence id', async () => {
    const fake = fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), docRoute, updateOk)
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
    expect(r).toEqual({ success: true })
    expect(createAdminClient).toHaveBeenCalled()
    expect(recordEvidence).toHaveBeenCalledWith(
      { admin: true },
      { kind: 'file', sourceId: 'engagement_document:5', webLink: DOC_URL },
      `user:${USER.id}`,
    )
    const upd = fake.calls.find((c) => c.table === 'engagement_milestone' && hasOp(c, 'update'))!
    expect(upd.ops.find((o) => o.method === 'update')!.args[0]).toEqual({
      status: 'prijato',
      accepted_at: '2026-09-01T12:00:00Z',
      accepted_by_contact_id: null,
      acceptance_evidence_id: 77,
    })
    expect(upd.ops).toContainEqual({ method: 'eq', args: ['status', 'ceka_na_schvaleni'] })
    // Dokument se naváže na milník (jen když ještě navázaný není).
    const link = fake.calls.find((c) => c.table === 'engagement_document' && hasOp(c, 'update'))!
    expect(link.ops).toContainEqual({ method: 'update', args: [{ milestone_id: 3 }] })
    expect(link.ops).toContainEqual({ method: 'is', args: ['milestone_id', null] })
    expect(recordAudit).toHaveBeenCalledWith(
      'engagement_milestone',
      3,
      'milestone.accepted',
      { status: 'ceka_na_schvaleni' },
      expect.objectContaining({ acceptance_evidence_id: 77 }),
      { type: 'user', id: USER.id },
      { evidenceId: 77, infoState: 'human_confirmed' },
    )
  })

  describe('verze dokumentu (0094)', () => {
    const sentDoc = (extra: Record<string, unknown> = {}): Route => (c) =>
      c.table === 'engagement_document' && isRead(c)
        ? { data: { id: 5, url: DOC_URL, milestone_id: null, status: 'sent', approved_version_id: 12, ...extra }, error: null }
        : undefined
    const noFinding: Route = (c) => (c.table === 'engagement_document_finding' ? { data: [], error: null } : undefined)

    test('odeslaný dokument se schválenou verzí: evidence nese verzi, milník na ni odkazuje, dokument je přijatý', async () => {
      const fake = fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), noFinding, sentDoc(), updateOk)
      const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
      expect(r).toEqual({ success: true })
      expect(recordEvidence).toHaveBeenCalledWith(
        { admin: true },
        { kind: 'file', sourceId: 'engagement_document:5@v12', webLink: DOC_URL },
        `user:${USER.id}`,
      )
      const upd = fake.calls.find((c) => c.table === 'engagement_milestone' && hasOp(c, 'update'))!
      expect(upd.ops.find((o) => o.method === 'update')!.args[0]).toEqual({
        status: 'prijato',
        accepted_at: '2026-09-01T12:00:00Z',
        accepted_by_contact_id: null,
        acceptance_evidence_id: 77,
        acceptance_document_version_id: 12,
      })
      // Nejdřív vazba na milník, pak stav dokumentu (DB přijetí dovolí až s přijatým milníkem).
      const docUpdates = fake.calls.filter((c) => c.table === 'engagement_document' && hasOp(c, 'update'))
      expect(docUpdates.map((c) => c.ops.find((o) => o.method === 'update')!.args[0])).toEqual([{ milestone_id: 3 }, { status: 'accepted' }])
      expect(docUpdates[1].ops).toContainEqual({ method: 'eq', args: ['status', 'sent'] })
    })

    test('dokument se od schválení změnil (otevřený nález) → akceptace neprojde, nic se nezapíše', async () => {
      const fake = fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), sentDoc(), (c) =>
        c.table === 'engagement_document_finding' ? { data: [{ id: 1 }], error: null } : undefined, updateOk)
      const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
      expect(r.success).toBe(false)
      expect(r.fieldErrors?.document_id).toMatch(/od schválení změnil/)
      expect(recordEvidence).not.toHaveBeenCalled()
      expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
    })

    test('koncept bez schválení nese starou evidenci bez verze', async () => {
      fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), noFinding, sentDoc({ status: 'draft', approved_version_id: null }), updateOk)
      await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
      expect(recordEvidence).toHaveBeenCalledWith(
        { admin: true },
        { kind: 'file', sourceId: 'engagement_document:5', webLink: DOC_URL },
        `user:${USER.id}`,
      )
    })

    test('migrace 0094 ještě neběžela → čte se původní tvar dokumentu a akceptace funguje jako dřív', async () => {
      let reads = 0
      const fake = fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), (c) => {
        if (c.table !== 'engagement_document' || !isRead(c)) return undefined
        return ++reads === 1
          ? { data: null, error: { code: '42703', message: 'column engagement_document.status does not exist' } }
          : { data: { id: 5, url: DOC_URL, milestone_id: null }, error: null }
      }, updateOk)
      const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
      expect(r).toEqual({ success: true })
      const upd = fake.calls.find((c) => c.table === 'engagement_milestone' && hasOp(c, 'update'))!
      expect(JSON.stringify(upd.ops.find((o) => o.method === 'update')!.args[0])).not.toContain('acceptance_document_version_id')
    })
  })

  test('po migraci 0064 zapíše akceptaci DB trigger (evidence ze sloupce) → appka audit nepíše', async () => {
    vi.mocked(dbAuditActive).mockResolvedValue(true)
    const fake = fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), docRoute, updateOk)
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
    expect(r).toEqual({ success: true })
    const upd = fake.calls.find((c) => c.table === 'engagement_milestone' && hasOp(c, 'update'))!
    expect(upd.ops.find((o) => o.method === 'update')!.args[0]).toMatchObject({ acceptance_evidence_id: 77 })
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('nový odkaz → založí dokument dodávky navázaný na milník, pak evidence', async () => {
    const fake = fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), (c) =>
      c.table === 'engagement_document' && hasOp(c, 'insert')
        ? { data: { id: 11, url: DOC_URL, milestone_id: 3 }, error: null }
        : undefined,
    updateOk)
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ new_title: 'Potvrzení e-mailem', new_url: DOC_URL, accepted_on: '2026-09-01' }))
    expect(r).toEqual({ success: true })
    const ins = fake.calls.find((c) => c.table === 'engagement_document' && hasOp(c, 'insert'))!
    expect(ins.ops.find((o) => o.method === 'insert')!.args[0]).toMatchObject({
      engagement_id: 2,
      milestone_id: 3,
      url: DOC_URL,
      created_by: USER.id,
    })
    expect(recordEvidence).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceId: 'engagement_document:11' }), expect.any(String))
  })

  test('selhání zápisu evidence → milník zůstane nepřijatý', async () => {
    vi.mocked(recordEvidence).mockResolvedValue({ ok: false, reason: 'db_error', message: 'x' })
    const fake = fakeWith(engagementOf(1), milestoneIn('ceka_na_schvaleni'), docRoute, updateOk)
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', accepted_on: '2026-09-01' }))
    expect(r.success).toBe(false)
    expect(fake.calls.some((c) => c.table === 'engagement_milestone' && hasOp(c, 'update'))).toBe(false)
  })

  test('vybrat dokument i zadat nový odkaz zároveň nejde', async () => {
    fakeWith()
    const r = await acceptMilestone(1, 2, 3, undefined, fd({ document_id: '5', new_title: 'x', new_url: DOC_URL, accepted_on: '2026-09-01' }))
    expect(r.fieldErrors?.document_id).toBeTruthy()
  })
})

describe('deleteMilestone', () => {
  test('přijatý milník smazat nejde', async () => {
    const fake = fakeWith(milestoneIn('prijato', { accepted_at: 'x', acceptance_evidence_id: 1 }))
    const r = await deleteMilestone(1, 2, 3)
    expect(r.success).toBe(false)
    expect(fake.calls.some((c) => hasOp(c, 'delete'))).toBe(false)
  })

  test('nepřijatý milník se smaže v rámci dodávky', async () => {
    const fake = fakeWith(milestoneIn('v_praci'), updateOk)
    expect(await deleteMilestone(1, 2, 3)).toEqual({ success: true })
    const del = fake.calls.find((c) => hasOp(c, 'delete'))!
    expect(del.ops).toContainEqual({ method: 'eq', args: ['engagement_id', 2] })
  })

  test('před migrací 0042 → klidná hláška', async () => {
    fakeWith((c) => (c.table === 'engagement_milestone' ? { data: null, error: { code: 'PGRST205', message: 'could not find the table' } } : undefined))
    expect(await deleteMilestone(1, 2, 3)).toEqual({ success: false, error: 'Milníky ještě nejsou dostupné — čekají na migraci 0042.' })
  })
})
