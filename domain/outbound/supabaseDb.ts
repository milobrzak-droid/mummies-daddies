// Supabase adaptér outbound agenta (P7) pro úlohu /api/cron/outbound-agent.
// Volá se SERVISNÍM klientem (RLS obchází, zápisy jen přes RPC z 0107 nebo
// přímé zápisy do tabulek 0107). Chyby se hlásí jen kódem — nikdy s daty.
import type { SupabaseClient } from '@supabase/supabase-js'
import { contactOptOut, noteSaysDoNotContact } from '@/domain/crm/outreachContacts'
import type { CrmAccountSnapshot } from '@/core/outbound/crmSignals'
import { OUTBOX_ENQUEUE_RPC, isMissingOutboxRpc } from '@/core/outbound/outbox'
import { factsFromRow, signalUpsertPayload } from '@/core/outbound/signal'
import { emailHash } from '@/core/outbound/unsubscribe'
import type { ApprovedOutreach, OutboundDb, OutreachTarget, StoredSignal } from './run'

type Client = Pick<SupabaseClient, 'from' | 'rpc'>

class OutboundDbError extends Error {
  constructor(what: string, code: string | null | undefined) {
    super(`${what}: ${code ?? 'error'}`)
    this.name = 'OutboundDbError'
  }
}

function check<T>(what: string, r: { data: T; error: { code?: string | null } | null }): T {
  if (r.error) throw new OutboundDbError(what, r.error.code)
  return r.data
}

const CLOSED_STAGES = ['vyhráno', 'prohráno', 'odloženo']

