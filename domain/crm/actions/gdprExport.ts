'use server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { recordAudit } from '@/core/audit'
import { logError } from '@/lib/log'
import { buildContactExport, contactExportFilename, type ContactExport, type Row } from '@/domain/crm/gdprExport'
import { readActiveMember } from '@/lib/auth/activeMember'

// Stejná brána jako v lib/actions/team.ts: AAL2 + is_admin čtený z DB řádku
// (nikdy z JWT/user_metadata). Export sahá přes service role na všechna data.
async function requireAdmin() {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false as const, status: 401 as const, error: AUTH_ERROR_MESSAGE }
  const supabase = await createClient()
  const { row: data } = await readActiveMember<{ is_admin?: boolean | null }>(supabase, user.id, 'is_admin')
  if (!data?.is_admin) return { ok: false as const, status: 403 as const, error: 'Nemáš oprávnění.' }
  return { ok: true as const, userId: user.id }
}

export type ContactExportResult =
  | { ok: true; filename: string; document: ContactExport }
  | { ok: false; status: 400 | 401 | 403 | 404 | 500; error: string }

// PostgREST PGRST205 / Postgres 42P01 = tabulka neexistuje.
function isMissingRelation(err: { code?: string } | null): boolean {
  return err?.code === '42P01' || err?.code === 'PGRST205'
}

// PostgREST vrací max 1000 řádků na dotaz (server-side cap), i bez `.limit()`
// — bez stránkování by export u klienta s > 1000 aktivitami/úkoly starší
// řádky potichu vynechal. Stránkuje po PAGE_SIZE, dokud stránka nepřijde
// kratší (= konec dat); TOTAL_CAP je pojistka proti neomezenému růstu (běžný
// kontakt má řádově desítky až stovky záznamů, ne desetitisíce) — při jejím
// dosažení export pokračuje s tím, co má, a zavolající to nahlásí v poznámce.
const EXPORT_PAGE_SIZE = 1000
const EXPORT_ROW_CAP = 50_000

type RangeQuery = { range: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }> }

async function loadAllRows(makeQuery: () => RangeQuery): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await makeQuery().range(offset, offset + EXPORT_PAGE_SIZE - 1)
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < EXPORT_PAGE_SIZE) return { rows, truncated: false }
    if (rows.length >= EXPORT_ROW_CAP) return { rows, truncated: true }
    offset += EXPORT_PAGE_SIZE
  }
}

export async function exportContactData(contactId: number): Promise<ContactExportResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { ok: false, status: gate.status, error: gate.error }
  if (!Number.isSafeInteger(contactId) || contactId <= 0) {
    return { ok: false, status: 400, error: 'Neplatný kontakt.' }
  }

  const admin = createAdminClient()
  const { data: contact, error: cErr } = await admin.from('contact').select('*').eq('id', contactId).maybeSingle()
  if (cErr) { logError('gdpr.export', cErr, { contactId }); return { ok: false, status: 500, error: 'Export se nepodařil.' } }
  if (!contact) return { ok: false, status: 404, error: 'Kontakt neexistuje.' }
  const c = contact as ContactExport['kontakt']

  try {
    let organizationName: string | null = null
    if (c.account_id) {
      const { data } = await admin.from('account').select('name').eq('id', c.account_id as number).maybeSingle()
      organizationName = (data as { name?: string } | null)?.name ?? null
    } else if (c.partner_id) {
      const { data } = await admin.from('partner').select('name').eq('id', c.partner_id as number).maybeSingle()
      organizationName = (data as { name?: string } | null)?.name ?? null
    }

    // Textová shoda se vyhodnocuje v JS (stejná logika jako výmaz), proto se
    // načtou všechny aktivity a úkoly; objem dat Cockpitu je typicky malý,
    // ale sales_activity/task se stránkují (viz loadAllRows výš), protože
    // PostgREST bez toho ořízne cokoli nad 1000 řádků bez varování.
    const [actsPaged, tasksPaged, audit, mail] = await Promise.all([
      loadAllRows(() => admin.from('sales_activity').select('*').order('occurred_at', { ascending: false }).order('id')),
      loadAllRows(() => admin.from('task').select('*').order('id')),
      admin.from('audit_event').select('*').eq('entity_table', 'contact').eq('entity_id', contactId).order('occurred_at'),
      admin.from('mail_event').select('*').eq('contact_id', contactId),
    ])
    if (audit.error) throw audit.error
    if (mail.error && !isMissingRelation(mail.error)) throw mail.error

    const now = new Date()
    let document = buildContactExport({
      contact: c,
      organizationName,
      salesActivities: actsPaged.rows,
      tasks: tasksPaged.rows,
      mailEvents: mail.error ? null : ((mail.data ?? []) as Row[]),
      auditEvents: (audit.data ?? []) as Row[],
      generatedAt: now,
    })
    if (actsPaged.truncated || tasksPaged.truncated) {
      // buildContactExport žije v domain/crm/gdprExport.ts (čistá funkce, mimo
      // rozsah tohoto zásahu) — poznámku o oříznutí proto doplňujeme až tady.
      document = {
        ...document,
        poznamka:
          `${document.poznamka} POZOR: počet aktivit nebo úkolů dosáhl limitu exportu ` +
          `(${EXPORT_ROW_CAP.toLocaleString('cs-CZ')} řádků na tabulku), export je proto neúplný.`,
      }
    }

    // Audit bez osobních údajů: jen počty záznamů.
    await recordAudit('contact', contactId, 'contact.exported', null, { counts: document.souhrn }, { type: 'user', id: gate.userId })
    return { ok: true, filename: contactExportFilename(contactId, now), document }
  } catch (e) {
    logError('gdpr.export', e, { contactId })
    return { ok: false, status: 500, error: 'Export se nepodařil.' }
  }
}
