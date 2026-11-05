// Pravidla jistoty automatického zakládání poptávek (domain/crm/autoIntake.ts):
// tabulka případů „co se stane se zprávou". Čisté funkce, bez sítě a DB.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import type { AutoIntakeConfig } from '@/core/tenant'
import {
  AUTO_INTAKE_MAX_DAILY_LIMIT,
  INTAKE_FREEMAIL,
  addBusinessDays,
  autoIntakeConfigIssues,
  autoIntakeEnabledFromEnv,
  buildFoundPayload,
  buildProposalText,
  cleanDisplayName,
  companyNameFromDomain,
  companyNameFromSender,
  contactNameFor,
  decideIntake,
  domainFromProposalKey,
  inDomainSet,
  intakeCandidateFromMessage,
  proposalSourceKey,
  resolveDailyLimit,
  senderCompanyMismatch,
  senderKind,
  type IntakeCandidate,
  type IntakeContext,
  type IntakeDecision,
} from '@/domain/crm/autoIntake'

// Pravidla se testují s konfigurací firmy, jen s jednou další interní doménou
// navíc (firma žádnou nemá), aby šlo ověřit pravidlo „interní doména z konfigurace".
const CFG = { ...(COMPANY.capabilities.autoIntake as AutoIntakeConfig), internalDomains: ['firma-web.example'] } as AutoIntakeConfig
const NOW = new Date('2026-09-29T10:00:00Z') // úterý
const MAILBOX = 'viktor@mummiesdaddies.com'

function cand(over: Partial<IntakeCandidate> = {}): IntakeCandidate {
  return {
    messageId: '<m1@acme-stroje.cz>',
    occurredAt: '2026-09-29T07:30:00.000Z',
    webLink: null,
    fromAddress: 'jan.novak@acme-stroje.cz',
    fromName: 'Jan Novák',
    to: [MAILBOX],
    cc: [],
    matchStatus: 'unknown',
    ...over,
  }
}

function ctx(over: Partial<IntakeContext> = {}): IntakeContext {
  return {
    ourDomains: new Set(['mummiesdaddies.com', ...CFG.internalDomains]),
    mailboxAddress: MAILBOX,
    partnerDomains: new Set(['taupartner.cz']),
    rejectedDomains: new Set(),
    proposedDomains: new Set(),
    knownDomains: new Map(),
    knownAddresses: new Map(),
    automatedDomains: new Set(CFG.automatedDomains),
    rules: CFG,
    now: NOW,
    ...over,
  }
}

type Expect =
  | { kind: 'skip'; reason: string }
  | { kind: 'auto' }
  | { kind: 'known'; accountId: number }
  | { kind: 'propose'; cautions: string[] }

