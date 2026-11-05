// Zápis schůzky doplní už naplánovanou schůzku (místo druhého řádku).
//
// PROČ: schůzka naplánovaná z Cockpitu je řádek sales_activity s outcome
// 'planned' (domain/crm/actions/planMeeting.ts). Když k ní přijde zápis —
// z Wispr Flow (POST /api/ingest/meeting-notes, domain/crm/meetingIntakeService.ts)
// nebo přes skill (MCP create_activity / REST /api/v1/activities,
// domain/crm/apiWrite.ts) — a založí se jako nová aktivita, leží schůzka na
// timeline klienta dvakrát a „naplánováno" visí dál. Tady se zápis spáruje
// s naplánovanou schůzkou TÉHOŽ klienta ve STEJNÝ pražský den a nejvýš
// PLANNED_MATCH_MAX_DIFF_HOURS hodin od sebe (pravidlo matchPlannedMeeting
// v domain/crm/meetingMatch.ts; dvě stejně blízké = nespárovat nic) a doplní ji:
//   outcome 'completed', text zápisu (plánová poznámka zůstane pod ním),
//   zdroj zápisu (source 'wispr_flow' / 'api'), kdy zápis přišel
//   (note_received_at, 0085), u Wispr Flow klíč idempotence
//   external_id 'intake:<id>', ze skillu případně kontakt, obchod a termín
//   dalšího kontaktu. Předmět a začátek zůstávají z plánu (Outlook je
//   pravda o termínu, kontrola kalendáře ho drží aktuální).
//
// IDEMPOTENCE: zápis je podmíněný na outcome 'planned' — dva souběžné zápisy
// ke stejné schůzce ji nedoplní dvakrát (druhý dostane „nespárováno" a založí
// vlastní řádek). U příjmu z Wispr Flow nese doplněný řádek external_id
// 'intake:<id>': opakovaný pokus o tentýž zápis ho najde (meetingIntakeService)
// a nic nezdvojí.
//
// Selhání párování zápis nikdy neztratí: chyba = „nespárováno" a volající
// založí nový řádek jako dřív.
import type { SupabaseClient } from '@supabase/supabase-js'
import { logError } from '@/lib/log'
import { matchPlannedMeeting, PLANNED_MATCH_MAX_DIFF_HOURS, type MatchTarget } from '@/domain/crm/meetingMatch'

type Db = Pick<SupabaseClient, 'from'>
type PgError = { code?: string | null } | null | undefined

/** Oddělovač poznámky z plánu (agenda, odkaz na Teams) pod textem zápisu. */
export const PLANNED_NOTE_SEPARATOR = '— Z plánu schůzky —'

const WINDOW_MS = PLANNED_MATCH_MAX_DIFF_HOURS * 3_600_000
/** Rezerva na hodiny odesílatele: schůzka smí začít nejvýš tolik po přijetí zápisu. */
const NOT_STARTED_TOLERANCE_MS = 15 * 60_000

export type NoteForPairing = {
  /** Název zápisu (Wispr Flow title / předmět ze skillu); uloží se jen když se liší od plánu. */
  title: string | null
  /** Text zápisu. */
  text: string | null
  /** Zdroj zápisu: 'wispr_flow' nebo 'api'. */
  source: string
  /** Klíč idempotence (příjem z Wispr Flow: 'intake:<id>'). */
  externalId?: string | null
  contactId?: number | null
  dealId?: number | null
  followUpOn?: string | null
}

export type PairResult =
  | { paired: true; activityId: number; plannedAt: string }
  | { paired: false }

type PlannedRow = {
  id: number
  account_id: number | null
  partner_id: number | null
  occurred_at: string
  outcome: string | null
  subject: string | null
  body: string | null
}

/** Text doplněné schůzky: (název zápisu), zápis, pod ním poznámka z plánu. */
export function mergeNoteWithPlan(planned: { subject: string | null; body: string | null }, note: Pick<NoteForPairing, 'title' | 'text'>): string {
  const title = note.title?.trim() || null
  const parts = [
    title && title !== planned.subject?.trim() ? title : null,
    note.text?.trim() || null,
    planned.body?.trim() ? `${PLANNED_NOTE_SEPARATOR}\n${planned.body.trim()}` : null,
  ].filter((p): p is string => !!p)
  return parts.join('\n\n')
}

