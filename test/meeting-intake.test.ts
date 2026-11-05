// Příjem zápisů schůzek z diktátu — čistá logika (domain/crm/meetingIntake.ts):
// validace vstupu, datum, klíč idempotence, párování na klienta a úkoly z textu.
import { describe, expect, test } from 'vitest'
import {
  MEETING_NOTE_ACTIONS_MAX,
  MEETING_NOTE_BODY_MAX,
  buildStepsProposal,
  canonicalIco,
  dedupeKeyFor,
  extractActionItems,
  icosInHint,
  icosInText,
  isValidIco,
  matchNoteToAccount,
  meetingNoteInput,
  renderProposalTitle,
  resolveOccurredAt,
  subjectFor,
  type MatchAccount,
  type MatchAlias,
  type MatchContact,
  type NoteMatchInput,
} from '@/domain/crm/meetingIntake'

// 27082440 = platné IČO (kontrolní součet), 25596641 také; 12345678 ne.
const ICO_A = '27082440'
const ICO_B = '25596641'

const accounts: MatchAccount[] = [
  { id: 1, name: 'Sigmaform s.r.o.', ico: ICO_A, web: 'https://www.sigmaform.cz/kontakt' },
  { id: 2, name: 'K2 atelier s.r.o.', ico: ICO_B, web: null },
  { id: 3, name: 'Presto a.s.', ico: null, web: null },
  { id: 4, name: 'Presto s.r.o.', ico: null, web: null },
  { id: 5, name: 'Nutrend', ico: null, web: 'nutrend.example' },
  { id: 6, name: 'CCH', ico: null, web: null },
  { id: 7, name: 'Sigmaform Servis a.s.', ico: null, web: null },
]
const aliases: MatchAlias[] = [
  { account_id: 2, alias_domain: 'k2-erp.cz', alias_name: null },
  { account_id: 5, alias_domain: null, alias_name: 'Nutrend Group' },
  { account_id: 3, alias_domain: 'sdilena.cz', alias_name: null },
  { account_id: 4, alias_domain: 'sdilena.cz', alias_name: null },
]
const contacts: MatchContact[] = [
  { account_id: 1, email: 'jana.novakova@sigmaform.cz' },
  { account_id: 6, email: 'petr@gmail.com' },
]

const match = (over: Partial<NoteMatchInput>) =>
  matchNoteToAccount({ clientHint: null, title: null, text: '', accounts, aliases, contacts, ...over })

describe('meetingNoteInput', () => {
  test('minimum: jen text; prázdná volitelná pole = neuvedeno', () => {
    const r = meetingNoteInput.parse({ text: '  Jednání s Sigmaformem.  ', title: '', client_hint: '  ', external_id: '', actions: null })
    expect(r).toEqual({ text: 'Jednání s Sigmaformem.', title: null, occurred_at: null, client_hint: null, external_id: null, actions: [] })
  })

  test('text je povinný a má strop', () => {
    expect(meetingNoteInput.safeParse({}).success).toBe(false)
    expect(meetingNoteInput.safeParse({ text: '   ' }).success).toBe(false)
    expect(meetingNoteInput.safeParse({ text: 'a'.repeat(MEETING_NOTE_BODY_MAX) }).success).toBe(true)
    const tooLong = meetingNoteInput.safeParse({ text: 'a'.repeat(MEETING_NOTE_BODY_MAX + 1) })
    expect(tooLong.success).toBe(false)
  })

  test('external_id: jen bezpečné znaky', () => {
    expect(meetingNoteInput.safeParse({ text: 'x', external_id: 'shortcut-2026-09-29T10:00' }).success).toBe(true)
    expect(meetingNoteInput.safeParse({ text: 'x', external_id: 'a b' }).success).toBe(false)
    expect(meetingNoteInput.safeParse({ text: 'x', external_id: 'a'.repeat(129) }).success).toBe(false)
  })

  test('actions: nejvýš 10 položek, prázdné se zahodí', () => {
    const ok = meetingNoteInput.parse({ text: 'x', actions: ['poslat nabídku', ' ', 'zavolat'] })
    expect(ok.actions).toEqual(['poslat nabídku', 'zavolat'])
    const many = Array.from({ length: MEETING_NOTE_ACTIONS_MAX + 1 }, (_, i) => `krok ${i}`)
    expect(meetingNoteInput.safeParse({ text: 'x', actions: many }).success).toBe(false)
  })
})