const CASES: { name: string; c: Partial<IntakeCandidate>; x?: Partial<IntakeContext>; expect: Expect }[] = [
  // ---- VYSOKÁ jistota
  { name: 'osobní firemní adresa přímo na schránku → automat', c: {}, expect: { kind: 'auto' } },
  { name: 'velká písmena v adresách nevadí', c: { fromAddress: 'Jan.Novak@ACME-stroje.cz'.toLowerCase(), to: ['Viktor@MummiesDaddies.com'.toLowerCase()] }, expect: { kind: 'auto' } },
  { name: 'jméno z hlavičky s firmou „Jan Novák | ACME s.r.o."', c: { fromName: 'Jan Novák | ACME Stroje s.r.o.' }, expect: { kind: 'auto' } },
  { name: 'kolega z firmy v kopii je v pořádku (nejvýš 3 příjemci)', c: { cc: ['lenka@mummiesdaddies.com'] }, expect: { kind: 'auto' } },
  { name: 'iniciála + příjmení (j.novak) bez jména v hlavičce', c: { fromAddress: 'j.novak@acme-stroje.cz', fromName: null }, expect: { kind: 'auto' } },
  { name: 'jedno slovo v jménu, ale adresa jan.novak', c: { fromName: 'Novák' }, expect: { kind: 'auto' } },
  { name: 'subdoména odesílatele', c: { fromAddress: 'jan.novak@mail.acme-stroje.cz' }, expect: { kind: 'auto' } },

  // ---- NIC (skip)
  { name: 'freemail: gmail', c: { fromAddress: 'jan.novak@gmail.com' }, expect: { kind: 'skip', reason: 'freemail' } },
  { name: 'freemail: seznam.cz', c: { fromAddress: 'jan.novak@seznam.cz' }, expect: { kind: 'skip', reason: 'freemail' } },
  { name: 'freemail: yahoo.com (mimo seznam syncu)', c: { fromAddress: 'jan.novak@yahoo.com' }, expect: { kind: 'skip', reason: 'freemail' } },
  { name: 'freemail: post.cz', c: { fromAddress: 'jan.novak@post.cz' }, expect: { kind: 'skip', reason: 'freemail' } },
  { name: 'interní doména firmy', c: { fromAddress: 'lenka@mummiesdaddies.com' }, expect: { kind: 'skip', reason: 'internal' } },
  { name: 'interní doména z konfigurace', c: { fromAddress: 'jan.novak@firma-web.example' }, expect: { kind: 'skip', reason: 'internal' } },
  { name: 'subdoména interní domény', c: { fromAddress: 'jan.novak@x.mummiesdaddies.com' }, expect: { kind: 'skip', reason: 'internal' } },
  { name: 'partner', c: { fromAddress: 'jan.novak@taupartner.cz' }, expect: { kind: 'skip', reason: 'partner' } },
  { name: 'no-reply', c: { fromAddress: 'no-reply@acme-stroje.cz', fromName: null }, expect: { kind: 'skip', reason: 'automated' } },
  { name: 'noreply bez pomlčky', c: { fromAddress: 'noreply@acme-stroje.cz' }, expect: { kind: 'skip', reason: 'automated' } },
  { name: 'newsletter@', c: { fromAddress: 'newsletter@acme-stroje.cz' }, expect: { kind: 'skip', reason: 'automated' } },
  { name: 'notifications@', c: { fromAddress: 'notifications@acme-stroje.cz' }, expect: { kind: 'skip', reason: 'automated' } },
  { name: 'faktury@ (účetní automat)', c: { fromAddress: 'faktury@acme-stroje.cz' }, expect: { kind: 'skip', reason: 'automated' } },
  { name: 'automat podle jména v hlavičce', c: { fromName: 'Acme Newsletter' }, expect: { kind: 'skip', reason: 'automated' } },
  { name: 'platforma hromadné pošty', c: { fromAddress: 'jan.novak@mailchimp.com' }, expect: { kind: 'skip', reason: 'automated_domain' } },
  { name: 'subdoména platformy', c: { fromAddress: 'jan.novak@mail.hubspot.com' }, expect: { kind: 'skip', reason: 'automated_domain' } },
  { name: 'dřív zamítnutá doména', c: {}, x: { rejectedDomains: new Set(['acme-stroje.cz']) }, expect: { kind: 'skip', reason: 'rejected' } },
  { name: 'k doméně už je návrh (i vyřízený)', c: {}, x: { proposedDomains: new Set(['acme-stroje.cz']) }, expect: { kind: 'skip', reason: 'has_proposal' } },
  { name: 'hromadná zpráva (9 příjemců)', c: { to: [MAILBOX], cc: Array.from({ length: 8 }, (_, i) => `x${i}@jina${i}.cz`) }, expect: { kind: 'skip', reason: 'bulk' } },
  { name: 'v hlavičce nejsme (skrytá kopie / konference)', c: { to: ['undisclosed@acme-stroje.cz'], cc: [] }, expect: { kind: 'skip', reason: 'not_addressed' } },
  { name: 'stará zpráva (4 dny)', c: { occurredAt: '2026-09-25T09:00:00.000Z' }, expect: { kind: 'skip', reason: 'stale' } },
  { name: 'zpráva z budoucnosti', c: { occurredAt: '2026-10-05T09:00:00.000Z' }, expect: { kind: 'skip', reason: 'stale' } },
  { name: 'adresa bez tečky v doméně', c: { fromAddress: 'jan.novak@localhost' }, expect: { kind: 'skip', reason: 'invalid' } },

  // ---- NIŽŠÍ jistota → návrh
  { name: 'obecná schránka info@', c: { fromAddress: 'info@acme-stroje.cz', fromName: 'Acme Stroje' }, expect: { kind: 'propose', cautions: ['role_address'] } },
  { name: 'obecná schránka obchod.praha@', c: { fromAddress: 'obchod.praha@acme-stroje.cz', fromName: null }, expect: { kind: 'propose', cautions: ['role_address'] } },
  { name: 'jedno slovo v jméně i v adrese (jan@)', c: { fromAddress: 'jan@acme-stroje.cz', fromName: 'Jan' }, expect: { kind: 'propose', cautions: ['unclear_person'] } },
  { name: 'jen v kopii (Cc), ne v To', c: { to: ['jiny@acme-stroje.cz'], cc: [MAILBOX] }, expect: { kind: 'propose', cautions: ['not_direct', 'external_recipients'] } },
  { name: 'adresa schránky neznámá → nikdy „přímo"', c: {}, x: { mailboxAddress: null }, expect: { kind: 'propose', cautions: ['not_direct'] } },
  { name: 'další externí příjemce', c: { cc: ['petr@jina-firma.cz'] }, expect: { kind: 'propose', cautions: ['external_recipients'] } },
  { name: 'čtyři příjemci (víc než 3)', c: { to: [MAILBOX, 'lenka@mummiesdaddies.com'], cc: ['a@mummiesdaddies.com', 'b@mummiesdaddies.com'] }, expect: { kind: 'propose', cautions: ['many_recipients'] } },
  {
    name: 'e-mail se dvěma klienty: v kopii je známý klient',
    c: { cc: ['petr@znamy-klient.cz'] },
    x: { knownAddresses: new Map([['petr@znamy-klient.cz', 7]]) },
    expect: { kind: 'propose', cautions: ['external_recipients', 'two_clients'] },
  },
  {
    name: 'e-mail se dvěma klienty: doména odesílatele patří dvěma firmám',
    c: { matchStatus: 'ambiguous' },
    x: { knownDomains: new Map([['acme-stroje.cz', [3, 9]]]) },
    expect: { kind: 'propose', cautions: ['two_clients'] },
  },
  { name: 'sync řekl ambiguous, my doménu neznáme → nikdy automat', c: { matchStatus: 'ambiguous' }, expect: { kind: 'propose', cautions: ['two_clients'] } },
  { name: 'role + jen kopie: víc důvodů najednou', c: { fromAddress: 'info@acme-stroje.cz', to: ['x@jina.cz'], cc: [MAILBOX] }, expect: { kind: 'propose', cautions: ['role_address', 'not_direct', 'external_recipients'] } },

  // ---- rozpor mezi firmou v hlavičce a doménou → návrh (S5, revize 30. 9.)
  { name: 'firma v hlavičce nesedí s doménou (vydává se za jinou firmu)', c: { fromName: 'Jan Novák | Skutečná Firma s.r.o.', fromAddress: 'jan.novak@evil-domena.cz' }, expect: { kind: 'propose', cautions: ['name_domain_mismatch'] } },
  { name: 'firma v hlavičce sedí s doménou (bez diakritiky a pomlček)', c: { fromName: 'Jan Novák | Acme-Stroje, s.r.o.', fromAddress: 'jan.novak@acmestroje.cz' }, expect: { kind: 'auto' } },
  { name: 'zkratka firmy je v doméně (ČEZ, a.s. / cez.cz)', c: { fromName: 'Jan Novák | ČEZ, a.s.', fromAddress: 'jan.novak@cez.cz' }, expect: { kind: 'auto' } },
  { name: 'jméno jen člověka (žádná firma) rozpor nemá', c: { fromName: 'Jan Novák', fromAddress: 'jan.novak@nahodna-domena.cz' }, expect: { kind: 'auto' } },
  { name: 'rozpor + jen kopie: oba důvody', c: { fromName: 'Jan Novák | Skutečná Firma s.r.o.', fromAddress: 'jan.novak@evil-domena.cz', to: ['x@jina.cz'], cc: [MAILBOX] }, expect: { kind: 'propose', cautions: ['name_domain_mismatch', 'not_direct', 'external_recipients'] } },
  { name: 'známý klient: rozpor jméno/doména nebrání aktivitě (nová doména se netýká)', c: { fromName: 'Jan Novák | Jiná Firma s.r.o.' }, x: { knownDomains: new Map([['acme-stroje.cz', [5]]]) }, expect: { kind: 'known', accountId: 5 } },

  // ---- doména už v CRM (jen podle webu klienta) → jen aktivita
  { name: 'doména patří jednomu klientovi (web) a zpráva splňuje podmínky', c: {}, x: { knownDomains: new Map([['acme-stroje.cz', [5]]]) }, expect: { kind: 'known', accountId: 5 } },
  { name: 'doména patří klientovi, ale píše info@ → nic', c: { fromAddress: 'info@acme-stroje.cz', fromName: null }, x: { knownDomains: new Map([['acme-stroje.cz', [5]]]) }, expect: { kind: 'skip', reason: 'known_domain' } },
]

