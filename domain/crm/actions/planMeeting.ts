'use server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { createAuditedAdminClient } from '@/core/auditDb'
import { graphTokenForCurrentUser } from '@/connectors/graph'
import { createMeetingEvent } from '@/connectors/graph'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { aresSearchByName, pickAresMatch } from '@/connectors/ares'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import { followUpStepText } from '@/domain/crm/meetingCalendar'
import { addDaysToPragueDay, pragueDayOf, pragueLocalString, pragueLocalToUtc } from '@/lib/pragueDate'
import { COMPANY } from '@/config'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { logError } from '@/lib/log'
import { escapeLikePattern, sameAccountName } from '@/domain/crm/offerProposal'
import { parseEmails } from '@/domain/crm/meetingAttendees'

// Naplánování schůzky z Cockpitu.
//
// Smysl: schůzka je začátek řídicí smyčky. Vznikne událost v Outlooku
// s Teams odkazem (zápis z ní přijde z Wispr Flow přes skill), v Cockpitu
// zůstane záznam a rovnou se nastaví, do kdy musí přijít další kontakt.
// Když klient ještě neexistuje, založí se — právě proto, aby nikdo
// neřešil schůzku „mimo systém" jen kvůli tomu, že klient v CRM chybí.
//
// Outlook je pak pravda o termínu: posun nebo zrušení tam Cockpit sám
// promítne (domain/crm/meetingCalendarSync.ts) — do schůzky, do dalšího
// kroku obchodu nastaveného tady (followUpStepText) a do milníku dodávky.
//
// MILNÍK (volitelně, jen u existujícího klienta, migrace 0085): schůzka se
// k němu přiváže (sales_activity.milestone_id). Když milník termín nemá
// (nebo ho měl převzatý ze schůzky, která už naplánovaná není), dostane den
// schůzky a označí se jako převzatý (engagement_milestone.due_from_activity_id)
// — takový termín se se schůzkou posouvá. Termín, který zadal člověk, se
// nemění nikdy; při posunu schůzky dostane vlastník milníku úkol ke kontrole.

const TZ = COMPANY.timeZone

// Prázdná volba „bez milníku" dorazí jako "" — to je „nic", ne id 0.
const optionalId = z.preprocess(
  (v) => (v === '' || v == null ? null : v),
  z.coerce.number().int().positive().nullable(),
)

const schema = z.object({
  account_id: z.coerce.number().int().nullish(),
  new_account_name: z.string().trim().min(1).max(200, 'Název klienta je moc dlouhý.').nullish(),
  title: z.string().trim().min(1, 'Název schůzky je povinný.').max(200, 'Název schůzky je moc dlouhý.'),
  start: z.string().trim().min(1, 'Termín je povinný.'),
  duration_min: z.coerce.number().int().min(15).max(480).default(60),
  attendees: z.string().trim().max(2_000, 'Seznam účastníků je moc dlouhý.').nullish(),
  follow_up_days: z.coerce.number().int().min(1).max(180).default(10),
  note: z.string().trim().max(4_000, 'Poznámka je moc dlouhá.').nullish(),
  milestone_id: optionalId.optional(),
})

export type PlanMilestoneOutcome = {
  title: string
  /** true = milník dostal termín podle schůzky a bude se s ní posouvat. */
  dueFromMeeting: boolean
  dueOn: string | null
}

export type PlanResult =
  | {
    ok: true; accountId: number; activityId: number; joinUrl: string | null; createdAccount: boolean
    milestone?: PlanMilestoneOutcome
  }
  | { ok: false; error: string }

// ('use server' soubor smí exportovat jen async funkce — hlášky zůstávají uvnitř.)
const MILESTONE_MIGRATION_PENDING =
  'Vazbu schůzky na milník půjde uložit po migraci 0085. Naplánuj schůzku zatím bez milníku.'