describe('resolveOccurredAt', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  test('prázdné = teď', () => {
    expect(resolveOccurredAt(null, now)).toEqual({ ok: true, iso: now.toISOString() })
  })
  test('samotné datum = poledne pražského času (letní čas +2 h)', () => {
    expect(resolveOccurredAt('2026-09-28', now)).toEqual({ ok: true, iso: '2026-09-28T10:00:00.000Z' })
  })
  test('zimní čas (+1 h)', () => {
    expect(resolveOccurredAt('2026-01-15', now)).toEqual({ ok: true, iso: '2026-01-15T11:00:00.000Z' })
  })
  test('ISO čas se převezme', () => {
    expect(resolveOccurredAt('2026-09-28T08:30:00Z', now)).toEqual({ ok: true, iso: '2026-09-28T08:30:00.000Z' })
  })
  test('nesmysl a budoucnost se odmítnou', () => {
    expect(resolveOccurredAt('včera', now).ok).toBe(false)
    expect(resolveOccurredAt('2026-13-45', now).ok).toBe(false)
    expect(resolveOccurredAt('2026-10-05', now).ok).toBe(false)
    // v toleranci 24 h (posun hodin) projde
    expect(resolveOccurredAt('2026-09-30T08:00:00Z', now).ok).toBe(true)
  })
})

describe('dedupeKeyFor, subjectFor', () => {
  test('external_id má přednost, jinak hash textu; stejný text = stejný klíč', () => {
    expect(dedupeKeyFor('wispr_flow', 'abc-1', 'text', 'u-1')).toBe('ext:wispr_flow:u-1:abc-1')
    // Jiný vlastník klíče = jiný klíč idempotence (žádná globální dedupe).
    expect(dedupeKeyFor('wispr_flow', 'abc-1', 'text', 'u-2')).not.toBe(dedupeKeyFor('wispr_flow', 'abc-1', 'text', 'u-1'))
    expect(dedupeKeyFor('wispr_flow', null, 'text', 'u-2')).not.toBe(dedupeKeyFor('wispr_flow', null, 'text', 'u-1'))
    const a = dedupeKeyFor('wispr_flow', null, 'Jednání')
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(dedupeKeyFor('wispr_flow', null, 'Jednání')).toBe(a)
    expect(dedupeKeyFor('wispr_flow', null, 'Jiný text')).not.toBe(a)
  })

  test('předmět: název, jinak první věta, jinak výchozí', () => {
    expect(subjectFor('Jednání o rozpočtu', 'x')).toBe('Jednání o rozpočtu')
    expect(subjectFor(null, 'Probrali jsme cenu. Klient chce slevu.')).toBe('Probrali jsme cenu.')
    expect(subjectFor(null, 'a'.repeat(300)).length).toBe(120)
    expect(subjectFor(null, ' \n ')).toBe('Zápis ze schůzky (Wispr Flow)')
  })
})

describe('IČO', () => {
  test('kontrolní součet', () => {
    expect(isValidIco(ICO_A)).toBe(true)
    expect(isValidIco(ICO_B)).toBe(true)
    expect(isValidIco('12345678')).toBe(false)
    expect(isValidIco('1234')).toBe(false)
  })
  test('kanonický tvar: mezery, CZ, nuly', () => {
    expect(canonicalIco('270 82 440')).toBe(ICO_A)
    expect(canonicalIco('CZ27082440')).toBe(ICO_A)
    expect(canonicalIco('1234567')).toBe('01234567')
    expect(canonicalIco('abc')).toBeNull()
  })
  test('v nápovědě jen s platným součtem, v textu jen s výslovným štítkem', () => {
    expect(icosInHint(`IČO ${ICO_A}`)).toEqual([ICO_A])
    expect(icosInHint('12345678')).toEqual([])
    expect(icosInText(`Firma, IČO: ${ICO_A}, ozvala se.`)).toEqual([ICO_A])
    expect(icosInText(`Číslo objednávky ${ICO_A} přišlo.`)).toEqual([])
    expect(icosInText('IČO 12345678')).toEqual([])
  })
})