describe('decideIntake — tabulka případů', () => {
  test.each(CASES)('$name', ({ c, x, expect: want }) => {
    const d = decideIntake(cand(c), ctx(x))
    expect(d.kind).toBe(want.kind)
    if (want.kind === 'skip') expect((d as { reason: string }).reason).toBe(want.reason)
    if (want.kind === 'known') expect((d as { accountId: number }).accountId).toBe(want.accountId)
    if (want.kind === 'propose') expect([...(d as { cautions: string[] }).cautions].sort()).toEqual([...want.cautions].sort())
  })

  test('automat nese firmu, kontakt a důvody jistoty', () => {
    const d = decideIntake(cand({ fromName: 'Jan Novák | ACME Stroje s.r.o.' }), ctx()) as Extract<IntakeDecision, { kind: 'auto' }>
    expect(d).toMatchObject({
      kind: 'auto', domain: 'acme-stroje.cz', companyName: 'ACME Stroje s.r.o.', contactName: 'Jan Novák', contactEmail: 'jan.novak@acme-stroje.cz',
    })
    expect(d.reasons).toEqual(['corporate_domain', 'new_domain', 'personal_sender', 'direct_to_mailbox', 'single_external_party', 'not_bulk'])
  })

  test('bez firmy v hlavičce je název z domény, jméno kontaktu z hlavičky', () => {
    const d = decideIntake(cand(), ctx()) as Extract<IntakeDecision, { kind: 'auto' }>
    expect(d).toMatchObject({ companyName: 'Acme Stroje', contactName: 'Jan Novák' })
  })

  test('propojený klient v kopii i dva klienti se dají dohledat pro návrh', () => {
    const d = decideIntake(
      cand({ cc: ['petr@znamy.cz'] }),
      ctx({ knownAddresses: new Map([['petr@znamy.cz', 7]]), knownDomains: new Map([['znamy.cz', [7]]]) }),
    ) as Extract<IntakeDecision, { kind: 'propose' }>
    expect(d.relatedAccountIds).toEqual([7])
    const two = decideIntake(
      cand({ matchStatus: 'ambiguous' }),
      ctx({ knownDomains: new Map([['acme-stroje.cz', [9, 3]]]) }),
    ) as Extract<IntakeDecision, { kind: 'propose' }>
    expect(two.relatedAccountIds).toEqual([3, 9])
  })

  test('hranice: přesně tři příjemci jde automaticky, přesně osm příjemců není ještě hromadná', () => {
    expect(decideIntake(cand({ to: [MAILBOX, 'a@mummiesdaddies.com'], cc: ['b@mummiesdaddies.com'] }), ctx()).kind).toBe('auto')
    const eight = decideIntake(cand({ to: [MAILBOX, ...Array.from({ length: 7 }, (_, i) => `k${i}@mummiesdaddies.com`)] }), ctx())
    expect(eight.kind).toBe('propose')
  })

  test('hranice stáří: přesně maxAgeDays ještě projde', () => {
    const edge = new Date(NOW.getTime() - CFG.maxAgeDays * 86_400_000).toISOString()
    expect(decideIntake(cand({ occurredAt: edge }), ctx()).kind).toBe('auto')
    const over = new Date(NOW.getTime() - CFG.maxAgeDays * 86_400_000 - 1000).toISOString()
    expect(decideIntake(cand({ occurredAt: over }), ctx())).toEqual({ kind: 'skip', reason: 'stale' })
  })

  test('výsledek je deterministický a nemění vstup', () => {
    const c = cand()
    const snapshot = JSON.stringify(c)
    expect(decideIntake(c, ctx())).toEqual(decideIntake(c, ctx()))
    expect(JSON.stringify(c)).toBe(snapshot)
  })
})

