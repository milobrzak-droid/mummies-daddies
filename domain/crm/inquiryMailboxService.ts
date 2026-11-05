// Agent příchozích poptávek (P2) — čtení schránek Gmailu do fronty.
//
// Pro každou schránku z INQUIRY_AGENT_MAILBOXES:
//   1) přístupový token (connectors/gmail, refresh token z env),
//   2) nové zprávy: users.history.list od uloženého historyId (connector_state
//      'gmail:inquiry:<hash>'); při prvním běhu nebo prošlém historyId polling
//      Doručené pošty (všechny stránky výpisu, ne jen prvních 100),
//   3) zprávy, které fronta už zná (stejná schránka + Gmail id), se přeskočí,
//   4) metadata (jen hlavičky) → předfiltr (domain/crm/inquiryMailbox.ts) →
//      RPC inquiry_agent_enqueue (jen identifikátory; UNIQUE Message-ID
//      vyřeší stejnou zprávu ve dvou schránkách),
//   5) PRŮBĚŽNÝ kurzor: po každém běhu se uloží místo, kam až jsou zprávy
//      zpracované — u historie id posledního celého záznamu historie, u
//      pollingu počet zpracovaných nejstarších zpráv v pevném okně
//      ('poll:<historyId>:<od>:<n>', domain/crm/inquiryMailbox.ts). Limit
//      stránek ani limit zpráv na běh tak nikdy nevrátí čtení na starý kurzor
//      (dřív se po výpadku stejných 5 stránek četlo pořád dokola a novější
//      zprávy zůstaly nezpracované).
//   6) zprávy starší než maxMessageAgeDays, které předfiltr přeskočí, nezmizí
//      tiše: za běh a schránku vznikne jeden souhrnný návrh případu pro obchod
//      (CSO) s počtem a odkazy (staleMessagesProposal). Než se návrh zapíše,
//      kurzor se za ně neposune.
//
// Nic z obsahu se neukládá ani neloguje; statistiky jsou jen počty a kódy.
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { COMPANY } from '@/config'
import type { InquiryAgentConfig } from '@/core/agents/inquiryAgentConfig'
import {
  gmailAccessToken,
  gmailHistoryPage,
  gmailListMessageIds,
  gmailMessageFull,
  gmailMessageMeta,
  gmailProfile,
  type GmailHistoryPage,
  type GmailMessageMeta,
  type GmailResult,
} from '@/connectors/gmail'
import { caseProposalSink } from '@/core/agents/caseProposal'
import type { CaseProposalOutput } from '@/core/agents/template'
import { getConnectorState, recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { logError } from '@/lib/log'
import { INQUIRY_AGENT_ACTOR } from './inquiryAgent'
import {
  inquiryMailboxesFromEnv,
  mailboxConnectorKey,
  parseMailboxCursor,
  pollCursor,
  pollingQueryAfter,
  screenInboundMessage,
  staleMessagesProposal,
  type ScreenSkip,
  type StaleMessage,
} from './inquiryMailbox'
import type { MailPort } from './inquiryAgentService'

export const MAX_HISTORY_PAGES = 5
/** Kolik nových zpráv (čtení metadat) na schránku a běh. */
export const MAX_NEW_PER_MAILBOX = 50
/** Stránek výpisu pollingu (po 100 zprávách) na běh. */
export const MAX_POLL_PAGES = 20
/**
 * O kolik zpráv se pokračování pollingu vrátí (zprávu mezitím přesunutou
 * z Doručené pošty by jinak posunutí pořadí mohlo přeskočit). Musí být
 * menší než MAX_NEW_PER_MAILBOX, jinak by běh nemusel postoupit.
 */
export const POLL_OFFSET_MARGIN = 10

export interface GmailPort {
  token(mailbox: string): Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }>
  profile(token: string): Promise<GmailResult<{ emailAddress: string | null; historyId: string | null }>>
  historyPage(token: string, startHistoryId: string, pageToken: string | null): Promise<GmailResult<GmailHistoryPage>>
  listIds(token: string, query: string, pageToken: string | null): Promise<GmailResult<{ messageIds: string[]; nextPageToken: string | null }>>
  meta(token: string, id: string): Promise<GmailResult<GmailMessageMeta>>
}