const isMissingColumn = (e: PgError) => !!e && (e.code === '42703' || e.code === 'PGRST204')

/**
 * Najde naplánovanou schůzku, kterou má zápis doplnit, a doplní ji.
 * `read` čte (servisní klient), `write` zapisuje (servisní klient s aktérem
 * pro audit). Nikdy nevyhazuje; když jistou shodu nemá nebo zápis selže,
 * vrací { paired: false } a volající založí nový řádek.
 */
export async function pairNoteWithPlannedMeeting(
  read: Db,
  write: Db,
  args: { target: MatchTarget; occurredAt: string; note: NoteForPairing; now: Date },
): Promise<PairResult> {
  const { target, note } = args
  if (target.account_id == null && target.partner_id == null) return { paired: false }
  const at = Date.parse(args.occurredAt)
  if (Number.isNaN(at)) return { paired: false }

  try {
    let q = read.from('sales_activity')
      .select('id, account_id, partner_id, occurred_at, outcome, subject, body')
      .eq('kind', 'meeting')
      .eq('outcome', 'planned')
      .gte('occurred_at', new Date(at - WINDOW_MS).toISOString())
    q = target.account_id != null ? q.eq('account_id', target.account_id) : q.eq('partner_id', target.partner_id as number)
    const { data, error } = await q.order('occurred_at', { ascending: true }).limit(20)
    if (error) {
      logError('meetingPairing.load', 'chyba databáze', { code: error.code ?? 'unknown' })
      return { paired: false }
    }
    // Zápis vzniká až po schůzce: schůzka, která ještě nezačala (vůči času
    // přijetí zápisu), se nedoplní — jinak by zápis o dopoledním hovoru
    // „odbavil" odpolední schůzku a kontrola kalendáře by ji přestala hlídat.
    const latestStart = Math.min(at + WINDOW_MS, args.now.getTime() + NOT_STARTED_TOLERANCE_MS)
    const candidates = (Array.isArray(data) ? (data as PlannedRow[]) : []).filter((r) => Date.parse(r.occurred_at) <= latestStart)
    const match = matchPlannedMeeting(args.occurredAt, target, candidates)
    if (!match) return { paired: false }
    const planned = candidates.find((r) => r.id === match.id)!

    const patch: Record<string, unknown> = {
      outcome: 'completed',
      body: mergeNoteWithPlan(planned, note),
      source: note.source,
      note_received_at: args.now.toISOString(),
      ...(note.externalId ? { external_id: note.externalId } : {}),
      ...(note.contactId != null ? { contact_id: note.contactId } : {}),
      ...(note.dealId != null ? { deal_id: note.dealId } : {}),
      ...(note.followUpOn != null ? { follow_up_on: note.followUpOn } : {}),
    }
    const update = (p: Record<string, unknown>) => {
      let u = write.from('sales_activity').update(p).eq('id', planned.id).eq('outcome', 'planned')
      // Klíč idempotence smí dostat jen řádek, který žádný nemá.
      if (note.externalId) u = u.is('external_id', null)
      return u.select('id')
    }
    let res = await update(patch)
    // Bez migrace 0085 (note_received_at) se schůzka doplní i tak.
    if (res.error && isMissingColumn(res.error)) {
      const rest = { ...patch }
      delete rest.note_received_at
      res = await update(rest)
    }
    if (res.error) {
      // Jen kód — Postgres v detailu cituje řádek, tedy i text zápisu.
      logError('meetingPairing.update', 'chyba databáze', { code: res.error.code ?? 'unknown', activity: planned.id })
      return { paired: false }
    }
    if (!Array.isArray(res.data) || res.data.length === 0) return { paired: false }
    return { paired: true, activityId: planned.id, plannedAt: planned.occurred_at }
  } catch (e) {
    logError('meetingPairing', e instanceof Error ? e.name : 'chyba')
    return { paired: false }
  }
}