describe('odesílatel', () => {
  test.each([
    ['jan.novak@acme.cz', 'Jan Novák', 'personal'],
    ['novak@acme.cz', 'Jan Novák', 'personal'],
    ['jnovak@acme.cz', 'Jan Novák', 'personal'],
    ['jan.novak@acme.cz', null, 'personal'],
    ['j.novak@acme.cz', null, 'personal'],
    ['jan_novak@acme.cz', null, 'personal'],
    ['jan@acme.cz', 'Jan', 'unclear'],
    ['novak@acme.cz', null, 'unclear'],
    ['jnovak@acme.cz', null, 'unclear'],
    ['info@acme.cz', 'Acme s.r.o.', 'role'],
    ['obchod@acme.cz', 'Jan Novák', 'role'],
    ['office@acme.cz', null, 'role'],
    ['podpora@acme.cz', 'Podpora Acme', 'role'],
    ['sales.cz@acme.cz', null, 'role'],
    ['hr@acme.cz', null, 'role'],
    ['info2@acme.cz', null, 'role'],
    ['obchodni.oddeleni@acme.cz', null, 'role'],
    ['petr.info@acme.cz', null, 'personal'],
    ['acme@acme.cz', 'Acme s.r.o.', 'unclear'],
    ['zdenek.svoboda@acme.cz', 'Obchodní oddělení', 'personal'],
  ] as const)('%s / %s → %s', (address, name, kind) => {
    expect(senderKind(address, name)).toBe(kind)
  })
})