const MILESTONE_NOT_FOUND = 'Vybraný milník u tohoto klienta není. Obnov stránku a vyber znovu.'
const MILESTONE_CLOSED = 'Vybraný milník je už přijatý nebo uzavřený — vyber jiný, nebo schůzku naplánuj bez milníku.'
const FINAL_MILESTONE_STATUSES = new Set(['prijato', 'uzavreno'])

type MilestoneRow = {
  id: number
  title: string
  status: string
  due_on: string | null
  due_from_activity_id: number | null
  engagement_id: number
}

type Admin = ReturnType<typeof createAuditedAdminClient>

/**
 * Milník ke schůzce: musí existovat, patřit dodávce tohoto klienta a nebýt
 * uzavřený. `deriveDue` = termín se má vzít ze schůzky (milník termín nemá,
 * nebo ho měl ze schůzky, která už naplánovaná není).
 */
async function loadMilestoneForMeeting(
  admin: Admin,
  milestoneId: number,
  accountId: number,
): Promise<{ ok: true; row: MilestoneRow; deriveDue: boolean } | { ok: false; error: string }> {
  const { data, error } = await admin.from('engagement_milestone')
    .select('id, title, status, due_on, due_from_activity_id, engagement_id')
    .eq('id', milestoneId)
    .maybeSingle()
  if (error) {
    const code = String((error as { code?: unknown }).code ?? '')
    if (code === '42703' || code === 'PGRST204' || code === '42P01' || code === 'PGRST205') {
      return { ok: false, error: MILESTONE_MIGRATION_PENDING }
    }
    logError('action.planMeeting.milestone', error)
    return { ok: false, error: 'Milník se nepodařilo načíst.' }
  }
  const row = data as MilestoneRow | null
  if (!row) return { ok: false, error: MILESTONE_NOT_FOUND }
  const { data: eng } = await admin.from('engagement').select('account_id').eq('id', row.engagement_id).maybeSingle()
  if ((eng as { account_id?: number | null } | null)?.account_id !== accountId) return { ok: false, error: MILESTONE_NOT_FOUND }
  if (FINAL_MILESTONE_STATUSES.has(row.status)) return { ok: false, error: MILESTONE_CLOSED }

  let deriveDue = row.due_on == null
  if (!deriveDue && row.due_from_activity_id != null) {
    const { data: prev } = await admin.from('sales_activity').select('outcome').eq('id', row.due_from_activity_id).maybeSingle()
    deriveDue = (prev as { outcome?: string } | null)?.outcome !== 'planned'
  }
  return { ok: true, row, deriveDue }
}

const GENERIC = new Set(['info', 'sales', 'obchod', 'podpora', 'office'])
function nameFromEmail(email: string): string {
  const local = email.split('@')[0]
  if (GENERIC.has(local)) return email
  return local.split(/[._-]+/).filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ')
}

