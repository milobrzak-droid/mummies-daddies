// Zapojení úlohy agent-outbox (./agentOutbox.ts) na Supabase (RPC z 0104,
// servisní klíč s aktérem system:agent_outbox pro audit) a Gmail API
// (@/connectors/gmail, send.ts + token.ts). Nastavení z @/config a z prostředí:
//
//   AGENT_OUTBOX_ENABLED=true     úloha vůbec běží (route bez něj vrací 404)
//   AGENT_AUTOSEND_ENABLED=true   smí odeslat i BEZ člověka (jinak jen schválené)
//   OUTBOUND_AUTOSEND_ENABLED=true  oslovení P7 smí odejít bez člověka (navíc L4 send_outreach)
//   GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_REFRESH_TOKENS
//
// Token schránky: společný modul @/connectors/gmail (token.ts) — refresh
// token podle e-mailu člena týmu mailbox_member_id z GMAIL_REFRESH_TOKENS,
// stejně jako čtení poptávek (P2).
import { COMPANY } from '@/config'
import { createAuditedAdminClient } from '@/core/auditDb'
import type { OutboxKind } from '@/core/agents/outboxPort'
import { autoSendOutboxKinds, isWithinWindow, parseSingleMailbox } from '@/core/agents/outboxPolicy'
import {
  base64Url,
  buildMimeMessage,
  findGmailMessageByRfcId,
  getGmailMessageMeta,
  getGmailThreadMeta,
  gmailAccessToken,
  sendGmailMessage,
} from '@/connectors/gmail'
import { logWarn } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'
import {
  OUTBOX_COLUMNS,
  runAgentOutbox,
  type DealFacts,
  type OutboxMail,
  type OutboxRow,
  type OutboxRunConfig,
  type OutboxRunStats,
  type OutboxStore,
} from './agentOutbox'

export const AGENT_OUTBOX_JOB = 'agent-outbox'
export const AGENT_OUTBOX_ACTOR = 'agent_outbox'

type Admin = ReturnType<typeof createAuditedAdminClient>
type RpcError = { code?: string; message?: string } | null

/** Migrace 0104 ještě není nasazená (PostgREST PGRST202 / Postgres 42883 / 42P01). */
export class OutboxSchemaMissingError extends Error {
  constructor() {
    super('Odchozí fronta čeká na migraci 0104')
  }
}

const isMissing = (e: RpcError) => e?.code === 'PGRST202' || e?.code === '42883' || e?.code === '42P01' || e?.code === 'PGRST205'

function fail(scope: string, e: RpcError): never {
  if (isMissing(e)) throw new OutboxSchemaMissingError()
  // Zpráva chyby z DB nenese osobní údaje (RPC vrací jen kódy AOxxx), přesto jen kód.
  throw new Error(`${scope}: ${e?.code ?? 'error'}`)
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

// --- Konfigurace ---------------------------------------------------------------

/** Pražský den v týdnu ISO (1 = pondělí) a hodina. */
export function pragueWeekdayHour(now: Date, timeZone: string = COMPANY.timeZone): { isoWeekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now)
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  return { isoWeekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd) + 1, hour }
}

export function outboxEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.AGENT_OUTBOX_ENABLED === 'true'
}

/** Nastavení běhu z firmy a prostředí; null = firma frontu nemá. */
export function outboxRunConfig(env: Record<string, string | undefined>, now: Date): OutboxRunConfig | null {
  const caps = COMPANY.capabilities
  const outbox = caps.agentOutbox
  if (!outbox) return null
  const map = caps.standardOffer?.priceMap ?? null
  const inquiry = caps.inquiryAgent ?? null
  const followUp = caps.followUpCadence ?? null
  const outreach = caps.outboundAgent?.outreach ?? null
  return {
    outbox,
    autoSendEnabled: env.AGENT_AUTOSEND_ENABLED === 'true',
    companyMapVersion: map?.version ?? null,
    autoSendMaxTotal: map?.autoSendMaxTotal ?? null,
    autoSendKinds: autoSendOutboxKinds(inquiry?.autoSendKinds, followUp != null, outreach != null && env.OUTBOUND_AUTOSEND_ENABLED === 'true'),
    inquiryLimits: inquiry ? { dailyAutoSendLimit: inquiry.dailyAutoSendLimit, perRecipientDailyLimit: inquiry.perRecipientDailyLimit } : null,
    followUpLimits: followUp ? { dailyLimit: followUp.dailyLimit } : null,
    followUpWindowOpen: followUp ? isWithinWindow(pragueWeekdayHour(now), followUp.sendWindow) : null,
    // Oslovení P7: okno a denní limit hlídá úloha outbound-agent při zařazení
    // a fronta znovu při odeslání (zpráva může čekat přes noc).
    outreachLimits: outreach ? { dailyLimit: outreach.dailyLimit } : null,
    outreachWindowOpen: outreach ? isWithinWindow(pragueWeekdayHour(now), outreach.sendWindow) : null,
    wonPhases: Object.values(COMPANY.wonPhases as Record<string, readonly string[]>).flat(),
  }
}

