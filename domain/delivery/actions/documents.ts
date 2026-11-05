'use server'
// Zápisy dokumentů engagementu. Cockpit ukládá jen odkaz + metadata, NIKDY
// obsah (rozhodnutí vlastníka 2026-09-28, plan kap. 8) — proto tu není
// žádné nahrávání souborů, jen odkaz, typ, identita položky, verze a stav.
//
// Vložený odkaz (SharePoint, OneDrive, soubor v Teams) se přísně rozparsuje
// (domain/delivery/documentLink.ts). Se zapnutým GRAPH_FILES_SCOPE_ENABLED
// se přes Graph s tokenem přihlášeného člena načtou metadata souboru
// (domain/delivery/documentMetadata.ts): název doplní prázdný „Název",
// místo vloženého (často sdílecího) odkazu se uloží kanonický webUrl a
// (revize kap. 2E, migrace 0094) i identita položky (drive + item), aktuální
// verze (eTag/cTag, číslo verze, kdy a kdo změnil) a řádek v historii verzí.
//
// Stav dokumentu (koncept → schváleno → odesláno → přijato): schválení
// připíchne verzi, proti které pak denní kontrola hlídá změnu; odeslat jde jen
// verzi, která se od schválení nezměnila; „přijato" nastaví jedině akceptace
// milníku (acceptMilestone) s dokladem. Kdo a kdy stav změnil doplní DB z
// auth.uid() (trigger 0094), z formuláře to podvrhnout nejde.
//
// Řádky verzí píše jen servisní klíč po ověření člena (append-only, migrace 0094).
// Stav dokumentu se píše přes session člena (RLS + AAL2). Identita položky
// (drive_id, item_id) a pozorovaná verze zdroje (eTag/cTag, číslo verze, kdo
// a kdy změnil, stav zdroje) se od migrace 0095 píšou JEN servisním klíčem po
// ověření člena (aktér = člen v auditu): databáze je z členovy session odmítne,
// aby si je nikdo nemohl přepsat přes PostgREST (bezpečnostní revize D1).
// Bez migrace 0094 (chybí sloupce) se dokument uloží jako dřív a člen dostane
// klidnou hlášku.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import { filesScopeEnabled, graphTokenForCurrentUser } from '@/connectors/graph'
import {
  DOCUMENT_STATUS_LABEL,
  canTransitionDocument,
  documentEntityId,
  documentLinkInputSchema,
  engagementDocumentSchema,
  isDocumentStatus,
  SHAREPOINT_EXAMPLES,
  SHAREPOINT_URL_RE,
  type DocumentStatus,
} from '@/domain/delivery/documents'
import { parseDocumentLink, storableSharePointUrl } from '@/domain/delivery/documentLink'
import {
  formatLastChange,
  readStoredItem,
  resolveDocumentMetadata,
  versionFactsOf,
  type MetadataResult,
} from '@/domain/delivery/documentMetadata'
import { isMissingDocumentColumn, latestDocumentVersion, recordDocumentVersion, versionFromRow, type VersionReason } from '@/domain/delivery/documentVersions'
import { hasOpenFinding, resolveDocumentFindings } from '@/domain/delivery/documentFindings'
import { sameVersion, versionName, type VersionFacts } from '@/domain/delivery/documentWatch'
import type { DriveItemMetadata } from '@/connectors/graph'
import type { ZodError } from 'zod'

// Úspěch může nést nápovědu (metadata se nenačetla) nebo potvrzení
// s poslední změnou ze SharePointu.
export type DocumentActionResult = ActionResult & { notice?: string }

