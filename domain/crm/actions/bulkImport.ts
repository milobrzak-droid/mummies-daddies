'use server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAuditedAdminClient } from '@/core/auditDb'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { dbErrorMessage } from '@/lib/actionResult'
import { logError, logWarn } from '@/lib/log'
import { recordEvidence } from '@/core/evidence'
import type { InjectionFlag } from '@/core/untrusted'
import { OFFER_PDF_TIMEOUT_MS, extractOfferFromPdf } from '@/connectors/anthropic'
import { takeAiPdfQuota } from '@/domain/crm/aiQuota'
import { czkPerEur } from '@/connectors/cnb'
import {
  AresUnavailableError, aresLookupByIco, aresRegionValue, aresSearch, cleanCompanyName, normalizeCompanyName, pickAresMatch,
} from '@/connectors/ares'
import { sanitizeExtraction, type SanitizedOfferFields } from '@/domain/crm/offer-extract'
import {
  OFFER_BUCKET, buildStoredProposal, derivedOfferStage, offerPaths, parseStoredProposal, isProposalId,
  type StoredOfferProposal,
} from '@/domain/crm/offerProposal'
import {
  BULK_MAX_CSV_BYTES, BULK_MAX_PDF_BYTES, DEFAULT_IMPORT_REVENUE_LINE, IMPORT_MISSING_MESSAGE,
  applyRowSchema, describeRevert, importDbMessage, importPdfKey, importRowKey, importStageProbability, isImportMissing,
  matchClient, parseImportCsv, parseRevertResult, revenueCategoryFor,
  IMPORT_STAGE_DEAL, type ClientMatch, type ImportMember, type ImportStage, type ParsedCsvRow, type RevertResult,
} from '@/domain/crm/bulkImport'
import {
  findDealsOfAccounts, findImportedKeys, findSameTitleDeal, listImportMembers, loadAccountIndex, purgeStaleOfferProposals,
  type PurgeDb,
} from '@/domain/crm/bulkImportService'

// Hromadný import běžících zakázek (migrace 0098, docs/PROVOZ.md).
// Dva zdroje (víc PDF, tabulka CSV), jedna kontrolní fronta. Nic se nezakládá,
// dokud člověk řádek nepotvrdí; zápis jednoho řádku je jedna databázová
// transakce (import_apply_row). Všechno jen pro obchodní role s AAL2: akce
// pracují přes servisní klíč (RLS obchází), proto roli hlídáme tady a znovu
// v databázi (aktér musí být aktivní člen s obchodní rolí, IM003).

const SALES_ONLY_ERROR = 'Import zakázek smí jen člen s přístupem k obchodu.'
const AI_OFF_ERROR = 'Čtení PDF umělou inteligencí není zapnuté (chybí klíč ANTHROPIC_API_KEY). Použij tabulku CSV.'

async function salesGate() {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false as const, error: AUTH_ERROR_MESSAGE }
  if (!memberSeesSales((await getCurrentMember()).member)) return { ok: false as const, error: SALES_ONLY_ERROR }
  return {
    ok: true as const,
    user,
    // Servisní klient nese aktéra: řádkové změny (klient, obchod, dodávka, finance) zapíše audit člověku.
    admin: createAuditedAdminClient({ actor: { type: 'user', id: user.id } }),
    db: await createClient(),
  }
}

// ---------------------------------------------------------------------------
// Dávka

export type OpenBatchResult = { ok: true; batchId: number } | { ok: false; error: string }

/** Otevře dávku (jedno nahrání). Volá se až při prvním potvrzení řádku. */
export async function openImportBatch(kind: unknown, label: unknown): Promise<OpenBatchResult> {
  const gate = await salesGate()
  if (!gate.ok) return gate
  if (kind !== 'pdf' && kind !== 'csv') return { ok: false, error: 'Neznámý druh importu.' }
  const text = typeof label === 'string' ? label.slice(0, 200) : ''
  const { data, error } = await gate.admin.rpc('import_open_batch', { p_actor: gate.user.id, p_kind: kind, p_label: text })
  if (error) return { ok: false, error: importDbMessage(error) ?? dbErrorMessage('bulkImport.openBatch', error) }
  const id = Number(data)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Dávku se nepodařilo otevřít.' }
  return { ok: true, batchId: id }
}

