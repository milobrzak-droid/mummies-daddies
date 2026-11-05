import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryDb, type MemoryDbOptions } from './helpers/memoryDb'

// Fronta Oslovování a nesouhlas s oslovením (0087): kdo u firmy nesouhlasí
// (políčko i poznámka), firma, kde nesouhlasí všichni, se nenabídne, ostatní
// nesou štítek. Dotazy běží nad databází v paměti; Supabase je falešný.

let db: MemoryDb
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db.client }))

import { loadAccountOptOut } from '@/domain/crm/queries/outreachOptOut'
import { getOutreachQueue, getOutreachQueueDetail } from '@/domain/crm/queries/outreach'

const OLD = '2026-08-01T08:00:00Z' // 21+ dní ticha vůči TODAY
const TODAY = new Date('2026-09-29T08:00:00Z')

function seed(opts: MemoryDbOptions = {}) {
  db = new MemoryDb(opts)
  const acc = (id: number, name: string, notes: string | null = null) => ({
    id, name, notes, last_inbound_at: null, last_outbound_at: OLD, nudged_on: null, snooze_until: null,
  })
  db.seed('account', [acc(1, 'Alfa'), acc(2, 'Beta'), acc(3, 'Gama'), acc(4, 'Delta', 'Neoslovovat, řeší se přes partnera.'), acc(5, 'Epsilon')])
  const c = (id: number, account_id: number, over: Record<string, unknown> = {}) => ({ id, account_id, full_name: `K${id}`, notes: null, do_not_contact: false, ...over })
  db.seed('contact', [
    c(11, 1, { do_not_contact: true }),
    c(12, 1, { notes: 'Nechce být kontaktován.' }),
    c(21, 2, { do_not_contact: true }),
    c(22, 2),
    c(31, 3),
    c(41, 4),
  ])
  db.seed('deal', [])
}

beforeEach(() => seed())

describe('loadAccountOptOut', () => {
  it('počty podle firmy: políčko i poznámka kontaktu, zákaz v poznámce firmy; firmy bez kontaktů 0 z 0', async () => {
    const m = await loadAccountOptOut(db.client as never, [1, 2, 3, 4, 5])
    expect(m.get(1)).toEqual({ opted_out: 2, total: 2, account_note: false })
    expect(m.get(2)).toEqual({ opted_out: 1, total: 2, account_note: false })
    expect(m.get(3)).toEqual({ opted_out: 0, total: 1, account_note: false })
    expect(m.get(4)).toEqual({ opted_out: 0, total: 1, account_note: true })
    expect(m.get(5)).toEqual({ opted_out: 0, total: 0, account_note: false })
  })

  it('bez migrace 0087 (sloupec chybí) rozhoduje poznámka', async () => {
    seed({
      fail: (table, op, _p, cols) => (table === 'contact' && op === 'select' && cols?.includes('do_not_contact')
        ? { code: '42703', message: 'column contact.do_not_contact does not exist' } : null),
    })
    const m = await loadAccountOptOut(db.client as never, [1, 2])
    expect(m.get(1)).toEqual({ opted_out: 1, total: 2, account_note: false })
    expect(m.get(2)).toEqual({ opted_out: 0, total: 2, account_note: false })
  })

  it('jiná chyba se nezamaskuje; prázdný vstup nic nečte', async () => {
    seed({ fail: (table) => (table === 'contact' ? { code: '57014', message: 'timeout' } : null) })
    await expect(loadAccountOptOut(db.client as never, [1])).rejects.toMatchObject({ code: '57014' })
    expect((await loadAccountOptOut(db.client as never, [])).size).toBe(0)
  })
})

describe('getOutreachQueueDetail', () => {
  it('Alfa (nesouhlasí všichni) a Delta (poznámka firmy) se nenabídnou; Beta nese štítek 1 z 2', async () => {
    const { queue, excludedOptOut } = await getOutreachQueueDetail(TODAY)
    expect(queue.map((q) => q.name).sort()).toEqual(['Beta', 'Epsilon', 'Gama'])
    expect(excludedOptOut).toBe(2)
    expect(queue.find((q) => q.name === 'Beta')!.opt_out).toEqual({ opted_out: 1, total: 2, account_note: false })
    expect(queue.find((q) => q.name === 'Gama')!.opt_out).toBeNull()
    expect((await getOutreachQueue(TODAY)).map((q) => q.account_id).sort()).toEqual([2, 3, 5])
  })
})
