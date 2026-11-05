// Obsahový vstup pošty (domain/crm/mailContent.ts): rozpoznání obsahu pravidly,
// úryvek, párování na klienta / dodávku / milník a skládání návrhu. Čisté funkce,
// bez sítě a bez DB.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  buildMailContentProposal,
  chooseMilestone,
  chooseTarget,
  cleanAttachmentNames,
  cleanSubject,
  counterpartDomain,
  dedupeKeyForMessage,
  excerptHead,
  extractSingleDate,
  isMailContentCapability,
  latestReplyText,
  mailContentAiEnabledFromEnv,
  mailContentEnabledFromEnv,
  mailContentFolderCreateFromEnv,
  mailContentFolderName,
  maskPersonalData,
  proposalKind,
  recognizeContent,
  resolveAccount,
  toContentMessage,
  MAIL_CONTENT_CAPABILITIES,
  MAIL_CONTENT_EMPTY_EXCERPT,
  MAIL_CONTENT_EXCERPT_MAX,
  type AccountMatchData,
  type MilestoneOption,
  type TargetOption,
} from '@/domain/crm/mailContent'

const RECEIVED = new Date('2026-09-14T09:00:00Z')
const rec = (text: string, extra: { subject?: string; hasAttachments?: boolean } = {}) =>
  recognizeContent({ subject: extra.subject ?? '', text, hasAttachments: extra.hasAttachments ?? false, receivedAt: RECEIVED })

describe('rozpoznání obsahu (pravidla)', () => {
  test('schválení', () => {
    const r = rec('Dobrý den, procesní mapu schvalujeme, můžete pokračovat. Děkujeme.')
    expect(r.signals).toEqual(['approval'])
    expect(r.primary).toBe('approval')
    expect(r.excerpt).toContain('schvalujeme')
  })

  test('„souhlasíme" a „odsouhlaseno" jsou schválení', () => {
    expect(rec('Souhlasíme s návrhem.').signals).toEqual(['approval'])
    expect(rec('Rozsah je odsouhlasen vedením.').signals).toEqual(['approval'])
  })

  test('záporné tvary NEJSOU schválení, ale požadavek na změnu', () => {
    const r = rec('Mapu neschvalujeme, chybí tam sklad.')
    expect(r.signals).toEqual(['change'])
    expect(rec('S tím nesouhlasíme.').signals).toEqual(['change'])
  })

  test('posun termínu s datem; datum se vytáhne jen když je jediné', () => {
    const r = rec('Prosíme o posunutí workshopu na 5. 10. Vyhovuje?')
    expect(r.signals).toEqual(['schedule'])
    expect(r.primary).toBe('schedule')
    expect(r.proposedDate).toBe('2026-10-05')
    expect(rec('Posuneme to na 5. 10. nebo 12. 10.?').proposedDate).toBeNull()
  })

  test('samotné slovo „termín" není posun (domlouvání schůzky), s datem ano', () => {
    expect(rec('Pošlete mi prosím termín schůzky.').signals).toEqual([])
    expect(rec('Nový termín je 20. října.').signals).toEqual(['schedule'])
  })

  test('požadavek na změnu má přednost před schválením i termínem', () => {
    const r = rec('Schvalujeme, ale máme pár připomínek a musíme posunout termín.')
    expect(r.signals).toEqual(['approval', 'schedule', 'change'])
    expect(r.primary).toBe('change')
    expect(proposalKind(r.signals)).toBe('change')
  })

  test('přílohy: výraz v textu i příznak hasAttachments', () => {
    expect(rec('Přikládám podklady k pilotu.').signals).toEqual(['attachment'])
    expect(rec('Ahoj.', { hasAttachments: true }).signals).toEqual(['attachment'])
  })

  test('předmět stačí jako signál; úryvek je pak z těla', () => {
    const r = rec('Dobrý den, posílám odpověď níže.', { subject: 'Re: Schválení procesní mapy' })
    expect(r.signals).toEqual(['approval'])
    expect(r.excerpt).toBe('Dobrý den, posílám odpověď níže.')
  })

  test('nic rozpoznáno = bez příznaků a úryvek z úvodu', () => {
    const r = rec('Dobrý den, děkuji za včerejší hovor.')
    expect(r.signals).toEqual([])
    expect(r.primary).toBeNull()
    expect(r.excerpt).toBe('Dobrý den, děkuji za včerejší hovor.')
  })

  test('diakritika a velká písmena nevadí', () => {
    expect(rec('SCHVALUJEME PROCESNÍ MAPU').signals).toEqual(['approval'])
    expect(rec('schvalujeme').signals).toEqual(['approval'])
  })
})

