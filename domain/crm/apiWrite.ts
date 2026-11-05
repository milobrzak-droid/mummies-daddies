import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { dbErrorMessage } from '@/lib/actionResult'
import { recordAudit, type AuditActor } from '@/core/audit'
import { createAuditedAdminClient, dbAuditActive } from '@/core/auditDb'
import { recordEvidence } from '@/core/evidence'
import { EVIDENCE_SOURCE_ID_MAX, EVIDENCE_WEB_LINK_MAX } from '@/core/informationState'
import { detectInjectionMarkers, injectionAuditMeta, type InjectionFlag } from '@/core/untrusted'
import { logWarn } from '@/lib/log'
import { pairNoteWithPlannedMeeting, type PairResult } from '@/domain/crm/plannedMeetingPairing'

// Zápisové operace dostupné externím nástrojům (skill v Coworku, MCP).
// Sdílené jádro pro REST i MCP, aby obě cesty měly stejná pravidla.
//
// Rozsah tohoto souboru je schválně úzký: zapsat, co vzešlo z jednání.
// Založení a úprava obchodu (i částky a fáze, jen vyjmenovaná pole a se
// stejnými pravidly přechodu fází jako UI) je zvlášť v domain/crm/apiDeals.ts,
// kontakty v apiContacts.ts a stav úkolu v apiTasks.ts. Mazat přes API nejde nic.
//
// Audit (kapitola 3, migrace 0064): zápisy jdou přes servisní klíč, takže
// DB trigger by bez nápovědy znal jen 'db-trigger:service_role'. Admin
// klient proto nese hlavičku s aktérem — API klíč jeho vlastníka
// (createdBy), stejný aktér, jakého appka psala do auditu dosud.

const optText = z.string().trim().min(1).nullish().transform((v) => v ?? null)
// Texty zapisované přes API/MCP (často z externích nástrojů a přepisů) mají strop
// délky: bez něj by jediné volání uložilo megabajty do sales_activity/task/deal.
export const API_TEXT_LIMITS = { subject: 300, body: 20_000, nextStep: 300, title: 300, description: 5_000, id: 100 } as const
const optTextMax = (max: number, what: string) =>
  z.string().trim().min(1).max(max, `${what} je delší než ${max} znaků`).nullish().transform((v) => v ?? null)
const optInt = z.number().int().nullish().transform((v) => v ?? null)

// Odkud smí přijít odkaz na zdroj schůzky. Evidence je sdílený ukazatel
// (první zápis vyhrává, viz core/evidence.ts), takže web_link od volajícího
// bereme jen z allow-listu — jinak by šel podstrčit libovolný odkaz.
export const MEETING_SOURCE_HOSTS = ['notes.wisprflow.ai'] as const

export const SOURCE_URL_ERROR =
  'source_url musí být https odkaz na notes.wisprflow.ai (jiné zdroje nejsou povolené).'

/**
 * Id zdroje evidence pro zápis přes API má jmenný prostor přidělený serverem
 * (`api:<vlastník klíče>:<id od volajícího>`). Evidence je sdílený ukazatel
 * (UNIQUE druh + id, první zápis vyhrává), takže volné `source_id` by šlo
 * zvolit tak, aby kolidovalo s interním prefixem (`cockpit-intake:<n>`) nebo s id
 * cizího klíče, a „otrávit" doklad dřív, než ho zapíše skutečný zdroj. Dlouhé id
 * se nahradí otiskem, ať se s prefixem vejde do EVIDENCE_SOURCE_ID_MAX.
 */
export function apiEvidenceSourceId(createdBy: string | null, id: string): string {
  const prefix = `api:${createdBy ?? 'anon'}:`
  return prefix.length + id.length <= EVIDENCE_SOURCE_ID_MAX
    ? `${prefix}${id}`
    : `${prefix}sha256:${createHash('sha256').update(id).digest('hex')}`
}

/** Je `raw` https URL na povoleném hostu (bez přihlašovacích údajů a portu)? */
export function isAllowedMeetingSourceUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    (MEETING_SOURCE_HOSTS as readonly string[]).includes(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    raw.length <= EVIDENCE_WEB_LINK_MAX
  )
}

