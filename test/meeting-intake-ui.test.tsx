// Karta „Zápisy schůzek z Wispr Flow" v Nastavení, akce fronty a pomocník
// pro čas posledního zápisu ve „Stavu zdrojů".
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturePendingDetailProvider } from '@/components/ui/FeaturePending'
import { renderToStaticMarkup } from 'react-dom/server'
import { MeetingSourcesCard } from '@/components/MeetingSourcesCard'
import { latestOf } from '@/domain/crm/queries/digest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

describe('MeetingSourcesCard', () => {
  it('bez migrace 0078 (stats null) řekne, že se příjem připravuje; čísla migrací jen vedení/správci', () => {
    const html = renderToStaticMarkup(<MeetingSourcesCard stats={null} />)
    expect(html).toContain('Zápisy schůzek z Wispr Flow')
    expect(html).toContain('Příjem zápisů se připravuje')
    expect(html).not.toContain('0078')
    const admin = renderToStaticMarkup(<FeaturePendingDetailProvider show><MeetingSourcesCard stats={null} /></FeaturePendingDetailProvider>)
    expect(admin).toContain('0078')
    expect(admin).toContain('0079')
    expect(html).not.toContain('Čeká na přiřazení')
  })

  it('ukáže počet za 30 dní, čas posledního zápisu a odkaz na frontu, když něco čeká', () => {
    const html = renderToStaticMarkup(
      <MeetingSourcesCard stats={{ received30d: 5, unmatched: 2, lastReceivedAt: '2026-09-28T08:15:00Z' }} />,
    )
    expect(html).toContain('Přijato za posledních 30 dní: 5')
    expect(html).toContain('Čeká na přiřazení: 2')
    expect(html).toContain('href="/cockpit/schuzky/nesparovane"')
    expect(html).toMatch(/Poslední zápis: 28\. ?9\. ?2026/)
  })

  it('nic nečeká → bez odkazu na frontu; nikdy nepřišel zápis → „nikdy"', () => {
    const html = renderToStaticMarkup(<MeetingSourcesCard stats={{ received30d: 0, unmatched: 0, lastReceivedAt: null }} />)
    expect(html).toContain('Poslední zápis: nikdy')
    expect(html).toContain('Čeká na přiřazení: 0')
    expect(html).not.toContain('/cockpit/schuzky/nesparovane')
  })
})

describe('latestOf', () => {
  it('vybere pozdější čas, null ignoruje', () => {
    expect(latestOf(null, null)).toBeNull()
    expect(latestOf('2026-09-01T10:00:00Z', null)).toBe('2026-09-01T10:00:00Z')
    expect(latestOf(null, '2026-09-02T10:00:00Z')).toBe('2026-09-02T10:00:00Z')
    expect(latestOf('2026-09-01T10:00:00Z', '2026-09-02T10:00:00Z')).toBe('2026-09-02T10:00:00Z')
    expect(latestOf('2026-09-03T10:00:00Z', '2026-09-02T10:00:00Z')).toBe('2026-09-03T10:00:00Z')
  })
})

// --- akce fronty ------------------------------------------------------------

const requireUser = vi.fn()
const canSeeSales = vi.fn()
const assignQueuedNote = vi.fn()
const discardQueuedNote = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: (...a: unknown[]) => requireUser(...a),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: () => canSeeSales() }))
vi.mock('@/domain/crm/meetingIntakeService', () => ({
  assignQueuedNote: (...a: unknown[]) => assignQueuedNote(...a),
  discardQueuedNote: (...a: unknown[]) => discardQueuedNote(...a),
}))

import { assignMeetingNote, discardMeetingNote } from '@/domain/crm/actions/meetingIntake'

const form = (fields: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

describe('akce fronty nespárovaných zápisů', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUser.mockResolvedValue({ id: 'u1' })
    canSeeSales.mockResolvedValue(true)
    assignQueuedNote.mockResolvedValue({ ok: true, data: {} })
    discardQueuedNote.mockResolvedValue({ ok: true, data: { id: 3 } })
  })

  it('přiřazení: AAL2 brána, obchodní role, předá id zápisu, klienta a uživatele', async () => {
    expect(await assignMeetingNote(null, form({ note_id: '3', account_id: '42' }))).toEqual({ success: true })
    expect(requireUser).toHaveBeenCalledWith({ aal2: true })
    expect(assignQueuedNote).toHaveBeenCalledWith({ noteId: 3, accountId: 42, userId: 'u1' })
  })

  it('přiřazení: bez přihlášení / bez obchodní role / neplatný vstup nic nezapíše', async () => {
    requireUser.mockResolvedValue(null)
    expect(await assignMeetingNote(null, form({ note_id: '3', account_id: '42' }))).toEqual({ success: false, error: 'auth' })
    requireUser.mockResolvedValue({ id: 'u1' })
    canSeeSales.mockResolvedValue(false)
    expect(await assignMeetingNote(null, form({ note_id: '3', account_id: '42' }))).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    canSeeSales.mockResolvedValue(true)
    expect((await assignMeetingNote(null, form({ note_id: '3', account_id: '' }))).success).toBe(false)
    expect((await assignMeetingNote(null, form({ note_id: 'x', account_id: '4' }))).success).toBe(false)
    expect(assignQueuedNote).not.toHaveBeenCalled()
  })

  it('chyba služby se vrátí uživateli (zápis už vyřízený)', async () => {
    assignQueuedNote.mockResolvedValue({ ok: false, status: 409, error: 'Zápis už je vyřízený. Obnov stránku.' })
    expect(await assignMeetingNote(null, form({ note_id: '3', account_id: '42' }))).toEqual({
      success: false, error: 'Zápis už je vyřízený. Obnov stránku.',
    })
  })

  it('zahození: stejné brány, předá id zápisu a uživatele', async () => {
    expect(await discardMeetingNote(null, form({ note_id: '3' }))).toEqual({ success: true })
    expect(discardQueuedNote).toHaveBeenCalledWith({ noteId: 3, userId: 'u1' })
    canSeeSales.mockResolvedValue(false)
    expect(await discardMeetingNote(null, form({ note_id: '3' }))).toEqual({ success: false, error: 'Nemáš oprávnění.' })
    requireUser.mockResolvedValue(null)
    expect(await discardMeetingNote(null, form({ note_id: '3' }))).toEqual({ success: false, error: 'auth' })
    expect(discardQueuedNote).toHaveBeenCalledTimes(1)
  })
})
