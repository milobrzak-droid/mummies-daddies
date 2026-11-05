import { describe, expect, test } from 'vitest'
import {
  accountFullyOptedOut,
  accountHasOptOut,
  applyOutreachOptOut,
  contactOptOut,
  foldText,
  matchesSearch,
  mergeLatest,
  noteSaysDoNotContact,
  outreachBlockReason,
  paginate,
  searchTokens,
  selectOutreachContacts,
  summarizeAccountOptOut,
  toOutreachContact,
  type ContactCandidate,
  type TargetRef,
} from '@/domain/crm/outreachContacts'

// Kontakty k oslovení (konektor Cowork): kdo se nesmí oslovit, hledání,
// řazení a stránkování. Čisté funkce, žádné I/O.

const TODAY = '2026-09-29'

const account = (over: Partial<NonNullable<ContactCandidate['account']>> = {}) => ({
  id: 1, name: 'Alfa s.r.o.', notes: null, snooze_until: null, ...over,
})
const contact = (over: Partial<ContactCandidate> = {}): ContactCandidate => ({
  id: 1, full_name: 'Jana Nováková', role: 'CFO', email: 'jana@alfa.cz', phone: '+420 111 222 333',
  notes: null, do_not_contact: false, account: account(), ...over,
})

describe('noteSaysDoNotContact: výslovný nesouhlas v poznámce', () => {
  test.each([
    'Nekontaktovat — požádal o to 3. 9.',
    'NEOSLOVOVAT do odvolání',
    'Nechce být kontaktován.',
    'Paní ředitelka nechce být oslovována obchodníky.',
    'nechce už další kontakt',
    'Nechce, abychom ho kontaktovali.',
    'Nepřeje si být kontaktována.',
    'Odhlásila se z odběru newsletteru.',
    'odhlášen z mailingu 2026-08',
    'Zákaz kontaktu (vedení).',
    'Odvolal souhlas se zasíláním.',
    'Nesouhlasí se zpracováním osobních údajů.',
    'Nesouhlas s oslovením.',
    'Námitka proti zpracování pro marketing',
    'GDPR námitka 12. 9.',
    'Požádal o výmaz údajů.',
    'Unsubscribed via link',
    'opt-out',
    'Opted out in June',
    'Do not contact',
  ])('ano: %s', (note) => {
    expect(noteSaysDoNotContact(note)).toBe(true)
  })

  test.each([
    'Nesouhlasí s cenou, poslat novou nabídku.',
    'Nesouhlasí se zpracováním dat v cloudu, chce on-premise.',
    'Odhlásil se ze školení 12. 10.',
    'Řeší GDPR audit, výmaz starých dat po projektu.',
    'Kontaktovat po 15. 10.',
    'Nechce pilot — oslovit znovu v listopadu.',
    'Chce nabídku na Copilot.',
    'Kontakt přes asistentku.',
    'Opt-in do newsletteru potvrzen.',
    '',
  ])('ne: %s', (note) => {
    expect(noteSaysDoNotContact(note)).toBe(false)
  })

  test('prázdná poznámka', () => {
    expect(noteSaysDoNotContact(null)).toBe(false)
    expect(noteSaysDoNotContact(undefined)).toBe(false)
  })

  test('poznámka firmy: jen přímý zákaz oslovení, ne smlouva ani projekt', () => {
    expect(noteSaysDoNotContact('Neoslovovat, řeší se přes partnera.', 'account')).toBe(true)
    expect(noteSaysDoNotContact('Firma nechce být oslovována.', 'account')).toBe(true)
    for (const note of [
      'Smlouva má opt-out po 12 měsících.',
      'Po projektu požádali o výmaz testovacích dat.',
      'Chtějí automatizovat unsubscribe v e-shopu.',
      'Odvolali souhlas s pilotem, pokračujeme workshopem.',
    ]) {
      expect(noteSaysDoNotContact(note, 'account'), note).toBe(false)
    }
    // Tentýž text u člověka je jeho odhlášení.
    expect(noteSaysDoNotContact('opt-out', 'contact')).toBe(true)
  })
})