export const activityInput = z.object({
  account_id: optInt,
  partner_id: optInt,
  deal_id: optInt,
  contact_id: optInt,
  kind: z.enum(['call', 'email', 'meeting', 'note', 'other']).default('note'),
  outcome: z.enum(['completed', 'no_answer', 'follow_up', 'cancelled']).default('completed'),
  subject: z.string().trim().min(1, 'subject je povinný').max(API_TEXT_LIMITS.subject, `subject je delší než ${API_TEXT_LIMITS.subject} znaků`),
  body: optTextMax(API_TEXT_LIMITS.body, 'body'),
  occurred_at: optTextMax(API_TEXT_LIMITS.id, 'occurred_at'),
  follow_up_on: optTextMax(API_TEXT_LIMITS.id, 'follow_up_on'),
  // Původ zápisu (kapitola 3): odkaz na poznámky ze schůzky a id schůzky
  // ve zdrojovém systému. Do sales_activity se neukládají — jdou do evidence.
  source_url: optText.refine((v) => v == null || isAllowedMeetingSourceUrl(v), { message: SOURCE_URL_ERROR }),
  source_id: z.string().trim().min(1).max(EVIDENCE_SOURCE_ID_MAX, `source_id je delší než ${EVIDENCE_SOURCE_ID_MAX} znaků`)
    .nullish().transform((v) => v ?? null),
}).refine(
  (v) => (v.account_id == null) !== (v.partner_id == null),
  { message: 'Vyplň právě jedno z account_id / partner_id.' },
)

export const nextStepInput = z.object({
  deal_id: z.number().int(),
  next_step: optTextMax(API_TEXT_LIMITS.nextStep, 'next_step'),
  next_step_due: optTextMax(API_TEXT_LIMITS.id, 'next_step_due'),
})

export const taskInput = z.object({
  title: z.string().trim().min(1, 'title je povinný').max(API_TEXT_LIMITS.title, `title je delší než ${API_TEXT_LIMITS.title} znaků`),
  description: optTextMax(API_TEXT_LIMITS.description, 'description'),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  due_on: optTextMax(API_TEXT_LIMITS.id, 'due_on'),
  account_id: optInt,
  deal_id: optInt,
  assignee_id: optTextMax(API_TEXT_LIMITS.id, 'assignee_id'),
})

export type WriteResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

function failed(error: string, status = 400): WriteResult<never> {
  return { ok: false, status, error }
}

export const SALES_ONLY_ERROR = 'sales_role_required'
// Jedna hláška pro neexistující obchod i obchod jiné firmy — odpověď nesmí
// prozradit, která ID obchodů existují.
export const DEAL_MISMATCH_ERROR = 'Obchod nenalezen u vybraného klienta.'
export const CONTACT_MISMATCH_ERROR = 'Kontakt nepatří vybrané firmě.'
export const FUTURE_OCCURRED_AT_ERROR = 'occurred_at nesmí být v budoucnosti.'
// Tolerance na posun hodin a časová pásma.
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000

type Admin = ReturnType<typeof createAdminClient>

// Stejná kontrola jako UI (createSalesActivity/createTask): obchod musí
// existovat a patřit klientovi account_id.
async function dealBelongsTo(admin: Admin, dealId: number, accountId: number | null): Promise<boolean> {
  if (accountId == null) return false
  const { data, error } = await admin.from('deal').select('account_id').eq('id', dealId).maybeSingle()
  if (error || !data) return false
  return (data as { account_id: number | null }).account_id === accountId
}

async function contactBelongsTo(
  admin: Admin,
  contactId: number,
  accountId: number | null,
  partnerId: number | null,
): Promise<boolean> {
  const { data, error } = await admin.from('contact').select('account_id, partner_id').eq('id', contactId).maybeSingle()
  if (error || !data) return false
  const c = data as { account_id: number | null; partner_id: number | null }
  return accountId != null ? c.account_id === accountId : c.partner_id === partnerId
}