describe('úryvek', () => {
  test('nejvýš 300 znaků a je to věta se signálem, ne začátek zprávy', () => {
    const filler = 'Toto je dlouhý úvod bez významu. '.repeat(20)
    const r = rec(`${filler}Mapu schvalujeme a děkujeme za práci. ${filler}`)
    expect(r.excerpt.length).toBeLessThanOrEqual(MAIL_CONTENT_EXCERPT_MAX)
    expect(r.excerpt).toContain('schvalujeme')
    expect(r.excerpt).not.toContain('dlouhý úvod')
  })

  test('jedna nekonečná věta se ořízne s výpustkou na 300', () => {
    const r = rec(`Schvalujeme ${'a pokračujeme dál '.repeat(60)}`)
    expect(r.excerpt.length).toBeLessThanOrEqual(MAIL_CONTENT_EXCERPT_MAX)
    expect(r.excerpt.startsWith('Schvalujeme')).toBe(true)
    expect(r.excerpt.endsWith('…')).toBe(true)
  })

  test('úryvek nikdy nepřesáhne 300 znaků (CHECK v DB), ať je věta jakkoli dlouhá', () => {
    for (let n = 200; n <= 700; n += 7) {
      for (const lead of ['', 'x'.repeat(n), `${'ab. '.repeat(n)}`]) {
        const r = rec(`${lead}Schvalujeme ${'slovo '.repeat(n)}`)
        expect(r.excerpt.length, `n=${n}`).toBeLessThanOrEqual(MAIL_CONTENT_EXCERPT_MAX)
        expect(r.excerpt.length).toBeGreaterThan(0)
      }
    }
    expect(excerptHead('a'.repeat(1000)).length).toBe(MAIL_CONTENT_EXCERPT_MAX)
  })

  test('adresy a dlouhá čísla se maskují, data zůstanou', () => {
    expect(maskPersonalData('Pište na jana.novakova@klient.cz nebo +420 777 123 456, účet 123456789012.')).toBe(
      'Pište na [e-mail] nebo [číslo], účet [číslo].',
    )
    expect(maskPersonalData('Termín 2026-10-05 a 5/10/2026.')).toBe('Termín 2026-10-05 a 5/10/2026.')
    // částky do osmi číslic zůstanou, protože nejsou telefon ani účet
    expect(maskPersonalData('Navýšení o 1 500 000 Kč.')).toBe('Navýšení o 1 500 000 Kč.')
    const r = rec('Schvalujeme, potvrzení pošlu z jan@klient.cz.')
    expect(r.excerpt).not.toContain('@')
  })

  test('prázdné tělo = zástupný text', () => {
    expect(rec('').excerpt).toBe(MAIL_CONTENT_EMPTY_EXCERPT)
    expect(excerptHead('   ')).toBe(MAIL_CONTENT_EMPTY_EXCERPT)
  })

  test('neviditelné znaky pryč (schovaný pokyn)', () => {
    const t = latestReplyText('Schvalujeme\u200b mapu\u202e.')
    expect(t).toBe('Schvalujeme mapu.')
  })
})

describe('citace předchozí korespondence', () => {
  test('odřízne odpověď od citace (česky i anglicky, hlavičky, > řádky)', () => {
    const czech = 'Souhlasíme.\n\nOd: Viktor <viktor@mummiesdaddies.com>\nOdesláno: 12. září 2026\nKomu: klient\nPředmět: Mapa\n\nPosunem termín.'
    expect(latestReplyText(czech)).toBe('Souhlasíme.')
    expect(latestReplyText('Ano.\n\nOn Mon, Sep 12, 2026 at 9:00 Viktor wrote:\n> Posuneme termín')).toBe('Ano.')
    expect(latestReplyText('Ano.\n> citace posun\nDíky')).toBe('Ano.\nDíky')
    expect(latestReplyText('Ano.\n-----Original Message-----\nposun termínu')).toBe('Ano.')
    expect(latestReplyText('Ano.\n________________________________\nposun')).toBe('Ano.')
  })

  test('slovo z citace signál nedělá', () => {
    const t = latestReplyText('Děkuji, ozvu se.\n\nDne 12. 9. 2026 napsal Viktor:\n> Prosím o schválení mapy')
    expect(rec(t).signals).toEqual([])
  })

  test('zpráva, která je celá citace, se přečte celá', () => {
    expect(latestReplyText('> schvalujeme\n> mapu')).toBe('> schvalujeme\n> mapu')
  })

  test('podpis zařízení se vynechá', () => {
    expect(latestReplyText('Ano.\nOdesláno z iPhonu')).toBe('Ano.')
  })
})