const MISSING_MIGRATION_ERROR = 'Dokumenty ještě nejsou dostupné — čekají na migraci 0051.'
const MISSING_0094 = 'Stavy a verze dokumentů ještě nejsou dostupné — čekají na migraci 0094.'
const NOT_FOUND = 'Dokument nebyl nalezen.'
const STALE = 'Dokument mezitím změnil stav. Načti prosím stránku znovu.'
// Cíle ručního přepnutí: všechny kromě „přijato" (to dělá akceptace milníku).
const MANUAL_TARGETS: readonly DocumentStatus[] = ['draft', 'approved', 'sent']
const DUPLICATE_FILE = 'Tenhle soubor už v dodávce je jako jiný dokument.'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

function editPath(accountId: number, engagementId: number): string {
  return `/cockpit/clients/${accountId}/engagements/${engagementId}/edit`
}

type Db = Awaited<ReturnType<typeof createClient>>

/** Zaznamená verzi servisním klíčem; nikdy nevyhodí (pozorovací vrstva). */
async function recordVersionSafe(documentId: number, facts: VersionFacts, reason: VersionReason, userId: string): Promise<number | null> {
  try {
    const r = await recordDocumentVersion(createAdminClient(), documentId, facts, reason, `user:${userId}`)
    return r.ok ? r.id : null
  } catch (e) {
    logError('action.documentVersion', e)
    return null
  }
}

/**
 * Zapíše identitu a pozorovanou verzi zdroje servisním klíčem. Volat až po
 * ověření člena (tryRequireUser) a po načtení dokumentu přes jeho session
 * (RLS), ať se nezapisuje k cizí dodávce; `engagementId` v filtru to drží.
 * Aktér zápisu v auditu je člen.
 */
async function writeDocumentSource(
  userId: string,
  documentId: number,
  engagementId: number,
  patch: Record<string, unknown>,
) {
  return createAuditedAdminClient({ actor: { type: 'user', id: userId } })
    .from('engagement_document')
    .update(patch)
    .eq('id', documentId)
    .eq('engagement_id', engagementId)
}

// Sloupce uložené metadat, které se s verzí mění.
function factsColumns(facts: VersionFacts, checkedAt: string) {
  return {
    e_tag: facts.eTag,
    c_tag: facts.cTag,
    version_label: facts.versionLabel,
    last_modified_at: facts.modifiedAt,
    last_modified_by: facts.modifiedBy,
    source_state: 'ok' as const,
    source_checked_at: checkedAt,
  }
}