export function supabaseOutboundDb(client: Client, opts: { today: string; now: Date; pillar: string }): OutboundDb {
  const sinceIso = (days: number) => new Date(opts.now.getTime() - days * 86_400_000).toISOString()

  async function accountDeals(accountId: number) {
    return check('deal', await client.from('deal').select('id, stage').eq('account_id', accountId)) as { id: number; stage: string }[]
  }

  return {
    async upsertSignal(c) {
      const data = check('outbound_signal_upsert', await client.rpc('outbound_signal_upsert', { p: signalUpsertPayload(c) })) as { signal_id: number; duplicate: boolean }
      return { signalId: data.signal_id, duplicate: data.duplicate }
    },

    async pendingSignals(limit) {
      const rows = check('outbound_signal', await client.from('outbound_signal')
        .select('id, source, kind, external_ref, title, url, ico, company_name, facts, account_id, attempts')
        .eq('status', 'new').lt('attempts', 3).order('detected_at', { ascending: true }).limit(limit)) as Record<string, unknown>[]
      return rows.map((r): StoredSignal => ({
        id: r.id as number,
        source: r.source as StoredSignal['source'],
        kind: r.kind as StoredSignal['kind'],
        externalRef: r.external_ref as string,
        title: r.title as string,
        url: (r.url as string | null) ?? null,
        ico: (r.ico as string | null) ?? null,
        companyName: (r.company_name as string | null) ?? null,
        facts: factsFromRow(r.facts),
        accountId: (r.account_id as number | null) ?? null,
        attempts: (r.attempts as number) ?? 0,
      }))
    },

    async crmContext(s, cooldownDays) {
      let accountId = s.accountId
      if (!accountId && s.ico) {
        const rows = check('account', await client.from('account').select('id').eq('ico', s.ico).order('id').limit(1)) as { id: number }[]
        accountId = rows[0]?.id ?? null
      }
      if (!accountId) return { accountId: null, relationship: null, optedOut: false, recentlyContacted: false }
      const [acc] = check('account', await client.from('account')
        .select('id, client_since, is_reference, notes, snooze_until, last_outbound_at').eq('id', accountId).limit(1)) as Record<string, unknown>[]
      const deals = await accountDeals(accountId)
      const contacts = check('contact', await client.from('contact').select('do_not_contact, notes').eq('account_id', accountId)) as { do_not_contact: boolean | null; notes: string | null }[]
      const recent = check('outbound_outreach', await client.from('outbound_outreach').select('id')
        .eq('account_id', accountId).in('status', ['queued', 'sent', 'done']).gte('created_at', sinceIso(cooldownDays)).limit(1)) as unknown[]
      const relationship = deals.some((d) => !CLOSED_STAGES.includes(d.stage)) ? 'aktivni_obchod' as const
        : (deals.some((d) => d.stage === 'vyhráno') || acc?.client_since || acc?.is_reference) ? 'klient' as const
          : 'prospekt' as const
      const optedOut = noteSaysDoNotContact((acc?.notes as string | null) ?? null, 'account')
        || (contacts.length > 0 && contacts.every((c) => contactOptOut(c) !== null))
        || (typeof acc?.snooze_until === 'string' && acc.snooze_until > opts.today)
      const lastOut = acc?.last_outbound_at as string | null | undefined
      return {
        accountId,
        relationship,
        optedOut,
        recentlyContacted: recent.length > 0 || (!!lastOut && lastOut > sinceIso(Math.min(cooldownDays, 30))),
      }
    },

    async saveQualification(id, x) {
      const { data } = await client.from('outbound_signal').select('attempts').eq('id', id).limit(1)
      const attempts = ((data as { attempts: number }[] | null)?.[0]?.attempts ?? 0) + (x.status === 'failed' ? 1 : 0)
      check('outbound_signal.update', await client.from('outbound_signal').update({
        // Po třetím selhání zůstane 'failed'; jinak se zkusí znovu v dalším běhu.
        status: x.status === 'failed' && attempts < 3 ? 'new' : x.status,
        score: x.score, reason_codes: x.reasons, segment: x.segment, attempts,
        error_code: x.errorCode ?? null, qualified_at: opts.now.toISOString(),
        ...(x.ico ? { ico: x.ico } : {}),
      }).eq('id', id))
    },

    async createLead(signalId, x) {
      check('outbound_signal.update', await client.from('outbound_signal').update({
        score: x.score, reason_codes: x.reasons, segment: x.segment, qualified_at: opts.now.toISOString(), ...(x.ico ? { ico: x.ico } : {}),
      }).eq('id', signalId))
      const r = await client.rpc('outbound_lead_create', { p: { signal_id: signalId } })
      if (r.error) {
        if (/OS422/.test(r.error.message ?? '')) return null
        throw new OutboundDbError('outbound_lead_create', r.error.code)
      }
      const d = r.data as { account_id: number; deal_id: number }
      return { accountId: d.account_id, dealId: d.deal_id }
    },

    async outreachTarget(accountId): Promise<OutreachTarget | null> {
      const [acc] = check('account', await client.from('account').select('id, name, client_since, is_reference').eq('id', accountId).limit(1)) as Record<string, unknown>[]
      if (!acc) return null
      const deals = await accountDeals(accountId)
      const contacts = check('contact', await client.from('contact')
        .select('id, email, do_not_contact, notes, is_champion').eq('account_id', accountId).order('id')) as Record<string, unknown>[]
      const usable = contacts
        .filter((c) => typeof c.email === 'string' && (c.email as string).includes('@'))
        .sort((a, b) => Number(!!b.is_champion) - Number(!!a.is_champion))
      const c = usable.find((x) => contactOptOut({ do_not_contact: x.do_not_contact as boolean | null, notes: x.notes as string | null }) === null) ?? usable[0] ?? null
      const isExistingCustomer = deals.some((d) => d.stage === 'vyhráno') || !!acc.client_since
      if (!c) return { contactId: null, email: null, optedOut: false, consent: null, isExistingCustomer, accountName: acc.name as string }
      const email = c.email as string
      const hash = emailHash(email)
      const suppressed = check('outreach_suppression', await client.from('outreach_suppression').select('id').eq('email_hash', hash).limit(1)) as unknown[]
      const consents = check('outreach_consent', await client.from('outreach_consent')
        .select('wording, wording_version, granted_at, source, withdrawn_at').eq('email_hash', hash).order('granted_at', { ascending: false }).limit(1)) as Record<string, string | null>[]
      const consent = consents[0]
        ? { wording: consents[0].wording, wordingVersion: consents[0].wording_version, grantedAt: consents[0].granted_at, source: consents[0].source, withdrawnAt: consents[0].withdrawn_at }
        : null
      return {
        contactId: c.id as number,
        email,
        optedOut: suppressed.length > 0 || contactOptOut({ do_not_contact: c.do_not_contact as boolean | null, notes: c.notes as string | null }) !== null,
        consent,
        isExistingCustomer,
        accountName: acc.name as string,
      }
    },

    async insertOutreach(x) {
      const rows = check('outbound_outreach.insert', await client.from('outbound_outreach').insert({
        signal_id: x.signalId, account_id: x.accountId, contact_id: x.contactId, deal_id: x.dealId, channel: x.channel,
        status: x.status, basis: x.basis, reason_codes: x.reasonCodes, template_key: x.templateKey, subject: x.subject,
        body: x.body, email_hash: x.emailHash,
      }).select('id')) as { id: number }[]
      return rows[0].id
    },

    async setOutreachText(id, x) {
      check('outbound_outreach.update', await client.from('outbound_outreach').update({ subject: x.subject, body: x.body }).eq('id', id))
    },

    async countSentToday(pragueDay) {
      const r = await client.from('outbound_outreach').select('id', { count: 'exact', head: true })
        .eq('prague_day', pragueDay).in('status', ['queued', 'sent'])
      if (r.error) throw new OutboundDbError('outbound_outreach.count', r.error.code)
      return r.count ?? 0
    },

    async approvedOutreach(limit): Promise<ApprovedOutreach[]> {
      const rows = check('outbound_outreach', await client.from('outbound_outreach')
        .select('id, channel, decided_by, deal_id, subject, body, email_hash, contact_id')
        .eq('status', 'approved').in('channel', ['auto_email', 'review_email']).order('created_at').limit(limit)) as Record<string, unknown>[]
      const out: ApprovedOutreach[] = []
      for (const r of rows) {
        let email: string | null = null
        if (r.contact_id) {
          const c = check('contact', await client.from('contact').select('email, do_not_contact').eq('id', r.contact_id as number).limit(1)) as { email: string | null; do_not_contact: boolean | null }[]
          email = c[0]?.do_not_contact ? null : c[0]?.email ?? null
        }
        const hash = r.email_hash as string | null
        const sup = hash ? check('outreach_suppression', await client.from('outreach_suppression').select('id').eq('email_hash', hash).limit(1)) as unknown[] : []
        out.push({
          id: r.id as number,
          channel: r.channel as ApprovedOutreach['channel'],
          humanApproved: r.channel === 'review_email' && !!r.decided_by,
          dealId: (r.deal_id as number | null) ?? null,
          subject: (r.subject as string | null) ?? '',
          body: (r.body as string | null) ?? '',
          emailHash: hash,
          email,
          suppressed: sup.length > 0,
        })
      }
      return out
    },

    async markQueued(id, x) {
      check('outbound_outreach.update', await client.from('outbound_outreach').update({
        status: 'queued', outbox_source_ref: x.sourceRef, outbox_id: x.outboxId, prague_day: x.pragueDay,
      }).eq('id', id))
    },

    async markSkipped(id, reason) {
      check('outbound_outreach.update', await client.from('outbound_outreach').update({ status: 'skipped', reason_codes: [reason] }).eq('id', id))
    },

    async enqueue(payload) {
      const r = await client.rpc(OUTBOX_ENQUEUE_RPC, { p: payload })
      if (r.error) {
        if (isMissingOutboxRpc(r.error)) return { ok: false, missingRpc: true }
        return { ok: false, missingRpc: false, code: (r.error.code ?? 'error').slice(0, 64) }
      }
      const d = (r.data ?? {}) as { outbox_id?: number; duplicate?: boolean }
      return { ok: true, outboxId: d.outbox_id ?? null, duplicate: !!d.duplicate }
    },

    async memberIdByEmail(email) {
      const rows = check('team_member', await client.from('team_member').select('id').ilike('email', email).is('deactivated_at', null).limit(1)) as { id: string }[]
      return rows[0]?.id ?? null
    },

    async crmAccounts(): Promise<CrmAccountSnapshot[]> {
      const deals = check('deal', await client.from('deal').select('account_id, title, stage, won_at').eq('pillar', opts.pillar).limit(5000)) as
        { account_id: number; title: string; stage: string; won_at: string | null }[]
      const by = new Map<number, { last: string | null; title: string | null; open: boolean }>()
      for (const d of deals) {
        const e = by.get(d.account_id) ?? { last: null, title: null, open: false }
        if (!CLOSED_STAGES.includes(d.stage)) e.open = true
        if (d.stage === 'vyhráno' && d.won_at && (!e.last || d.won_at > e.last)) { e.last = d.won_at; e.title = d.title }
        by.set(d.account_id, e)
      }
      const ids = [...by.entries()].filter(([, e]) => e.last && !e.open).map(([id]) => id)
      if (!ids.length) return []
      const accounts = check('account', await client.from('account').select('id, name, ico').in('id', ids)) as { id: number; name: string; ico: string | null }[]
      return accounts.map((a) => {
        const e = by.get(a.id)!
        return { accountId: a.id, name: a.name, ico: a.ico, lastEventDate: e.last, lastEventTitle: e.title, hasOpenDeal: e.open }
      })
    },
  }
}