describe('datum z textu', () => {
  test('číselné, slovní a s rokem', () => {
    expect(extractSingleDate('do 5. 10. 2026', RECEIVED)).toBe('2026-10-05')
    expect(extractSingleDate('do 20. října', RECEIVED)).toBe('2026-10-20')
    expect(extractSingleDate('do 3. března', RECEIVED)).toBe('2027-03-03')
    expect(extractSingleDate('bez data', RECEIVED)).toBeNull()
    expect(extractSingleDate('31. 2.', RECEIVED)).toBeNull()
  })

  test('týden zpět je ještě letošní, dřív už příští rok', () => {
    expect(extractSingleDate('10. 9.', RECEIVED)).toBe('2026-09-10')
    expect(extractSingleDate('1. 9.', RECEIVED)).toBe('2027-09-01')
  })
})

describe('zpráva z Graphu', () => {
  const base = {
    id: 'AAA',
    internetMessageId: ' <abc@klient.cz> ',
    subject: 'Re: mapa',
    from: { emailAddress: { address: 'Jana@Klient.cz', name: 'Jana' } },
    toRecipients: [{ emailAddress: { address: 'viktor@mummiesdaddies.com' } }],
    ccRecipients: [{ emailAddress: { address: 'x@klient.cz' } }],
    receivedDateTime: '2026-09-14T08:00:00Z',
    hasAttachments: true,
    webLink: 'https://outlook.office.com/mail/x',
    body: { contentType: 'text', content: 'Schvalujeme.' },
  }

  test('převede a očistí (adresy malými písmeny, jen povolený odkaz)', () => {
    const r = toContentMessage(base)
    expect(r).toEqual({
      message: {
        graphId: 'AAA',
        internetMessageId: '<abc@klient.cz>',
        webLink: 'https://outlook.office.com/mail/x',
        subject: 'Re: mapa',
        body: 'Schvalujeme.',
        hasAttachments: true,
        from: 'jana@klient.cz',
        to: ['viktor@mummiesdaddies.com'],
        cc: ['x@klient.cz'],
        receivedAt: '2026-09-14T08:00:00.000Z',
      },
    })
    expect(toContentMessage({ ...base, webLink: 'https://evil.example/x' })).toMatchObject({ message: { webLink: null } })
  })

  test('přeskočí smazané, koncepty, bez Message-ID a bez data', () => {
    expect(toContentMessage({ ...base, '@removed': {} })).toEqual({ skip: 'removed' })
    expect(toContentMessage({ ...base, isDraft: true })).toEqual({ skip: 'draft' })
    expect(toContentMessage({ ...base, internetMessageId: ' ' })).toEqual({ skip: 'no_message_id' })
    expect(toContentMessage({ ...base, internetMessageId: `<${'x'.repeat(600)}@a.cz>` })).toEqual({ skip: 'no_message_id' })
    expect(toContentMessage({ ...base, receivedDateTime: null, sentDateTime: null })).toEqual({ skip: 'no_date' })
  })

  test('klíč idempotence je hash, ne Message-ID', () => {
    const k = dedupeKeyForMessage('<abc@klient.cz>')
    expect(k).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(k).not.toContain('abc')
    expect(dedupeKeyForMessage(' <abc@klient.cz> ')).toBe(k)
  })

  test('doména protistrany: odesílatel, u naší odchozí příjemce; nikdy adresa', () => {
    expect(counterpartDomain({ from: 'jana@klient.cz', to: ['viktor@mummiesdaddies.com'], cc: [] })).toBe('klient.cz')
    expect(counterpartDomain({ from: 'viktor@mummiesdaddies.com', to: ['x@jiny.cz'], cc: [] })).toBe('jiny.cz')
    expect(counterpartDomain({ from: 'viktor@mummiesdaddies.com', to: ['a@mummiesdaddies.com'], cc: [] })).toBeNull()
  })

  test('předmět a názvy příloh: čistě a s mezemi', () => {
    expect(cleanSubject('  Re:\u200b   mapa  ')).toBe('Re: mapa')
    expect(cleanSubject('   ')).toBeNull()
    expect(cleanSubject('x'.repeat(500))!.length).toBe(200)
    const names = cleanAttachmentNames(Array.from({ length: 14 }, (_, i) => `soubor-${i}.pdf`))
    expect(names).toHaveLength(10)
    expect(cleanAttachmentNames(['a'.repeat(300)])[0].length).toBe(120)
  })
})