export async function planMeeting(_prev: unknown, formData: FormData): Promise<PlanResult> {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Neplatný vstup.' }
  const f = parsed.data

  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false, error: AUTH_ERROR_MESSAGE }
  // Akce zapisuje sales_activity a deal přes service role (mimo RLS 0058),
  // ID akce je globální — obchodní roli proto kontroluje sama, nejen stránka.
  if (!(await canCurrentUserSeeSales())) return { ok: false, error: 'Nemáš oprávnění.' }

  const token = await graphTokenForCurrentUser()
  if (!token.ok) {
    // Stejné spojení s Microsoftem jako syncMyTasksToOutlook — proto
    // společný `graph_calendar` řádek místo samostatného konektoru jen
    // pro plánování schůzek.
    await recordConnectorError('graph_calendar', token.error)
    return { ok: false, error: token.error }
  }

  // Servisní klient s aktérem: DB audit trigger (0064) připíše založeného
  // klienta, kontakty, aktivitu i další krok obchodu přihlášenému člověku,
  // ne anonymnímu 'db-trigger:service_role'.
  const admin = createAuditedAdminClient({ actor: { type: 'user', id: user.id } })

  // ---- klient: existující, nebo nový
  // Prázdný výběr klienta dorazí jako "" a coerce z něj udělá 0; ber to
  // výslovně jako „žádný klient", ať to nestojí na tom, že 0 je falsy.
  let accountId = f.account_id && f.account_id > 0 ? f.account_id : null
  let createdAccount = false

  // ---- milník (jen existující klient) — ověřit DŘÍV, než vznikne klient
  // nebo událost v Outlooku, ať špatná volba nic nezaloží napůl.
  let milestone: { row: MilestoneRow; deriveDue: boolean } | null = null
  if (f.milestone_id) {
    if (!accountId) return { ok: false, error: 'Milník jde vybrat jen u existujícího klienta.' }
    const loaded = await loadMilestoneForMeeting(admin, f.milestone_id, accountId)
    if (!loaded.ok) return { ok: false, error: loaded.error }
    milestone = { row: loaded.row, deriveDue: loaded.deriveDue }
  }
  if (!accountId) {
    if (!f.new_account_name) return { ok: false, error: 'Vyber klienta nebo zadej název nového.' }
    // Zástupné znaky LIKE se escapují a výsledek se dofiltruje přesnou shodou
    // (PostgREST bere `*` jako `%`, viz escapeLikePattern). Bez toho by název
    // „Spol%" nebo „*a*" přiřadil schůzku cizímu klientovi. Víc přesných shod
    // = nejisté, klient se nezaloží podruhé, ale ani nepřiřadí naslepo.
    const { data: dupes } = await admin.from('account').select('id, name')
      .ilike('name', escapeLikePattern(f.new_account_name)).order('id').limit(20)
    const exact = ((dupes ?? []) as { id: number; name: string }[]).filter((r) => sameAccountName(r.name, f.new_account_name!))
    if (exact.length > 1) {
      return { ok: false, error: 'Klient s tímhle názvem už existuje víckrát. Vyber ho ze seznamu.' }
    }
    if (exact.length === 1) {
      accountId = exact[0].id
    } else {
      // IČO z ARESu jen při jisté shodě — pravidlo je otestované v connectors/ares.
      const candidates = await aresSearchByName(f.new_account_name, 20).catch(() => [])
      const pick = pickAresMatch(f.new_account_name, candidates, candidates.length)
      const { data: created, error } = await admin.from('account').insert({
        name: f.new_account_name,
        ico: pick?.company.ico ?? null,
        region: pick?.company.city ?? null,
        owner_id: user.id,
        notes: 'Založeno při plánování schůzky z Cockpitu.',
      }).select('id').single()
      if (error || !created) {
        if (error) logError('action.planMeeting.account', error)
        return { ok: false, error: 'Klienta se nepodařilo založit.' }
      }
      accountId = created.id
      createdAccount = true
    }
  }

  if (accountId == null) return { ok: false, error: 'Klienta se nepodařilo určit.' }

  // ---- kontakty z e-mailů účastníků (jen ty, které ještě neznáme)
  const emails = parseEmails(f.attendees)
  if (emails.length) {
    const { data: known } = await admin.from('contact').select('email').in('email', emails)
    const have = new Set((known ?? []).map((c) => (c.email ?? '').toLowerCase()))
    const fresh = emails.filter((e) => !have.has(e))
    if (fresh.length) {
      await admin.from('contact').insert(
        fresh.map((e) => ({ full_name: nameFromEmail(e), email: e, account_id: accountId })),
      )
    }
  }

  // ---- událost v Outlooku s Teams odkazem
  // `f.start` je naivní místní čas z <input type="datetime-local">, myšlený
  // jako Europe/Prague — pragueLocalToUtc ho převede na správný UTC okamžik
  // bez ohledu na časové pásmo serveru (viz lib/pragueDate.ts).
  let start: Date
  try {
    start = pragueLocalToUtc(f.start)
  } catch {
    return { ok: false, error: 'Termín se nepodařilo přečíst.' }
  }
  const end = new Date(start.getTime() + f.duration_min * 60_000)

  const event = await createMeetingEvent(token.accessToken, {
    subject: f.title,
    start: { dateTime: pragueLocalString(start), timeZone: TZ },
    end: { dateTime: pragueLocalString(end), timeZone: TZ },
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
    attendees: emails.map((e) => ({ emailAddress: { address: e }, type: 'required' as const })),
    body: f.note ? { contentType: 'text', content: f.note } : undefined,
  })
  if (!event) return { ok: false, error: 'Událost se nepodařilo založit v Outlooku.' }
  // Událost v Outlooku vznikla — spojení funguje, i kdyby zápis do Cockpitu
  // níž ještě selhal (to je problém CRM zápisu, ne konektoru).
  await recordConnectorSuccess('graph_calendar', new Date().toISOString())

  // ---- záznam v Cockpitu + termín dalšího kontaktu
  // follow_up_on / next_step_due jsou DATE: pražský kalendářní den konce
  // schůzky (tak, jak ho vidí Outlook — posíláme ho s timeZone Europe/Prague),
  // posunutý o N kalendářních dnů — ne UTC den instantu + N × 24 h.
  const followUpDay = addDaysToPragueDay(pragueDayOf(end), f.follow_up_days)
  const { data: activity, error: actErr } = await admin.from('sales_activity').insert({
    source: 'cockpit',
    ms_event_id: event.id,
    account_id: accountId,
    kind: 'meeting',
    outcome: 'planned',
    subject: f.title,
    body: [f.note, event.joinUrl ? `Připojení: ${event.joinUrl}` : null].filter(Boolean).join('\n\n') || null,
    occurred_at: start.toISOString(),
    follow_up_on: followUpDay,
    created_by: user.id,
    ...(milestone ? { milestone_id: milestone.row.id } : {}),
  }).select('id').single()
  if (actErr || !activity) {
    if (actErr) logError('action.planMeeting.activity', actErr)
    return { ok: false, error: 'Záznam se nepodařilo uložit.' }
  }

  // ---- milník: termín podle schůzky, jen když ho neurčil člověk
  // Podmíněný zápis: když milník mezitím termín dostal (nebo převzal jinou
  // schůzku), nic se nepřepíše — schůzka k němu jen patří.
  let milestoneOutcome: PlanMilestoneOutcome | undefined
  if (milestone) {
    const { row } = milestone
    milestoneOutcome = { title: row.title, dueFromMeeting: false, dueOn: row.due_on }
    if (milestone.deriveDue) {
      const meetingDay = pragueDayOf(start)
      let q = admin.from('engagement_milestone')
        .update({ due_on: meetingDay, due_from_activity_id: activity.id })
        .eq('id', row.id)
      q = row.due_on == null ? q.is('due_on', null) : q.eq('due_from_activity_id', row.due_from_activity_id as number)
      const { data: updated, error: msErr } = await q.select('id')
      if (msErr) logError('action.planMeeting.milestoneDue', msErr)
      else if (Array.isArray(updated) && updated.length > 0) {
        milestoneOutcome = { title: row.title, dueFromMeeting: true, dueOn: meetingDay }
      }
    }
  }

  // ---- promítnout do otevřeného obchodu, ať to vidí pipeline i hlídač
  // Text kroku je sdílený s kontrolou kalendáře: podle něj (a termínu =
  // follow_up_on schůzky) pozná, že krok je odvozený ze schůzky a smí ho
  // při posunu schůzky posunout.
  const { data: deal } = await admin.from('deal')
    .select('id').eq('account_id', accountId)
    .in('stage', OPEN_DEAL_STAGE_FILTER)
    .order('id').limit(1).maybeSingle()
  if (deal) {
    await admin.from('deal').update({
      next_step: followUpStepText(f.title),
      next_step_due: followUpDay,
      follow_up_nudged_on: null,
      follow_up_escalated_on: null,
    }).eq('id', deal.id)
  }

  revalidatePath('/cockpit/schuzky')
  revalidatePath(`/cockpit/clients/${accountId}`)
  revalidatePath('/cockpit')
  return {
    ok: true, accountId, activityId: activity.id, joinUrl: event.joinUrl, createdAccount,
    ...(milestoneOutcome ? { milestone: milestoneOutcome } : {}),
  }
}