export interface MailboxStore {
  cursor(key: string): Promise<string | null>
  success(key: string, cursor: string | null): Promise<void>
  error(key: string, code: string): Promise<void>
  /** Gmail id zpráv této schránky, které už fronta má. */
  knownIds(mailbox: string, ids: readonly string[]): Promise<Set<string>>
  enqueue(p: Record<string, unknown>): Promise<'created' | 'duplicate'>
  memberIdByEmail(email: string): Promise<string | null>
  /** Souhrnný návrh případu pro obchod se starými přeskočenými zprávami (viz staleMessagesProposal). */
  reportStale(a: { mailbox: string; mailboxKey: string; batchKey: string; items: StaleMessage[]; maxAgeDays: number; now: Date }): Promise<'created' | 'duplicate'>
}

export type MailboxSyncStats = {
  mailboxes: number
  listed: number
  enqueued: number
  duplicates: number
  skipped: Partial<Record<ScreenSkip, number>>
  errors: Record<string, number>
  polled: number
  /** Staré zprávy (too_old) nahlášené obchodu souhrnným návrhem případu. */
  staleReported: number
}

export type MailboxSyncDeps = {
  gmail: GmailPort
  store: MailboxStore
  mailboxes?: readonly string[]
  now?: () => Date
  timeUp?: () => boolean
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex')

function inquiryCfg(): InquiryAgentConfig {
  const c = COMPANY.capabilities.inquiryAgent as InquiryAgentConfig | null | undefined
  if (!c) throw new Error('Firma nemá capabilities.inquiryAgent')
  return c
}

/** Položka ke zpracování: zpráva (id) a kurzor platný, až bude hotová ona i vše před ní. */
type Entry = { id: string | null; after: string | null }

type ProcessCtx = {
  deps: MailboxSyncDeps
  token: string
  mailbox: string
  key: string
  memberId: string | null
  maxAgeDays: number
  inquiryAddresses: readonly string[]
  automated: readonly string[]
  stats: MailboxSyncStats
  now: () => Date
  timeUp: () => boolean
  stale: StaleMessage[]
  /** Položky před tímto indexem už se zpracovaly v minulém běhu (okraj pokračování pollingu): staré se znovu nehlásí. */
  staleFrom: number
}

/**
 * Zpracuje položky v pořadí. Vrací počet hotových položek od začátku (další
 * běh pokračuje za nimi) a kód chyby, pokud se zastavil kvůli chybě.
 * Zastaví se i na limitu zpráv na běh nebo času (bez chyby).
 */
async function processEntries(ctx: ProcessCtx, entries: readonly Entry[]): Promise<{ done: number; error: string | null }> {
  const ids = [...new Set(entries.map((e) => e.id).filter((x): x is string => x !== null))]
  ctx.stats.listed += ids.length
  const known = await ctx.deps.store.knownIds(ctx.mailbox, ids)
  const seen = new Set<string>()
  let fetched = 0
  for (let i = 0; i < entries.length; i++) {
    const id = entries[i].id
    if (id === null || known.has(id) || seen.has(id)) continue
    if (fetched >= MAX_NEW_PER_MAILBOX || ctx.timeUp()) return { done: i, error: null }
    fetched++
    const m = await ctx.deps.gmail.meta(ctx.token, id)
    if (m.kind === 'not_found') {
      seen.add(id)
      continue
    }
    if (m.kind !== 'ok') return { done: i, error: `meta_${m.kind}` }
    const s = screenInboundMessage(m.data, {
      mailbox: ctx.mailbox,
      companyDomains: [COMPANY.emailDomain],
      inquiryAddresses: ctx.inquiryAddresses,
      automatedDomains: ctx.automated,
      maxAgeDays: ctx.maxAgeDays,
      now: ctx.now(),
    })
    seen.add(id)
    if (!s.ok) {
      ctx.stats.skipped[s.reason] = (ctx.stats.skipped[s.reason] ?? 0) + 1
      if (s.reason === 'too_old' && i >= ctx.staleFrom) ctx.stale.push({ gmailMessageId: id, receivedAt: m.data.receivedAt })
      continue
    }
    try {
      const res = await ctx.deps.store.enqueue({
        internet_message_id: s.candidate.internetMessageId,
        graph_message_id: s.candidate.gmailMessageId,
        thread_id: s.candidate.threadId,
        mailbox: ctx.mailbox,
        mailbox_member_id: ctx.memberId,
        received_at: s.candidate.receivedAt,
      })
      if (res === 'created') ctx.stats.enqueued++
      else ctx.stats.duplicates++
    } catch (e) {
      logError('inquiryMailbox.enqueue', e, { mailboxKey: ctx.key })
      seen.delete(id)
      return { done: i, error: 'enqueue' }
    }
  }
  return { done: entries.length, error: null }
}

/** Kurzor platný po prvních `done` položkách (poslední `after` v hotové části). */
function cursorAfter(entries: readonly Entry[], done: number): string | null {
  for (let i = done - 1; i >= 0; i--) if (entries[i].after) return entries[i].after
  return null
}

/** Nahlásí staré přeskočené zprávy; false = nepovedlo se (kurzor se za ně nesmí posunout). */
async function reportStale(ctx: ProcessCtx): Promise<boolean> {
  if (ctx.stale.length === 0) return true
  try {
    // Klíč dávky z id všech zpráv: jiná dávka = nový návrh, stejná (opakované čtení) = žádný druhý.
    const batchKey = hash(ctx.stale.map((x) => x.gmailMessageId).join(',')).slice(0, 16)
    await ctx.deps.store.reportStale({ mailbox: ctx.mailbox, mailboxKey: ctx.key, batchKey, items: ctx.stale, maxAgeDays: ctx.maxAgeDays, now: ctx.now() })
    ctx.stats.staleReported += ctx.stale.length
    return true
  } catch (e) {
    logError('inquiryMailbox.reportStale', e, { mailboxKey: ctx.key })
    return false
  }
}

/** Projde schránky a nové poptávky zařadí do fronty. */
export async function syncInquiryMailboxes(deps: MailboxSyncDeps): Promise<MailboxSyncStats> {
  const cfg = inquiryCfg()
  const now = deps.now ?? (() => new Date())
  const timeUp = deps.timeUp ?? (() => false)
  const mailboxes = deps.mailboxes ?? inquiryMailboxesFromEnv()
  const stats: MailboxSyncStats = { mailboxes: mailboxes.length, listed: 0, enqueued: 0, duplicates: 0, skipped: {}, errors: {}, polled: 0, staleReported: 0 }
  const err = (code: string) => {
    stats.errors[code] = (stats.errors[code] ?? 0) + 1
  }
  const maxAgeDays = cfg.maxMessageAgeDays ?? 3
  const automated = COMPANY.capabilities.autoIntake?.automatedDomains ?? []

  for (const mailbox of mailboxes) {
    if (timeUp()) break
    const key = mailboxConnectorKey(mailbox, hash)
    const tok = await deps.gmail.token(mailbox)
    if (!tok.ok) {
      err(`token_${tok.reason}`)
      await deps.store.error(key, `token_${tok.reason}`)
      continue
    }
    const ctx: ProcessCtx = {
      deps, token: tok.accessToken, mailbox, key, memberId: await deps.store.memberIdByEmail(mailbox), maxAgeDays,
      inquiryAddresses: cfg.inquiryAddresses ?? [], automated, stats, now, timeUp, stale: [], staleFrom: 0,
    }
    const stored = await deps.store.cursor(key)
    let cur = parseMailboxCursor(stored)

    // --- historie od kurzoru
    if (cur.mode === 'history') {
      const entries: Entry[] = []
      let readError: string | null = null
      let gone = false
      let page: string | null = null
      for (let i = 0; i < MAX_HISTORY_PAGES; i++) {
        const r = await deps.gmail.historyPage(ctx.token, cur.historyId, page)
        if (r.kind === 'not_found') {
          gone = true
          break
        }
        if (r.kind !== 'ok') {
          readError = `history_${r.kind}`
          break
        }
        const records = r.data.records ?? [{ id: null as string | null, messageIds: r.data.messageIds }]
        for (const rec of records) {
          if (rec.messageIds.length === 0) entries.push({ id: null, after: rec.id })
          rec.messageIds.forEach((id, j) => entries.push({ id, after: j === rec.messageIds.length - 1 ? rec.id : null }))
        }
        page = r.data.nextPageToken
        if (!page) {
          // Konec historie: kurzor = aktuální historyId schránky.
          if (r.data.historyId) entries.push({ id: null, after: r.data.historyId })
          break
        }
        // Limit stránek: pokračuje se příště od posledního celého záznamu (průběžný kurzor).
      }
      if (gone) {
        cur = { mode: 'none' }
      } else {
        const res = await processEntries(ctx, entries)
        const reported = await reportStale(ctx)
        const next = reported ? cursorAfter(entries, res.done) : null
        const code = res.error ?? readError ?? (reported ? null : 'report_stale')
        // Posun kurzoru i při chybě (co je hotové, se znovu nečte); bez chyby vždy zápis úspěchu.
        if (next && next !== cur.historyId) await deps.store.success(key, next)
        else if (!code) await deps.store.success(key, cur.historyId)
        if (code) {
          err(code)
          await deps.store.error(key, code)
        }
        continue
      }
    }

    // --- polling (první běh, prošlé historyId, nebo pokračování)
    let historyId: string
    let afterSec: number
    let offset: number
    if (cur.mode === 'poll') {
      historyId = cur.historyId
      afterSec = cur.afterSec
      offset = cur.offset
    } else {
      // Kurzor bereme PŘED výpisem, ať mezi výpisem a uložením nic nepropadne.
      const prof = await deps.gmail.profile(ctx.token)
      if (prof.kind !== 'ok' || !prof.data.historyId) {
        err(`profile_${prof.kind}`)
        await deps.store.error(key, `profile_${prof.kind}`)
        continue
      }
      historyId = prof.data.historyId
      // Pevný začátek okna: pokračování přes víc běhů vidí stejné pořadí zpráv.
      afterSec = Math.floor(now().getTime() / 1000) - Math.max(1, Math.min(Math.round(maxAgeDays), 30)) * 86_400
      offset = 0
    }
    stats.polled++
    const listed: string[] = []
    let listError: string | null = null
    let truncated = false
    let page: string | null = null
    for (let i = 0; i < MAX_POLL_PAGES; i++) {
      const list = await deps.gmail.listIds(ctx.token, pollingQueryAfter(afterSec), page)
      if (list.kind !== 'ok') {
        listError = `list_${list.kind}`
        break
      }
      listed.push(...list.data.messageIds)
      page = list.data.nextPageToken
      if (!page) break
      if (i === MAX_POLL_PAGES - 1) truncated = true
    }
    if (listError) {
      err(listError)
      await deps.store.error(key, listError)
      continue
    }
    // Výpis je od nejnovější; zpracovává se od nejstarší, aby nové zprávy
    // (přibývají na začátku výpisu) neposouvaly už zpracovanou část.
    const oldestFirst = [...new Set(listed)].reverse()
    const start = Math.min(Math.max(0, offset - POLL_OFFSET_MARGIN), oldestFirst.length)
    const entries: Entry[] = oldestFirst.slice(start).map((id) => ({ id, after: null }))
    ctx.staleFrom = offset - start
    const res = await processEntries(ctx, entries)
    const reported = await reportStale(ctx)
    if (reported) {
      const doneAll = res.done === entries.length
      await deps.store.success(key, doneAll ? historyId : pollCursor(historyId, afterSec, start + res.done))
    }
    // Víc zpráv, než se vejde do výpisu (MAX_POLL_PAGES × 100): ohlásit jako chybu konektoru (alarm).
    const code = res.error ?? (reported ? null : 'report_stale') ?? (truncated ? 'poll_truncated' : null)
    if (code) {
      err(code)
      await deps.store.error(key, code)
    }
  }
  return stats
}

// ---------------------------------------------------------------------------
// Adaptéry

export function createGmailPort(): GmailPort {
  return {
    async token(mailbox) {
      const r = await gmailAccessToken(mailbox)
      return r.ok ? r : { ok: false, reason: r.reason }
    },
    profile: (t) => gmailProfile(t),
    historyPage: (t, start, page) => gmailHistoryPage(t, start, page),
    listIds: (t, q, page) => gmailListMessageIds(t, q, page, { maxResults: 100 }),
    meta: (t, id) => gmailMessageMeta(t, id),
  }
}

type Admin = Pick<SupabaseClient, 'from' | 'rpc'>

export function createMailboxStore(admin: Admin): MailboxStore {
  const staleSink = caseProposalSink<Record<string, never>, CaseProposalOutput>(admin, { createdBy: `system:${INQUIRY_AGENT_ACTOR}` })
  return {
    async cursor(key) {
      return (await getConnectorState(key))?.cursor ?? null
    },
    success: (key, cursor) => recordConnectorSuccess(key, cursor),
    error: (key, code) => recordConnectorError(key, code),
    async knownIds(mailbox, ids) {
      if (ids.length === 0) return new Set()
      const out = new Set<string>()
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await admin
          .from('inquiry_agent_run')
          .select('graph_message_id')
          .eq('mailbox', mailbox)
          .in('graph_message_id', ids.slice(i, i + 100))
        if (error) throw new Error(`inquiry_agent_run: ${error.code ?? 'chyba čtení'}`)
        for (const r of (data as { graph_message_id: string }[] | null) ?? []) out.add(r.graph_message_id)
      }
      return out
    },
    async enqueue(p) {
      const { data, error } = await admin.rpc('inquiry_agent_enqueue', { p })
      if (error) throw new Error(`inquiry_agent_enqueue: ${error.code ?? 'chyba'}`)
      return (data as { duplicate?: boolean } | null)?.duplicate ? 'duplicate' : 'created'
    },
    async reportStale(a) {
      const draft = staleMessagesProposal({ ...a, node: inquiryCfg().escalationNode })
      if (!draft) return 'duplicate'
      return staleSink.propose(draft)
    },
    async memberIdByEmail(email) {
      const { data, error } = await admin
        .from('team_member')
        .select('id')
        .ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`))
        .is('deactivated_at', null)
        .limit(1)
        .maybeSingle()
      if (error) return null
      return (data as { id: string } | null)?.id ?? null
    },
  }
}

/** Čtení celé zprávy pro agenta (tělo jen v paměti). */
export function createGmailMailPort(): MailPort {
  return {
    async fetchMessage(mailbox, gmailId) {
      const tok = await gmailAccessToken(mailbox)
      if (!tok.ok) return { kind: 'retry', seconds: 3600, code: `mail_token_${tok.reason}` }
      const r = await gmailMessageFull(tok.accessToken, gmailId)
      if (r.kind === 'ok') return { kind: 'ok', message: { headers: r.data.headers, text: r.data.text } }
      if (r.kind === 'not_found') return { kind: 'gone' }
      if (r.kind === 'throttled') return { kind: 'retry', seconds: Math.max(r.retryAfterSeconds, 60), code: 'mail_throttled' }
      if (r.kind === 'forbidden') return { kind: 'retry', seconds: 3600, code: 'mail_forbidden' }
      if (r.kind === 'unauthorized') return { kind: 'retry', seconds: 300, code: 'mail_unauthorized' }
      return { kind: 'retry', seconds: 900, code: 'mail_error' }
    },
  }
}