describe('párování na klienta', () => {
  const data: AccountMatchData = {
    accounts: [
      { id: 1, name: 'Sigmaform Servis s.r.o.', ico: null, web: 'https://www.sigmaform.cz' },
      { id: 2, name: 'Novotný Logistika a.s.', ico: null, web: null },
      { id: 3, name: 'Sdílená a.s.', ico: null, web: null },
      { id: 4, name: 'Sdílená Dcera s.r.o.', ico: null, web: null },
    ],
    aliases: [{ account_id: 2, alias_domain: 'novotny-log.cz', alias_name: null }],
    contacts: [
      { account_id: 1, email: 'jana@sigmaform.cz' },
      { account_id: 3, email: 'a@sdilena.cz' },
      { account_id: 4, email: 'b@sdilena.cz' },
    ],
  }
  const msg = (from: string, subject = '', to: string[] = ['viktor@mummiesdaddies.com']) => ({ from, to, cc: [], subject })

  test('známý kontakt → klient, způsob contact', () => {
    expect(resolveAccount(msg('jana@sigmaform.cz'), data)).toEqual({ status: 'matched', accountId: 1, method: 'contact' })
  })

  test('nový člověk ze známé domény → domain; alias → alias', () => {
    expect(resolveAccount(msg('petr@sigmaform.cz'), data)).toEqual({ status: 'matched', accountId: 1, method: 'domain' })
    expect(resolveAccount(msg('ivo@novotny-log.cz'), data)).toEqual({ status: 'matched', accountId: 2, method: 'alias' })
  })

  test('doména sdílená dvěma firmami = nejednoznačné', () => {
    expect(resolveAccount(msg('nikdo@sdilena.cz'), data)).toEqual({ status: 'ambiguous' })
  })

  test('neznámá doména, ale název klienta v předmětu → name', () => {
    expect(resolveAccount(msg('x@neznamy.cz', 'Novotný Logistika – schválení mapy'), data)).toEqual({ status: 'matched', accountId: 2, method: 'name' })
  })

  test('freemail bez kontaktu a bez názvu = žádný klient', () => {
    expect(resolveAccount(msg('lidr@gmail.com', 'dotaz'), data)).toEqual({ status: 'none' })
  })

  test('naše odchozí zpráva (přesunutá z Odeslaných): klient podle příjemce', () => {
    expect(resolveAccount({ from: 'viktor@mummiesdaddies.com', to: ['jana@sigmaform.cz'], cc: [], subject: 'mapa' }, data)).toEqual({
      status: 'matched', accountId: 1, method: 'contact',
    })
  })

  test('jen interní adresy → žádný klient', () => {
    expect(resolveAccount({ from: 'viktor@mummiesdaddies.com', to: ['a@mummiesdaddies.com'], cc: [], subject: 'poznámka' }, data)).toEqual({ status: 'none' })
  })
})