describe('názvy', () => {
  test.each([
    ['acme-stroje.cz', 'Acme Stroje'],
    ['spolchemie.cz', 'Spolchemie'],
    ['mail.acme.cz', 'Acme'],
    ['firma.co.uk', 'Firma'],
    ['my_firma-cz.com', 'My Firma Cz'],
    ['k2.cz', 'K2'],
  ])('doména %s → %s', (domain, name) => {
    expect(companyNameFromDomain(domain)).toBe(name)
  })

  test.each([
    ['Jan Novák | ACME Stroje s.r.o.', 'ACME Stroje s.r.o.'],
    ['ACME Stroje a.s. — Jan Novák', 'ACME Stroje a.s.'],
    ['Jan Novák (Beta Trade spol. s r.o.)', 'Beta Trade spol. s r.o.'],
    ['Petr Svoboda / Gamma GmbH', 'Gamma GmbH'],
    ['Jan Novák', null],
    ['Ana Svobodová', null],
    ['s.r.o.', null],
    [null, null],
  ])('firma z odesílatele „%s" → %s', (name, company) => {
    expect(companyNameFromSender(name)).toBe(company)
  })

  test('jméno kontaktu: osobní část hlavičky, jinak z adresy', () => {
    expect(contactNameFor({ fromName: 'Jan Novák | ACME s.r.o.', fromAddress: 'x@acme.cz' })).toBe('Jan Novák')
    expect(contactNameFor({ fromName: null, fromAddress: 'jan.novak@acme.cz' })).toBe('Jan Novak')
    expect(contactNameFor({ fromName: 'ACME s.r.o.', fromAddress: 'petr_svoboda@acme.cz' })).toBe('Petr Svoboda')
  })

  test.each([
    ['Jan Novák', 'jan.novak@acme.cz', 'Jan Novák'],
    ['  "Jan   Novák"  ', 'jan.novak@acme.cz', 'Jan Novák'],
    ['Jan​ Novák', 'x@y.cz', 'Jan Novák'], // neviditelný znak
    ['jan.novak@acme.cz', 'jan.novak@acme.cz', null],
    ['Jan <script>', 'x@y.cz', null],
    ['Navštivte https://spam.example', 'x@y.cz', null],
    ['www.spam.cz', 'x@y.cz', null],
    ['1234', 'x@y.cz', null],
    ['J', 'x@y.cz', null],
    [42, 'x@y.cz', null],
  ])('jméno z hlavičky %j → %j', (raw, address, want) => {
    expect(cleanDisplayName(raw, address)).toBe(want)
  })

  test('jméno z hlavičky se zkrátí na 200 znaků', () => {
    expect(cleanDisplayName(`Jan ${'N'.repeat(500)}`, null)?.length).toBe(200)
  })
})

