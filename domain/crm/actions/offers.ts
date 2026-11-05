'use server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { logError, logWarn } from '@/lib/log'
import { OFFER_PDF_TIMEOUT_MS, extractOfferFromPdf } from '@/connectors/anthropic'
import { takeAiPdfQuota } from '@/domain/crm/aiQuota'
import { sanitizeExtraction, type SanitizedOfferFields } from '@/domain/crm/offer-extract'
import { categoryForLine } from '@/lib/validation/schemas'
import { czkPerEur } from '@/connectors/cnb'
import { pragueToday } from '@/lib/pragueDate'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { recordAuditWithEvidence, recordEvidence } from '@/core/evidence'
import { detectInjectionMarkers, injectionAuditMeta, mergeInjectionFlags, type InjectionFlag } from '@/core/untrusted'
import { isScopeVersionMissing, versionFromOffer } from '@/domain/crm/scopeVersion'
import type { EvidenceRef } from '@/core/informationState'
import { OFFER_ACCOUNT_ERRORS, findAccountByName, resolveNewOfferAccount, type OfferAccountHint } from '@/domain/crm/offerAccount'
import { dbErrorMessage } from '@/lib/actionResult'
import { CONNECTOR_SOURCE } from '@/domain/crm/connectorProposals'
import {
  OFFER_BUCKET,
  OFFER_FIELD_KEYS,
  OFFER_UPLOAD_MAX_BYTES,
  SERVER_ACTION_BODY_LIMIT_BYTES,
  buildStoredProposal,
  changedOfferFields,
  derivedOfferStage,
  mailOfferPath,
  offerConfirmSchema,
  offerPaths,
  parseStoredProposal,
  toConfirmedFields,
  type StoredOfferProposal,
} from '@/domain/crm/offerProposal'

// Import nabídky z PDF ve dvou krocích (proč: domain/crm/offerProposal.ts):
//   1. proposeOffersFromPdfs — model PDF přečte a vznikne NÁVRH AI; nic se
//      nezakládá, návrh se jen uloží vedle PDF a ukáže ke kontrole.
//   2. confirmOfferProposal — člověk návrh zkontroluje/opraví a potvrdí;
//      teprve tady vzniká klient a obchod (s auditem human_confirmed a
//      verzí nabídky 0072, viz createOfferVersion níže).

// Strop velikosti = strop těla Server Action (4 MB, next.config.ts) pro
// VŠECHNA PDF jednoho odeslání dohromady; dřív tu bylo 15 MB, které se k akci
// nikdy nedostalo (Next tělo nad 4 MB odmítne dřív).
const MAX_PDF_BYTES = OFFER_UPLOAD_MAX_BYTES
const MAX_PDF_MB = Math.floor(SERVER_ACTION_BODY_LIMIT_BYTES / 1024 / 1024)
// Jedno volání zpracuje nejvýš tolik souborů: každý jde k Anthropicu (kredity)
// a do bucketu, takže strop chrání před spálením kreditů jedním formulářem.
// Denní strop na člověka hlídá takeAiPdfQuota (domain/crm/aiQuota.ts).
const MAX_PDF_FILES = 5
// Stránka /nabidka/import má maxDuration 60 s; soubory se čtou souběžně
// a každé volání modelu skončí nejpozději tolik před koncem minuty, ať
// zbyde čas na uložení PDF a návrhu.
const PROPOSE_BUDGET_MS = 55_000
const STORE_RESERVE_MS = 5_000

// Typ souboru z prohlížeče (`file.type`) si volající určuje sám; skutečné PDF
// začíná značkou %PDF- (norma dovoluje její výskyt v prvním kilobajtu).
function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes('%PDF-')
}
const SALES_ONLY_ERROR = 'Nahrát nabídku může jen člen s přístupem k obchodu.'

type Admin = ReturnType<typeof createAdminClient>

export type OfferProposalView = {
  proposalId: string
  /** Název PDF (u návrhu z e-mailu název přílohy); jen k zobrazení. */
  fileName?: string
  fields: SanitizedOfferFields
  warnings: string[]
  flags: InjectionFlag[]
  account: OfferAccountHint
}

export type ProposedOfferResult =
  | { fileName: string; success: true; proposal: OfferProposalView }
  | { fileName: string; success: false; error: string }

