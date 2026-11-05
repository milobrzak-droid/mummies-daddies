// Čtení pro stránku agenta (P5) pod session přihlášeného (RLS can_see_sales).
// Tabulky inquiry_agent_run (P2) a agent_outbox (P3) vznikají v jiných
// balících: dokud chybí (42P01 / PGRST205), vrací se prázdný výsledek a
// stránka řekne „agent není zapnutý". Ostatní chyby se zalogují (bez dat)
// a přehled je přizná v `unavailable`.
//
// Vybírají se jen sloupce bez textu zpráv a bez kontaktních údajů.
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import { pragueLocalToUtc, addDaysToPragueDay } from '@/lib/pragueDate'
import {
  ATTENTION_STATUSES, agentActivityRows, attentionRows, computeAgentKpi, outboxQueueOverview, periodFor,
  type AgentActivityRow, type AgentOutboxListRow, type AgentOutboxQueue, type AgentAttentionRow, type AgentDealRow, type AgentInquiryRow, type AgentKpi,
  type AgentMailEventRow, type AgentOutboxRow, type AgentPeriod, type PeriodDays,
} from '@/domain/crm/agentKpi'
import { OPEN_SHOP_STATUSES, buildShopOrderOverview, type ShopOrderOverview, type ShopOrderOverviewRow } from '@/domain/crm/shopOrderOverview'

type Db = Awaited<ReturnType<typeof createClient>>
type DbError = { code?: string | null; message?: string | null } | null

/** Výsledek jednoho zdroje: řádky, nebo chybějící tabulka / jiná chyba. */
export type Sourced<T> = { rows: T[]; missing: boolean; failed: boolean }

const RUN_COLS = 'id, received_at, status, decision_kind, reason_codes, segment, deal_id, account_id, quote_total, decided_at'
const WEB_COLS = 'id, received_at, status, decision_kind, reason_codes, segment, deal_id, account_id, quote_total, decided_at'
const OUTBOX_COLS = 'id, kind, source_ref, deal_id, status, stop_reason, sent_at, prague_day'
const OUTBOX_LIST_COLS = `${OUTBOX_COLS}, created_at`
/** Kolik posledních zpráv fronty ukázat v přehledu. */
export const OUTBOX_RECENT_LIMIT = 30
const DEAL_COLS = 'id, account_id, pillar, phase, stage, created_at, closed_at, won_at, lost_reason'
const MAIL_COLS = 'account_id, direction, occurred_at'
const SHOP_COLS = 'id, received_at, status, fulfilment_date, fulfilment, items, total_czk'

/** Strop řádků na zdroj — stránka je přehled, ne export. */
export const ROW_LIMIT = 2000

async function read<T>(scope: string, q: PromiseLike<{ data: unknown; error: DbError }>): Promise<Sourced<T>> {
  try {
    const { data, error } = await q
    if (error) {
      if (isMissingRelation(error)) return { rows: [], missing: true, failed: false }
      logError(`agentKpi.${scope}`, new Error(error.code ?? 'db_error'))
      return { rows: [], missing: false, failed: true }
    }
    return { rows: (data ?? []) as T[], missing: false, failed: false }
  } catch (e) {
    logError(`agentKpi.${scope}`, e)
    return { rows: [], missing: false, failed: true }
  }
}

export type AgentOverview = {
  period: AgentPeriod
  /** Ani inquiry_agent_run, ani agent_outbox zatím neexistuje. */
  agentMissing: boolean
  /** Zdroje, které se nepodařilo načíst (česky, do poznámky na stránce). */
  unavailable: string[]
  kpi: AgentKpi
  activity: AgentActivityRow[]
  attention: AgentAttentionRow[]
  /** null = modul objednávek vypnutý nebo tabulka shop_order chybí. */
  shop: ShopOrderOverview | null
  /** Přehled odchozí fronty (P3); null = tabulka agent_outbox chybí. */
  outboxQueue?: AgentOutboxQueue | null
}

export type AgentOverviewContext = {
  today: string
  days: PeriodDays
  db?: Db
  /** Načíst i objednávky cheesecaků (modul shopOrders). */
  withShop?: boolean
  /**
   * Volající ověřil, že přihlášený vidí obchod (canSeeSales). Jen pak se čtou
   * metadata odchozích e-mailů z mail_event — tu od 0069 čte jen service role
   * (stejně jako loadEmails v queries/changes.ts), pod session by čtení vždy
   * selhalo. Bere se jen firma, směr a čas, nikdy adresa ani obsah.
   */
  canSeeSales?: boolean
}

