import { describe, expect, test } from 'vitest'
import { buildContactExport, contactExportFilename, mentionsPerson, GDPR_EXPORT_FORMAT } from '@/domain/crm/gdprExport'

const contact = { id: 7, full_name: 'Jan Novák', email: 'jan.novak@firma.cz', account_id: 3, partner_id: null }
const at = new Date('2026-09-28T10:00:00Z')

function build(over: Partial<Parameters<typeof buildContactExport>[0]> = {}) {
  return buildContactExport({
    contact, organizationName: 'Firma s.r.o.', salesActivities: [], tasks: [],
    mailEvents: [], auditEvents: [], generatedAt: at, ...over,
  })
}

describe('buildContactExport', () => {
  test('hlavička, kontakt, firma jen název', () => {
    const d = build()
    expect(d.format).toBe(GDPR_EXPORT_FORMAT)
    expect(d.vygenerovano).toBe('2026-09-28T10:00:00.000Z')
    expect(d.poznamka).toMatch(/čl\. 15/)
    expect(d.kontakt).toEqual(contact)
    expect(d.firma).toEqual({ nazev: 'Firma s.r.o.' })
  })

  test('aktivity přes contact_id i přes zmínku, schůzky zvlášť, cizí vynechá', () => {
    const d = build({ salesActivities: [
      { id: 1, contact_id: 7, kind: 'call', subject: 'Hovor', body: null },
      { id: 2, contact_id: null, kind: 'email', subject: 'Re', body: 'psal (JAN.NOVAK@firma.cz).' },
      { id: 3, contact_id: null, kind: 'meeting', subject: 'Schůzka s Jan  Novák', body: null },
      { id: 4, contact_id: 9, kind: 'note', subject: 'Jan Nováková', body: 'xjan.novak@firma.cz' },
      { id: 1, contact_id: 7, kind: 'call', subject: 'dup', body: null },
    ] })
    expect(d.aktivity.map((a) => [a.id, a.duvod_zahrnuti])).toEqual([[1, 'contact_id'], [2, 'zminka_v_textu']])
    expect(d.schuzky.map((a) => a.id)).toEqual([3])
    expect(d.souhrn).toMatchObject({ aktivity: 2, schuzky: 1 })
  })

  test('úkoly jen se zmínkou, audit jen tohoto kontaktu', () => {
    const d = build({
      tasks: [{ id: 1, title: 'Zavolat Jan Novák', description: null }, { id: 2, title: 'Jan', description: 'Novák' }],
      auditEvents: [
        { id: 1, entity_table: 'contact', entity_id: 7, action: 'contact.updated' },
        { id: 2, entity_table: 'contact', entity_id: 8, action: 'contact.updated' },
        { id: 3, entity_table: 'deal', entity_id: 7, action: 'deal.updated' },
      ],
    })
    expect(d.ukoly.map((t) => t.id)).toEqual([1])
    expect(d.audit.map((a) => a.id)).toEqual([1])
  })

  test('nesouhlas s oslovením (0087): políčko s datem a důvodem, i poznámka jako druhá pojistka', () => {
    const optedOut = build({ contact: { ...contact, notes: null, do_not_contact: true, do_not_contact_at: '2026-09-29T08:00:00Z',
      do_not_contact_reason: 'Řekl na veletrhu', do_not_contact_by: 'u-1' } })
    expect(optedOut.nesouhlas_s_oslovenim).toEqual({
      nesouhlasi: true, policko_v_evidenci: true, policko: true, od: '2026-09-29T08:00:00Z', odkud_proc: 'Řekl na veletrhu',
      poznamka_uvadi_nesouhlas: false,
    })
    expect(optedOut.souhrn.nesouhlasi_s_oslovenim).toBe(true)
    expect(optedOut.poznamka).toMatch(/nesouhlas_s_oslovenim/)

    const byNote = build({ contact: { ...contact, notes: 'Nekontaktovat.', do_not_contact: false, do_not_contact_at: null, do_not_contact_reason: null } })
    expect(byNote.nesouhlas_s_oslovenim).toMatchObject({ nesouhlasi: true, policko: false, od: null, poznamka_uvadi_nesouhlas: true })

    // Před migrací 0087 řádek sloupce nemá.
    expect(build().nesouhlas_s_oslovenim).toEqual({
      nesouhlasi: false, policko_v_evidenci: false, policko: false, od: null, odkud_proc: null, poznamka_uvadi_nesouhlas: false,
    })
  })

  test('chybějící mail_event → dostupne false', () => {
    expect(build({ mailEvents: null }).maily).toMatchObject({ dostupne: false, zaznamy: [] })
    expect(build({ mailEvents: [{ id: 1 }] }).maily).toEqual({ dostupne: true, zaznamy: [{ id: 1 }] })
  })

  test('bez e-mailu a s jednoslovným jménem se textem nic nepáruje', () => {
    expect(mentionsPerson('Jan přišel', { email: null, name: 'Jan' })).toBe(false)
    expect(mentionsPerson(null, { email: 'a@b.cz' })).toBe(false)
  })

  test('název souboru bez PII', () => {
    expect(contactExportFilename(7, at)).toBe('gdpr-export-kontakt-7-2026-09-28.json')
  })
})