// Verze 1 nabídky (0072) = to, co klient v PDF dostal: stav „odesláno",
// částky v měně nabídky (ne přepočet), zdroj = PDF v bucketu nabidky přes
// evidence (u nabídky z e-mailu odkaz na zprávu). Best-effort: obchod už existuje, takže výpadek (nebo nenasazená
// migrace) jen přidá varování, import neshodí.
async function createOfferVersion(
  admin: Admin,
  dealId: number,
  source: EvidenceRef,
  fields: { title: string; amount_one_time: number | null; currency: 'CZK' | 'EUR' },
  userId: string,
  warnings: string[],
): Promise<void> {
  const evidence = await recordEvidence(admin, source, `user:${userId}`)
  const { error } = await admin.from('deal_scope_version').insert({
    deal_id: dealId,
    ...versionFromOffer(fields),
    evidence_id: evidence.ok ? evidence.id : null,
    created_by: userId,
  })
  if (isScopeVersionMissing(error)) return
  if (error) {
    logError('offers.scope_version', error, { dealId })
    warnings.push('verzi nabídky se nepodařilo založit (založ ji ručně v detailu obchodu)')
  }
}

export type ProposeOffersState = { results: ProposedOfferResult[] } | null

export type ConfirmOfferState =
  | { ok: true; dealId: number; accountId: number; title: string; warnings: string[]; alreadyImported?: boolean }
  | { ok: false; error?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> }
  | null

async function proposeOne(file: File, admin: Admin, userId: string, deadlineAt: number): Promise<ProposedOfferResult> {
  if (file.type !== 'application/pdf') {
    return { fileName: file.name, success: false, error: 'Není PDF.' }
  }
  if (file.size > MAX_PDF_BYTES) {
    return { fileName: file.name, success: false, error: `Soubor je moc velký (nejvýš ${MAX_PDF_MB} MB).` }
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  if (!looksLikePdf(buffer)) {
    return { fileName: file.name, success: false, error: 'Není PDF (soubor nezačíná značkou PDF).' }
  }

  // Denní strop volání modelu na člověka (zápis do audit_event PŘED voláním).
  const quota = await takeAiPdfQuota(admin, userId, 'offer_import')
  if (!quota.ok) return { fileName: file.name, success: false, error: quota.error }

  let raw
  try {
    raw = await extractOfferFromPdf(buffer.toString('base64'), {
      timeoutMs: Math.min(OFFER_PDF_TIMEOUT_MS, deadlineAt - Date.now() - STORE_RESERVE_MS),
    })
  } catch (e) {
    logError('offers.extract', e)
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return {
      fileName: file.name,
      success: false,
      error: timedOut
        ? 'Čtení nabídky trvalo moc dlouho. Zkus ji nahrát znovu, samostatně.'
        : 'Nabídku se nepodařilo přečíst. Zkus to prosím znovu.',
    }
  }

  let extraction
  try {
    extraction = sanitizeExtraction(raw)
  } catch (e) {
    return { fileName: file.name, success: false, error: `Nabídka neobsahuje jméno klienta: ${(e as Error).message}` }
  }
  const { fields, warnings, flags } = extraction

  const proposalId = crypto.randomUUID()
  const paths = offerPaths(proposalId)
  const bucket = admin.storage.from(OFFER_BUCKET)
  const { error: uploadError } = await bucket.upload(paths.pdf, buffer, { contentType: 'application/pdf' })
  if (uploadError) {
    logError('offers.upload', uploadError)
    return { fileName: file.name, success: false, error: 'PDF se nepodařilo uložit. Zkus to prosím znovu.' }
  }

  // Návrh AI se ukládá na server (vedle PDF), ne do prohlížeče: potvrzení
  // si ho načte odsud, takže příznaky ani „co navrhla AI" nejde podvrhnout.
  const stored = buildStoredProposal({ proposalId, fileName: file.name, fields, warnings, flags, now: new Date() })
  const { error: proposalError } = await bucket.upload(
    paths.proposal,
    Buffer.from(JSON.stringify(stored), 'utf8'),
    { contentType: 'application/json' },
  )
  if (proposalError) {
    await bucket.remove([paths.pdf]).catch(() => undefined)
    logError('offers.uploadProposal', proposalError)
    return { fileName: file.name, success: false, error: 'Návrh se nepodařilo uložit. Zkus to prosím znovu.' }
  }

  if (flags.length > 0) {
    // Jen názvy příznaků a id návrhu — nikdy text z dokumentu.
    logWarn('offers.injection_markers', 'návrh AI z PDF nese příznaky možných pokynů pro AI', { flags, proposal: proposalId })
  }

  const lookup = await findAccountByName(admin, fields.account_name)
  const account: OfferAccountHint = lookup.kind === 'error' ? { kind: 'unknown' } : lookup

  return { fileName: file.name, success: true, proposal: { proposalId, fields, warnings, flags, account } }
}

/** Krok 1: PDF → návrh AI ke kontrole. Nic nezakládá. */
export async function proposeOffersFromPdfs(_prev: unknown, formData: FormData): Promise<ProposeOffersState> {
  const startedAt = Date.now()
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { results: [{ fileName: '', success: false, error: AUTH_ERROR_MESSAGE }] }
  // Import pracuje s částkami přes service role (RLS obchází), proto
  // obchodní roli (0058, rozhodnutí majitele 2026-09-28) hlídáme tady.
  if (!memberSeesSales((await getCurrentMember()).member)) {
    return { results: [{ fileName: '', success: false, error: SALES_ONLY_ERROR }] }
  }

  const files = formData.getAll('pdf').filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0) return { results: [{ fileName: '', success: false, error: 'Nahraj prosím aspoň jedno PDF.' }] }
  if (files.length > MAX_PDF_FILES) {
    return { results: [{ fileName: '', success: false, error: `Naráz jde nahrát nejvýš ${MAX_PDF_FILES} PDF. Nahraj zbytek zvlášť.` }] }
  }
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_PDF_BYTES) {
    return { results: [{ fileName: '', success: false, error: `Soubory mají dohromady víc než ${MAX_PDF_MB} MB. Nahraj je po menších skupinách.` }] }
  }

  // Krok 1 zatím nic nezakládá v DB (jen storage), ale servisní klient nese
  // aktéra i tady, ať to platí jednotně pro celý soubor (test níže to hlídá).
  const admin = createAuditedAdminClient({ actor: { type: 'user', id: user.id } })
  // Souběžně: pět PDF po sobě by se do minuty funkce nevešlo.
  const deadlineAt = startedAt + PROPOSE_BUDGET_MS
  const results = await Promise.all(files.map((file) => proposeOne(file, admin, user.id, deadlineAt)))
  return { results }
}