describe('outreachBlockReason', () => {
  test('odložené oslovení firmy platí do zadaného pražského dne včetně', () => {
    expect(outreachBlockReason(contact({ account: account({ snooze_until: '2026-09-30' }) }), TODAY)).toBe('account_snoozed')
    expect(outreachBlockReason(contact({ account: account({ snooze_until: TODAY }) }), TODAY)).toBeNull()
    expect(outreachBlockReason(contact({ account: account({ snooze_until: '2026-01-01' }) }), TODAY)).toBeNull()
  })

  test('nesouhlas v poznámce kontaktu i firmy', () => {
    expect(outreachBlockReason(contact({ notes: 'Nekontaktovat.' }), TODAY)).toBe('note_opt_out')
    expect(outreachBlockReason(contact({ notes: 'Odhlásil se z odběru.' }), TODAY)).toBe('note_opt_out')
    expect(outreachBlockReason(contact({ account: account({ notes: 'Firma nechce být oslovována.' }) }), TODAY)).toBe('note_opt_out')
    expect(outreachBlockReason(contact({ account: account({ notes: 'Smlouva má opt-out po roce.' }) }), TODAY)).toBeNull()
    expect(outreachBlockReason(contact({ notes: 'Volat ráno.' }), TODAY)).toBeNull()
  })

  test('bez firmy rozhoduje jen kontakt (políčko, poznámka)', () => {
    expect(outreachBlockReason({ notes: null, account: null }, TODAY)).toBeNull()
    expect(outreachBlockReason({ notes: null, do_not_contact: true, account: null }, TODAY)).toBe('contact_opt_out')
  })

  test('políčko „Nesouhlasí s oslovením" má přednost před odložením i poznámkou', () => {
    expect(outreachBlockReason(contact({ do_not_contact: true }), TODAY)).toBe('contact_opt_out')
    expect(outreachBlockReason(contact({ do_not_contact: true, notes: 'Nekontaktovat.', account: account({ snooze_until: '2999-01-01' }) }), TODAY))
      .toBe('contact_opt_out')
  })

  test('poznámka zůstává druhou pojistkou i bez políčka (před migrací 0087 undefined)', () => {
    expect(outreachBlockReason({ notes: 'Nekontaktovat.', account: null }, TODAY)).toBe('note_opt_out')
    expect(outreachBlockReason(contact({ do_not_contact: false, notes: 'Odvolal souhlas.' }), TODAY)).toBe('note_opt_out')
  })
})