export async function createEngagementDocument(
  accountId: number,
  engagementId: number,
  _prev: unknown,
  formData: FormData,
): Promise<DocumentActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const input = documentLinkInputSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!input.success) return { success: false, fieldErrors: fieldErrorsOf(input.error) }
  const link = parseDocumentLink(input.data.url)
  if (!link.ok) return { success: false, fieldErrors: { url: link.error } }

  const s = await createClient()

  // Milník musí patřit k téže dodávce. DB to hlídá taky (trigger
  // engagement_document_milestone_guard z 0042), ale 0042 ještě nemusí být
  // aplikovaná — pak by šlo navázat cizí id.
  if (input.data.milestone_id !== null) {
    const { data, error } = await s
      .from('engagement_milestone')
      .select('id')
      .eq('id', input.data.milestone_id)
      .eq('engagement_id', engagementId)
      .maybeSingle()
    if (isMissingRelation(error)) return { success: false, fieldErrors: { milestone_id: 'Milníky ještě nejsou dostupné — čekají na migraci 0042.' } }
    if (error) return { success: false, error: dbErrorMessage('action.engagementDocuments', error) }
    if (!data) return { success: false, fieldErrors: { milestone_id: 'Milník nepatří k této dodávce.' } }
  }

  let title = input.data.title
  let url = link.storableUrl
  let notice: string | undefined
  // Odkaz, který nejde uložit ani sám (cizí tenant, osobní OneDrive), do
  // Graphu neposíláme: webUrl takového souboru leží vždy mimo firemní
  // SharePoint, takže by ho DB (0053) stejně neuložila.
  const meta: MetadataResult = url === null
    ? { ok: false, reason: 'disabled', problem: null }
    : await resolveDocumentMetadata(link.resolveUrl)
  if (meta.ok) {
    // Ukládá se kanonický webUrl — ale jen když vede do firemního SharePointu
    // (stejné pravidlo jako DB constraint z 0053; obrana do hloubky).
    const canonical = storableSharePointUrl(meta.meta.webUrl)
    if (!canonical) {
      return { success: false, fieldErrors: { url: `Soubor leží mimo firemní SharePoint — Cockpit ukládá jen ${SHAREPOINT_EXAMPLES}.` } }
    }
    url = canonical
    if (!title) title = meta.meta.name.slice(0, 200)
    const lastChange = formatLastChange(meta.meta)
    notice = lastChange ? `Načteno ze SharePointu. ${lastChange}` : 'Načteno ze SharePointu.'
    if (meta.version) notice += ` Verze ${meta.version.label}.`
  } else if (meta.problem && url) {
    notice = `${meta.problem} Odkaz je uložený tak, jak jsi ho vložil.`
  }

  if (!url) {
    const why = link.source === 'onedrive_personal'
      ? 'Osobní OneDrive Cockpit neukládá — dokument patří do firemního SharePointu.'
      : `Uložit jde jen odkaz do firemního SharePointu (${SHAREPOINT_EXAMPLES}).`
    return { success: false, fieldErrors: { url: why } }
  }

  const parsed = engagementDocumentSchema.safeParse({
    engagement_id: engagementId,
    milestone_id: input.data.milestone_id,
    title,
    url,
    kind: input.data.kind,
    doc_type: input.data.doc_type,
  })
  if (!parsed.success) {
    const fieldErrors = fieldErrorsOf(parsed.error)
    if (fieldErrors.title && !title && !meta.ok && meta.reason !== 'disabled') {
      fieldErrors.title = 'Vyplň název — ze SharePointu se ho načíst nepodařilo.'
    }
    return { success: false, fieldErrors }
  }
  // Obrana do hloubky: nic mimo firemní SharePoint se nezapíše.
  if (!SHAREPOINT_URL_RE.test(parsed.data.url)) return { success: false, fieldErrors: { url: 'Odkaz musí vést na firemní SharePoint.' } }

  // Identita a verze jen z odpovědi Graphu (nikdy z formuláře).
  const identity = meta.ok && meta.meta.driveId && meta.meta.itemId ? meta.meta : null
  const facts = meta.ok ? versionFactsOf(meta.meta, meta.version) : null
  const extended: Record<string, unknown> = identity && facts
    ? { drive_id: identity.driveId, item_id: identity.itemId, ...factsColumns(facts, new Date().toISOString()) }
    : {}

  // created_by neposíláme: DB ho doplní z auth.uid() (DEFAULT) a trigger
  // z 0053 odmítne cokoli jiného — autora nejde podvrhnout z klienta.
  async function insertRow(row: Record<string, unknown>, wantId: boolean) {
    const q = s.from('engagement_document').insert(row)
    if (wantId) {
      const r = await q.select('id').single()
      return { error: r.error, id: (r.data as { id?: number } | null)?.id ?? null }
    }
    const r = await q
    return { error: r.error, id: null as number | null }
  }
  // Řádek vzniká z členovy session bez identity a verze zdroje (DB je od 0095
  // od člena nepřijme); ty se doplní servisním klíčem hned potom.
  const hasSource = Object.keys(extended).length > 0
  let res = await insertRow({ ...parsed.data }, hasSource)
  if (res.error && isMissingDocumentColumn(res.error)) {
    // Migrace 0094 ještě neběžela: dokument se uloží jako dřív (odkaz + typ role).
    const { doc_type: _docType, ...legacy } = parsed.data
    void _docType
    res = await insertRow(legacy, false)
    if (!res.error) notice = 'Typ, verze a stav dokumentů čekají na migraci 0094 — odkaz je uložený bez nich.'
  }
  if (isMissingRelation(res.error)) return { success: false, error: MISSING_MIGRATION_ERROR }
  if (res.error?.code === '23505') return { success: false, fieldErrors: { url: DUPLICATE_FILE } }
  if (res.error) return { success: false, error: dbErrorMessage('action.engagementDocuments', res.error) }

  if (res.id !== null && hasSource) {
    const { error: sourceError } = await writeDocumentSource(user.id, res.id, engagementId, extended)
    if (sourceError?.code === '23505') {
      // Tentýž soubor je v dodávce už pod jiným dokumentem: právě založený řádek se vrací.
      const { error: rollbackError } = await s.from('engagement_document').delete().eq('id', res.id).eq('engagement_id', engagementId)
      if (rollbackError) logError('action.documentFacts', rollbackError)
      return { success: false, fieldErrors: { url: DUPLICATE_FILE } }
    }
    if (sourceError) {
      // Odkaz je uložený, jen bez ověřené identity; „Načíst znovu" ji doplní.
      logError('action.documentFacts', sourceError)
      notice = 'Odkaz je uložený, ale metadata ze SharePointu se nepodařilo zapsat. Zkus „Načíst znovu ze SharePointu".'
    }
  }

  // Historie verzí: první záznam „linked". Selhání dokument nestrhne (kontrola
  // verzi doplní při dalším běhu).
  if (res.id !== null && facts) await recordVersionSafe(res.id, facts, 'linked', user.id)

  revalidatePath(editPath(accountId, engagementId))
  return notice ? { success: true, notice } : { success: true }
}