export async function loadAgentOverview(ctx: AgentOverviewContext): Promise<AgentOverview> {
  const s = ctx.db ?? await createClient()
  // Testy podstrčí jednoho klienta pro všechno; jinak mail_event přes service role.
  const mailDb = ctx.db ?? (ctx.canSeeSales ? createAdminClient() : null)
  const period = periodFor(ctx.today, ctx.days)
  const fromIso = pragueLocalToUtc(`${period.from}T00:00`).toISOString()
  const toIso = pragueLocalToUtc(`${addDaysToPragueDay(period.to, 1)}T00:00`).toISOString()

  const [runs, web, outbox, attentionQ, deals, mail, shopReceived, shopUpcoming, outboxRecent, outboxOpen] = await Promise.all([
    read<Omit<AgentInquiryRow, 'source'>>('runs', s.from('inquiry_agent_run').select(RUN_COLS)
      .gte('received_at', fromIso).lt('received_at', toIso).order('received_at', { ascending: false }).limit(ROW_LIMIT)),
    read<Omit<AgentInquiryRow, 'source'>>('web', s.from('web_inquiry').select(WEB_COLS)
      .gte('received_at', fromIso).lt('received_at', toIso).order('received_at', { ascending: false }).limit(ROW_LIMIT)),
    read<AgentOutboxRow>('outbox', s.from('agent_outbox').select(OUTBOX_COLS)
      .gte('prague_day', period.from).lte('prague_day', period.to).order('id', { ascending: false }).limit(ROW_LIMIT)),
    // Fronta k řešení bez ohledu na období: co visí, visí i z minulého měsíce.
    read<AgentOutboxRow>('attention', s.from('agent_outbox').select(OUTBOX_COLS)
      .in('status', [...ATTENTION_STATUSES]).order('id', { ascending: true }).limit(100)),
    // Obchody založené NEBO uzavřené v období (trychtýř a výhry/prohry).
    read<AgentDealRow>('deals', s.from('deal').select(DEAL_COLS)
      .or(`created_at.gte.${fromIso},closed_at.gte.${period.from}`).limit(ROW_LIMIT)),
    mailDb
      ? read<AgentMailEventRow>('mail', mailDb.from('mail_event').select(MAIL_COLS)
          .eq('direction', 'outbound').gte('occurred_at', fromIso).not('account_id', 'is', null).limit(ROW_LIMIT * 2))
      : Promise.resolve<Sourced<AgentMailEventRow>>({ rows: [], missing: false, failed: false }),
    ctx.withShop
      ? read<ShopOrderOverviewRow>('shop', s.from('shop_order').select(SHOP_COLS)
          .gte('received_at', fromIso).lt('received_at', toIso).order('received_at', { ascending: false }).limit(ROW_LIMIT))
      : Promise.resolve(null),
    ctx.withShop
      ? read<ShopOrderOverviewRow>('shopUpcoming', s.from('shop_order').select(SHOP_COLS)
          .in('status', [...OPEN_SHOP_STATUSES]).gte('fulfilment_date', ctx.today).order('fulfilment_date', { ascending: true }).limit(50))
      : Promise.resolve(null),
    // Přehled fronty: posledních N zpráv a počty neukončených stavů (bez ohledu na období).
    read<AgentOutboxListRow>('outboxRecent', s.from('agent_outbox').select(OUTBOX_LIST_COLS).order('id', { ascending: false }).limit(OUTBOX_RECENT_LIMIT)),
    read<{ status: string }>('outboxOpen', s.from('agent_outbox').select('status')
      .in('status', ['queued', 'claimed', 'blocked', 'failed', 'needs_attention']).limit(ROW_LIMIT)),
  ])

  const inquiries: AgentInquiryRow[] = [
    ...runs.rows.map((r) => ({ ...r, source: 'email' as const })),
    ...web.rows.map((r) => ({ ...r, source: 'web' as const })),
  ]
  // Zprávy k řešení jsou ve výpočtu i v tabulce jednou (dotazy se překrývají).
  const outboxRows = [...new Map([...outbox.rows, ...attentionQ.rows].map((o) => [o.id, o])).values()]

  const kpi = computeAgentKpi({ period, inquiries, outbox: outboxRows, deals: deals.rows, mailEvents: mail.rows })

  // Jména firem jen pro řádky tabulky (id → název z CRM).
  const accountIds = [...new Set([
    ...inquiries.map((r) => r.account_id),
  ].filter((id): id is number => id != null))].slice(0, 500)
  const accounts = accountIds.length > 0
    ? await read<{ id: number; name: string }>('accounts', s.from('account').select('id, name').in('id', accountIds))
    : { rows: [], missing: false, failed: false }
  const accountNames = new Map(accounts.rows.map((a) => [a.id, a.name]))

  // Firma obchodu pro odkaz ze zprávy ve frontě (bez další tabulky, jen deal).
  const dealAccounts = new Map<number, number | null>(deals.rows.map((d) => [d.id, d.account_id]))
  const missingDealIds = [...new Set([...attentionQ.rows, ...outboxRecent.rows].map((o) => o.deal_id).filter((id): id is number => id != null && !dealAccounts.has(id)))]
  if (missingDealIds.length > 0) {
    const extra = await read<{ id: number; account_id: number | null }>('attentionDeals', s.from('deal').select('id, account_id').in('id', missingDealIds))
    for (const d of extra.rows) dealAccounts.set(d.id, d.account_id)
  }

  const unavailable = [
    runs.failed && 'poptávky z e-mailu',
    web.failed && 'poptávky z webu',
    (outbox.failed || attentionQ.failed || outboxRecent.failed || outboxOpen.failed) && 'odchozí fronta',
    deals.failed && 'obchody',
    mail.failed && 'odeslané e-maily',
    accounts.failed && 'názvy firem',
    (shopReceived?.failed || shopUpcoming?.failed) && 'objednávky',
  ].filter((x): x is string => typeof x === 'string')

  const shop = shopReceived && shopUpcoming && !shopReceived.missing && !shopUpcoming.missing
    ? buildShopOrderOverview({ from: period.from, to: period.to, today: ctx.today, received: shopReceived.rows, upcoming: shopUpcoming.rows })
    : null

  return {
    period,
    agentMissing: runs.missing && outbox.missing,
    unavailable,
    kpi,
    activity: agentActivityRows(inquiries, outboxRows, accountNames),
    attention: attentionRows(attentionQ.rows, dealAccounts),
    shop,
    outboxQueue: outboxRecent.missing ? null : outboxQueueOverview(outboxOpen.rows, outboxRecent.rows, dealAccounts),
  }
}