describe('dodávka nebo obchod a milník', () => {
  const targets: TargetOption[] = [
    { kind: 'engagement', id: 10, label: 'Procesní audit Sigmaform', dealId: 5 },
    { kind: 'engagement', id: 11, label: 'Workshop pro vedení', dealId: 6 },
    { kind: 'deal', id: 7, label: 'Podpora provozu', dealId: 7 },
  ]

  test('název v předmětu vyhraje; pak název v textu', () => {
    expect(chooseTarget(targets, 'Re: Workshop pro vedení', 'ahoj')).toMatchObject({ status: 'chosen', how: 'named', target: { id: 11 } })
    expect(chooseTarget(targets, 'Dotaz', 'k projektu Procesní audit Sigmaform: schvalujeme')).toMatchObject({ status: 'chosen', target: { id: 10 } })
  })

  test('víc kandidátů bez názvu = nejednoznačné; jediný kandidát = jistý', () => {
    expect(chooseTarget(targets, 'Dotaz', 'schvalujeme')).toMatchObject({ status: 'ambiguous' })
    expect(chooseTarget([targets[0]], 'Dotaz', 'schvalujeme')).toMatchObject({ status: 'chosen', how: 'only', target: { id: 10 } })
    expect(chooseTarget([], 'x', 'y')).toEqual({ status: 'none' })
  })

  test('dva různé názvy v předmětu = nejednoznačné (ne první shoda)', () => {
    expect(chooseTarget(targets, 'Procesní audit Sigmaform a Workshop pro vedení', '')).toMatchObject({ status: 'ambiguous' })
  })

  test('delší název přebije kratší, který je jeho součástí', () => {
    const t: TargetOption[] = [
      { kind: 'engagement', id: 1, label: 'Workshop', dealId: null },
      { kind: 'engagement', id: 2, label: 'Workshop pro vedení', dealId: null },
    ]
    expect(chooseTarget(t, 'Workshop pro vedení', '')).toMatchObject({ status: 'chosen', target: { id: 2 } })
  })

  const milestones: MilestoneOption[] = [
    { id: 1, title: 'Procesní mapa', status: 'ceka_na_schvaleni', dueOn: '2026-10-01' },
    { id: 2, title: 'Technická analýza', status: 'pripraveno', dueOn: null },
    { id: 3, title: 'Workshop', status: 'uzavreno', dueOn: null },
  ]

  test('milník podle názvu; uzavřený se nenabízí', () => {
    expect(chooseMilestone(milestones, [], 'Technická analýza', '')?.id).toBe(2)
    expect(chooseMilestone(milestones, [], 'Workshop', '')).toBeNull()
  })

  test('schválení bez názvu = jediný milník čekající na schválení', () => {
    expect(chooseMilestone(milestones, ['approval'], 'Re: dotaz', 'schvalujeme')?.id).toBe(1)
    expect(chooseMilestone(milestones, ['schedule'], 'Re: dotaz', 'posunout')).toBeNull()
    const two = [...milestones, { id: 4, title: 'Další', status: 'ceka_na_schvaleni', dueOn: null }]
    expect(chooseMilestone(two, ['approval'], 'dotaz', 'schvalujeme')).toBeNull()
  })
})

describe('návrh', () => {
  const base = {
    accountName: 'Sigmaform Servis s.r.o.',
    target: { kind: 'engagement' as const, id: 10, label: 'Procesní audit', dealId: 5 },
    targetUnclear: false,
    milestone: { id: 1, title: 'Procesní mapa', status: 'ceka_na_schvaleni', dueOn: null },
    proposedDate: null,
    receivedAt: '2026-09-14T08:00:00.000Z',
    attachmentNames: [] as string[],
  }

  test('schválení: název, doložený milník, kroky; zdůvodnění nenese úryvek', () => {
    const p = buildMailContentProposal({ ...base, signals: ['approval'] })
    expect(p.kind).toBe('approval')
    expect(p.capability).toBe('mail_content_approval')
    expect(p.title).toBe('Schválení od klienta: Procesní mapa — Sigmaform Servis s.r.o.')
    expect(p.rationale).toContain('14. 9. 2026')
    expect(p.rationale).toContain('schválení')
    expect(p.rationale).toContain('Dodávka: Procesní audit')
    expect(p.rationale).toContain('Jen návrh, nic se samo nezměnilo')
    expect(p.steps.join(' ')).toContain('U milníku „Procesní mapa“ zapsat přijetí')
    expect(p.steps.length).toBeLessThanOrEqual(10)
  })

  test('posun termínu nese datum jako k ověření', () => {
    const p = buildMailContentProposal({ ...base, signals: ['schedule'], proposedDate: '2026-10-05' })
    expect(p.capability).toBe('mail_content_schedule')
    expect(p.rationale).toContain('Datum z textu: 5. 10. 2026 (ověř ve zprávě)')
    expect(p.steps[0]).toContain('z textu: 5. 10. 2026')
  })

  test('bez rozpoznání = návrh „k posouzení"; nejasná dodávka se přizná', () => {
    const p = buildMailContentProposal({ ...base, signals: [], target: null, targetUnclear: true, milestone: null })
    expect(p.kind).toBe('review')
    expect(p.capability).toBe('mail_content_review')
    expect(p.rationale).toContain('nic konkrétního nerozpoznáno')
    expect(p.rationale).toContain('Dodávka ani obchod nebyly jednoznačné')
    expect(p.title).toBe('Zpráva klienta k posouzení: Sigmaform Servis s.r.o.')
  })

  test('přílohy jako názvy, AI shrnutí označené, délky drží meze', () => {
    const p = buildMailContentProposal({
      ...base, signals: ['attachment'], attachmentNames: ['a.pdf', 'b.xlsx', 'c.docx', 'd.png'], aiSummary: 'Klient posílá podklady.',
    })
    expect(p.rationale).toContain('Přílohy (jen názvy): a.pdf, b.xlsx, c.docx a další.')
    expect(p.rationale).toContain('Shrnutí AI: Klient posílá podklady.')
    const long = buildMailContentProposal({ ...base, signals: ['change'], accountName: 'F'.repeat(400), aiSummary: 'x'.repeat(2000) })
    expect(long.title.length).toBeLessThanOrEqual(300)
    expect(long.rationale.length).toBeLessThanOrEqual(1000)
  })

  test('capability id odpovídá CHECK case_proposal a rozlišuje druhy', () => {
    for (const c of Object.values(MAIL_CONTENT_CAPABILITIES)) {
      expect(c).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
      expect(isMailContentCapability(c)).toBe(true)
    }
    expect(new Set(Object.values(MAIL_CONTENT_CAPABILITIES)).size).toBe(5)
    expect(isMailContentCapability('mail_to_case')).toBe(false)
  })
})

