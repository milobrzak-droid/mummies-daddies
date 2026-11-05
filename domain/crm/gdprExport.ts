// GDPR „právo na přístup" (čl. 15) — čisté sestavení exportu všeho, co
// Cockpit drží o jedné osobě (kontaktu). Beze všeho I/O; data načítá
// domain/crm/actions/gdprExport.ts a sem je jen předá.
//
// Formát dokumentu (klíče česky, verze v `format`):
//   format            'enter-cockpit.gdpr-export/1'
//   vygenerovano      ISO čas vzniku (generated_at)
//   poznamka          vysvětlení zdrojů a jejich omezení
//   kontakt           řádek `contact` celý
//   firma             jen název klienta/partnera, ke kterému kontakt patří
//   aktivity          `sales_activity` (kromě schůzek) — přes contact_id NEBO
//                     výskyt e-mailu/jména v subject/body; `duvod_zahrnuti`
//   schuzky           totéž pro kind='meeting' (zápisy schůzek — dnes
//                     z Wispr Flow přes skill — jsou sales_activity; účastníci
//                     zvlášť uloženi nejsou, vazba je contact_id / text)
//   ukoly             `task`, kde se osoba zmiňuje v title/description
//                     (úkol nemá contact_id, jiná vazba neexistuje)
//   maily             `mail_event` přes contact_id, nebo null + důvod, pokud
//                     tabulka (migrace 0041) neexistuje
//   audit             `audit_event` s entity_table='contact' a tímto id
//   nesouhlas_s_oslovenim
//                     zda osoba nesouhlasí s oslovením: políčko u kontaktu
//                     (contact.do_not_contact, 0087 — od kdy, odkud/proč)
//                     a zda nesouhlas uvádí poznámka u kontaktu (druhá
//                     pojistka, domain/crm/outreachContacts.ts)
//
// Shoda v textu používá stejnou logiku jako výmaz (gdprErasure.ts): e-mail
// jako celý token, jméno jen jako celá fráze o >= 2 tokenech.

import { redactPersonalData, type PersonalIdentifiers } from '@/domain/crm/gdprErasure'
import { COMPANY } from '@/config'
import { noteSaysDoNotContact } from '@/domain/crm/outreachContacts'

export const GDPR_EXPORT_FORMAT = 'enter-cockpit.gdpr-export/1'

export type Row = Record<string, unknown>

export type ContactExportInput = {
  contact: Row & { id: number; full_name?: string | null; email?: string | null }
  organizationName: string | null
  salesActivities: Row[]
  tasks: Row[]
  mailEvents: Row[] | null // null = tabulka mail_event neexistuje
  auditEvents: Row[]
  generatedAt: Date
}

/** True, pokud text obsahuje e-mail nebo (dost specifické) jméno osoby. */
export function mentionsPerson(text: unknown, ids: PersonalIdentifiers): boolean {
  if (typeof text !== 'string' || !text) return false
  return redactPersonalData(text, ids) !== text
}

type Reason = 'contact_id' | 'zminka_v_textu'

function activityReason(row: Row, contactId: number, ids: PersonalIdentifiers): Reason | null {
  if (row.contact_id === contactId) return 'contact_id'
  if (mentionsPerson(row.subject, ids) || mentionsPerson(row.body, ids)) return 'zminka_v_textu'
  return null
}

/**
 * Údaj o nesouhlasu s oslovením. `policko_v_evidenci: false` = databáze
 * políčko ještě nemá (migrace 0087 nenasazena) — rozhoduje jen poznámka.
 */
export function optOutExport(contact: Row) {
  const hasColumn = Object.prototype.hasOwnProperty.call(contact, 'do_not_contact')
  const flag = contact.do_not_contact === true
  const note = noteSaysDoNotContact(typeof contact.notes === 'string' ? contact.notes : null)
  return {
    nesouhlasi: flag || note,
    policko_v_evidenci: hasColumn,
    policko: flag,
    od: flag ? (contact.do_not_contact_at as string | null | undefined) ?? null : null,
    odkud_proc: flag ? (contact.do_not_contact_reason as string | null | undefined) ?? null : null,
    poznamka_uvadi_nesouhlas: note,
  }
}

export function buildContactExport(input: ContactExportInput) {
  const { contact } = input
  const ids: PersonalIdentifiers = { email: contact.email ?? null, name: contact.full_name ?? null }

  const aktivity: Row[] = []
  const schuzky: Row[] = []
  const seen = new Set<unknown>()
  for (const row of input.salesActivities) {
    if (seen.has(row.id)) continue
    const reason = activityReason(row, contact.id, ids)
    if (!reason) continue
    seen.add(row.id)
    const out = { ...row, duvod_zahrnuti: reason }
    ;(row.kind === 'meeting' ? schuzky : aktivity).push(out)
  }

  const ukoly = input.tasks
    .filter((t) => mentionsPerson(t.title, ids) || mentionsPerson(t.description, ids))
    .map((t): Row => ({ ...t, duvod_zahrnuti: 'zminka_v_textu' satisfies Reason }))

  const audit = input.auditEvents.filter((a) => a.entity_table === 'contact' && a.entity_id === contact.id)
  const optOut = optOutExport(contact)

  return {
    format: GDPR_EXPORT_FORMAT,
    vygenerovano: input.generatedAt.toISOString(),
    poznamka:
      `Export osobních údajů podle čl. 15 GDPR ze systému ${COMPANY.productName}. ` +
      'Zdroje: tabulka contact (záznam osoby); account/partner (jen název organizace); ' +
      'sales_activity (vazba contact_id nebo výskyt e-mailu či celého jména v předmětu/textu; ' +
      'schůzky jsou záznamy druhu meeting); task (výskyt e-mailu či jména v názvu/popisu); ' +
      'mail_event (vazba contact_id, pokud tabulka existuje); audit_event (historie změn kontaktu). ' +
      'nesouhlas_s_oslovenim: políčko „Nesouhlasí s oslovením" u kontaktu (od kdy, odkud/proč) a zda nesouhlas uvádí poznámka. ' +
      'Jméno se hledá jen jako celá fráze o alespoň dvou slovech, e-mail jako celá adresa.',
    kontakt: contact,
    firma: input.organizationName === null ? null : { nazev: input.organizationName },
    aktivity,
    schuzky,
    ukoly,
    maily: input.mailEvents === null
      ? { dostupne: false, duvod: 'Tabulka mail_event v databázi neexistuje (migrace 0041 nenasazena).', zaznamy: [] }
      : { dostupne: true, zaznamy: input.mailEvents },
    audit,
    nesouhlas_s_oslovenim: optOut,
    souhrn: {
      aktivity: aktivity.length,
      schuzky: schuzky.length,
      ukoly: ukoly.length,
      maily: input.mailEvents?.length ?? 0,
      audit: audit.length,
      nesouhlasi_s_oslovenim: optOut.nesouhlasi,
    },
  }
}

export type ContactExport = ReturnType<typeof buildContactExport>

/** Název souboru bez osobních údajů — jen id kontaktu a datum. */
export function contactExportFilename(contactId: number, at: Date): string {
  return `gdpr-export-kontakt-${contactId}-${at.toISOString().slice(0, 10)}.json`
}