export async function deleteEngagementDocument(
  accountId: number,
  engagementId: number,
  documentId: number,
): Promise<ActionResult> {
  if (!(await tryRequireUser({ aal2: true }))) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, documentId) || !documentEntityId.safeParse(documentId).success) {
    return { success: false, error: 'Neplatné ID.' }
  }
  const s = await createClient()
  const { data: deleted, error } = await s
    .from('engagement_document')
    .delete()
    .eq('id', documentId)
    .eq('engagement_id', engagementId)
    .select('id')
  if (isMissingRelation(error)) return { success: false, error: MISSING_MIGRATION_ERROR }
  if (error) return { success: false, error: dbErrorMessage('action.engagementDocuments', error) }
  if (!deleted?.length) return { success: false, error: NOT_FOUND }
  revalidatePath(`/cockpit/clients/${accountId}/engagements/${engagementId}/edit`)
  return { success: true }
}

// ---------------------------------------------------------------------------
// Stav, verze a obnova metadat (0094)

type DocRow = {
  id: number
  engagement_id: number
  url: string
  title: string
  status: DocumentStatus
  approved_version_id: number | null
  drive_id: string | null
  item_id: string | null
}
const DOC_COLUMNS = 'id, engagement_id, url, title, status, approved_version_id, drive_id, item_id'

async function loadDoc(s: Db, engagementId: number, documentId: number): Promise<{ ok: true; doc: DocRow } | { ok: false; error: string }> {
  const { data, error } = await s
    .from('engagement_document')
    .select(DOC_COLUMNS)
    .eq('id', documentId)
    .eq('engagement_id', engagementId)
    .maybeSingle()
  if (isMissingRelation(error)) return { ok: false, error: MISSING_MIGRATION_ERROR }
  if (isMissingDocumentColumn(error)) return { ok: false, error: MISSING_0094 }
  if (error) return { ok: false, error: dbErrorMessage('action.documentStatus', error) }
  if (!data) return { ok: false, error: NOT_FOUND }
  const row = data as unknown as DocRow
  return { ok: true, doc: { ...row, status: isDocumentStatus(row.status) ? row.status : 'draft' } }
}

type Fresh =
  | { kind: 'facts'; facts: VersionFacts; item: DriveItemMetadata }
  | { kind: 'missing' }
  | { kind: 'unavailable'; problem: string | null }