describe('pracovní dny', () => {
  test.each([
    ['2026-09-28', 1, '2026-09-29'], // pondělí → úterý
    ['2026-09-29', 1, '2026-09-30'],
    ['2026-10-02', 1, '2026-10-05'], // pátek → pondělí
    ['2026-10-03', 1, '2026-10-05'], // sobota → pondělí
    ['2026-10-04', 1, '2026-10-05'], // neděle → pondělí
    ['2026-10-02', 3, '2026-10-07'],
    ['2026-10-02', 0, '2026-10-02'],
  ])('%s + %i pracovních dnů = %s', (day, n, want) => {
    expect(addBusinessDays(day, n)).toBe(want)
  })
})

describe('konfigurace', () => {
  test('konfigurace firmy je v pořádku a uzel existuje', () => {
    expect(autoIntakeConfigIssues(CFG, COMPANY.nodes)).toEqual([])
    expect(CFG.dailyLimit).toBe(10)
  })

  test.each([
    [{ dailyLimit: 0 }, 'dailyLimit'],
    [{ dailyLimit: AUTO_INTAKE_MAX_DAILY_LIMIT + 1 }, 'dailyLimit'],
    [{ dailyLimit: 2.5 }, 'dailyLimit'],
    [{ node: 'neexistuje' }, 'uzel'],
    [{ maxAgeDays: 0 }, 'maxAgeDays'],
    [{ maxAutoRecipients: 0 }, 'maxAutoRecipients'],
    [{ bulkRecipients: 2, maxAutoRecipients: 3 }, 'bulkRecipients'],
    [{ revenueLine: 'nic' }, 'obchodní linie'],
    [{ dealTitleTemplate: 'bez firmy' }, 'dealTitleTemplate'],
    [{ taskTitleTemplate: 'bez firmy' }, 'taskTitleTemplate'],
    [{ proposalTitleTemplate: 'bez domény' }, 'proposalTitleTemplate'],
    [{ nextStep: '  ' }, 'nextStep'],
    [{ nextStepBusinessDays: 11 }, 'nextStepBusinessDays'],
    [{ proposalSteps: [] }, 'proposalSteps'],
    [{ internalDomains: ['Není doména'] }, 'neplatná doména'],
  ] as const)('chyba konfigurace %j', (over, text) => {
    const issues = autoIntakeConfigIssues({ ...CFG, ...over } as AutoIntakeConfig, COMPANY.nodes)
    expect(issues.join(' | ')).toContain(text)
  })

  test('denní limit: výchozí z konfigurace, env ho přebije, nesmysl se ignoruje', () => {
    expect(resolveDailyLimit(CFG, {})).toBe(10)
    expect(resolveDailyLimit(CFG, { AUTO_INTAKE_DAILY_LIMIT: '3' })).toBe(3)
    expect(resolveDailyLimit(CFG, { AUTO_INTAKE_DAILY_LIMIT: ' 25 ' })).toBe(25)
    for (const bad of ['0', '-1', '1.5', 'abc', '', '201', '1e3']) expect(resolveDailyLimit(CFG, { AUTO_INTAKE_DAILY_LIMIT: bad })).toBe(10)
  })

  test('přepínač je vypnutý, dokud není přesně „true"', () => {
    expect(autoIntakeEnabledFromEnv({})).toBe(false)
    expect(autoIntakeEnabledFromEnv({ CAPABILITY_AUTO_INTAKE_ENABLED: 'TRUE' })).toBe(false)
    expect(autoIntakeEnabledFromEnv({ CAPABILITY_AUTO_INTAKE_ENABLED: '1' })).toBe(false)
    expect(autoIntakeEnabledFromEnv({ CAPABILITY_AUTO_INTAKE_ENABLED: 'true' })).toBe(true)
  })

  test('freemail seznam obsahuje i domény, které sync nezná', () => {
    for (const d of ['gmail.com', 'seznam.cz', 'yahoo.com', 'post.cz', 'outlook.com', 'icloud.com']) expect(INTAKE_FREEMAIL.has(d)).toBe(true)
    expect(INTAKE_FREEMAIL.has('acme-stroje.cz')).toBe(false)
  })

  test('inDomainSet: přesná shoda i subdoména, ne podřetězec', () => {
    const set = new Set(['mummiesdaddies.com'])
    expect(inDomainSet('mummiesdaddies.com', set)).toBe(true)
    expect(inDomainSet('mail.mummiesdaddies.com', set)).toBe(true)
    expect(inDomainSet('notmummiesdaddies.com', set)).toBe(false)
    expect(inDomainSet('mummiesdaddies.com.evil.example', set)).toBe(false)
  })
})