describe('matchNoteToAccount — s nápovědou klienta', () => {
  test('IČO', () => {
    expect(match({ clientHint: ICO_B })).toEqual({ status: 'matched', accountId: 2, method: 'ico' })
    expect(match({ clientHint: `IČO 270 82 440` })).toEqual({ status: 'matched', accountId: 1, method: 'ico' })
  })

  test('název bez právní formy a diakritiky', () => {
    expect(match({ clientHint: 'sigmaform' })).toEqual({ status: 'matched', accountId: 1, method: 'name' })
    expect(match({ clientHint: 'SIGMAFORM s.r.o.' })).toEqual({ status: 'matched', accountId: 1, method: 'name' })
    expect(match({ clientHint: 'K2 Atelier' })).toEqual({ status: 'matched', accountId: 2, method: 'name' })
  })

  test('alias názvu', () => {
    expect(match({ clientHint: 'Nutrend Group' })).toEqual({ status: 'matched', accountId: 5, method: 'alias' })
  })

  test('e-mail známého kontaktu i doména firmy z kontaktu, aliasu a webu', () => {
    expect(match({ clientHint: 'jana.novakova@sigmaform.cz' })).toEqual({ status: 'matched', accountId: 1, method: 'domain' })
    expect(match({ clientHint: 'někdo.jiný@sigmaform.cz' })).toEqual({ status: 'matched', accountId: 1, method: 'domain' })
    expect(match({ clientHint: 'https://k2-erp.cz/produkty' })).toEqual({ status: 'matched', accountId: 2, method: 'alias' })
    expect(match({ clientHint: 'www.nutrend.example' })).toEqual({ status: 'matched', accountId: 5, method: 'domain' })
  })

  test('freemail: jen přesná adresa známého kontaktu, nikdy doména', () => {
    expect(match({ clientHint: 'petr@gmail.com' })).toEqual({ status: 'matched', accountId: 6, method: 'domain' })
    expect(match({ clientHint: 'jiny@gmail.com' })).toEqual({ status: 'none' })
    expect(match({ clientHint: 'gmail.com' })).toEqual({ status: 'none' })
  })

  test('víc firem (stejné jméno, sdílená doména) = nejednoznačné, ne hádání', () => {
    expect(match({ clientHint: 'Presto' })).toEqual({ status: 'ambiguous', accountIds: [3, 4] })
    expect(match({ clientHint: 'info@sdilena.cz' })).toEqual({ status: 'ambiguous', accountIds: [3, 4] })
  })

  test('protichůdné signály v jedné nápovědě = nejednoznačné', () => {
    expect(match({ clientHint: `${ICO_A} k2-erp.cz` })).toEqual({ status: 'ambiguous', accountIds: [1, 2] })
  })

  test('nápověda, která nic nenajde, NEpadá zpět na text zápisu', () => {
    expect(match({ clientHint: 'Neznámá firma', text: 'Jednání s Sigmaform, IČO 27082440.' })).toEqual({ status: 'none' })
  })

  test('částečný název se nepáruje (Sigmaform ≠ Sigmaform Servis, jen přesná shoda klíče)', () => {
    expect(match({ clientHint: 'Sigmaform Servis' })).toEqual({ status: 'matched', accountId: 7, method: 'name' })
    expect(match({ clientHint: 'Gent' })).toEqual({ status: 'none' })
  })
})