/**
 * Čerstvá metadata dokumentu ze SharePointu s tokenem člena. Nikdy nevyhazuje
 * a nikdy nečte obsah. `unavailable` = přepínač vypnutý, Outlook nepřipojený,
 * chybí právo nebo Graph teď neodpověděl — volající pak pracuje s tím, co je uložené.
 */
async function readFresh(doc: DocRow): Promise<Fresh> {
  if (!filesScopeEnabled()) return { kind: 'unavailable', problem: null }
  if (doc.drive_id && doc.item_id) {
    const token = await graphTokenForCurrentUser()
    if (!token.ok) return { kind: 'unavailable', problem: `Metadata ze SharePointu se nenačetla: ${token.error}` }
    const r = await readStoredItem(token.accessToken, doc.drive_id, doc.item_id)
    if (r.outcome.kind === 'ok' && r.item) return { kind: 'facts', facts: r.outcome.facts, item: r.item }
    if (r.outcome.kind === 'missing') return { kind: 'missing' }
    if (r.outcome.kind === 'no_access') {
      return { kind: 'unavailable', problem: 'Microsoft nepovolil načíst metadata: buď chybí oprávnění Files.Read.All (Nastavení → Znovu připojit), nebo k souboru nemáš přístup.' }
    }
    return { kind: 'unavailable', problem: 'Metadata ze SharePointu se teď nepodařilo načíst.' }
  }
  // Starší dokument bez identity: dohledá se přes uložený odkaz.
  const meta = await resolveDocumentMetadata(doc.url)
  if (meta.ok) return { kind: 'facts', facts: versionFactsOf(meta.meta, meta.version), item: meta.meta }
  if (meta.reason === 'not_found') return { kind: 'missing' }
  return { kind: 'unavailable', problem: meta.problem }
}

/**
 * Uloží čerstvá metadata k dokumentu a zaznamená verzi; obojí servisním
 * klíčem po ověření člena (0095: člen je z vlastní session zapsat nesmí).
 * Starším dokumentům bez identity ji tím doplní.
 */
async function persistFresh(
  doc: DocRow,
  fresh: Extract<Fresh, { kind: 'facts' }>,
  userId: string,
  reason: VersionReason,
): Promise<{ versionId: number | null; duplicate: boolean }> {
  const identity = !doc.drive_id && !doc.item_id && fresh.item.driveId && fresh.item.itemId
    ? { drive_id: fresh.item.driveId, item_id: fresh.item.itemId }
    : {}
  const patch = { ...factsColumns(fresh.facts, new Date().toISOString()), ...identity }
  let duplicate = false
  let { error } = await writeDocumentSource(userId, doc.id, doc.engagement_id, patch)
  if (error?.code === '23505') {
    // Tentýž soubor je v dodávce už pod jiným dokumentem: identitu tomuhle nedáme.
    duplicate = true
    ;({ error } = await writeDocumentSource(userId, doc.id, doc.engagement_id, factsColumns(fresh.facts, new Date().toISOString())))
  }
  if (error) logError('action.documentFacts', error)
  const versionId = await recordVersionSafe(doc.id, fresh.facts, reason, userId)
  return { versionId, duplicate }
}

async function approvedFacts(s: Db, versionId: number | null): Promise<VersionFacts | null> {
  if (versionId === null) return null
  const { data, error } = await s
    .from('engagement_document_version')
    .select('id, e_tag, c_tag, version_label, modified_at, modified_by')
    .eq('id', versionId)
    .maybeSingle()
  if (error || !data) return null
  return versionFromRow(data as never)
}

/**
 * Změna stavu dokumentu: koncept → schváleno → odesláno, zpět do konceptu.
 * „Přijato" tudy nejde — nastaví ho akceptace milníku s dokladem.
 *
 *  - schválit: čerstvá verze ze SharePointu se připíchne; bez Graphu se
 *    připíchne poslední známá, a když žádná není, schválí se bez ní
 *    (změny se pak nehlídají — člen to v potvrzení uvidí);
 *  - odeslat: jen když se soubor od schválení nezměnil;
 *  - koncept: zruší schválení a uzavře otevřené nálezy.
 */
