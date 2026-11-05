// Verze dokumentu dodávky a hlídání změn od schválení — čistá logika bez I/O
// (revize kap. 2E, migrace 0094). Čtení Graphu i zápisy jsou jinde
// (documentMetadata.ts, documentSync.ts); tady jen odpovědi na otázky:
//   - je to pořád tatáž verze?              sameVersion
//   - co má denní kontrola udělat?          planDocumentCheck
//   - co o verzi řekneme člověku?           versionSummary
//
// Obsah souborů se nečte: verze se pozná jen z eTag/cTag/čísla verze, která
// vrací Graph v metadatech.
import { formatDate } from '@/lib/format'
import { DOCUMENT_STATUS_LABEL, type DocumentStatus } from '@/domain/delivery/documents'

/** Verze dokumentu tak, jak ji vidí Graph. Cokoli může chybět. */
export type VersionFacts = {
  eTag: string | null
  cTag: string | null
  versionLabel: string | null
  modifiedAt: string | null
  modifiedBy: string | null
}

export const NO_VERSION: VersionFacts = { eTag: null, cTag: null, versionLabel: null, modifiedAt: null, modifiedBy: null }

export function hasVersionFacts(v: Pick<VersionFacts, 'eTag' | 'cTag' | 'versionLabel'> | null | undefined): boolean {
  return !!v && (!!v.eTag || !!v.cTag || !!v.versionLabel)
}

/**
 * Je to tatáž verze? Nejspolehlivější je cTag (mění se jen s obsahem souboru,
 * přejmenování ani změna práv ji nehnou); když ho jedna ze stran nemá, eTag;
 * poslední záchrana je číslo verze. Bez společného údaje se verze neporovná
 * a funkce vrací `null` (neznámé) — kontrola pak neplaší.
 */
export function sameVersion(
  a: Pick<VersionFacts, 'eTag' | 'cTag' | 'versionLabel'>,
  b: Pick<VersionFacts, 'eTag' | 'cTag' | 'versionLabel'>,
): boolean | null {
  if (a.cTag && b.cTag) return a.cTag === b.cTag
  if (a.eTag && b.eTag) return a.eTag === b.eTag
  if (a.versionLabel && b.versionLabel) return a.versionLabel === b.versionLabel
  return null
}

/** „verze 3.0", „jiná verze"; pro větu v upozornění. */
export function versionName(v: Pick<VersionFacts, 'versionLabel'> | null | undefined): string {
  return v?.versionLabel ? `verze ${v.versionLabel}` : 'jiná verze'
}

/** „Verze 3.0 · upraveno 28. 9. 2026, Jana Nováková"; null, když o verzi nic nevíme. */
export function versionSummary(v: Pick<VersionFacts, 'versionLabel' | 'modifiedAt' | 'modifiedBy'> | null | undefined): string | null {
  if (!v) return null
  const when = v.modifiedAt ? formatDate(v.modifiedAt) : null
  const at = when && when !== '—' ? when : null
  if (!v.versionLabel && !at && !v.modifiedBy) return null
  const parts: string[] = []
  if (v.versionLabel) parts.push(`Verze ${v.versionLabel}`)
  const changed = [at, v.modifiedBy].filter(Boolean).join(', ')
  if (changed) parts.push(`upraveno ${changed}`)
  return parts.join(' · ')
}

// --- Denní kontrola ----------------------------------------------------------

export type FindingKind = 'changed' | 'missing' | 'no_access'
export const FINDING_KINDS: readonly FindingKind[] = ['changed', 'missing', 'no_access']

export type SourceState = 'ok' | 'missing' | 'no_access'

/** Co o dokumentu řekl Graph. `skip` = nevíme (chyba, omezení, vypršelé přihlášení) — nic se nemění. */
export type SourceOutcome =
  | { kind: 'ok'; facts: VersionFacts }
  | { kind: 'missing' }
  | { kind: 'no_access' }
  | { kind: 'skip' }

export type WatchedDocument = {
  status: DocumentStatus
  /** Verze uložená u dokumentu z minulé kontroly. */
  current: VersionFacts
  /** Verze připíchnutá při schválení; null = schválení proběhlo bez známé verze. */
  approved: VersionFacts | null
  sourceState: SourceState | null
  /** Druhy nálezů, které už jsou otevřené. */
  openFindings: readonly FindingKind[]
}