describe('nesouhlas u kontaktu a u firmy', () => {
  test('contactOptOut: políčko, pak poznámka', () => {
    expect(contactOptOut({ do_not_contact: true, notes: null })).toBe('flag')
    expect(contactOptOut({ do_not_contact: true, notes: 'Nekontaktovat.' })).toBe('flag')
    expect(contactOptOut({ do_not_contact: false, notes: 'Nekontaktovat.' })).toBe('note')
    expect(contactOptOut({ notes: 'Volat ráno.' })).toBeNull()
    expect(contactOptOut({ do_not_contact: null, notes: null })).toBeNull()
  })

  test('summarizeAccountOptOut: počty lidí a zákaz v poznámce firmy (jen přímý)', () => {
    const people = [{ do_not_contact: true, notes: null }, { notes: 'Nechce být kontaktován.' }, { do_not_contact: false, notes: null }]
    expect(summarizeAccountOptOut(null, people)).toEqual({ opted_out: 2, total: 3, account_note: false })
    expect(summarizeAccountOptOut('Neoslovovat.', [])).toEqual({ opted_out: 0, total: 0, account_note: true })
    expect(summarizeAccountOptOut('Smlouva má opt-out po roce.', []).account_note).toBe(false)
  })

  test('firma: celá vyřazená jen když nesouhlasí všichni nebo poznámka firmy; štítek už při jednom', () => {
    expect(accountFullyOptedOut({ opted_out: 2, total: 2, account_note: false })).toBe(true)
    expect(accountFullyOptedOut({ opted_out: 1, total: 2, account_note: false })).toBe(false)
    expect(accountFullyOptedOut({ opted_out: 0, total: 0, account_note: false })).toBe(false)
    expect(accountFullyOptedOut({ opted_out: 0, total: 0, account_note: true })).toBe(true)
    expect(accountFullyOptedOut(null)).toBe(false)
    expect(accountHasOptOut({ opted_out: 1, total: 3, account_note: false })).toBe(true)
    expect(accountHasOptOut({ opted_out: 0, total: 3, account_note: false })).toBe(false)
    expect(accountHasOptOut(undefined)).toBe(false)
  })

  test('applyOutreachOptOut: vynechá firmy, kde nesouhlasí všichni; ostatním dá štítek, pořadí drží', () => {
    const queue = [{ account_id: 1, n: 'a' }, { account_id: 2, n: 'b' }, { account_id: 3, n: 'c' }, { account_id: 4, n: 'd' }]
    const by = new Map([
      [1, { opted_out: 1, total: 1, account_note: false }],
      [2, { opted_out: 1, total: 3, account_note: false }],
      [3, { opted_out: 0, total: 2, account_note: false }],
    ])
    const { queue: out, excluded } = applyOutreachOptOut(queue, by)
    expect(excluded).toBe(1)
    expect(out.map((q) => q.account_id)).toEqual([2, 3, 4])
    expect(out[0].opt_out).toEqual({ opted_out: 1, total: 3, account_note: false })
    expect(out[1].opt_out).toBeNull()
    expect(out[2].opt_out).toBeNull()
  })
})

describe('hledání', () => {
  test('bez diakritiky a velikosti písmen, víc slov = všechna musí sedět', () => {
    const fields = ['Jana Nováková', 'Finanční ředitelka', 'jana@alfa.cz', 'Alfa s.r.o.']
    expect(matchesSearch(searchTokens('novakova'), fields)).toBe(true)
    expect(matchesSearch(searchTokens('FINANCNI reditelka'), fields)).toBe(true)
    expect(matchesSearch(searchTokens('jana alfa'), fields)).toBe(true)
    expect(matchesSearch(searchTokens('@alfa.cz'), fields)).toBe(true)
    expect(matchesSearch(searchTokens('jana beta'), fields)).toBe(false)
  })

  test('prázdný dotaz nic nefiltruje', () => {
    expect(searchTokens('   ')).toBeNull()
    expect(searchTokens(undefined)).toBeNull()
    expect(matchesSearch(null, ['x'])).toBe(true)
  })

  test('foldText sjednotí mezery a diakritiku', () => {
    expect(foldText('  Žluťoučký   KŮŇ ')).toBe('zlutoucky kun')
  })
})

