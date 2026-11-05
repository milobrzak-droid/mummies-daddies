import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { EngagementDocuments } from '@/components/EngagementDocuments'
import type { EngagementDocument } from '@/domain/delivery/queries/documents'

// Karta dokumentů dodávky (0094): typ, stav, kdo a kdy, verze, upozornění
// a akce podle stavu. Serverové akce jsou zamockované, vykresluje se jen HTML.

vi.mock('@/domain/delivery/actions/documents', () => ({
  createEngagementDocument: vi.fn(),
  deleteEngagementDocument: vi.fn(),
  reapproveDocument: vi.fn(),
  refreshEngagementDocument: vi.fn(),
  setDocumentStatus: vi.fn(),
}))

const doc = (over: Partial<EngagementDocument> = {}): EngagementDocument => ({
  id: 1, engagement_id: 2, milestone_id: null, title: 'Nabídka pro ALFATECH', url: 'https://mummiesdaddies.sharepoint.com/sites/P/Nabidka.docx',
  kind: 'vystup', created_by: null, created_at: '2026-09-20T10:00:00Z',
  doc_type: 'nabidka', status: 'draft', status_changed_at: null, status_changed_by: null, approved_at: null, approved_by: null,
  approved_version_id: null, approved_version: null, has_identity: true, version_label: '3.0',
  last_modified_at: '2026-09-27T12:30:00Z', last_modified_by: 'Jana Nováková', source_state: 'ok', source_checked_at: '2026-09-30T04:00:00Z',
  changed_since_approval: false, findings: [], ...over,
})
const approved = {
  status: 'approved' as const, status_changed_at: '2026-09-28T09:00:00Z', status_changed_by: 'u1', approved_at: '2026-09-28T09:00:00Z', approved_by: 'u1',
  approved_version_id: 70, approved_version: { version_label: '3.0', modified_at: null, modified_by: null, e_tag: 'e', c_tag: 'c' },
}
const NAMES = { u1: 'Viktor Kovář' }

function html(documents: EngagementDocument[], extra: Partial<Parameters<typeof EngagementDocuments>[0]> = {}) {
  return renderToStaticMarkup(
    <EngagementDocuments accountId={1} engagementId={2} memberNames={NAMES} state="ok" documents={documents} {...(extra as object)} />,
  )
}