// ---------------------------------------------------------------------------
// Zdroj A: PDF

export type BulkPdfProposal = {
  proposalId: string
  fileName: string
  fields: SanitizedOfferFields
  warnings: string[]
  flags: InjectionFlag[]
  match: ClientMatch
  suggestedStage: ImportStage
  sameTitleDeal: { id: number; title: string } | null
}

export type ProposePdfResult =
  | { ok: true; proposal: BulkPdfProposal }
  | { ok: false; fileName: string; error: string; code?: 'no_key' | 'already_imported' | 'unavailable' | 'quota' }

// Úklid nepotvrzených návrhů je tak levný, že stačí jednou za hodinu a instanci.
let lastPurgeAt = 0
const PURGE_EVERY_MS = 60 * 60 * 1000

/** Krok 1 pro jedno PDF: soubor → návrh AI. Nic nezakládá; PDF a návrh se uloží do bucketu nabidky. */
export async function proposePdfImport(formData: FormData): Promise<ProposePdfResult> {
  const gate = await salesGate()
  if (!gate.ok) return { ok: false, fileName: '', error: gate.error }
  const file = formData.get('pdf')
  if (!(file instanceof File) || file.size === 0) return { ok: false, fileName: '', error: 'Nahraj prosím PDF.' }
  const fileName = file.name.slice(0, 300)
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, fileName, error: AI_OFF_ERROR, code: 'no_key' }
  if (file.type !== 'application/pdf') return { ok: false, fileName, error: 'Není PDF.' }
  if (file.size > BULK_MAX_PDF_BYTES) {
    return { ok: false, fileName, error: `Soubor je moc velký (nejvýš ${BULK_MAX_PDF_BYTES / 1024 / 1024} MB).` }
  }
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { ok: false, fileName, error: 'Soubor nevypadá jako PDF.' }

  // Stejný soubor už je importovaný: bez volání AI (šetří čas i peníze).
  const pdfKey = await importPdfKey(buffer)
  try {
    if ((await findImportedKeys(gate.db, [pdfKey])).has(pdfKey)) {
      return { ok: false, fileName, error: 'Tenhle soubor už byl importován.', code: 'already_imported' }
    }
  } catch (e) {
    if (isImportMissing(e as { code?: string })) return { ok: false, fileName, error: IMPORT_MISSING_MESSAGE, code: 'unavailable' }
    return { ok: false, fileName, error: dbErrorMessage('bulkImport.propose.keys', e) }
  }

  if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
    lastPurgeAt = Date.now()
    await purgeStaleOfferProposals(gate.admin as unknown as PurgeDb)
  }

  // Denní strop volání modelu na člověka (sdílený s /nabidka/import, domain/crm/aiQuota.ts).
  const quota = await takeAiPdfQuota(gate.admin, gate.user.id, 'bulk_import')
  if (!quota.ok) return { ok: false, fileName, error: quota.error, code: 'quota' }

  let raw
  try {
    // Stránka má maxDuration 60 s; volání modelu nejvýš OFFER_PDF_TIMEOUT_MS (50 s).
    raw = await extractOfferFromPdf(buffer.toString('base64'), { timeoutMs: OFFER_PDF_TIMEOUT_MS })
  } catch (e) {
    logError('bulkImport.extract', e)
    return { ok: false, fileName, error: 'Nabídku se nepodařilo přečíst. Zkus to znovu, nebo ji zadej v tabulce.' }
  }
  let extraction
  try {
    extraction = sanitizeExtraction(raw)
  } catch {
    return { ok: false, fileName, error: 'V nabídce není poznat jméno klienta.' }
  }
  const { fields, warnings, flags } = extraction

  const proposalId = crypto.randomUUID()
  const paths = offerPaths(proposalId)
  const bucket = gate.admin.storage.from(OFFER_BUCKET)
  const { error: uploadError } = await bucket.upload(paths.pdf, buffer, { contentType: 'application/pdf' })
  if (uploadError) return { ok: false, fileName, error: dbErrorMessage('bulkImport.upload', uploadError) }
  // Návrh AI se ukládá na server vedle PDF (ne do prohlížeče): potvrzení si ho načte odsud.
  const stored = buildStoredProposal({
    proposalId, fileName, fields, warnings, flags, now: new Date(),
    fileSha256: pdfKey.slice('pdf:'.length), proposedBy: gate.user.id,
  })
  const { error: proposalError } = await bucket.upload(paths.proposal, Buffer.from(JSON.stringify(stored), 'utf8'), { contentType: 'application/json' })
  if (proposalError) {
    await bucket.remove([paths.pdf]).catch(() => undefined)
    return { ok: false, fileName, error: dbErrorMessage('bulkImport.saveProposal', proposalError) }
  }
  if (flags.length > 0) logWarn('bulkImport.injection_markers', 'návrh AI z PDF nese příznaky možných pokynů pro AI', { flags, proposal: proposalId })

  let match: ClientMatch = { kind: 'none' }
  let sameTitleDeal: BulkPdfProposal['sameTitleDeal'] = null
  try {
    match = matchClient({ name: fields.account_name, ico: null }, await loadAccountIndex(gate.db))
    if (match.kind === 'matched') {
      const d = findSameTitleDeal(await findDealsOfAccounts(gate.db, [match.accountId]), match.accountId, fields.title)
      sameTitleDeal = d ? { id: d.id, title: d.title } : null
    }
  } catch (e) {
    logError('bulkImport.match', e)
  }

  return {
    ok: true,
    proposal: {
      proposalId, fileName, fields, warnings, flags, match,
      suggestedStage: derivedOfferStage(fields.pillar, fields.phase) === 'vyhráno' ? 'won' : 'sent',
      sameTitleDeal,
    },
  }
}

