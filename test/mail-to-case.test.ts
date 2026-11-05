// Kapitola 11, „Hotovo když": jedna schopnost („příchozí e-mail vytvoří
// doložený návrh pracovního případu") běží ve DVOU firmách. Tentýž kód —
// Graph odpovědi → Outlook konektor (adaptér kontraktu) → normalizované
// události → schopnost → návrh — jednou s konfigurací firmy, jednou
// s druhou, fiktivní firmou definovanou v testu. Liší se jen konfigurace (uzel, texty, pravidla,
// firemní doména); výsledek se liší přesně podle nich.
//
// DB je malý svět v paměti, který drží stejná pravidla jako migrace 0067
// (UNIQUE capability+source_key, jeden čekající návrh na firmu a uzel,
// evidence „první zápis vyhrává").
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPANY } from '@/config'
import type { CompanyConfig } from '@/core/tenant'
import type { NormalizedEvent } from '@/core/connectors/contract'
import { eventKey } from '@/core/connectors/contract'
import type { ProposalDraft, ProposalSink } from '@/core/agents/template'
import { MAIL_TO_CASE, mailToCaseRuntime, type MailToCaseOutput } from '@/core/agents/mailToCase'
import { runOutlookMailConnector } from '@/domain/crm/mailConnector'
import { runMailToCase, type MailToCaseContext } from '@/domain/crm/mailToCase'
import type { MailEventRow, MailSyncDb, MatchData } from '@/domain/crm/mailSync'
import { mailDeltaStartUrl, type GraphMailMessage, type MailDeltaResult } from '@/connectors/graph'

const G = 'https://graph.microsoft.com/v1.0'
const NOW = new Date('2026-09-28T08:00:00.000Z')
const ACCOUNTS = new Map<number, string>([
  [1, 'Acme a.s.'],
  [2, 'Beta s.r.o.'],
  [3, 'Gama Trade'],
  [4, 'Delta Logistik'],
  [5, 'Epsilon Pumpy'],
])

// ---------------------------------------------------------------------------
// Svět v paměti (stejná pravidla jako 0041 + 0067)

type Proposal = ReturnType<typeof toRow> & { id: number; status: 'pending' | 'accepted' | 'rejected'; decided_at: string | null }

function toRow(d: ProposalDraft<unknown, MailToCaseOutput>, evidenceId: number) {
  return {
    capability: d.capability,
    source_key: d.sourceKey,
    node: d.target.node,
    account_id: d.target.accountId,
    title: d.output.title,
    rationale: d.output.rationale,
    steps: [...d.target.steps],
    method: d.method,
    info_state: d.infoState,
    evidence_id: evidenceId,
  }
}

function world() {
  const mail: MailEventRow[] = []
  const cases: { account_id: number; node: string; status: string }[] = []
  const proposals: Proposal[] = []
  const evidence = new Map<string, { id: number; webLink: string | null }>()

  const context: MailToCaseContext = {
    async accountName(id) { return ACCOUNTS.get(id) ?? null },
    async lastOutboundBefore(id, before) {
      const out = mail
        .filter((m) => m.account_id === id && m.direction === 'outbound' && m.occurred_at < before)
        .map((m) => m.occurred_at)
        .sort()
      return out.at(-1) ?? null
    },
    async hasMailBefore(id, before) { return mail.some((m) => m.account_id === id && m.occurred_at < before) },
    async alreadyTracked(id, node) {
      return (
        cases.some((c) => c.account_id === id && c.node === node && ['open', 'in_progress', 'waiting'].includes(c.status)) ||
        proposals.some((p) => p.account_id === id && p.node === node && p.status === 'pending')
      )
    },
    async rejectedAfter(id, node, after) {
      return proposals.some((p) => p.account_id === id && p.node === node && p.status === 'rejected' && (p.decided_at ?? '') > after)
    },
  }

  const sink: ProposalSink<unknown, MailToCaseOutput> = {
    async propose(d) {
      if (!d.event.evidence) throw new Error('bez dokladu')
      const ref = d.event.evidence
      if (!evidence.has(ref.sourceId)) evidence.set(ref.sourceId, { id: evidence.size + 1, webLink: ref.webLink ?? null })
      if (proposals.some((p) => p.capability === d.capability && p.source_key === d.sourceKey)) return 'duplicate'
      if (proposals.some((p) => p.status === 'pending' && p.capability === d.capability && p.account_id === d.target.accountId && p.node === d.target.node)) {
        return 'duplicate'
      }
      proposals.push({ ...toRow(d, evidence.get(ref.sourceId)!.id), id: proposals.length + 1, status: 'pending', decided_at: null })
      return 'created'
    },
  }

  return { mail, cases, proposals, evidence, context, sink }
}

