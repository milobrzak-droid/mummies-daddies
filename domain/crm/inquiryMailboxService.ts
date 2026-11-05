// Agent příchozích poptávek (P2) — čtení schránek Gmailu do fronty.
//
// Pro každou schránku z INQUIRY_AGENT_MAILBOXES:
//   1) přístupový token (connectors/gmail, refresh token z env),
//   2) nové zprávy: users.history.list od uloženého historyId (connector_state
//      'gmail:inquiry:<hash>'), při prvním běhu nebo prošlém historyId záložní
//      polling `in:inbox newer_than:Nd`,
//   3) zprávy, které fronta už zná (stejná schránka + Gmail id), se přeskočí,
//   4) metadata (jen hlavičky) → předfiltr (domain/crm/inquiryMailbox.ts) →
//      RPC inquiry_agent_enqueue (jen identifikátory; UNIQUE Message-ID
//      vyřeší stejnou zprávu ve dvou schránkách),
//   5) kurzor se posune jen tehdy, když se celá dávka zpracovala; jinak
//      zůstane starý a další běh dávku projde znovu (idempotentně).
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
import { getConnectorState, recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { logError } from '@/lib/log'
import { inquiryMailboxesFromEnv, mailboxConnectorKey, pollingQuery, screenInboundMessage, type ScreenSkip } from './inquiryMailbox'
import type { MailPort } from './inquiryAgentService'

export const MAX_HISTORY_PAGES = 5
export const MAX_NEW_PER_MAILBOX = 50

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
}

export type MailboxSyncStats = {
  mailboxes: number
  listed: number
  enqueued: number
  duplicates: number
  skipped: Partial<Record<ScreenSkip, number>>
  errors: Record<string, number>
  polled: number
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

/** Projde schránky a nové poptávky zařadí do fronty. */
export async function syncInquiryMailboxes(deps: MailboxSyncDeps): Promise<MailboxSyncStats> {
  const cfg = inquiryCfg()
  const now = deps.now ?? (() => new Date())
  const timeUp = deps.timeUp ?? (() => false)
  const mailboxes = deps.mailboxes ?? inquiryMailboxesFromEnv()
  const stats: MailboxSyncStats = { mailboxes: mailboxes.length, listed: 0, enqueued: 0, duplicates: 0, skipped: {}, errors: {}, polled: 0 }
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
    const token = tok.accessToken
    const memberId = await deps.store.memberIdByEmail(mailbox)

    // --- seznam nových zpráv
    const cursor = await deps.store.cursor(key)
    let newCursor: string | null = cursor
    let ids: string[] = []
    let complete = true
    let poll = cursor === null
    if (cursor) {
      let page: string | null = null
      for (let i = 0; i < MAX_HISTORY_PAGES; i++) {
        const r = await deps.gmail.historyPage(token, cursor, page)
        if (r.kind === 'not_found') {
          poll = true
          break
        }
        if (r.kind !== 'ok') {
          complete = false
          err(`history_${r.kind}`)
          break
        }
        ids.push(...r.data.messageIds)
        if (r.data.historyId) newCursor = r.data.historyId
        page = r.data.nextPageToken
        if (!page) break
        if (i === MAX_HISTORY_PAGES - 1) complete = false
      }
    }
    if (poll) {
      // Kurzor bereme PŘED výpisem, ať mezi výpisem a uložením nic nepropadne.
      const prof = await deps.gmail.profile(token)
      if (prof.kind !== 'ok' || !prof.data.historyId) {
        err(`profile_${prof.kind}`)
        await deps.store.error(key, `profile_${prof.kind}`)
        continue
      }
      newCursor = prof.data.historyId
      const list = await deps.gmail.listIds(token, pollingQuery(maxAgeDays), null)
      if (list.kind !== 'ok') {
        err(`list_${list.kind}`)
        await deps.store.error(key, `list_${list.kind}`)
        continue
      }
      ids = list.data.messageIds
      stats.polled++
    }
    ids = [...new Set(ids)]
    stats.listed += ids.length

    // --- jen nové
    const known = await deps.store.knownIds(mailbox, ids)
    const fresh = ids.filter((id) => !known.has(id))
    if (fresh.length > MAX_NEW_PER_MAILBOX) complete = false

    for (const id of fresh.slice(0, MAX_NEW_PER_MAILBOX)) {
      if (timeUp()) {
        complete = false
        break
      }
      const m = await deps.gmail.meta(token, id)
      if (m.kind === 'not_found') continue
      if (m.kind !== 'ok') {
        complete = false
        err(`meta_${m.kind}`)
        break
      }
      const s = screenInboundMessage(m.data, {
        mailbox,
        companyDomains: [COMPANY.emailDomain],
        inquiryAddresses: cfg.inquiryAddresses ?? [],
        automatedDomains: automated,
        maxAgeDays,
        now: now(),
      })
      if (!s.ok) {
        stats.skipped[s.reason] = (stats.skipped[s.reason] ?? 0) + 1
        continue
      }
      try {
        const res = await deps.store.enqueue({
          internet_message_id: s.candidate.internetMessageId,
          graph_message_id: s.candidate.gmailMessageId,
          thread_id: s.candidate.threadId,
          mailbox,
          mailbox_member_id: memberId,
          received_at: s.candidate.receivedAt,
        })
        if (res === 'created') stats.enqueued++
        else stats.duplicates++
      } catch (e) {
        logError('inquiryMailbox.enqueue', e, { mailboxKey: key })
        complete = false
        err('enqueue')
        break
      }
    }

    if (complete) await deps.store.success(key, newCursor)
    else if (cursor === null) await deps.store.error(key, 'partial_first_run')
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