async function loadStoredProposal(gate: { admin: ReturnType<typeof createAuditedAdminClient> }, proposalId: string): Promise<StoredOfferProposal | null> {
  try {
    const { data, error } = await gate.admin.storage.from(OFFER_BUCKET).download(offerPaths(proposalId).proposal)
    if (error || !data) return null
    return parseStoredProposal(JSON.parse(await data.text()), proposalId)
  } catch {
    return null
  }
}

/** Zamítnutí řádku z PDF: PDF i návrh se hned smažou (neuchovává se nic, co nevzniklo obchodem). */
export async function rejectPdfProposal(proposalId: unknown): Promise<{ ok: boolean; error?: string }> {
  const gate = await salesGate()
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!isProposalId(proposalId)) return { ok: false, error: 'Neplatný návrh.' }
  const stored = await loadStoredProposal(gate, proposalId)
  // Cizí návrh se nemaže; návrh, který už neexistuje, je hotová věc.
  if (stored && stored.proposed_by !== gate.user.id) return { ok: false, error: 'Návrh patří jinému člověku.' }
  const paths = offerPaths(proposalId)
  // Už potvrzený návrh (obchod na PDF odkazuje) se nemaže: PDF je důkaz.
  const { data: deal } = await gate.db.from('deal').select('id').eq('source_pdf_path', paths.pdf).limit(1)
  if (deal && deal.length > 0) return { ok: true }
  const { error } = await gate.admin.storage.from(OFFER_BUCKET).remove([paths.pdf, paths.proposal])
  if (error) return { ok: false, error: dbErrorMessage('bulkImport.reject', error) }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Zdroj B: tabulka CSV

export type CsvPreviewRow = {
  row: ParsedCsvRow
  /** Klíč idempotence řádku (jen pro řádky bez chyb). */
  key: string | null
  match: ClientMatch
  alreadyImported: boolean
  sameTitleDeal: { id: number; title: string } | null
}