type World = ReturnType<typeof world>

/** Svět, kde Delta (firma 4) už má v cílovém uzlu firmy rozpracovaný případ. */
function seeded(tenant: CompanyConfig): World {
  const w = world()
  const node = tenant.capabilities.mailToCase?.node
  if (node) w.cases.push({ account_id: 4, node, status: 'in_progress' })
  return w
}

function syncDb(w: World, match: MatchData): MailSyncDb {
  const cursors = new Map<string, string | null>()
  return {
    async loadCursor(c) { return cursors.get(c) ?? null },
    async saveCursor(c, v) { cursors.set(c, v) },
    async recordSuccess() {},
    async recordError() {},
    async loadMatchData() { return match },
    async insertEvents(rows) {
      let n = 0
      for (const r of rows) {
        if (w.mail.some((m) => m.internet_message_id === r.internet_message_id && m.direction === r.direction)) continue
        w.mail.push(r)
        n++
      }
      return n
    },
    async applyToAccount() {},
    async purgeUnmatchedEvents() { return 0 },
    async recordEvidence() {},
  }
}

// ---------------------------------------------------------------------------
// Pošta: stejný příběh pro obě firmy, jen „naše" adresa je z jejich domény

function mailbox(tenant: CompanyConfig) {
  const our = `obchod@${tenant.emailDomain}`
  const inbound = (id: string, from: string, at: string): GraphMailMessage => ({
    id,
    internetMessageId: `<${id}@mail.test>`,
    from: { emailAddress: { address: from } },
    toRecipients: [{ emailAddress: { address: our } }],
    receivedDateTime: at,
    isDraft: false,
    webLink: `https://outlook.office.com/mail/id/${id}`,
  })
  const outbound = (id: string, to: string, at: string): GraphMailMessage => ({
    id,
    internetMessageId: `<${id}@mail.test>`,
    from: { emailAddress: { address: our } },
    toRecipients: [{ emailAddress: { address: to } }],
    sentDateTime: at,
    receivedDateTime: at,
    isDraft: false,
    webLink: `https://outlook.office.com/mail/id/${id}`,
  })
  const match: MatchData = {
    contacts: [{ id: 7, email: 'jana@acme.test', account_id: 1 }],
    aliases: [
      { domain: 'beta.test', account_id: 2 },
      { domain: 'gama.test', account_id: 3 },
      { domain: 'delta.test', account_id: 4 },
    ],
    ourDomain: tenant.emailDomain,
  }
  const page = (messages: GraphMailMessage[], delta: string): MailDeltaResult => ({ kind: 'page', messages, nextLink: null, deltaLink: delta })
  const script: Record<string, MailDeltaResult> = {
    [mailDeltaStartUrl('inbox')]: page([
      inbound('i-gama', 'info@gama.test', '2026-09-10T10:00:00Z'),        // stará zpráva
      inbound('i-acme', 'jana@acme.test', '2026-09-27T10:00:00Z'),        // odpověď na naši zprávu z 20. 9.
      inbound('i-beta', 'novak@beta.test', '2026-09-27T11:00:00Z'),       // první zpráva od firmy
      inbound('i-delta', 'info@delta.test', '2026-09-27T12:00:00Z'),      // firma už má případ
      inbound('i-neznama', 'nekdo@neznama.test', '2026-09-27T13:00:00Z'), // nespárovaná
      inbound('i-kolega', `kolega@${tenant.emailDomain}`, '2026-09-27T14:00:00Z'), // interní
      inbound('i-acme-2', 'jana@acme.test', '2026-09-27T15:00:00Z'),      // druhá odpověď téhož dne
    ], `${G}/inbox?delta=1`),
    [mailDeltaStartUrl('sentitems')]: page([
      outbound('s-gama', 'info@gama.test', '2026-09-09T09:00:00Z'),
      outbound('s-acme', 'jana@acme.test', '2026-09-20T09:00:00Z'),
      outbound('s-delta', 'info@delta.test', '2026-09-26T09:00:00Z'),
    ], `${G}/sent?delta=1`),
  }
  return { match, fetchPage: async (url: string) => script[url] ?? { kind: 'error' as const, status: 404, message: url } }
}

/** Celá cesta: Graph → konektor → události → schopnost (jako cron route). */
async function pipeline(tenant: CompanyConfig, w: World, extra: NormalizedEvent[] = []) {
  const box = mailbox(tenant)
  const run = await runOutlookMailConnector({
    fetchPage: box.fetchPage,
    db: syncDb(w, box.match),
    sleep: async () => {},
    now: () => 0,
  })
  const capability = await runMailToCase({
    tenant,
    events: [...run.results.inbox.events, ...run.results.sent.events, ...extra],
    context: w.context,
    sink: w.sink,
    now: NOW,
  })
  return { run, capability }
}