function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['proposal_id', ...OFFER_FIELD_KEYS]) {
    const v = formData.get(key)
    out[key] = typeof v === 'string' ? v : ''
  }
  return out
}

type ExistingDeal = { id: number; account_id: number; title: string }

async function findDealByPdf(admin: Admin, pdfPath: string): Promise<{ deal: ExistingDeal | null; error: string | null }> {
  const { data, error } = await admin
    .from('deal')
    .select('id, account_id, title')
    .eq('source_pdf_path', pdfPath)
    .order('id', { ascending: true })
    .limit(1)
  if (error) return { deal: null, error: error.message }
  return { deal: ((data ?? [])[0] as ExistingDeal | undefined) ?? null, error: null }
}

async function loadStoredProposal(admin: Admin, proposalId: string): Promise<StoredOfferProposal | null> {
  try {
    const { data, error } = await admin.storage.from(OFFER_BUCKET).download(offerPaths(proposalId).proposal)
    if (error || !data) return null
    return parseStoredProposal(JSON.parse(await data.text()), proposalId)
  } catch {
    return null
  }
}

/** Návrh zakázky z přílohy e-mailu: čeká ve frontě „Pošta k zařazení" (mail_content_intake, 0099). */
type MailOrigin = { rowId: number; evidence: EvidenceRef }

async function loadMailDraft(
  admin: Admin,
  proposalId: string,
): Promise<{ stored: StoredOfferProposal; origin: MailOrigin } | null | 'error'> {
  const { data, error } = await admin
    .from('mail_content_intake')
    .select('id, status, offer_draft, evidence_id')
    .eq('offer_proposal_id', proposalId)
    // Návrh z konektoru se potvrzuje jen na /rozhodnuti (vedení, kontakt, další krok).
    .neq('source', CONNECTOR_SOURCE)
    .limit(1)
  // Bez migrace 0099 (sloupec) ani 0091 (tabulka) žádný návrh z e-mailu není.
  if (error) return isMissingMailIntake(error) ? null : 'error'
  const row = ((data ?? [])[0] ?? null) as { id: number; status: string; offer_draft: unknown; evidence_id: number } | null
  if (!row || row.status !== 'queued' || row.offer_draft == null) return null
  const stored = parseStoredProposal(row.offer_draft, proposalId)
  if (!stored) return null
  const ev = await admin.from('evidence').select('source_kind, source_id, web_link').eq('id', row.evidence_id).maybeSingle()
  const e = ev.data as { source_kind: string; source_id: string; web_link: string | null } | null
  if (!e || e.source_kind !== 'email_message') return null
  return { stored, origin: { rowId: row.id, evidence: { kind: 'email_message', sourceId: e.source_id, webLink: e.web_link } } }
}