export type PreviewCsvResult =
  | { ok: true; rows: CsvPreviewRow[]; ignoredColumns: string[]; members: ImportMember[]; meId: string }
  | { ok: false; error: string }

/** Náhled tabulky: řádky s chybami, spárovaný klient, už importované a podobné zakázky. Nic nezapisuje. */
export async function previewCsvImport(formData: FormData): Promise<PreviewCsvResult> {
  const gate = await salesGate()
  if (!gate.ok) return gate
  const file = formData.get('csv')
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'Nahraj prosím soubor CSV.' }
  if (file.size > BULK_MAX_CSV_BYTES) return { ok: false, error: `Soubor je moc velký (nejvýš ${BULK_MAX_CSV_BYTES / 1024 / 1024} MB).` }
  let text: string
  try {
    text = await file.text()
  } catch {
    return { ok: false, error: 'Soubor se nepodařilo přečíst.' }
  }
  if (text.includes('\u0000')) return { ok: false, error: 'Tohle není textové CSV. V Excelu zvol Uložit jako, CSV UTF-8.' }

  try {
    const members = await listImportMembers(gate.db)
    const parsed = parseImportCsv(text, members)
    if (!parsed.ok) return parsed

    const index = await loadAccountIndex(gate.db)
    const keyed = await Promise.all(parsed.rows.map(async (row) => ({
      row,
      key: row.errors.length === 0
        ? await importRowKey({ clientName: row.clientName, ico: row.ico, title: row.title, amount: row.amount, currency: row.currency })
        : null,
    })))
    const imported = await findImportedKeys(gate.db, keyed.flatMap((k) => (k.key ? [k.key] : [])))
    const matches = keyed.map((k) => (k.row.errors.length === 0 ? matchClient({ name: k.row.clientName, ico: k.row.ico }, index) : ({ kind: 'none' } as ClientMatch)))
    const matchedIds = matches.flatMap((m) => (m.kind === 'matched' ? [m.accountId] : []))
    const deals = matchedIds.length > 0 ? await findDealsOfAccounts(gate.db, matchedIds) : []

    const rows: CsvPreviewRow[] = keyed.map((k, i) => {
      const m = matches[i]
      const same = m.kind === 'matched' ? findSameTitleDeal(deals, m.accountId, k.row.title) : null
      return {
        row: k.row, key: k.key, match: m,
        alreadyImported: k.key ? imported.has(k.key) : false,
        sameTitleDeal: same ? { id: same.id, title: same.title } : null,
      }
    })
    return { ok: true, rows, ignoredColumns: parsed.ignoredColumns, members, meId: gate.user.id }
  } catch (e) {
    if (isImportMissing(e as { code?: string })) return { ok: false, error: IMPORT_MISSING_MESSAGE }
    return { ok: false, error: dbErrorMessage('bulkImport.previewCsv', e) }
  }
}

// ---------------------------------------------------------------------------
// Potvrzení jednoho řádku (oba zdroje)

export type ConfirmRowResult =
  | {
    ok: true
    dealId: number
    accountId: number
    accountCreated: boolean
    engagementId: number | null
    records: number
    /** Stejná zakázka už v Cockpitu je (stejný soubor nebo řádek): nic se nezaložilo podruhé. */
    duplicate: boolean
    warnings: string[]
  }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

type NewAccountData = { name: string; ico: string | null; industry: string | null; region: string | null }