/** Událost z jiného konektoru, který smí předat titulek (webový formulář). */
function formEvent(accountId: number, title: string): NormalizedEvent {
  return {
    source: 'formular:web',
    type: 'message.inbound',
    external_id: `form-${accountId}`,
    occurred_at: '2026-09-27T16:00:00.000Z',
    subject: { kind: 'account', id: accountId },
    participants: [{ role: 'from', accountId, contactId: null, domain: null }],
    evidence: { kind: 'url', sourceId: `https://formular.test/odeslano/${accountId}`, webLink: `https://formular.test/odeslano/${accountId}` },
    title,
    payload: null,
  }
}

// ---------------------------------------------------------------------------

// Firma (aktivní konfigurace) a druhá, fiktivní firma jen pro test: stejná
// schopnost, jiná konfigurace (první zpráva + klíčová slova, jiný uzel).
const ENTER: CompanyConfig = COMPANY
const DEMO_NODES = ['prodej', 'servis', 'vyroba'] as const
const DEMO = {
  ...COMPANY,
  id: 'druha-firma',
  name: 'Druhá firma',
  emailDomain: 'druha.example',
  nodes: DEMO_NODES,
  nodeLabels: { prodej: 'Prodej', servis: 'Servis', vyroba: 'Výroba' },
  caseTemplates: [],
  followUpNode: 'prodej',
  capabilities: {
    mailToCase: {
      node: 'prodej',
      titleTemplate: 'Poptávka: {firma}',
      maxEventAgeDays: 3,
      replyWindowDays: null,
      firstContact: true,
      keywords: ['poptávka'],
      steps: ['Kvalifikovat poptávku', 'Poslat nabídku'],
    },
  },
} as unknown as CompanyConfig<(typeof DEMO_NODES)[number]> & { capabilities: { mailToCase: NonNullable<CompanyConfig['capabilities']['mailToCase']> } }

describe('obě firmy mají schopnost zapnutou a platně nastavenou', () => {
  it.each([['firma', ENTER], ['druha', DEMO]] as const)('%s', (_id, tenant) => {
    const cfg = mailToCaseRuntime(tenant)
    expect(cfg).not.toBeNull()
    expect(MAIL_TO_CASE.configIssues(cfg!)).toEqual([])
  })
  it('liší se jen konfigurací: uzel, texty i pravidla', () => {
    expect(ENTER.capabilities.mailToCase!.node).not.toBe(DEMO.capabilities.mailToCase.node)
    expect(ENTER.capabilities.mailToCase!.replyWindowDays).not.toBe(DEMO.capabilities.mailToCase.replyWindowDays)
    expect(ENTER.capabilities.mailToCase!.firstContact).not.toBe(DEMO.capabilities.mailToCase.firstContact)
  })
})

describe('Firma: odpověď na naše oslovení → návrh v uzlu obchodu', () => {
  it('jeden doložený návrh (Acme), ostatní zprávy s důvodem', async () => {
    const w = seeded(ENTER)
    const cfg = ENTER.capabilities.mailToCase!
    const { capability } = await pipeline(ENTER, w)

    expect(w.proposals).toHaveLength(1)
    const p = w.proposals[0]
    expect(p).toMatchObject({
      capability: 'mail_to_case',
      source_key: 'outlook:inbox|message.inbound|<i-acme@mail.test>',
      node: cfg.node,
      account_id: 1,
      title: 'Odpověď od Acme a.s. — další krok',
      method: 'rule',
      info_state: 'ai_suggestion',
      steps: [...cfg.steps],
      status: 'pending',
    })
    expect(p.rationale).toBe('Odpověď na naši zprávu z 20. 9. 2026 (do 14 dní).')
    // Doložení: odkaz na konkrétní zprávu v Outlooku.
    expect(w.evidence.get('<i-acme@mail.test>')).toEqual({ id: p.evidence_id, webLink: 'https://outlook.office.com/mail/id/i-acme' })

    expect(capability).toMatchObject({
      capability: 'mail_to_case',
      events: 6,
      proposed: 1,
      duplicates: 0,
      errors: 0,
      skipped: { stale_event: 1, no_rule: 1, already_tracked: 2, no_context: 1 },
    })
  })

  it('titulek z jiného konektoru firmu nezajímá (klíčová slova vypnutá)', async () => {
    const w = seeded(ENTER)
    const { capability } = await pipeline(ENTER, w, [formEvent(5, 'Poptávka čerpadla KX-200')])
    expect(w.proposals.map((p) => p.account_id)).toEqual([1])
    expect((capability as { skipped: Record<string, number> }).skipped.no_rule).toBe(2)
  })
})