function isMissingMailIntake(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === '42P01' || error.code === '42703' || error.code === 'PGRST205' || error.code === 'PGRST204'
    || /does not exist|could not find/i.test(error.message ?? '')
}

/**
 * Po založení obchodu z návrhu z e-mailu uzavře řádek fronty: stav „vyřízeno",
 * klient a obchod, návrh (klient, cena) z řádku zmizí (žije už jen v obchodu).
 * Best-effort: když se nepovede, obchod stojí a další potvrzení skončí jako
 * „už založeno" a uzavření zopakuje.
 */
async function closeMailQueueRow(admin: Admin, proposalId: string, accountId: number, dealId: number, userId: string): Promise<void> {
  const { error } = await admin
    .from('mail_content_intake')
    .update({
      status: 'proposed',
      wait_reason: null,
      offer_draft: null,
      account_id: accountId,
      deal_id: dealId,
      match_method: 'manual',
      decided_by: `user:${userId}`,
      decided_at: new Date().toISOString(),
    })
    .eq('offer_proposal_id', proposalId)
    .eq('status', 'queued')
  if (error) logError('offers.mailRow', 'uzavření řádku fronty selhalo', { code: error.code ?? 'unknown' })
}

/**
 * Krok 2: člověk potvrdil (a případně opravil) návrh AI. Teprve tady vzniká
 * klient a obchod. Hodnoty z formuláře projdou stejným schématem jako
 * návrh; návrh samotný se čte ze storage, ne z prohlížeče.
 */