describe('matchNoteToAccount — bez nápovědy (podle textu)', () => {
  test('výslovné IČO v textu', () => {
    expect(match({ text: `Volali jsme s panem Novákem, IČO ${ICO_B}.` })).toEqual({ status: 'matched', accountId: 2, method: 'ico' })
  })

  test('zmínka celého názvu firmy', () => {
    expect(match({ text: 'Dnes jsem měl schůzku s Sigmaform. Chtějí školení.' })).toEqual({
      status: 'matched', accountId: 1, method: 'text_name',
    })
  })

  test('delší jméno přebije kratší obsažené v něm (Sigmaform Servis vs. Sigmaform)', () => {
    expect(match({ text: 'Schůzka s Sigmaform Servis o smlouvě.' })).toEqual({ status: 'matched', accountId: 7, method: 'text_name' })
  })

  test('zmínka dvou různých firem = nejednoznačné', () => {
    expect(match({ text: 'Porovnávali jsme Sigmaform a Nutrend.' })).toEqual({ status: 'ambiguous', accountIds: [1, 5] })
  })

  test('krátké a obecné názvy (CCH) se z textu nepáruji', () => {
    expect(match({ text: 'Zavolal jsem do CCH ohledně vzduchotechniky.' })).toEqual({ status: 'none' })
  })

  test('nic konkrétního = žádná shoda; číslo bez štítku IČO nespáruje', () => {
    expect(match({ text: 'Osobní poznámka k víkendu.' })).toEqual({ status: 'none' })
    expect(match({ text: `Objednávka ${ICO_A} dorazila.` })).toEqual({ status: 'none' })
  })

  test('název se hledá i v titulku', () => {
    expect(match({ title: 'Jednání Sigmaform', text: 'Krátký zápis.' })).toEqual({ status: 'matched', accountId: 1, method: 'text_name' })
  })
})

describe('extractActionItems', () => {
  test('řádky s výslovnou předponou, i s odrážkou a číslováním', () => {
    const text = [
      'Probrali jsme cenu.',
      'Úkol: poslat upravenou nabídku do pátku',
      '- úkol pro Petra: připravit reference',
      '2) TODO – zavolat panu Novákovi',
      'Další krok: domluvit workshop',
      'Akce: objednat licence',
    ].join('\n')
    expect(extractActionItems(text)).toEqual([
      'poslat upravenou nabídku do pátku',
      'připravit reference',
      'zavolat panu Novákovi',
      'domluvit workshop',
      'objednat licence',
    ])
  })

  test('jednoodstavcový diktát: úkoly za sebou oddělené větou', () => {
    expect(extractActionItems('Byla to dobrá schůzka. Úkol: poslat nabídku. Úkol: zavolat Petrovi. Díky.')).toEqual([
      'poslat nabídku',
      'zavolat Petrovi',
    ])
  })

  test('nic si nevymýšlí: věta o úkolu bez předpony a dvojtečky není úkol', () => {
    expect(extractActionItems('Máme úkol poslat nabídku.\nBudeme muset zavolat.')).toEqual([])
    expect(extractActionItems('Akce Black Friday: sleva 20 %')).toEqual([])
  })

  test('úkoly od odesílatele se přidají, duplicity (i bez diakritiky) se sloučí, strop 10', () => {
    expect(extractActionItems('Úkol: Poslat nabídku', ['poslat nabidku', 'Zavolat'])).toEqual(['poslat nabidku', 'Zavolat'])
    const many = Array.from({ length: 15 }, (_, i) => `krok číslo ${i}`)
    expect(extractActionItems('', many)).toHaveLength(MEETING_NOTE_ACTIONS_MAX)
  })

  test('příliš dlouhý úkol se zkrátí na 300 znaků', () => {
    const [item] = extractActionItems(`Úkol: ${'a'.repeat(400)}`)
    expect(item).toHaveLength(300)
    expect(item.endsWith('…')).toBe(true)
  })
})

describe('buildStepsProposal', () => {
  test('bez úkolů žádný návrh', () => {
    expect(buildStepsProposal([], 'Sigmaform', 'Kroky — {firma}')).toBeNull()
  })

  test('název ze šablony firmy, kroky = úkoly, zdůvodnění nenese text zápisu', () => {
    const p = buildStepsProposal(['poslat nabídku', 'zavolat'], 'Sigmaform s.r.o.', 'Kroky ze schůzky — {firma}')!
    expect(p.title).toBe('Kroky ze schůzky — Sigmaform s.r.o.')
    expect(p.steps).toEqual(['poslat nabídku', 'zavolat'])
    expect(p.rationale).toContain('2 úkoly')
    expect(p.rationale).not.toContain('nabídku')
  })

  test('šablona jiné firmy (bez {firma}) a dlouhý název', () => {
    expect(renderProposalTitle('Vždy stejné', 'Sigmaform')).toBe('Vždy stejné')
    expect(renderProposalTitle('{firma}', 'x'.repeat(400))).toHaveLength(300)
  })
})