export async function setDocumentStatus(
  accountId: number,
  engagementId: number,
  documentId: number,
  to: string,
): Promise<DocumentActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, documentId) || !documentEntityId.safeParse(documentId).success) {
    return { success: false, error: 'Neplatné ID.' }
  }
  if (!isDocumentStatus(to) || !MANUAL_TARGETS.includes(to)) {
    return { success: false, error: 'Do tohohle stavu dokument ručně přepnout nejde.' }
  }
  const s = await createClient()
  const loaded = await loadDoc(s, engagementId, documentId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const doc = loaded.doc
  if (!canTransitionDocument(doc.status, to)) {
    return { success: false, error: `Dokument ve stavu „${DOCUMENT_STATUS_LABEL[doc.status]}" nejde přepnout na „${DOCUMENT_STATUS_LABEL[to]}".` }
  }

  let approvedVersionId: number | null | undefined
  let notice: string | undefined

  if (to === 'approved' || to === 'sent') {
    const fresh = await readFresh(doc)
    if (fresh.kind === 'missing') {
      return { success: false, error: 'Soubor už ve SharePointu není — nejdřív oprav odkaz nebo dokument odeber.' }
    }
    let freshVersionId: number | null = null
    if (fresh.kind === 'facts') {
      const p = await persistFresh(doc, fresh, user.id, to === 'approved' ? 'approved' : 'refreshed')
      freshVersionId = p.versionId
    } else if (fresh.problem) {
      notice = fresh.problem
    }

    if (to === 'approved') {
      if (fresh.kind === 'facts') {
        approvedVersionId = freshVersionId
      } else if (doc.drive_id && doc.item_id) {
        // Graph teď neodpověděl: připíchne se poslední známá verze.
        approvedVersionId = (await latestDocumentVersion(s, doc.id))?.id ?? null
      } else {
        approvedVersionId = null
      }
      if (approvedVersionId === null) {
        notice = `${notice ? `${notice} ` : ''}Verze dokumentu není zaznamenaná, proto se jeho změny nehlídají.`
      }
    } else {
      // Odeslat jde jen schválenou verzi.
      const approved = await approvedFacts(s, doc.approved_version_id)
      const changedNow = fresh.kind === 'facts' && approved !== null && sameVersion(approved, fresh.facts) === false
      const changedBefore = fresh.kind !== 'facts' && (await hasOpenFinding(s, doc.id, 'changed'))
      if (changedNow || changedBefore) {
        const seen = fresh.kind === 'facts' ? versionName(fresh.facts) : 'jiná verze'
        return {
          success: false,
          error: `Dokument se od schválení změnil (schválená ${versionName(approved)}, nyní ${seen}). Nejdřív ho znovu schval, pak ho odešli.`,
        }
      }
    }
  }

  const patch: Record<string, unknown> = { status: to }
  if (approvedVersionId !== undefined) patch.approved_version_id = approvedVersionId
  const { data: updated, error } = await s
    .from('engagement_document')
    .update(patch)
    .eq('id', doc.id)
    .eq('engagement_id', engagementId)
    .eq('status', doc.status)
    .select('id')
  if (isMissingRelation(error)) return { success: false, error: MISSING_MIGRATION_ERROR }
  if (isMissingDocumentColumn(error)) return { success: false, error: MISSING_0094 }
  if (error) return { success: false, error: dbErrorMessage('action.documentStatus', error) }
  if (!updated?.length) return { success: false, error: STALE }

  if (to === 'approved') await resolveDocumentFindings(s, doc.id, 'reapproved')
  if (to === 'draft') await resolveDocumentFindings(s, doc.id, 'draft')
  revalidatePath(editPath(accountId, engagementId))
  return notice ? { success: true, notice } : { success: true }
}