export async function confirmOfferProposal(_prev: unknown, formData: FormData): Promise<ConfirmOfferState> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false, error: AUTH_ERROR_MESSAGE }
  if (!memberSeesSales((await getCurrentMember()).member)) return { ok: false, error: SALES_ONLY_ERROR }

  const values = formValues(formData)
  const parsed = offerConfirmSchema.safeParse(values)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '_')
      if (!fieldErrors[key]) fieldErrors[key] = issue.message
    }
    return { ok: false, fieldErrors, values }
  }
  const proposalId = parsed.data.proposal_id
  const confirmed = toConfirmedFields(parsed.data)
  const paths = offerPaths(proposalId)
  // Servisní klient s aktérem: založeného klienta i obchod připíše DB audit
  // trigger (0064) přihlášenému člověku (aktér db-trigger jinak — viz
  // docs/PROVOZ.md).
  const admin = createAuditedAdminClient({ actor: { type: 'user', id: user.id } })

  // Návrh je buď z ručního importu (JSON vedle PDF ve storage), nebo z přílohy
  // e-mailu (řádek fronty, PDF se neukládá). Klient ani cena se v obou případech
  // nevezmou z prohlížeče.
  let stored = await loadStoredProposal(admin, proposalId)
  let mail: MailOrigin | null = null
  if (!stored) {
    const draft = await loadMailDraft(admin, proposalId)
    if (draft === 'error') return { ok: false, error: 'Návrh z e-mailu se nepodařilo načíst. Zkus to prosím znovu.', values }
    if (draft) {
      stored = draft.stored
      mail = draft.origin
    }
  }
  if (!stored) {
    // Návrh z e-mailu po potvrzení z řádku zmizí; druhé potvrzení (dvojklik) pak
    // najde už založený obchod podle odvozené cesty.
    const done = await findDealByPdf(admin, mailOfferPath(proposalId))
    if (done.deal) {
      return {
        ok: true, dealId: done.deal.id, accountId: done.deal.account_id, title: done.deal.title,
        warnings: [], alreadyImported: true,
      }
    }
    return { ok: false, error: 'Návrh nenalezen nebo je poškozený — nahraj PDF znovu.', values }
  }
  // Cesta, pod kterou obchod drží nabídku (jedna nabídka = jeden obchod, 0070):
  // u e-mailu virtuální (PDF se neukládá), jinak skutečné PDF v bucketu.
  const sourcePath = stored.pdf_path

  // Idempotence: stejný návrh potvrzený dvakrát (dvojklik, druhá záložka)
  // nesmí založit druhý obchod.
  // Tady jen rychlá cesta; skutečnou pojistku proti souběhu dělá unikátní
  // index 0070 (viz ošetření 23505 u insertu níž). limit(1) místo
  // maybeSingle, ať případné starší duplicity kontrolu nerozbijí.
  const existing = await findDealByPdf(admin, sourcePath)
  if (existing.error) {
    logError('offers.findDeal', new Error(existing.error))
    return { ok: false, error: 'Nepodařilo se ověřit, jestli už obchod z této nabídky existuje. Zkus to prosím znovu.', values }
  }
  const existingDeal = existing.deal
  if (existingDeal) {
    if (mail) await closeMailQueueRow(admin, proposalId, existingDeal.account_id, existingDeal.id, user.id)
    return {
      ok: true, dealId: existingDeal.id, accountId: existingDeal.account_id, title: existingDeal.title,
      warnings: [], alreadyImported: true,
    }
  }

  const warnings: string[] = []
  const match = await findAccountByName(admin, confirmed.account_name)
  if (match.kind === 'error') {
    logError('offers.findAccount', new Error(match.message))
    return { ok: false, error: OFFER_ACCOUNT_ERRORS.lookup, values }
  }
  if (match.kind === 'ambiguous') {
    return {
      ok: false,
      fieldErrors: { account_name: 'V Cockpitu je víc klientů s tímto názvem — upřesni název, nebo založ obchod ručně u správného klienta.' },
      values,
    }
  }

  let accountId = match.kind === 'existing' ? match.id : undefined
  let createdAccountId: number | null = null
  if (!accountId) {
    // Nový klient — IČO, obor a sídlo z ARES jen při přesné shodě jména;
    // když to IČO už v Cockpitu je, obchod se naváže na existujícího klienta
    // (domain/crm/offerAccount.ts). Bez shody se založí s potvrzeným jménem.
    const resolved = await resolveNewOfferAccount(admin, confirmed.account_name, warnings)
    if (resolved.kind === 'error') return { ok: false, error: resolved.error, values }
    accountId = resolved.id
    if (resolved.kind === 'created') createdAccountId = resolved.id
  }

  // amount_one_time je v DB vždy v Kč — když nabídka byla v EUR, přepočítej
  // živým kurzem ČNB (stejná logika jako u ručního formuláře v deals.ts),
  // nikdy nedůvěřuj kurzu vytištěnému v samotném PDF.
  let amount_one_time = confirmed.amount_one_time
  let cogs_one_time = confirmed.cogs_one_time
  let amount_one_time_original: number | null = null
  let fx_rate: number | null = null
  let rateFailed = false
  if (confirmed.currency === 'EUR') {
    try {
      fx_rate = await czkPerEur()
      amount_one_time_original = confirmed.amount_one_time
      amount_one_time = confirmed.amount_one_time != null ? Math.round(confirmed.amount_one_time * fx_rate) : null
      cogs_one_time = confirmed.cogs_one_time != null ? Math.round(confirmed.cogs_one_time * fx_rate) : null
    } catch (e) {
      // Nesmí se stát, že v korunovém sloupci skončí eurová částka: 70 000
      // vypadá jako věrohodná cena, takže by se ta chyba nikdy neodhalila
      // a tiše by tekla do pipeline, marží i do API. Nula je taky špatně,
      // ale je špatně VIDITELNĚ — obchod za 0 Kč každý najde. Původní
      // částka zůstává v amount_one_time_original, takže se nic neztratí.
      logError('offers.fx', e, { currency: 'EUR' })
      amount_one_time_original = confirmed.amount_one_time
      amount_one_time = 0
      cogs_one_time = 0
      fx_rate = null
      warnings.push(
        'kurz ČNB nedostupný — částka uložena jako 0 Kč, aby nezkreslila součty.'
        + ` Původní hodnota ${confirmed.amount_one_time ?? '?'} EUR je v poli „původní částka“; doplň kurz ručně.`,
      )
      rateFailed = true
    }
  }

  const stage = derivedOfferStage(confirmed.pillar, confirmed.phase)
  // Nabídka ve „vyhrané" fázi zakládá obchod rovnou jako vyhraný — stejně
  // jako updateDeal/createDeal v deals.ts: won_at + closed_at (pražský den)
  // a forecast_category 'closed'. Formulář návrhu to člověku předem ukáže.
  const won = stage === 'vyhráno'
  const today = pragueToday()
  const { data: deal, error: dealError } = await admin
    .from('deal')
    .insert({
      account_id: accountId,
      title: confirmed.title,
      revenue_line: confirmed.revenue_line,
      revenue_category: categoryForLine[confirmed.revenue_line],
      stage,
      ...(won ? { won_at: today, closed_at: today, forecast_category: 'closed' } : {}),
      pillar: confirmed.pillar,
      phase: confirmed.phase,
      currency: confirmed.currency,
      amount_one_time: amount_one_time ?? 0,
      note: rateFailed
        ? `POZOR: kurz ČNB nebyl při importu dostupný. Částka ${amount_one_time_original} EUR nebyla přepočtena — doplň ji ručně.`
        : null,
      amount_one_time_original,
      fx_rate,
      cogs_one_time: cogs_one_time ?? 0,
      estimate_md: confirmed.estimate_md,
      expected_close: confirmed.expected_close,
      subsidy_program: 'none',
      subsidy_pct: 0,
      source_pdf_path: sourcePath,
    })
    .select('id')
    .single()
  if (dealError) {
    // Nový klient bez obchodu by zůstal jako sirotek a příští párování
    // jmen by ho bralo jako existujícího — ukliď ho (best-effort).
    if (createdAccountId != null) {
      const { error: cleanupError } = await admin.from('account').delete().eq('id', createdAccountId)
      if (cleanupError) logError('offers.orphanAccount', cleanupError, { accountId: createdAccountId })
    }
    // 23505 = souběžné potvrzení stejného návrhu vyhrálo závod (index 0070).
    if (dealError.code === '23505') {
      const winner = await findDealByPdf(admin, sourcePath)
      if (winner.deal) {
        if (mail) await closeMailQueueRow(admin, proposalId, winner.deal.account_id, winner.deal.id, user.id)
        return {
          ok: true, dealId: winner.deal.id, accountId: winner.deal.account_id, title: winner.deal.title,
          warnings: [], alreadyImported: true,
        }
      }
    }
    return { ok: false, error: `Projekt se nepodařilo založit. ${dbErrorMessage('offers.deal', dealError)}`, values }
  }

  // Původ: obchod stojí na PDF (evidence 'file') a na potvrzení člověkem.
  // Do auditu jen neosobní metadata: která pole člověk oproti návrhu AI
  // změnil a příznaky možné injection — žádný text z dokumentu.
  // sourceId není text od uživatele (pravidlo core/evidence.ts): je to cesta
  // odvozená z UUID návrhu, který server sám uložil a výš úspěšně načetl.
  const flags = mergeInjectionFlags(
    stored.injection_flags,
    detectInjectionMarkers(`${confirmed.account_name}\n${confirmed.title}`),
  )
  try {
    await recordAuditWithEvidence(
      admin,
      mail ? mail.evidence : { kind: 'file', sourceId: `${OFFER_BUCKET}/${paths.pdf}`, webLink: null },
      'human_confirmed',
      {
        entityTable: 'deal',
        entityId: deal.id as number,
        action: 'deal.offer_confirmed',
        before: null,
        after: {
          source: mail ? 'mail_offer_attachment' : 'offer_import',
          proposal_id: proposalId,
          proposal_info_state: stored.info_state,
          changed_fields: changedOfferFields(stored.fields, confirmed),
          stage,
          currency: confirmed.currency,
          ...injectionAuditMeta(flags),
        },
        actor: { type: 'user', id: user.id },
      },
    )
  } catch (e) {
    // recordAuditWithEvidence nevyhazuje; pojistka, aby obchod nikdy nespadl.
    logError('offers.audit', e, { deal: deal.id })
  }

  await createOfferVersion(
    admin, deal.id as number,
    mail ? mail.evidence : { kind: 'file', sourceId: `nabidky:${paths.pdf}` },
    confirmed, user.id, warnings,
  )
  // Nabídka z e-mailu: řádek fronty se uzavře (návrh z něj zmizí). Stránku Případy
  // záměrně nepřekreslujeme, ať člověk vidí, co vzniklo, a odkaz na klienta.
  if (mail) await closeMailQueueRow(admin, proposalId, accountId, deal.id as number, user.id)

  revalidatePath('/cockpit')
  revalidatePath('/cockpit/clients')
  return { ok: true, dealId: deal.id as number, accountId, title: confirmed.title, warnings }
}