// Nový klient: doplnit z ARES, ale bezpečně. S IČO se ptáme podle IČO; bez něj
// jen při přesné shodě jména (cizí IČO je horší než prázdné pole, viz pickAresMatch).
async function enrichNewAccount(name: string, ico: string | null, warnings: string[]): Promise<NewAccountData> {
  const base: NewAccountData = { name, ico, industry: null, region: null }
  try {
    if (ico) {
      const c = await aresLookupByIco(ico, { timeoutMs: 6000 })
      if (!c) { warnings.push(`IČO ${ico} ARES nezná (doplň údaje ručně)`); return base }
      return { name, ico, industry: c.industry, region: aresRegionValue(c) }
    }
    const res = await aresSearch(name, { timeoutMs: 6000, count: 10 })
    const pick = pickAresMatch(name, res.candidates, res.total)
    if (pick?.how === 'přesná shoda') {
      const c = pick.company
      const same = normalizeCompanyName(c.legalName) === normalizeCompanyName(cleanCompanyName(name))
      return { name: same ? c.legalName : name, ico: c.ico, industry: c.industry, region: aresRegionValue(c) }
    }
    warnings.push('klient nenalezen v ARES jednoznačně (doplň IČO ručně)')
  } catch (e) {
    warnings.push(e instanceof AresUnavailableError ? 'ARES nedostupný (doplň IČO ručně)' : 'ARES se nepodařilo zeptat (doplň IČO ručně)')
  }
  return base
}

/**
 * Potvrzení jednoho řádku. Hodnoty z kontrolní tabulky projdou stejným schématem
 * jako všude (applyRowSchema); u PDF se návrh čte ze serveru, ne z prohlížeče.
 * Zápis dělá databáze v jedné transakci; stejný soubor či řádek podruhé nezaloží nic.
 */