describe('selectOutreachContacts', () => {
  const alfa = account({ id: 1, name: 'Alfa s.r.o.' })
  const beta = account({ id: 2, name: 'Beta a.s.', snooze_until: '2999-01-01' })
  const gama = account({ id: 3, name: 'Gama', notes: 'Nekontaktovat, řeší se přes partnera.' })
  const candidates: ContactCandidate[] = [
    contact({ id: 1, full_name: 'Zdeněk Adam', account: alfa }),
    contact({ id: 2, full_name: 'Anna Bílá', account: alfa }),
    contact({ id: 3, full_name: 'Petr Svoboda', account: alfa, notes: 'Nechce být kontaktován.' }),
    contact({ id: 4, full_name: 'Eva Černá', account: beta }),
    contact({ id: 5, full_name: 'Karel Dvořák', account: gama }),
    contact({ id: 6, full_name: 'Partner Kontakt', account: null }),
    contact({ id: 7, full_name: 'Olga Veselá', account: alfa, do_not_contact: true }),
  ]

  test('vynechané se jen spočítají podle důvodu, partnerský kontakt se nepočítá vůbec', () => {
    const { selected, excluded } = selectOutreachContacts({ candidates, today: TODAY })
    expect(selected.map((s) => s.candidate.id)).toEqual([2, 1])
    expect(excluded).toEqual({ count: 4, contact_opt_out: 1, account_snoozed: 1, note_opt_out: 2 })
  })

  test('hledání se vyhodnotí před vynecháním: počet vynechaných je jen z odpovídajících', () => {
    const { selected, excluded } = selectOutreachContacts({ candidates, today: TODAY, search: searchTokens('beta') })
    expect(selected).toEqual([])
    expect(excluded).toEqual({ count: 1, contact_opt_out: 0, account_snoozed: 1, note_opt_out: 0 })
  })

  test('člověk s políčkem nesouhlasu se nevrátí ani při hledání jménem, jen se započítá', () => {
    const { selected, excluded } = selectOutreachContacts({ candidates, today: TODAY, search: searchTokens('vesela') })
    expect(selected).toEqual([])
    expect(excluded).toEqual({ count: 1, contact_opt_out: 1, account_snoozed: 0, note_opt_out: 0 })
  })

  test('seznam k oslovení: jen firmy ze seznamu, hlavní kontakt první', () => {
    const targets = new Map<number, TargetRef>([
      [1, { item_id: 50, list_id: 5, account_id: 1, contact_id: 1, status: 'navrzeno' }],
    ])
    const { selected } = selectOutreachContacts({ candidates, today: TODAY, targets })
    expect(selected.map((s) => s.candidate.id)).toEqual([1, 2])
    const out = toOutreachContact(selected[0], new Map())
    expect(out.target).toEqual({ list_id: 5, item_id: 50, status: 'navrzeno', main_contact: true })
    expect(toOutreachContact(selected[1], new Map()).target?.main_contact).toBe(false)
  })

  test('výstup nese jen pole potřebná k oslovení', () => {
    const { selected } = selectOutreachContacts({ candidates: [contact({ notes: 'Volat ráno.' })], today: TODAY })
    const out = toOutreachContact(selected[0], new Map([[1, '2026-09-20T08:00:00.000Z']]))
    expect(out).toEqual({
      id: 1, full_name: 'Jana Nováková', role: 'CFO', email: 'jana@alfa.cz', phone: '+420 111 222 333',
      account: { id: 1, name: 'Alfa s.r.o.' }, last_activity_at: '2026-09-20T08:00:00.000Z',
    })
    expect(JSON.stringify(out)).not.toContain('Volat')
  })
})

describe('stránkování a poslední aktivita', () => {
  test('paginate: next_offset jen když něco zbývá', () => {
    const all = [1, 2, 3, 4, 5]
    expect(paginate(all, 2, 0)).toEqual({ items: [1, 2], total: 5, next_offset: 2 })
    expect(paginate(all, 2, 4)).toEqual({ items: [5], total: 5, next_offset: null })
    expect(paginate(all, 5, 0)).toEqual({ items: all, total: 5, next_offset: null })
    expect(paginate(all, 2, 10)).toEqual({ items: [], total: 5, next_offset: null })
  })

  test('mergeLatest: vyhraje pozdější čas z kteréhokoli zdroje, prázdné řádky se přeskočí', () => {
    const into = new Map<number, string>()
    mergeLatest(into, [
      { contact_id: 1, occurred_at: '2026-09-01T10:00:00+00:00' },
      { contact_id: 1, occurred_at: '2026-08-01T10:00:00+00:00' },
      { contact_id: null, occurred_at: '2026-09-28T10:00:00Z' },
      { contact_id: 2, occurred_at: null },
      { contact_id: 3, occurred_at: 'nesmysl' },
    ])
    mergeLatest(into, [{ contact_id: 1, occurred_at: '2026-09-02T08:00:00+02:00' }])
    expect([...into]).toEqual([[1, '2026-09-02T06:00:00.000Z']])
  })
})
