// GDPR „právo na výmaz" — I/O vrstva nad čistými funkcemi z domain/crm/gdprErasure.ts.
//
// Záměrně BEZ 'use server': dřív to byl export ze souboru se Server Akcemi,
// takže ho mohl kterýkoli přihlášený člen týmu zavolat jako endpoint
// s libovolným `actor` (audit se zapisuje service-role klientem) a přepsat
// subject/body aktivit klienta podle libovolných jmen. Teď je to obyčejná
// serverová funkce, kterou volají jen akce v domain/crm/actions/contacts.ts
// s actorem odvozeným z auth.getUser().
//
// Proč vlastní soubor, ne přímo v domain/crm/actions/contacts.ts: smazání kontaktu
// je operace nad tabulkou `contact`, ale zametení osobních údajů po
// smazaném kontaktu je operace nad `sales_activity`, která na kontakt
// nemá spolehlivou vazbu — `contact_id` je nepovinný cizí klíč (viz migrace
// 0020) a řada řádků ho vůbec nevyplňuje, i když se jméno/e-mail dané osoby
// objevuje přímo v textu poznámky (volný text z hovorů, shrnutí schůzek).
// Škálovat redakci přes `contact_id` by tedy minulo většinu výskytů — proto
// se prohledává celý `sales_activity` daného účtu/partnera podle obsahu
// `subject`/`body`, ne podle cizího klíče.
//
// Sales_activity patří buď klientovi (`account_id`), nebo partnerovi
// (`partner_id`) — nikdy oběma (CHECK constraint z migrace 0021) — proto
// `ErasureScope` kopíruje stejné rozlišení jako `deleteContact` /
// `deletePartnerContact` v domain/crm/actions/contacts.ts.

import { createClient } from '@/lib/supabase/server'
import { recordAudit, type AuditActor } from '@/core/audit'
import { redactPersonalData, redactionSummary, type PersonalIdentifiers } from '@/domain/crm/gdprErasure'
import { salesActivityRedactedAudit } from '@/domain/crm/auditPayload'
import { logError } from '@/lib/log'

export type ErasureScope = { accountId: number } | { partnerId: number }

// Stejný důvod jako v domain/crm/actions/gdprExport.ts: PostgREST bez
// `.range()` ořízne odpověď na 1000 řádků, takže velký klient/partner by
// tiše přeskočil starší sales_activity řádky při redakci. Stránkujeme po
// SWEEP_PAGE_SIZE, dokud stránka nepřijde kratší; SWEEP_ROW_CAP je pojistka
// proti neomezenému růstu (best-effort úklid, viz komentář funkce níž).
const SWEEP_PAGE_SIZE = 1000
const SWEEP_ROW_CAP = 50_000

type SweepRow = { id: number; subject: string | null; body: string | null }
type RangeQuery = { range: (from: number, to: number) => PromiseLike<{ data: SweepRow[] | null; error: { message: string } | null }> }

async function loadAllSweepRows(makeQuery: () => RangeQuery): Promise<{ rows: SweepRow[]; truncated: boolean }> {
  const rows: SweepRow[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await makeQuery().range(offset, offset + SWEEP_PAGE_SIZE - 1)
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < SWEEP_PAGE_SIZE) return { rows, truncated: false }
    if (rows.length >= SWEEP_ROW_CAP) return { rows, truncated: true }
    offset += SWEEP_PAGE_SIZE
  }
}

/**
 * Projde `sales_activity` daného klienta/partnera a v `subject`/`body`
 * nahradí výskyty e-mailu a/nebo jména smazané osoby placeholderem.
 * Best-effort úklid: řádek, který se nezmění, se ani nezapisuje, ani
 * neauditje — jen se přeskočí.
 *
 * Volá se AŽ PO potvrzeném smazání kontaktu (viz deleteContact /
 * deletePartnerContact), nikdy před ním ani paralelně — kdyby smazání
 * kontaktu selhalo napůl, nemá smysl mazat stopy po osobě, jejíž záznam
 * v `contact` třeba vůbec nezmizel. Volající navíc tuhle funkci obaluje
 * do try/catch: selhání redakce nemá strhnout už dokončené smazání
 * kontaktu (to je časově kritické právo na výmaz primárního záznamu),
 * jen se zaloguje jako varování — úklid `sales_activity` je sekundární
 * a dá se dohnat i dodatečně, kdežto zpětně "nesmazat" kontakt kvůli
 * vedlejší chybě by nedávalo smysl.
 *
 * Audit neukládá text: `recordAudit` dostává jen neosobní kostru (příznaky
 * had_subject/had_body a délky původního i zredigovaného textu, viz
 * domain/crm/auditPayload.ts, stejný tvar jako migrace 0037). Původní text by
 * se jinak přesunul z `sales_activity` do `audit_event`, který nemá retenci
 * ani výmaz, a redakce by ztratila smysl. Cena: z auditu nejde rekonstruovat,
 * co přesně bylo přepsáno, jen že a kde k tomu došlo.
 */
export async function redactContactFromSalesActivity(
  scope: ErasureScope,
  identifiers: PersonalIdentifiers,
  actor: AuditActor,
): Promise<{ redactedCount: number }> {
  const email = identifiers.email?.trim() || undefined
  const name = identifiers.name?.trim() || undefined
  if (!email && !name) return { redactedCount: 0 }

  const s = await createClient()
  const makeQuery = () => {
    const q = s.from('sales_activity').select('id, subject, body').order('id')
    return 'accountId' in scope ? q.eq('account_id', scope.accountId) : q.eq('partner_id', scope.partnerId)
  }

  let rows: SweepRow[]
  let truncated: boolean
  try {
    ({ rows, truncated } = await loadAllSweepRows(makeQuery))
  } catch (error) {
    logError('gdpr', error, { scope })
    return { redactedCount: 0 }
  }
  if (truncated) {
    // Best-effort úklid (viz komentář funkce výš): oříznutí se jen zaloguje,
    // volající (deleteContact/deletePartnerContact) na tom nesmí ztroskotat.
    logError('gdpr', new Error('sales_activity redakce dosáhla limitu řádků, část záznamů zůstala neredigovaná'), { scope })
  }

  let redactedCount = 0
  for (const row of rows) {
    const originalSubject = row.subject ?? ''
    const originalBody = row.body ?? ''
    const redactedSubject = redactPersonalData(originalSubject, { email, name })
    const redactedBody = row.body ? redactPersonalData(row.body, { email, name }) : row.body

    const subjectChanged = redactionSummary(originalSubject, redactedSubject).changed
    const bodyChanged = row.body ? redactionSummary(originalBody, redactedBody ?? '').changed : false
    if (!subjectChanged && !bodyChanged) continue

    const { error: updateError } = await s.from('sales_activity')
      .update({ subject: redactedSubject, body: redactedBody })
      .eq('id', row.id)
    if (updateError) {
      logError('gdpr', updateError, { activityId: row.id })
      continue
    }
    redactedCount++
    try {
      await recordAudit(
        'sales_activity',
        row.id,
        'sales_activity.redacted',
        salesActivityRedactedAudit({ subject: row.subject, body: row.body }),
        salesActivityRedactedAudit({ subject: redactedSubject, body: redactedBody ?? null }),
        actor,
      )
    } catch {
      // úmyslně tiché — recordAudit už zalogoval, tady se jen jistíme
    }
  }

  return { redactedCount }
}