export async function confirmImportRow(input: unknown): Promise<ConfirmRowResult> {
  const gate = await salesGate()
  if (!gate.ok) return gate
  const parsed = applyRowSchema.safeParse(input)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const k = String(issue.path[0] ?? '_')
      if (!fieldErrors[k]) fieldErrors[k] = issue.message
    }
    return { ok: false, error: Object.values(fieldErrors)[0] ?? 'Údaje řádku nejsou v pořádku.', fieldErrors }
  }
  const v = parsed.data
  const warnings: string[] = []

  // Zdroj: u PDF návrh ze serveru (typ příjmu, pilíř, fáze, náklady, důkaz), u CSV výchozí hodnoty.
  let revenueLine: string = v.revenue_line ?? DEFAULT_IMPORT_REVENUE_LINE
  let pillar: string | null = null
  let phase: string | null = null
  let cogs: number | null = null
  let estimateMd: number | null = null
  let expectedClose: string | null = null
  let sourcePdfPath: string | null = null
  let evidenceId: number | null = null
  const keys: string[] = []

  if (v.source === 'pdf') {
    const stored = await loadStoredProposal(gate, v.proposal_id as string)
    if (!stored) return { ok: false, error: 'Návrh z PDF nenalezen nebo je poškozený. Nahraj PDF znovu.' }
    if (stored.proposed_by !== gate.user.id) return { ok: false, error: 'Návrh z PDF patří jinému člověku.' }
    revenueLine = stored.fields.revenue_line
    pillar = stored.fields.pillar
    phase = stored.fields.phase
    cogs = stored.fields.cogs_one_time
    estimateMd = stored.fields.estimate_md
    expectedClose = stored.fields.expected_close
    const paths = offerPaths(v.proposal_id as string)
    sourcePdfPath = paths.pdf
    const evidence = await recordEvidence(gate.admin, { kind: 'file', sourceId: `nabidky:${paths.pdf}` }, `user:${gate.user.id}`)
    if (evidence.ok) evidenceId = evidence.id
    keys.push(stored.file_sha256 ? `pdf:${stored.file_sha256}` : `pdf-id:${v.proposal_id}`)
    if (stored.injection_flags.length > 0) warnings.push('dokument obsahuje text, který vypadá jako pokyny pro AI — údaje jsi ověřil(a) podle PDF')
  }
  // Tabulka: termín otevřené zakázky (nabídka, rozjednáno) je zároveň očekávané
  // uzavření; u vyhrané je termín konec dodávky a uzavřená už je.
  if (v.source !== 'pdf' && v.stage !== 'won' && v.due_on) expectedClose = v.due_on
  keys.push(await importRowKey({
    clientName: v.key_name, ico: v.key_ico ?? null, title: v.title, amount: v.amount ?? 0, currency: v.currency,
  }))

  // Kurz: bez kurzu ČNB se řádek nezapíše (nula by vypadala jako věrohodná cena).
  let fxRate: number | null = null
  if (v.currency === 'EUR') {
    try {
      fxRate = await czkPerEur()
    } catch (e) {
      logError('bulkImport.fx', e, { currency: 'EUR' })
      return { ok: false, error: 'Kurz ČNB teď není dostupný. Zkus řádek potvrdit za chvíli.' }
    }
  }

  const row: Record<string, unknown> = {
    import_keys: keys,
    title: v.title,
    revenue_line: revenueLine,
    revenue_category: revenueCategoryFor(revenueLine as Parameters<typeof revenueCategoryFor>[0]),
    pillar, phase,
    stage: IMPORT_STAGE_DEAL[v.stage],
    probability_pct: importStageProbability(v.stage),
    currency: v.currency,
    amount: v.amount ?? 0,
    fx_rate: fxRate,
    cogs,
    estimate_md: estimateMd,
    expected_close: expectedClose,
    owner_id: v.owner_id ?? gate.user.id,
    started_on: v.started_on,
    due_on: v.due_on,
    invoiced: v.invoiced,
    received: v.received,
    source_pdf_path: sourcePdfPath,
    evidence_id: evidenceId,
  }
  if (v.account.mode === 'existing') {
    row.account_id = v.account.id
  } else {
    const ico = v.account.ico ? v.account.ico.replace(/\s/g, '') : null
    row.new_account = await enrichNewAccount(v.account.name, ico, warnings)
  }

  const { data, error } = await gate.admin.rpc('import_apply_row', { p_actor: gate.user.id, p_batch_id: v.batch_id, p_row: row })
  if (error) return { ok: false, error: importDbMessage(error) ?? dbErrorMessage('bulkImport.apply', error) }
  const r = data as { status?: string; deal_id?: number; account_id?: number; account_created?: boolean; engagement_id?: number | null; records?: number } | null
  if (!r || typeof r.deal_id !== 'number' || typeof r.account_id !== 'number') {
    return { ok: false, error: 'Databáze vrátila neočekávanou odpověď. Zkontroluj, jestli zakázka vznikla.' }
  }

  revalidatePath('/cockpit')
  revalidatePath('/cockpit/clients')
  revalidatePath('/cockpit/pipeline')
  revalidatePath('/cockpit/finance')
  return {
    ok: true,
    dealId: r.deal_id,
    accountId: r.account_id,
    accountCreated: r.account_created === true,
    engagementId: typeof r.engagement_id === 'number' ? r.engagement_id : null,
    records: r.records ?? 0,
    duplicate: r.status === 'duplicate',
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Vrácení dávky

export type RevertBatchResult = { ok: true; result: RevertResult; message: string } | { ok: false; error: string }

/**
 * „Vrátit import“: smaže jen záznamy vytvořené danou dávkou a jen tam, kde od
 * importu nevznikla lidská práce (rozhoduje databázová funkce import_revert_batch).
 */
export async function revertImportBatch(batchId: unknown): Promise<RevertBatchResult> {
  const gate = await salesGate()
  if (!gate.ok) return gate
  const id = typeof batchId === 'number' && Number.isInteger(batchId) && batchId > 0 ? batchId : null
  if (id === null) return { ok: false, error: 'Neplatná dávka.' }
  const { data, error } = await gate.admin.rpc('import_revert_batch', { p_actor: gate.user.id, p_batch_id: id })
  if (error) return { ok: false, error: importDbMessage(error) ?? dbErrorMessage('bulkImport.revert', error) }
  const result = parseRevertResult(data)
  if (!result) return { ok: false, error: 'Databáze vrátila neočekávanou odpověď. Zkontroluj stav dávky.' }
  revalidatePath('/cockpit')
  revalidatePath('/cockpit/clients')
  revalidatePath('/cockpit/pipeline')
  revalidatePath('/cockpit/finance')
  revalidatePath('/cockpit/import/zakazky')
  return { ok: true, result, message: describeRevert(result) }
}