describe('vstup pro založení a návrh', () => {
  const auto = () => decideIntake(cand({ fromName: 'Jan Novák | ACME Stroje s.r.o.' }), ctx()) as Extract<IntakeDecision, { kind: 'auto' }>

  test('vstup RPC: vlastník, fáze Poptávka, další krok do 1 pracovního dne, označení „automaticky"', () => {
    const p = buildFoundPayload({
      candidate: cand({ fromName: 'Jan Novák | ACME Stroje s.r.o.' }), decision: auto(), companyName: 'ACME Stroje s.r.o.', cfg: CFG,
      ownerId: '11111111-1111-4111-8111-111111111111', evidenceId: 42, dailyLimit: 10, now: new Date('2026-10-02T10:00:00Z'), // pátek
    })
    expect(p).toMatchObject({
      message_id: '<m1@acme-stroje.cz>', domain: 'acme-stroje.cz', today: '2026-10-02', daily_limit: 10, evidence_id: 42,
      owner_id: '11111111-1111-4111-8111-111111111111',
      account: { name: 'ACME Stroje s.r.o.' },
      contact: { full_name: 'Jan Novák', email: 'jan.novak@acme-stroje.cz' },
      deal: {
        title: 'Poptávka z e-mailu — ACME Stroje s.r.o.', stage: 'kvalifikace', revenue_line: 'catering_firemni',
        revenue_category: 'one_time', next_step: 'Odpovědět na poptávku', next_step_due: '2026-10-05',
      },
      task: { title: 'Odpovědět na poptávku — ACME Stroje s.r.o.', due_on: '2026-10-05', priority: 'high' },
    })
    expect(p.account.notes).toContain('Vzniklo automaticky z e-mailu (29. 9. 2026)')
    expect(p.account.notes).toContain('Předmět ani obsah zprávy Cockpit nečte')
    expect(p.deal.note).toContain('Vzniklo automaticky z e-mailu')
    expect(p.activity.subject).toContain('vzniklo automaticky z e-mailu')
    expect(p.reasons).toContain('personal_sender')
  })

  test('vstup RPC nenese předmět ani obsah zprávy (žádné takové pole neexistuje)', () => {
    const p = buildFoundPayload({ candidate: cand(), decision: auto(), companyName: 'Acme', cfg: CFG, ownerId: 'x', evidenceId: null, dailyLimit: 10, now: NOW })
    const keys = JSON.stringify(Object.keys(p)) + JSON.stringify(Object.keys(p.account)) + JSON.stringify(Object.keys(p.activity))
    expect(keys).not.toMatch(/subject_line|body|preview|content|text/)
  })

  test('návrh: název a zdůvodnění nesou jen doménu a důvody, nikdy jméno ani adresu', () => {
    const t = buildProposalText('acme-stroje.cz', ['role_address', 'not_direct'], CFG)
    expect(t.title).toBe('Nová poptávka z domény acme-stroje.cz — ověřit')
    expect(t.rationale).toContain('obecná adresa firmy')
    expect(t.rationale).toContain('jen v kopii')
    expect(t.rationale).not.toMatch(/@|Novák/)
  })

  test('návrh „dva klienti" jmenuje dotčené firmy', () => {
    const t = buildProposalText('acme-stroje.cz', ['external_recipients', 'two_clients'], CFG, ['Alfa s.r.o.', 'Beta a.s.'])
    expect(t.title).toBe('E-mail se dvěma klienty — rozhodni, komu patří')
    expect(t.rationale).toContain('Týká se: Alfa s.r.o., Beta a.s.')
  })

  test('klíč návrhu je jeden na doménu a jde z něj doména zpátky', () => {
    const key = proposalSourceKey('acme-stroje.cz')
    expect(key).toBe('outlook:inbox|inquiry.domain|acme-stroje.cz')
    expect(domainFromProposalKey(key)).toBe('acme-stroje.cz')
    expect(domainFromProposalKey('outlook:inbox|message.inbound|<x@y>')).toBeNull()
    expect(domainFromProposalKey('outlook:inbox|inquiry.domain|')).toBeNull()
  })
})