describe('Druhá firma: první zpráva a klíčová slova → návrh v uzlu prodeje', () => {
  it('stejná pošta, jiný výsledek: návrh pro Beta (první kontakt), ne pro Acme', async () => {
    const w = seeded(DEMO)
    const cfg = DEMO.capabilities.mailToCase
    const { capability } = await pipeline(DEMO, w)

    expect(w.proposals).toHaveLength(1)
    expect(w.proposals[0]).toMatchObject({
      source_key: 'outlook:inbox|message.inbound|<i-beta@mail.test>',
      node: 'prodej',
      account_id: 2,
      title: 'Poptávka: Beta s.r.o.',
      rationale: 'První zpráva od firmy — dosud s ní žádná pošta.',
      steps: [...cfg.steps],
      method: 'rule',
    })
    expect(capability).toMatchObject({
      proposed: 1,
      skipped: { stale_event: 1, no_rule: 2, already_tracked: 1, no_context: 1 },
    })
  })

  it('klíčové slovo v titulku z konektoru, který titulek smí předat', async () => {
    const w = seeded(DEMO)
    await pipeline(DEMO, w, [formEvent(5, 'POPTAVKA čerpadla KX-200')])
    const epsilon = w.proposals.find((p) => p.account_id === 5)
    expect(epsilon).toMatchObject({
      title: 'Poptávka: Epsilon Pumpy',
      rationale: 'První zpráva od firmy — dosud s ní žádná pošta. Klíčové slovo „poptávka" v titulku zprávy.',
      source_key: 'formular:web|message.inbound|form-5',
    })
  })
})

describe('idempotence a lidské rozhodnutí', () => {
  it('opakovaný běh nad stejnou poštou nic nezdvojí', async () => {
    const w = seeded(ENTER)
    await pipeline(ENTER, w)
    const second = await pipeline(ENTER, w)
    expect(w.proposals).toHaveLength(1)
    expect(second.capability).toMatchObject({ proposed: 0 })
  })

  it('zamítnutí platí pro poštu, kterou člověk viděl; stejná zpráva návrh znovu nevytvoří', async () => {
    const w = seeded(ENTER)
    await pipeline(ENTER, w)
    Object.assign(w.proposals[0], { status: 'rejected', decided_at: '2026-09-28T07:00:00.000Z' })
    const again = await pipeline(ENTER, w)
    expect(w.proposals).toHaveLength(1)
    expect((again.capability as { skipped: Record<string, number> }).skipped.rejected_by_human).toBe(2)
  })

  it('stejný klíč zdroje u sinku = duplicita (UNIQUE capability + source_key)', async () => {
    const w = seeded(ENTER)
    await pipeline(ENTER, w)
    const p = w.proposals[0]
    // I kdyby kontext nic nehlásil (např. návrh mezitím přijat a případ zrušen),
    // tatáž zpráva druhý návrh nevytvoří.
    Object.assign(p, { status: 'accepted', decided_at: '2026-09-28T07:00:00.000Z' })
    const again = await pipeline(ENTER, w)
    expect(w.proposals).toHaveLength(2) // i-acme-2 je nová zpráva → nový návrh
    expect(w.proposals[1].source_key).toBe('outlook:inbox|message.inbound|<i-acme-2@mail.test>')
    expect(again.capability).toMatchObject({ proposed: 1, duplicates: 1 })
  })

  it('klíč návrhu = klíč normalizované události', async () => {
    const w = seeded(ENTER)
    const { run } = await pipeline(ENTER, w)
    const acme = run.results.inbox.events.find((e) => e.external_id === '<i-acme@mail.test>')!
    expect(w.proposals[0].source_key).toBe(eventKey(acme))
  })
})

// Důkaz „nula nového kódu" pro druhou firmu: kód schopnosti, šablony,
// kontraktu i adaptéru neobsahuje hodnoty ani jedné firmy. Vše je v config/.
describe('kód schopnosti nezná žádnou firmu', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? files(p) : [p]
    })
  const code = [
    ...files('core/agents'),
    ...files('core/connectors'),
    'domain/crm/mailConnector.ts',
    'domain/crm/mailToCase.ts',
    'supabase/migrations/0067_case_proposal.sql',
  ]
  const literals = ([ENTER, DEMO] as CompanyConfig[]).flatMap((t) => [
    t.emailDomain,
    t.timeZone,
    ...t.nodes,
    ...t.sharepointHosts,
    t.capabilities.mailToCase!.titleTemplate,
    ...t.capabilities.mailToCase!.keywords,
    ...t.capabilities.mailToCase!.steps,
  ])

  it.each(code)('%s', (f) => {
    const text = readFileSync(f, 'utf8')
    const hits = literals.filter((l) => new RegExp(`['"\`]${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(text))
    expect(hits).toEqual([])
  })
})