// --- Krátký souhrn pro provozní přehled (domain/crm/opsReport.ts) ---------

export type AgentOpsSummary = {
  inquiries: number
  escalations: number
  sent: number
  needsAttention: number
  blocked: number
}

/** Souhrn agenta za okno přehledu; null = tabulky agenta zatím nejsou. */
export async function loadAgentOpsSummary(args: { db: Db; from: string; to: string }): Promise<AgentOpsSummary | null> {
  const { db: s } = args
  const fromIso = pragueLocalToUtc(`${args.from}T00:00`).toISOString()
  const toIso = pragueLocalToUtc(`${addDaysToPragueDay(args.to, 1)}T00:00`).toISOString()
  const [runs, web, outbox, attentionQ] = await Promise.all([
    read<{ decision_kind: string | null }>('ops.runs', s.from('inquiry_agent_run').select('id, decision_kind, status')
      .gte('received_at', fromIso).lt('received_at', toIso).limit(ROW_LIMIT)),
    read<{ decision_kind: string | null }>('ops.web', s.from('web_inquiry').select('id, decision_kind, status')
      .gte('received_at', fromIso).lt('received_at', toIso).limit(ROW_LIMIT)),
    read<{ status: string }>('ops.outbox', s.from('agent_outbox').select('id, status')
      .eq('status', 'sent').gte('prague_day', args.from).lte('prague_day', args.to).limit(ROW_LIMIT)),
    read<{ status: string }>('ops.attention', s.from('agent_outbox').select('id, status')
      .in('status', [...ATTENTION_STATUSES]).limit(500)),
  ])
  if (runs.missing && outbox.missing) return null
  if (runs.failed || web.failed || outbox.failed || attentionQ.failed) throw new Error('agent_summary_unavailable')
  const all = [...runs.rows, ...web.rows] as { decision_kind: string | null; status?: string }[]
  return {
    inquiries: all.filter((r) => r.decision_kind !== 'not_inquiry' && r.status !== 'spam' && r.status !== 'skipped').length,
    escalations: all.filter((r) => r.decision_kind === 'escalate').length,
    sent: outbox.rows.length,
    needsAttention: attentionQ.rows.filter((r) => r.status === 'needs_attention').length,
    blocked: attentionQ.rows.filter((r) => r.status === 'blocked').length,
  }
}