// Když přijde schůzka s odkazem na zdroj (Wispr Flow přes Cowork skill),
// zapíše se k ní evidence a audit s původem human_confirmed — zápis v skillu
// potvrdil člověk. Evidence je pozorovací vrstva: její selhání (třeba když
// migrace 0038 ještě neběžela) aktivitu nestrhne, jen vrátí evidence_id null.
//
// Pořadí: evidence se zapisuje PŘED aktivitou, aby ji DB trigger (0064)
// mohl připsat k sales_activity.created přes hlavičku. Když insert aktivity
// selže, zůstane řádek evidence bez auditu — je to jen ukazatel na zdroj
// (UNIQUE, další pokus ho znovu použije), nic se tím neztratí.
//
// sales_activity je v DB jen pro obchodní role (0020, can_see_sales()) —
// zápis přes service role proto vyžaduje canSeeSales vlastníka klíče.
//
// Text zápisu (subject/body) je nedůvěryhodný — vzniká z přepisu schůzky,
// kde mohl mluvit kdokoli. Tady ho nic nevykonává (žádný model), jen se
// uloží a zobrazí jako text. Heuristika core/untrusted.ts ale označí známky
// pokynů pro AI: příznaky jdou do audit_event.after (jen jejich názvy, nikdy
// text), do logu a do odpovědi volajícímu. Neblokují.
export async function createActivity(
  raw: unknown,
  createdBy: string | null,
  canSeeSales: boolean,
): Promise<WriteResult<{
  id: number
  evidence_id: number | null
  injection_flags?: InjectionFlag[]
  /** Zápis doplnil naplánovanou schůzku (id je její); planned_at = její začátek. */
  paired_planned?: true
  planned_at?: string
}>> {
  if (!canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  const parsed = activityInput.safeParse(raw)
  if (!parsed.success) return failed(parsed.error.issues[0]?.message ?? 'Neplatný vstup.')

  const { source_url, source_id, ...fields } = parsed.data
  if (fields.occurred_at != null) {
    const t = Date.parse(fields.occurred_at)
    if (Number.isNaN(t)) return failed('occurred_at není platné datum.')
    if (t > Date.now() + FUTURE_TOLERANCE_MS) return failed(FUTURE_OCCURRED_AT_ERROR)
  }
  const occurredAt = fields.occurred_at ?? new Date().toISOString()
  const actor: AuditActor = { type: 'api_key', id: createdBy }
  const withEvidence = source_url != null && fields.kind === 'meeting'
  const flags = detectInjectionMarkers(`${fields.subject}\n${fields.body ?? ''}`)

  const checkAdmin = createAdminClient()
  if (fields.deal_id != null && !(await dealBelongsTo(checkAdmin, fields.deal_id, fields.account_id))) {
    return failed(DEAL_MISMATCH_ERROR, 404)
  }
  if (fields.contact_id != null
    && !(await contactBelongsTo(checkAdmin, fields.contact_id, fields.account_id, fields.partner_id))) {
    return failed(CONTACT_MISMATCH_ERROR)
  }

  let evidenceId: number | null = null
  if (withEvidence) {
    try {
      const evidence = await recordEvidence(
        checkAdmin,
        { kind: 'meeting', sourceId: apiEvidenceSourceId(createdBy, source_id ?? source_url), webLink: source_url },
        createdBy ? `api_key:${createdBy}` : 'api_key',
      )
      evidenceId = evidence.ok ? evidence.id : null
    } catch {
      // recordEvidence nevyhazuje; pojistka, aby aktivita nikdy nespadla.
      evidenceId = null
    }
  }

  const admin = createAuditedAdminClient({
    actor,
    evidenceId,
    infoState: withEvidence ? 'human_confirmed' : null,
  })

  // Zápis proběhlé schůzky ke klientovi (partnerovi), který má ten den
  // naplánovanou schůzku z Cockpitu, ji doplní (outcome completed) místo
  // druhého řádku — domain/crm/plannedMeetingPairing.ts.
  let pairing: PairResult = { paired: false }
  if (fields.kind === 'meeting' && fields.outcome === 'completed') {
    pairing = await pairNoteWithPlannedMeeting(checkAdmin, admin, {
      target: { account_id: fields.account_id, partner_id: fields.partner_id, contact_id: fields.contact_id },
      occurredAt,
      note: {
        title: fields.subject,
        text: fields.body,
        source: 'api',
        contactId: fields.contact_id,
        dealId: fields.deal_id,
        followUpOn: fields.follow_up_on,
      },
      now: new Date(),
    })
  }

  let data: { id: number }
  if (pairing.paired) {
    data = { id: pairing.activityId }
  } else {
    const inserted = await admin
      .from('sales_activity')
      .insert({
        ...fields,
        occurred_at: occurredAt,
        source: 'api',
        created_by: createdBy,
      })
      .select('id')
      .single()
    if (inserted.error) return failed(dbErrorMessage('apiWrite.createActivity', inserted.error), 500)
    data = inserted.data as { id: number }
  }

  // Do aplikace 0064 zapisuje schůzku se zdrojem appka sama (dřív jediný
  // audit téhle cesty); po ní ji zapíše trigger jako sales_activity.created
  // se stejnou evidencí — nikdy obojí.
  if (withEvidence && !(await dbAuditActive())) {
    await recordAudit(
      'sales_activity',
      data.id,
      'activity.created',
      null,
      // Jen NEOSOBNÍ metadata — audit_event.after je jsonb blob, který
      // GDPR redakce (domain/crm/gdprSweep.ts) nezná a nikdy nepřepíše
      // (ta redaguje jen sales_activity.subject/body). Text zápisu
      // (subject) proto sem nepatří vůbec, ani jako kopie — jen má-li
      // jaký a jak dlouhý (has_subject/subject_length), a odkaz na
      // zdroj zůstává v evidence (source_id/source_url výše), ne tady.
      {
        kind: fields.kind,
        occurred_at: occurredAt,
        account_id: fields.account_id,
        partner_id: fields.partner_id,
        has_subject: fields.subject.length > 0,
        subject_length: fields.subject.length,
        source: 'api',
        ...injectionAuditMeta(flags),
      },
      actor,
      { evidenceId, infoState: 'human_confirmed' },
    )
  } else if (flags.length > 0 && !(await dbAuditActive())) {
    // Bez zdroje se audit jinak nepíše; příznaky ale mají zůstat dohledatelné.
    await recordAudit(
      'sales_activity',
      data.id,
      'activity.untrusted_markers',
      null,
      { kind: fields.kind, source: 'api', ...injectionAuditMeta(flags) },
      actor,
    )
  }
  if (flags.length > 0) {
    logWarn('api.activity', 'text zápisu nese příznaky možných pokynů pro AI', { flags, activity: data.id })
  }
  return {
    ok: true,
    data: {
      id: data.id,
      evidence_id: evidenceId,
      ...(flags.length > 0 ? { injection_flags: flags } : {}),
      ...(pairing.paired ? { paired_planned: true as const, planned_at: pairing.plannedAt } : {}),
    },
  }
}

// Rychlá změna obchodu: co je další krok a do kdy. Ostatní pole (částky,
// fáze, …) mění updateDealForApi v domain/crm/apiDeals.ts.
// Audit: DB trigger 0064 zapíše deal.updated (next_step jen názvem — je to
// volný text — next_step_due i s hodnotou) s aktérem API klíče.
export async function setNextStep(
  raw: unknown,
  createdBy: string | null,
): Promise<WriteResult<{ id: number }>> {
  const parsed = nextStepInput.safeParse(raw)
  if (!parsed.success) return failed(parsed.error.issues[0]?.message ?? 'Neplatný vstup.')

  const admin = createAuditedAdminClient({ actor: { type: 'api_key', id: createdBy } })
  const { data, error } = await admin
    .from('deal')
    .update({ next_step: parsed.data.next_step, next_step_due: parsed.data.next_step_due })
    .eq('id', parsed.data.deal_id)
    .select('id')
    .maybeSingle()
  if (error) return failed(dbErrorMessage('apiWrite.setNextStep', error), 500)
  if (!data) return failed('Obchod nenalezen.', 404)
  return { ok: true, data: { id: data.id } }
}

// Úkol s deal_id smí založit jen obchodní role a obchod musí patřit
// klientovi account_id (stejně jako v UI).
export async function createTask(
  raw: unknown,
  createdBy: string | null,
  canSeeSales: boolean,
): Promise<WriteResult<{ id: number }>> {
  const parsed = taskInput.safeParse(raw)
  if (!parsed.success) return failed(parsed.error.issues[0]?.message ?? 'Neplatný vstup.')

  const checkAdmin = createAdminClient()
  if (parsed.data.deal_id != null) {
    if (!canSeeSales) return failed(SALES_ONLY_ERROR, 403)
    if (!(await dealBelongsTo(checkAdmin, parsed.data.deal_id, parsed.data.account_id))) {
      return failed(DEAL_MISMATCH_ERROR, 404)
    }
  }
  // Audit: DB trigger 0064 zapíše task.created s aktérem API klíče.
  const admin = createAuditedAdminClient({ actor: { type: 'api_key', id: createdBy } })
  const { data, error } = await admin
    .from('task')
    .insert({ ...parsed.data, status: 'todo', created_by: createdBy })
    .select('id')
    .single()
  if (error) return failed(dbErrorMessage('apiWrite.createTask', error), 500)
  return { ok: true, data: { id: data.id } }
}
