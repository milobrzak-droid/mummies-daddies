// Zápis schůzky doplní naplánovanou schůzku téhož klienta a dne, místo aby
// vznikl druhý řádek (domain/crm/plannedMeetingPairing.ts) — pro příjem
// z Wispr Flow (ingestMeetingNote) i pro skill (createActivity, MCP/REST).
// Nad databází v paměti; idempotence, tolerance a „radši nic než špatně".
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryDb, type Row } from './helpers/memoryDb'

const state = vi.hoisted(() => ({ db: null as unknown }))
const mem = () => state.db as MemoryDb

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mem().client }))
vi.mock('@/core/auditDb', () => ({ createAuditedAdminClient: () => mem().client, dbAuditActive: async () => true }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { assignQueuedNote, ingestMeetingNote } from '@/domain/crm/meetingIntakeService'
import { createActivity } from '@/domain/crm/apiWrite'
import { mergeNoteWithPlan, PLANNED_NOTE_SEPARATOR } from '@/domain/crm/plannedMeetingPairing'
import { lastApiMeetingNoteAt } from '@/domain/crm/queries/meetingNotes'

const KEY_OWNER = '11111111-1111-4111-8111-111111111111'
const NOW = new Date('2026-09-29T15:00:00Z')
const ctx = { createdBy: KEY_OWNER, canSeeSales: true, now: NOW }

// Sigmaform má dnes v 10:00 Praha (08:00Z) schůzku naplánovanou z Cockpitu.
const PLANNED: Row = {
  id: 41, account_id: 1, partner_id: null, kind: 'meeting', outcome: 'planned', source: 'cockpit', external_id: null,
  subject: 'Workshop AI – Sigmaform', body: 'Agenda: mapa procesů\n\nPřipojení: https://teams.microsoft.com/l/x',
  occurred_at: '2026-09-29T08:00:00+00:00', follow_up_on: '2026-10-09', ms_event_id: 'ev-41', created_by: KEY_OWNER,
  created_at: '2026-09-20T10:00:00Z', contact_id: null, deal_id: null,
}

function freshDb(opts: ConstructorParameters<typeof MemoryDb>[0] = {}) {
  const db = new MemoryDb({
    unique: {
      meeting_note_intake: [{ columns: ['dedupe_key'] }],
      sales_activity: [{ columns: ['source', 'external_id'] }],
      evidence: [{ columns: ['source_kind', 'source_id'] }],
      case_proposal: [{ columns: ['capability', 'source_key'] }],
    },
    defaults: { sales_activity: () => ({ created_at: NOW.toISOString() }) },
    ...opts,
  })
  db.seed('account', [
    { id: 1, name: 'Sigmaform s.r.o.', ico: '27082440', web: null },
    { id: 2, name: 'K2 atelier s.r.o.', ico: '25596641', web: null },
  ])
  db.seed('contact', [{ id: 5, account_id: 1, partner_id: null, email: 'jan@sigmaform.cz' }])
  db.seed('deal', [{ id: 8, account_id: 1 }])
  db.seed('sales_activity', [{ ...PLANNED }])
  state.db = db
  return db
}

const activities = () => mem().rows('sales_activity')
const planned = () => activities().find((r) => r.id === 41)!

beforeEach(() => {
  freshDb()
})

describe('mergeNoteWithPlan', () => {
  test('zápis nahoře, poznámka z plánu pod oddělovačem; stejný název se neopakuje', () => {
    expect(mergeNoteWithPlan({ subject: 'Workshop', body: 'Agenda' }, { title: 'Workshop', text: 'Probrali jsme mapu.' }))
      .toBe(`Probrali jsme mapu.\n\n${PLANNED_NOTE_SEPARATOR}\nAgenda`)
    expect(mergeNoteWithPlan({ subject: 'Workshop', body: null }, { title: 'Zápis z workshopu', text: 'Text' }))
      .toBe('Zápis z workshopu\n\nText')
  })
})

describe('příjem z Wispr Flow (ingestMeetingNote)', () => {
  const note = { text: 'Zápis: probrali jsme mapu procesů, klient pošle data.', client_hint: 'Sigmaform', occurred_at: '2026-09-29' }

  test('zápis ke klientovi se schůzkou naplánovanou týž den ji doplní — žádný druhý řádek', async () => {
    const r = await ingestMeetingNote(note, ctx)
    expect(r).toMatchObject({ ok: true, data: { status: 'assigned', account_id: 1, activity_id: 41, paired_planned: true } })
    expect(activities()).toHaveLength(1)
    expect(planned()).toMatchObject({
      outcome: 'completed',
      source: 'wispr_flow',
      external_id: `intake:${r.ok ? r.data.id : 0}`,
      note_received_at: NOW.toISOString(),
      // Předmět a začátek z plánu (Outlook je pravda o termínu).
      subject: 'Workshop AI – Sigmaform',
      occurred_at: '2026-09-29T08:00:00+00:00',
    })
    const body = String(planned().body)
    expect(body.startsWith('Zápis: probrali jsme mapu procesů')).toBe(true)
    expect(body).toContain(`${PLANNED_NOTE_SEPARATOR}\nAgenda: mapa procesů`)
    // Řádek fronty je vyřízený a odkazuje na doplněnou schůzku.
    expect(mem().rows('meeting_note_intake')[0]).toMatchObject({ status: 'assigned', activity_id: 41, body: null })
  })

  test('opakované odeslání téhož zápisu nic nezdvojí ani nepřepíše', async () => {
    await ingestMeetingNote(note, ctx)
    const snapshot = JSON.stringify(activities())
    const again = await ingestMeetingNote(note, { ...ctx, now: new Date('2026-09-29T16:00:00Z') })
    expect(again).toMatchObject({ ok: true, data: { duplicate: true, activity_id: 41 } })
    expect(JSON.stringify(activities())).toBe(snapshot)
  })

  test('pád po doplnění (řádek fronty se neuzavřel) → ruční přiřazení doplněnou schůzku najde, druhý řádek nevznikne', async () => {
    let failClose = true
    freshDb({
      fail: (table, op) => {
        if (table === 'meeting_note_intake' && op === 'update' && failClose) {
          failClose = false
          return { code: '08006', message: 'connection failure' }
        }
        return null
      },
    })
    const r = await ingestMeetingNote(note, ctx)
    expect(r).toMatchObject({ ok: true, data: { status: 'unmatched', reason: 'assign_failed' } })
    expect(planned().outcome).toBe('completed')

    const manual = await assignQueuedNote({ noteId: r.ok ? r.data.id : 0, accountId: 1, userId: KEY_OWNER, now: NOW })
    expect(manual).toMatchObject({ ok: true, data: { activityId: 41 } })
    expect(activities()).toHaveLength(1)
  })

  test('jiný den → nová aktivita, naplánovaná schůzka zůstane', async () => {
    const r = await ingestMeetingNote({ ...note, occurred_at: '2026-09-28' }, ctx)
    expect(r.ok && r.data.paired_planned).toBeFalsy()
    expect(activities()).toHaveLength(2)
    expect(planned().outcome).toBe('planned')
  })

  test('dvě naplánované schůzky stejně daleko → radši nespárovat nic', async () => {
    mem().seed('sales_activity', [{ ...PLANNED, id: 42, ms_event_id: 'ev-42', occurred_at: '2026-09-29T12:00:00+00:00' }])
    // Zápis bez hodiny = poledne Praha (10:00Z): schůzky v 8:00Z a 12:00Z jsou obě 2 h daleko.
    const r = await ingestMeetingNote(note, ctx)
    expect(r.ok && r.data.paired_planned).toBeFalsy()
    expect(activities().filter((a) => a.outcome === 'planned')).toHaveLength(2)
    expect(activities()).toHaveLength(3)
  })

  test('schůzka, která ještě nezačala, se zápisem o dřívějším hovoru neodbaví', async () => {
    // Zápis přijatý v 11:00 Praha o hovoru v 10:00; schůzka je naplánovaná na 16:00.
    planned().occurred_at = '2026-09-29T14:00:00+00:00'
    const r = await ingestMeetingNote({ ...note, occurred_at: '2026-09-29T08:00:00Z' }, { ...ctx, now: new Date('2026-09-29T09:00:00Z') })
    expect(r.ok && r.data.paired_planned).toBeFalsy()
    expect(planned().outcome).toBe('planned')
    expect(activities()).toHaveLength(2)
  })

  test('zrušená schůzka ani schůzka jiného klienta se nedoplní', async () => {
    planned().outcome = 'cancelled'
    mem().seed('sales_activity', [{ ...PLANNED, id: 43, account_id: 2, ms_event_id: 'ev-43' }])
    const r = await ingestMeetingNote(note, ctx)
    expect(r.ok && r.data.paired_planned).toBeFalsy()
    expect(activities().find((a) => a.id === 43)!.outcome).toBe('planned')
    expect(activities()).toHaveLength(3)
  })
})

describe('skill (createActivity přes MCP / REST)', () => {
  const input = {
    account_id: 1, kind: 'meeting', outcome: 'completed', subject: 'Zápis z workshopu Sigmaform', body: 'Klient pošle data do pátku.',
    occurred_at: '2026-09-29T09:10:00Z', contact_id: 5, deal_id: 8, follow_up_on: '2026-10-03',
  }

  test('proběhlá schůzka téhož dne doplní naplánovanou: id schůzky, zdroj api, kontakt, obchod, termín dalšího kontaktu', async () => {
    const r = await createActivity(input, KEY_OWNER, true)
    expect(r).toMatchObject({ ok: true, data: { id: 41, paired_planned: true, planned_at: '2026-09-29T08:00:00+00:00' } })
    expect(activities()).toHaveLength(1)
    expect(planned()).toMatchObject({
      outcome: 'completed', source: 'api', contact_id: 5, deal_id: 8, follow_up_on: '2026-10-03', subject: 'Workshop AI – Sigmaform',
    })
    expect(String(planned().body)).toMatch(/^Zápis z workshopu Sigmaform\n\nKlient pošle data do pátku\./)
    expect(typeof planned().note_received_at).toBe('string')
    // „Stav zdrojů": zápis přes skill se počítá podle času přijetí, ne podle plánování.
    expect(await lastApiMeetingNoteAt(mem().client as never)).toBe(planned().note_received_at)
  })

  test('druhý zápis ke stejné (už doplněné) schůzce založí vlastní řádek', async () => {
    await createActivity(input, KEY_OWNER, true)
    const second = await createActivity({ ...input, body: 'Doplnění.' }, KEY_OWNER, true)
    expect(second.ok && second.data.paired_planned).toBeFalsy()
    expect(activities()).toHaveLength(2)
  })

  test('hovor, nebo schůzka s jiným výsledkem než „proběhla", se s plánem nepáruje', async () => {
    await createActivity({ ...input, kind: 'call' }, KEY_OWNER, true)
    await createActivity({ ...input, outcome: 'follow_up' }, KEY_OWNER, true)
    expect(planned().outcome).toBe('planned')
    expect(activities()).toHaveLength(3)
  })

  test('bez migrace 0085 (chybí note_received_at) se schůzka doplní i tak', async () => {
    freshDb({
      fail: (table, op, payload) =>
        table === 'sales_activity' && op === 'update' && payload && typeof payload === 'object' && 'note_received_at' in payload
          ? { code: 'PGRST204', message: "Could not find the 'note_received_at' column" }
          : null,
    })
    const r = await createActivity(input, KEY_OWNER, true)
    expect(r).toMatchObject({ ok: true, data: { id: 41, paired_planned: true } })
    expect(planned()).toMatchObject({ outcome: 'completed', source: 'api' })
    expect(planned().note_received_at).toBeUndefined()
  })
})