describe('přepínače prostředí (výchozí vypnuto)', () => {
  test('jen přesně "true"', () => {
    expect(mailContentEnabledFromEnv({})).toBe(false)
    expect(mailContentEnabledFromEnv({ MAIL_CONTENT_INTAKE_ENABLED: '1' })).toBe(false)
    expect(mailContentEnabledFromEnv({ MAIL_CONTENT_INTAKE_ENABLED: 'true' })).toBe(true)
    expect(mailContentAiEnabledFromEnv({})).toBe(false)
    expect(mailContentAiEnabledFromEnv({ MAIL_CONTENT_AI_ENABLED: 'true' })).toBe(true)
    expect(mailContentFolderCreateFromEnv({})).toBe(false)
    expect(mailContentFolderCreateFromEnv({ MAIL_CONTENT_FOLDER_CREATE: 'true' })).toBe(true)
  })

  test('název složky: výchozí Cockpit, z prostředí jen rozumný', () => {
    expect(mailContentFolderName({})).toBe('Cockpit')
    expect(mailContentFolderName({ MAIL_CONTENT_FOLDER: '  Pro Cockpit ' })).toBe('Pro Cockpit')
    expect(mailContentFolderName({ MAIL_CONTENT_FOLDER: '   ' })).toBe('Cockpit')
    expect(mailContentFolderName({ MAIL_CONTENT_FOLDER: 'x'.repeat(101) })).toBe('Cockpit')
  })
})

describe('klientská karta fronty nesmí táhnout server', () => {
  // Build (Turbopack) selhal, když MailQueueCard importoval mailContent.ts,
  // který přes mailSync.ts a Graph dosáhl na next/headers.
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  test('popisky a příznaky jsou v souboru bez importů', () => {
    expect(code('domain/crm/mailContentLabels.ts')).not.toMatch(/^\s*import\s/m)
  })

  test('MailQueueCard importuje jen popisky, ne mailContent.ts ani služby', () => {
    const src = code('components/MailQueueCard.tsx')
    expect(src).toContain("'use client'")
    expect(src).toContain("@/domain/crm/mailContentLabels")
    expect(src).not.toMatch(/from '@\/domain\/crm\/mailContent'/)
    expect(src).not.toMatch(/mailContentService|mailSync|@\/connectors/)
    // typy z dotazů (server) jen jako `import type`, ať se do klienta nedostanou
    for (const line of src.split('\n').filter((l) => /queries\/mailContent/.test(l))) expect(line).toMatch(/^import type /)
  })
})