export type CheckPlan = {
  /** Stav zdroje k uložení; null = beze změny (skip). */
  sourceState: SourceState | null
  /** Zapsat aktuální verzi k dokumentu (jen u `ok`). */
  writeFacts: VersionFacts | null
  /** Je to nová verze oproti té, co u dokumentu už bylo (zapsat řádek verze). */
  newVersion: boolean
  open: FindingKind[]
  /** Otevřené nálezy, které už neplatí (soubor je zpátky / verze sedí) — zavřít jako „auto". */
  close: FindingKind[]
}

/**
 * Co má kontrola s dokumentem udělat. Čistě podle odpovědi Graphu a uložených
 * údajů — nic nedopočítává:
 *  - `ok`: uloží aktuální verzi; změnila-li se oproti schválené, otevře nález
 *    „changed"; sedí-li zase, „changed" zavře; „missing" a „no_access" zavře;
 *  - `missing` / `no_access`: otevře odpovídající nález;
 *  - `skip`: nic.
 * Draft se nekontroluje; volající ho do kontroly nepustí, tady je pojistka.
 */
export function planDocumentCheck(doc: WatchedDocument, outcome: SourceOutcome): CheckPlan {
  const none: CheckPlan = { sourceState: null, writeFacts: null, newVersion: false, open: [], close: [] }
  if (doc.status === 'draft' || outcome.kind === 'skip') return none
  const isOpen = (k: FindingKind) => doc.openFindings.includes(k)

  if (outcome.kind === 'missing') {
    return { ...none, sourceState: 'missing', open: isOpen('missing') ? [] : ['missing'], close: [] }
  }
  if (outcome.kind === 'no_access') {
    return { ...none, sourceState: 'no_access', open: isOpen('no_access') ? [] : ['no_access'], close: [] }
  }

  const close: FindingKind[] = FINDING_KINDS.filter((k) => k !== 'changed' && isOpen(k))
  const open: FindingKind[] = []
  const same = doc.approved ? sameVersion(doc.approved, outcome.facts) : null
  if (same === false) {
    if (!isOpen('changed')) open.push('changed')
  } else if (same === true && isOpen('changed')) {
    close.push('changed')
  }
  const previously = hasVersionFacts(doc.current) ? sameVersion(doc.current, outcome.facts) : false
  return {
    sourceState: 'ok',
    writeFacts: outcome.facts,
    // Neznámé porovnání (žádný společný údaj) bereme jako novou verzi, ať se nic neztratí.
    newVersion: previously !== true,
    open,
    close,
  }
}

// --- Texty pro člověka ---------------------------------------------------------

/** Věta pro úkol a „Co se změnilo". Bez obsahu souboru, jen stav a verze. */
export function findingSentence(
  kind: FindingKind,
  status: DocumentStatus,
  versions: { approved: Pick<VersionFacts, 'versionLabel'> | null; seen: Pick<VersionFacts, 'versionLabel'> | null },
): string {
  const state = DOCUMENT_STATUS_LABEL[status].toLowerCase()
  if (kind === 'missing') return `Soubor ze SharePointu zmizel (dokument je ${state}).`
  if (kind === 'no_access') return `Kontrola nemá k souboru přístup (dokument je ${state}): buď byl přístup odebrán, nebo chybí oprávnění Files.Read.All.`
  const was = versionName(versions.approved)
  const now = versionName(versions.seen)
  return was === now
    ? `Od schválení se změnil (dokument je ${state}); je to jiná verze než schválená.`
    : `Od schválení se změnil (dokument je ${state}): schválená ${was}, nyní ${now}.`
}

export function findingTaskTitle(kind: FindingKind, docTitle: string): string {
  const t = docTitle.trim().slice(0, 160)
  if (kind === 'missing') return `Dokument zmizel ze SharePointu: ${t}`
  if (kind === 'no_access') return `Nemáme přístup k dokumentu: ${t}`
  return `Dokument se změnil od schválení: ${t}`
}
