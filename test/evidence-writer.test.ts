import { beforeEach, expect, test, vi } from 'vitest'

const auditInsert = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: auditInsert }) }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { recordEvidence, recordAuditWithEvidence, type EvidenceDb } from '@/core/evidence'

// Falešná DB: pamatuje řádky, upsert s ignoreDuplicates nic nepřepíše.
function fakeDb(opts: { upsertError?: string; selectError?: string; throws?: boolean } = {}) {
  const rows: { id: number; source_kind: string; source_id: string; web_link: unknown }[] = []
  const upsert = vi.fn(async (row: Record<string, unknown>, o: { ignoreDuplicates: boolean }) => {
    if (opts.throws) throw new Error('síť')
    if (opts.upsertError) return { error: { message: opts.upsertError } }
    const dup = rows.find((r) => r.source_kind === row.source_kind && r.source_id === row.source_id)
    if (!dup || !o.ignoreDuplicates) {
      rows.push({ id: rows.length + 1, source_kind: String(row.source_kind), source_id: String(row.source_id), web_link: row.web_link })
    }
    return { error: null }
  })
  const db = {
    from: () => ({
      upsert,
      select: () => ({
        eq: (_c1: string, kind: string) => ({
          eq: (_c2: string, id: string) => ({
            maybeSingle: async () => {
              if (opts.selectError) return { data: null, error: { message: opts.selectError } }
              const r = rows.find((x) => x.source_kind === kind && x.source_id === id)
              return { data: r ? { id: r.id } : null, error: null }
            },
          }),
        }),
      }),
    }),
  } as unknown as EvidenceDb
  return { db, rows, upsert }
}

const ref = { kind: 'email_message' as const, sourceId: 'AAMk-1', webLink: 'https://outlook.office.com/x' }

beforeEach(() => {
  auditInsert.mockReset()
  auditInsert.mockResolvedValue({ error: null })
})

test('nový zdroj vrátí id a upsert jde s ignoreDuplicates', async () => {
  const { db, upsert } = fakeDb()
  expect(await recordEvidence(db, ref, 'user:u1')).toEqual({ ok: true, id: 1 })
  expect(upsert.mock.calls[0][1]).toEqual({ onConflict: 'source_kind,source_id', ignoreDuplicates: true })
  expect(upsert.mock.calls[0][0]).toMatchObject({ source_kind: 'email_message', source_id: 'AAMk-1', created_by: 'user:u1' })
})

test('stejný zdroj podruhé vrátí stávající id a nepřepíše web_link', async () => {
  const { db, rows } = fakeDb()
  await recordEvidence(db, ref)
  const again = await recordEvidence(db, { ...ref, webLink: 'https://evil.example' })
  expect(again).toEqual({ ok: true, id: 1 })
  expect(rows).toHaveLength(1)
  expect(rows[0].web_link).toBe('https://outlook.office.com/x')
})

test('neplatný odkaz se do DB vůbec nepošle', async () => {
  const { db, upsert } = fakeDb()
  const r = await recordEvidence(db, { kind: 'email_message', sourceId: 'x', webLink: 'javascript:alert(1)' })
  expect(r).toMatchObject({ ok: false, reason: 'invalid' })
  expect(upsert).not.toHaveBeenCalled()
})

test('chyby DB a výjimky vrací typované selhání, nevyhazují', async () => {
  expect(await recordEvidence(fakeDb({ upsertError: 'denied' }).db, ref)).toEqual({ ok: false, reason: 'db_error', message: 'denied' })
  expect(await recordEvidence(fakeDb({ selectError: 'boom' }).db, ref)).toEqual({ ok: false, reason: 'db_error', message: 'boom' })
  expect(await recordEvidence(fakeDb({ throws: true }).db, ref)).toEqual({ ok: false, reason: 'db_error', message: 'síť' })
})

const audit = { entityTable: 'deal', entityId: 7, action: 'deal.stage_changed', before: {}, after: {}, actor: { type: 'user' as const, id: 'u1' } }

test('recordAuditWithEvidence zapíše audit s evidence_id a info_state', async () => {
  const { db } = fakeDb()
  const r = await recordAuditWithEvidence(db, ref, 'source_fact', audit)
  expect(r).toEqual({ ok: true, id: 1 })
  expect(auditInsert.mock.calls[0][0]).toMatchObject({ evidence_id: 1, info_state: 'source_fact' })
})

test('při selhání evidence se audit zapíše bez evidence_id', async () => {
  const { db } = fakeDb({ upsertError: 'denied' })
  await recordAuditWithEvidence(db, ref, 'ai_suggestion', audit)
  expect(auditInsert.mock.calls[0][0]).toMatchObject({ evidence_id: null, info_state: 'ai_suggestion' })
})