describe('intakeCandidateFromMessage', () => {
  const msg = {
    internetMessageId: ' <abc@acme-stroje.cz> ',
    receivedDateTime: '2026-09-29T07:30:00Z',
    from: { emailAddress: { address: 'Jan.Novak@ACME-stroje.cz', name: 'Jan Novák' } },
    toRecipients: [{ emailAddress: { address: 'Viktor@mummiesdaddies.com' } }],
    ccRecipients: [{ emailAddress: { address: 'a@b.cz' } }, { emailAddress: { address: 'a@b.cz' } }, { emailAddress: { address: 'není adresa' } }],
  }

  test('normalizuje adresy, dedupuje příjemce a čistí jméno', () => {
    expect(intakeCandidateFromMessage(msg, 'unknown', 'https://outlook.office.com/x')).toEqual({
      messageId: '<abc@acme-stroje.cz>',
      occurredAt: '2026-09-29T07:30:00.000Z',
      webLink: 'https://outlook.office.com/x',
      fromAddress: 'jan.novak@acme-stroje.cz',
      fromName: 'Jan Novák',
      to: ['viktor@mummiesdaddies.com'],
      cc: ['a@b.cz'],
      matchStatus: 'unknown',
    })
  })

  test.each([
    ['bez Message-ID', { internetMessageId: '' }],
    ['bez data', { receivedDateTime: null }],
    ['nesmyslné datum', { receivedDateTime: 'včera' }],
    ['bez odesílatele', { from: null }],
    ['odesílatel bez adresy', { from: { emailAddress: { address: 'x', name: 'Jan' } } }],
  ])('zpráva %s není kandidát', (_label, over) => {
    expect(intakeCandidateFromMessage({ ...msg, ...over }, 'unknown', null)).toBeNull()
  })
})

describe('senderCompanyMismatch', () => {
  test.each([
    ['Jan Novák | ACME Stroje s.r.o.', 'acme-stroje.cz', false],
    ['Jan Novák | ACME Stroje s.r.o.', 'mail.acme-stroje.cz', false],
    ['Jan Novák | Skutečná Firma s.r.o.', 'evil.cz', true],
    ['Jan Novák | Skutečná Firma s.r.o.', 'skutecnafirma.cz', false],
    ['Petr | Kaufland Česká republika v.o.s.', 'kaufland.cz', false],
    ['Jan Novák', 'evil.cz', false],
    [null, 'evil.cz', false],
    ['Jan | Firma Group s.r.o.', 'firma.co.uk', false],
  ])('%s / %s -> %s', (name, domain, want) => {
    expect(senderCompanyMismatch(name, domain)).toBe(want)
  })
})
