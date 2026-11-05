// Nabídka z přílohy e-mailu — celá cesta přes skutečný konektor Graph a model
// (jen fetch je falešný): bez přepínače Cockpit na obsah příloh nesáhne, se
// zapnutým přepínačem stáhne jen PDF podobné nabídce, pošle ho JEN do Anthropic
// API a uloží jen návrh. Žádné jiné volání než GET na Graph.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryDb } from './helpers/memoryDb'
import { fakePdf } from './helpers/fakePdf'

const state = vi.hoisted(() => ({ db: null as unknown }))
const mem = () => state.db as MemoryDb

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mem().client }))
vi.mock('@/core/auditDb', () => ({ createAuditedAdminClient: () => mem().client, dbAuditActive: async () => true }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/connectorState', () => ({ recordConnectorError: async () => undefined, recordConnectorSuccess: async () => undefined }))

import { runMailContentIntakeLive } from '@/domain/crm/mailContentService'

const G = 'https://graph.microsoft.com/v1.0'
const PDF = fakePdf({ pages: 2, marker: 'TAJNA-PDF-77' })
const ENV_ALL = {
  MAIL_CONTENT_INTAKE_ENABLED: 'true',
  MAIL_OFFER_ATTACHMENT_ENABLED: 'true',
  ANTHROPIC_API_KEY: 'test-key-not-real',
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }
let calls: Call[]

function graphMessage(over: Record<string, unknown> = {}) {
  return {
    id: 'AAMk1', internetMessageId: '<live1@sigmaform.cz>', subject: 'Nabídka na procesní audit',
    from: { emailAddress: { address: 'jana@sigmaform.cz' } }, toRecipients: [{ emailAddress: { address: 'viktor@mummiesdaddies.com' } }],
    receivedDateTime: '2026-09-29T08:00:00Z', hasAttachments: true, webLink: 'https://outlook.office.com/mail/live1',
    body: { contentType: 'text', content: 'Posílám nabídku.' }, ...over,
  }
}

function installFetch(opts: { attachments?: Record<string, unknown>[] } = {}) {
  calls = []
  const attachments = opts.attachments ?? [
    { id: 'ATT1', name: 'Nabidka_Sigmaform.pdf', contentType: 'application/pdf', size: PDF.byteLength, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' },
    { id: 'ATT2', name: 'podpis.png', contentType: 'image/png', size: 900, isInline: true, '@odata.type': '#microsoft.graph.fileAttachment' },
    { id: 'ATT3', name: 'rozpis.xlsx', contentType: 'application/vnd.ms-excel', size: 9000, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' },
  ]
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    calls.push({ url, method: String(init.method ?? 'GET'), headers, body: typeof init.body === 'string' ? init.body : undefined })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
    if (url.startsWith('https://api.anthropic.com/')) {
      return json({ content: [{ type: 'tool_use', id: 't', name: 'extract_offer', input: {
        account_name: 'Sigmaform Servis s.r.o.', title: 'Procesní audit', currency: 'CZK', amount_one_time: 180000,
      } }] })
    }
    if (url.startsWith(`${G}/me/mailFolders?`)) return json({ value: [{ id: 'F1', displayName: 'Cockpit' }] })
    if (url.includes('/messages/delta')) return json({ value: [graphMessage()], '@odata.deltaLink': `${G}/me/mailFolders/F1/messages/delta?$deltatoken=d1` })
    if (/\/attachments\/ATT1\/\$value$/.test(url)) return new Response(PDF, { status: 200 })
    if (url.includes('/attachments?')) return json({ value: attachments })
    return json({}, 404)
  }))
}

beforeEach(() => {
  // Konektor modelu čte klíč z process.env; přepínače dostává run jako parametr.
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real')
  const db = new MemoryDb({
    unique: { mail_content_intake: [{ columns: ['dedupe_key'] }, { columns: ['offer_proposal_id'] }], evidence: [{ columns: ['source_kind', 'source_id'] }] },
  })
  db.seed('account', [{ id: 1, name: 'Sigmaform Servis s.r.o.', ico: null, web: null }])
  state.db = db
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const run = (env: Record<string, string | undefined>) => runMailContentIntakeLive({ accessToken: 'tok', ownerId: null, budgetMs: 30_000, env })
const graphCalls = () => calls.filter((c) => c.url.startsWith(G))
const anthropicCalls = () => calls.filter((c) => c.url.startsWith('https://api.anthropic.com/'))

describe('runMailContentIntakeLive + nabídka z přílohy', () => {
  test('bez přepínače se obsah příloh nestahuje a model se nevolá (zpráva projde jako dřív)', async () => {
    installFetch()
    for (const env of [
      { MAIL_CONTENT_INTAKE_ENABLED: 'true', ANTHROPIC_API_KEY: 'k' },
      { ...ENV_ALL, MAIL_OFFER_ATTACHMENT_ENABLED: 'yes' },
      { ...ENV_ALL, ANTHROPIC_API_KEY: '' },
    ]) {
      calls = []
      mem().tables.mail_content_intake = []
      mem().tables.evidence = []
      const stats = await run(env)
      expect(stats.offer).toBeUndefined()
      expect(calls.some((c) => c.url.includes('/$value'))).toBe(false)
      expect(anthropicCalls()).toHaveLength(0)
      expect(mem().rows('mail_content_intake')[0].offer_draft ?? null).toBeNull()
    }
  })

  test('se zapnutými přepínači: stáhne jen PDF nabídku, pošle ho jen modelu a uloží jen návrh', async () => {
    installFetch()
    const stats = await run(ENV_ALL)
    expect(stats).toMatchObject({ outcome: 'caught_up', queued: 1, queuedReasons: { offer_draft: 1 }, offer: { drafts: 1, deferred: 0 } })

    // Graph: výhradně GET; stáhla se jediná příloha (PDF), ne obrázek ani xlsx.
    expect(graphCalls().every((c) => c.method === 'GET')).toBe(true)
    const downloads = graphCalls().filter((c) => c.url.includes('/$value'))
    expect(downloads.map((c) => c.url)).toEqual([`${G}/me/messages/AAMk1/attachments/ATT1/$value`])
    expect(downloads[0].headers.Authorization).toBe('Bearer tok')

    // PDF odešlo právě jednou a jen do Anthropic API, v ohraničeném bloku.
    expect(anthropicCalls()).toHaveLength(1)
    const body = JSON.parse(anthropicCalls()[0].body!)
    const doc = body.messages[0].content.find((b: { type: string }) => b.type === 'document')
    expect(Buffer.from(doc.source.data, 'base64').equals(Buffer.from(PDF))).toBe(true)
    expect(body.messages[0].content[0].text).toMatch(/^<<<UNTRUSTED_DATA/)
    expect(calls.filter((c) => !c.url.startsWith(G) && !c.url.startsWith('https://api.anthropic.com/'))).toEqual([])

    // Uložen je návrh, PDF nikde.
    const row = mem().rows('mail_content_intake')[0]
    expect(row).toMatchObject({ status: 'queued', wait_reason: 'offer_draft' })
    expect(row.offer_draft).toMatchObject({ fields: { account_name: 'Sigmaform Servis s.r.o.', amount_one_time: 180000 } })
    expect(JSON.stringify(mem().tables)).not.toContain('TAJNA-PDF-77')
    expect(JSON.stringify(mem().tables)).not.toContain('%PDF')
    expect(mem().rows('account')).toHaveLength(1)
  })

  test('opakovaný běh (stejná zpráva) nestahuje ani nečte podruhé', async () => {
    installFetch()
    await run(ENV_ALL)
    calls = []
    installFetch()
    const again = await run(ENV_ALL)
    expect(again.skipped).toMatchObject({ duplicate: 1 })
    expect(anthropicCalls()).toHaveLength(0)
    expect(calls.some((c) => c.url.includes('/$value'))).toBe(false)
    expect(mem().rows('mail_content_intake')).toHaveLength(1)
  })

  test('zpráva s jinými přílohami než PDF nabídkou: nic se nestáhne', async () => {
    installFetch({ attachments: [
      { id: 'D1', name: 'nabidka.docx', contentType: 'application/msword', size: 100, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' },
    ] })
    const stats = await run(ENV_ALL)
    expect(calls.some((c) => c.url.includes('/$value'))).toBe(false)
    expect(anthropicCalls()).toHaveLength(0)
    expect(stats.offer?.skipped).toEqual({ no_pdf: 1 })
  })
})