describe('EngagementDocuments', () => {
  it('koncept: typ, stav slovem, verze a kdo změnil soubor; jediná stavová akce je Schválit', () => {
    const h = html([doc()])
    expect(h).toContain('Nabídka</span>')
    expect(h).toContain('Koncept')
    expect(h).toContain('Verze 3.0')
    expect(h).toContain('Jana Nováková')
    expect(h).toContain('>Schválit<')
    expect(h).not.toContain('Označit jako odesláno')
    expect(h).not.toContain('Vrátit do konceptu')
  })

  it('schváleno: kdo a kdy stav změnil, schválená verze, akce Označit jako odesláno a Vrátit do konceptu', () => {
    const h = html([doc(approved)])
    expect(h).toContain('Schváleno')
    expect(h).toContain('Viktor Kovář')
    expect(h).toMatch(/Schválil\(a\) Viktor Kovář .*schválená verze 3\.0/)
    expect(h).toContain('Označit jako odesláno')
    expect(h).toContain('Vrátit do konceptu')
    expect(h).not.toContain('role="alert"')
  })

  it('změnil se od schválení: upozornění s verzemi a opravou; odeslat nejde, dokud se nezaschválí znovu', () => {
    const h = html([doc({ ...approved, version_label: '4.0', changed_since_approval: true, findings: ['changed'] })])
    expect(h).toMatch(/role="alert"[^>]*>.*Od schválení se soubor změnil: schválená verze 3\.0, teď verze 4\.0/)
    expect(h).toContain('Schválit aktuální verzi')
    // Tlačítko odeslání je neaktivní.
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Označit jako odesláno<\/button>/)
  })

  it('odeslaný dokument, který se změnil, varuje, že klientovi mohla odejít jiná verze', () => {
    const h = html([doc({ ...approved, status: 'sent', findings: ['changed'] })])
    expect(h).toContain('Klientovi mohla odejít jiná verze.')
    expect(h).not.toContain('Označit jako odesláno')
  })

  it('přijatý dokument nemá stavové akce; změna po přijetí neumožní návrat do konceptu', () => {
    const ok = html([doc({ ...approved, status: 'accepted' })])
    expect(ok).toContain('Přijato klientem')
    expect(ok).not.toContain('Vrátit do konceptu')
    expect(ok).not.toContain('Označit jako odesláno')
    const changed = html([doc({ ...approved, status: 'accepted', findings: ['changed'] })])
    expect(changed).toContain('Klient přijal dřívější verzi.')
    expect(changed).toContain('Schválit aktuální verzi')
    expect(changed).not.toContain('Vrátit do konceptu')
  })

  it('zmizel soubor a chybějící přístup mají vlastní upozornění', () => {
    const missing = html([doc({ ...approved, source_state: 'missing', findings: ['missing'] })])
    expect(missing).toContain('Soubor ze SharePointu zmizel')
    const noAccess = html([doc({ ...approved, source_state: 'no_access', findings: ['no_access'] })])
    expect(noAccess).toContain('Kontrola nemá k souboru přístup')
    expect(noAccess).toContain('Files.Read.All')
  })

  it('schváleno bez zaznamenané verze: nápověda; nabídka zaznamenání jen se zapnutým načítáním metadat', () => {
    const base = doc({ ...approved, approved_version_id: null, approved_version: null, has_identity: false, version_label: null })
    expect(html([base])).toContain('změny souboru nehlídají')
    expect(html([base])).not.toContain('Zaznamenat aktuální verzi')
    expect(html([base], { metadataEnabled: true })).toContain('Zaznamenat aktuální verzi jako schválenou')
  })

  it('„Načíst znovu" jen se zapnutými metadaty; poznámka o denní kontrole podle přepínače', () => {
    expect(html([doc()])).not.toContain('Načíst znovu')
    expect(html([doc()], { metadataEnabled: true })).toContain('Načíst znovu')
    expect(html([doc()])).toContain('Denní kontrola změn souborů je vypnutá')
    const on = html([doc()], { watchEnabled: true })
    expect(on).toContain('denně kontrolují')
    expect(on).toContain('Cockpit čte jen údaje o souboru, ne jeho obsah')
  })

  it('formulář má typ dokumentu (pět druhů), roli a odkaz; odkaz jde jen do firemního SharePointu', () => {
    const h = html([])
    for (const label of ['Nabídka', 'Procesní mapa', 'Zápis', 'Předávací balíček', 'Jiné']) expect(h).toContain(`>${label}</option>`)
    expect(h).toContain('name="doc_type"')
    expect(h).toContain('name="kind"')
    expect(h).toContain('placeholder="https://mummiesdaddies.sharepoint.com/…"')
    expect(h).toContain('Zatím žádné dokumenty')
  })

  it('bez migrace a při chybě klidná hláška; nebezpečný odkaz není klikací', () => {
    expect(renderToStaticMarkup(<EngagementDocuments accountId={1} engagementId={2} state="missing_migration" />)).toContain('Tahle část se připravuje.')
    expect(renderToStaticMarkup(<EngagementDocuments accountId={1} engagementId={2} state="error" />)).toContain('nepodařilo načíst')
    const h = html([doc({ url: 'javascript:alert(1)' })])
    expect(h).not.toContain('href="javascript:')
  })

  it('chyba denní kontroly (chybí oprávnění) je nad seznamem, jen když kontrola běží', () => {
    const problem = 'Členu chybí oprávnění Files.Read.All'
    expect(html([doc()], { watchEnabled: true, syncProblem: problem })).toContain(`Denní kontrola dokumentů hlásí problém: ${problem}`)
    expect(html([doc()], { syncProblem: problem })).not.toContain('hlásí problém')
    expect(html([doc()], { watchEnabled: true })).not.toContain('hlásí problém')
  })

  it('milník a role dokumentu jsou vidět', () => {
    const h = html([doc({ milestone_id: 5 })], { milestones: [{ id: 5, title: 'Workshop' }] })
    expect(h).toContain('Výstup · Milník: Workshop')
  })
})