/**
 * Schválit aktuální verzi znovu (po změně souboru od schválení): připíchne
 * čerstvou verzi jako novou schválenou a uzavře nález „změnil se". Stav
 * (schváleno / odesláno / přijato) zůstává.
 */
export async function reapproveDocument(
  accountId: number,
  engagementId: number,
  documentId: number,
): Promise<DocumentActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, documentId) || !documentEntityId.safeParse(documentId).success) {
    return { success: false, error: 'Neplatné ID.' }
  }
  const s = await createClient()
  const loaded = await loadDoc(s, engagementId, documentId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const doc = loaded.doc
  if (doc.status === 'draft') return { success: false, error: 'Koncept se neschvaluje znovu — schval ho.' }

  const fresh = await readFresh(doc)
  if (fresh.kind === 'missing') return { success: false, error: 'Soubor už ve SharePointu není — nejdřív oprav odkaz nebo dokument odeber.' }
  if (fresh.kind !== 'facts') {
    return { success: false, error: fresh.problem ?? 'Načítání metadat ze SharePointu je vypnuté, verzi nejde ověřit.' }
  }
  const p = await persistFresh(doc, fresh, user.id, 'approved')
  if (p.versionId === null) return { success: false, error: 'Verzi se nepodařilo zaznamenat. Zkus to prosím znovu.' }

  const { data: updated, error } = await s
    .from('engagement_document')
    .update({ approved_version_id: p.versionId })
    .eq('id', doc.id)
    .eq('engagement_id', engagementId)
    .eq('status', doc.status)
    .select('id')
  if (isMissingDocumentColumn(error)) return { success: false, error: MISSING_0094 }
  if (error) return { success: false, error: dbErrorMessage('action.documentStatus', error) }
  if (!updated?.length) return { success: false, error: STALE }

  await resolveDocumentFindings(s, doc.id, 'reapproved', ['changed'])
  revalidatePath(editPath(accountId, engagementId))
  return { success: true, notice: `Schválená je teď ${versionName(fresh.facts)}.` }
}

/** „Načíst znovu ze SharePointu": obnoví metadata a verzi; starším dokumentům doplní identitu. */
export async function refreshEngagementDocument(
  accountId: number,
  engagementId: number,
  documentId: number,
): Promise<DocumentActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId, documentId) || !documentEntityId.safeParse(documentId).success) {
    return { success: false, error: 'Neplatné ID.' }
  }
  const s = await createClient()
  const loaded = await loadDoc(s, engagementId, documentId)
  if (!loaded.ok) return { success: false, error: loaded.error }
  const doc = loaded.doc
  if (!filesScopeEnabled()) return { success: false, error: 'Načítání metadat ze SharePointu není zapnuté.' }

  const fresh = await readFresh(doc)
  if (fresh.kind === 'missing') {
    const { error } = await writeDocumentSource(user.id, doc.id, engagementId, { source_state: 'missing', source_checked_at: new Date().toISOString() })
    if (error) logError('action.documentRefresh', error)
    revalidatePath(editPath(accountId, engagementId))
    return { success: true, notice: 'Soubor už ve SharePointu není.' }
  }
  if (fresh.kind !== 'facts') return { success: false, error: fresh.problem ?? 'Metadata ze SharePointu se teď nepodařilo načíst.' }

  const p = await persistFresh(doc, fresh, user.id, 'refreshed')
  revalidatePath(editPath(accountId, engagementId))
  const bits = ['Načteno ze SharePointu.']
  const last = formatLastChange(fresh.item)
  if (last) bits.push(last)
  if (fresh.facts.versionLabel) bits.push(`Verze ${fresh.facts.versionLabel}.`)
  if (p.duplicate) bits.push(DUPLICATE_FILE)
  return { success: true, notice: bits.join(' ') }
}