// --- Úložiště (RPC 0104) -------------------------------------------------------

const CLOSED_STAGES = new Set(['vyhráno', 'prohráno'])

export function createOutboxStore(admin: Admin, wonPhases: readonly string[]): OutboxStore {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args)
    if (error) fail(fn, error)
    return data as T
  }
  return {
    async markStale(minutes) {
      return ((await rpc<number[] | null>('agent_outbox_mark_stale', { p_minutes: minutes })) ?? []).map(Number)
    },
    async syncApprovals() {
      return Number((await rpc<number | null>('agent_outbox_sync_approvals', {})) ?? 0)
    },
    async listQueued(limit) {
      const { data, error } = await admin.from('agent_outbox').select(OUTBOX_COLUMNS).eq('status', 'queued').order('id').limit(limit)
      if (error) fail('agent_outbox.queued', error)
      return (data ?? []) as unknown as OutboxRow[]
    },
    async listUncertain(limit) {
      // Jen týden staré: starší dohledá člověk (úkol už má).
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
      const { data, error } = await admin.from('agent_outbox').select(OUTBOX_COLUMNS)
        .eq('status', 'needs_attention').in('stop_reason', ['stale_claim', 'uncertain'])
        .not('rfc_message_id', 'is', null).gte('updated_at', since).order('id').limit(limit)
      if (error) fail('agent_outbox.uncertain', error)
      return (data ?? []) as unknown as OutboxRow[]
    },
    async autonomyGranted(kind: OutboxKind) {
      return (await rpc<boolean | null>('agent_outbox_autonomy_granted', { p_kind: kind })) === true
    },
    async dealFacts(row, recipient, since): Promise<DealFacts> {
      const [deal, version, mailbox, activity, contact] = await Promise.all([
        admin.from('deal').select('id, stage, phase, account_id').eq('id', row.deal_id).maybeSingle(),
        row.scope_version_id != null
          ? admin.from('deal_scope_version').select('status, send_approved_at').eq('id', row.scope_version_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        row.mailbox_member_id
          ? admin.from('team_member').select('email, deactivated_at').eq('id', row.mailbox_member_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        admin.from('sales_activity').select('id').eq('deal_id', row.deal_id).not('created_by', 'is', null).gt('created_at', since).limit(1),
        recipient
          ? admin.from('contact').select('id').ilike('email', escapeLike(recipient)).eq('do_not_contact', true).limit(1)
          : Promise.resolve({ data: [], error: null }),
      ])
      for (const r of [deal, version, mailbox, activity, contact]) if (r.error) fail('agent_outbox.facts', r.error)
      const d = deal.data as { stage: string | null; phase: string | null; account_id: number | null } | null
      let snoozed = d?.stage === 'odloženo'
      if (d?.account_id != null && !snoozed) {
        const acc = await admin.from('account').select('snooze_until').eq('id', d.account_id).maybeSingle()
        if (acc.error) fail('agent_outbox.account', acc.error)
        const until = (acc.data as { snooze_until: string | null } | null)?.snooze_until ?? null
        snoozed = until != null && until >= pragueToday()
      }
      const v = version.data as { status: string; send_approved_at: string | null } | null
      const m = mailbox.data as { email: string | null; deactivated_at: string | null } | null
      const email = m?.email ? parseSingleMailbox(m.email) : null
      return {
        dealClosed: !d || CLOSED_STAGES.has(d.stage ?? '') || (d.phase != null && wonPhases.includes(d.phase)),
        snoozed,
        doNotContact: ((contact.data as unknown[] | null) ?? []).length > 0,
        versionStatus: v?.status ?? null,
        versionSendApproved: v?.send_approved_at != null,
        mailbox: email ? { email, active: m?.deactivated_at == null } : null,
        humanActivity: ((activity.data as unknown[] | null) ?? []).length > 0,
      }
    },
    async claim(x) {
      const r = await rpc<{ ok: boolean; reason?: string }>('agent_outbox_claim', {
        p_id: x.id, p_recipient: x.recipient, p_rfc_message_id: x.rfcMessageId, p_autonomous: x.autonomous,
        p_daily_limit: x.dailyLimit, p_limit_kinds: x.limitKinds, p_per_recipient_limit: x.perRecipientDailyLimit,
      })
      return r?.ok ? { ok: true } : { ok: false, reason: r?.reason ?? 'unknown' }
    },
    async confirm(id, sentMessageId, sentThreadId, bodySha256) {
      await rpc('agent_outbox_confirm', { p_id: id, p_sent_message_id: sentMessageId, p_sent_thread_id: sentThreadId, p_body_sha256: bodySha256 })
    },
    async finish(id, status, reason, errorCode, task) {
      const code = errorCode && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(errorCode) ? errorCode : null
      const r = await rpc<{ ok: boolean }>('agent_outbox_finish', {
        p_id: id, p_status: status, p_reason: reason, p_error_code: code, p_task_title: task?.title ?? null, p_task_text: task?.text ?? null,
      })
      return r?.ok === true
    },
    async requestOfferApproval(id) {
      const r = await rpc<{ ok: boolean; reason?: string }>('agent_outbox_request_offer_approval', { p_id: id })
      return { ok: r?.ok === true, reason: r?.reason }
    },
    async purgeText(days) {
      return Number((await rpc<number | null>('agent_outbox_purge_text', { p_days: days })) ?? 0)
    },
    async threadHeaders(row) {
      const m = /^inquiry:([0-9]+)$/.exec(row.source_ref)
      if (!m) return null
      const { data, error } = await admin.from('inquiry_agent_run').select('internet_message_id').eq('id', Number(m[1])).maybeSingle()
      if (error) fail('inquiry_agent_run.message_id', error)
      return threadHeadersFromMessageId((data as { internet_message_id?: string | null } | null)?.internet_message_id ?? null)
    },
  }
}

/** In-Reply-To / References z Message-ID původní zprávy; nečitelná hodnota = null (bez vlákna). */
export function threadHeadersFromMessageId(raw: string | null | undefined): { inReplyTo: string; references: string } | null {
  const v = (raw ?? '').trim()
  const id = /^<[^<>\s]{1,500}>$/.test(v) ? v : /^[^<>\s@]{1,250}@[^<>\s@]{1,250}$/.test(v) ? `<${v}>` : null
  if (!id || !/^[\x21-\x7e]+$/.test(id)) return null
  return { inReplyTo: id, references: id }
}

// --- Gmail ---------------------------------------------------------------------

export function createGmailOutboxMail(admin: Admin, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): OutboxMail {
  return {
    async token(memberId) {
      // Schránka = e-mail člena týmu; token ze společného modulu (GMAIL_REFRESH_TOKENS).
      const { data, error } = await admin.from('team_member').select('email').eq('id', memberId).maybeSingle()
      if (error) return { ok: false, reason: 'error' }
      const email = parseSingleMailbox((data as { email?: string | null } | null)?.email ?? null)
      if (!email) return { ok: false, reason: 'not_configured' }
      const t = await gmailAccessToken(email, { env, fetchImpl })
      return t.ok ? t : { ok: false, reason: t.reason }
    },
    async original(token, id) {
      const r = await getGmailMessageMeta(token, id, fetchImpl)
      if (!r.ok) return { ok: false, kind: r.kind }
      const m = r.message
      return { ok: true, message: { threadId: m.threadId, from: m.from, replyTo: m.replyTo, messageId: m.messageId, references: m.references, authResults: m.authResults } }
    },
    async customerRepliedInThread(token, threadId, sinceMs, mailboxEmail) {
      const r = await getGmailThreadMeta(token, threadId, fetchImpl)
      if (!r.ok) return null
      return r.messages.some((m) =>
        (m.internalDate ?? 0) > sinceMs && !m.labelIds.includes('SENT') && parseSingleMailbox(m.from) !== mailboxEmail)
    },
    async send(token, x) {
      let raw: string
      try {
        raw = base64Url(buildMimeMessage({
          from: x.from, to: x.to, subject: x.subject, text: x.text, messageId: x.messageId,
          inReplyTo: x.inReplyTo, references: x.references, date: new Date(),
          // Oslovení (P7): hlavičky odhlášení jedním kliknutím (RFC 2369 / RFC 8058).
          extraHeaders: { 'X-Cockpit-Outbox': String(x.outboxId), ...(x.headers ?? {}) },
        }))
      } catch {
        // Zprávu nejde sestavit: prokazatelně neodešla.
        return { kind: 'rejected', reason: 'invalid_message' }
      }
      const r = await sendGmailMessage(token, { raw, threadId: x.threadId }, fetchImpl)
      return r.kind === 'accepted' ? r : { kind: r.kind, reason: r.reason }
    },
    async findSent(token, rfc) {
      const r = await findGmailMessageByRfcId(token, rfc, fetchImpl)
      return r.ok ? r : { ok: false }
    },
  }
}

// --- Spuštění --------------------------------------------------------------------

export type OutboxLiveResult =
  | ({ status: 'ran' } & OutboxRunStats)
  | { status: 'not_configured' }
  | { status: 'waiting_for_migration' }

export async function runAgentOutboxLive(opts: { budgetMs?: number; env?: Record<string, string | undefined> } = {}): Promise<OutboxLiveResult> {
  const env = opts.env ?? process.env
  const now = new Date()
  const config = outboxRunConfig(env, now)
  if (!config) return { status: 'not_configured' }
  const admin = createAuditedAdminClient({ actor: { type: 'system', id: AGENT_OUTBOX_ACTOR } })
  try {
    const stats = await runAgentOutbox({
      store: createOutboxStore(admin, config.wonPhases),
      mail: createGmailOutboxMail(admin, env),
      config,
      now: () => new Date(),
      budgetMs: opts.budgetMs,
      // Jen id, druh a kód — nikdy text ani adresy.
      log: (event, ctx) => logWarn('agentOutbox', event, ctx),
    })
    return { status: 'ran', ...stats }
  } catch (e) {
    if (e instanceof OutboxSchemaMissingError) return { status: 'waiting_for_migration' }
    throw e
  }
}
