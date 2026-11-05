// Nabídka z přílohy e-mailu — I/O kolem čisté logiky (domain/crm/mailOffer.ts).
// Volá ji processContentMessage (domain/crm/mailContentService.ts) pro zprávu
// ze složky „Cockpit" (ne pro nic jiného), za MAIL_OFFER_ATTACHMENT_ENABLED.
//
// Tok pro jednu zprávu:
//   1. seznam příloh (jen metadata) → vybere se PDF, které vypadá jako nabídka
//      (název souboru / předmět); jiný typ přílohy se ignoruje a nestahuje,
//   2. stažení PDF do paměti (limit velikosti), kontrola hlavičky a počtu stran,
//   3. otisk PDF: stejná nabídka už čeká nebo je založená → přeskočit,
//   4. model přečte PDF stejným krokem jako ruční import (extractOfferFromPdf:
//      ohraničený blok, preambule, nástroj s pevným schématem),
//   5. výstup se vyčistí zod schématem; při jakékoli známce pokynů pro AI se zahodí,
//   6. výsledek je NÁVRH ZAKÁZKY (StoredOfferProposal) s id z (Message-ID, id přílohy).
//
// SOUKROMÍ: PDF žije jen v proměnných tohoto volání. Do logu jde jen kód důvodu
// (nikdy název souboru, text PDF ani odpověď modelu), do statistik jen počty.
//
// Nedostatek času nebo kapacity běhu NENÍ chyba zprávy: vyhodí se MailOfferDefer
// a zpráva (ještě bez řádku fronty) se zpracuje až v dalším běhu. Přechodné
// selhání modelu nebo sítě zprávu neodkládá (jeden vadný soubor by zastavil
// celou složku): zpráva projde běžnou cestou jako „přílohy" a nabídku jde
// nahrát ručně.
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  downloadMessageAttachment,
  listMessageAttachments,
  type AttachmentDownload,
  type AttachmentList,
} from '@/connectors/graph'
import { AnthropicApiError, extractOfferFromPdf, type RawExtraction } from '@/connectors/anthropic'
import { logWarn } from '@/lib/log'
import { cleanAttachmentNames } from '@/domain/crm/mailContent'
import {
  MAIL_OFFER_MAX_BYTES,
  MAIL_OFFER_MAX_PER_RUN,
  MAIL_OFFER_MIN_REMAINING_MS,
  MAIL_OFFER_MODEL_TIMEOUT_MS,
  interpretOfferExtraction,
  mailOfferProposalId,
  pickOfferAttachment,
  sha256Hex,
  validatePdfBytes,
} from '@/domain/crm/mailOffer'
import { buildMailOfferDraft, type StoredOfferProposal } from '@/domain/crm/offerProposal'

export type OfferSkipReason =
  | 'no_pdf'
  | 'not_offer'
  | 'too_large'
  | 'not_pdf'
  | 'too_many_pages'
  | 'encrypted'
  | 'duplicate_pdf'
  | 'flagged'
  | 'invalid'
  | 'model_failed'
  | 'model_unavailable'
  | 'download_failed'
  | 'forbidden'

export type OfferAttempt =
  | { kind: 'none'; reason: OfferSkipReason }
  | { kind: 'draft'; proposalId: string; draft: StoredOfferProposal; pdfSha256: string }

/** Zpráva se má zpracovat až v dalším běhu (čas, kapacita, Graph žádá počkat). */
export class MailOfferDefer extends Error {
  constructor(readonly why: 'capacity' | 'time' | 'throttled') {
    super(`nabídka z přílohy odložena: ${why}`)
    this.name = 'MailOfferDefer'
  }
}

export type MailOfferDeps = {
  listAttachments(graphId: string): Promise<AttachmentList>
  download(graphId: string, attachmentId: string): Promise<AttachmentDownload>
  extract(pdfBase64: string, timeoutMs: number): Promise<RawExtraction>
  /** Stejné PDF už čeká ve frontě nebo je založené. */
  isKnownPdf(sha256: string): Promise<boolean>
  /** Kolik ms zbývá v rozpočtu běhu. */
  remainingMs(): number
  now(): Date
  /** Další slova z MAIL_OFFER_ATTACHMENT_KEYWORDS. */
  keywords: RegExp | null
}

export type MailOfferContext = {
  deps: MailOfferDeps
  state: { extractions: number; disabled: boolean }
}

export type MailOfferStats = {
  /** Kolik PDF se poslalo modelu. */
  read: number
  drafts: number
  deferred: number
  skipped: Partial<Record<OfferSkipReason, number>>
}

export const emptyOfferStats = (): MailOfferStats => ({ read: 0, drafts: 0, deferred: 0, skipped: {} })

export function createMailOfferContext(deps: MailOfferDeps): MailOfferContext {
  return { deps, state: { extractions: 0, disabled: false } }
}

const none = (reason: OfferSkipReason): OfferAttempt => ({ kind: 'none', reason })

function isTransientModelError(e: unknown): boolean {
  if (e instanceof AnthropicApiError) return e.status === 429 || e.status === 408 || e.status >= 500
  // Časový limit a výpadek sítě (fetch) nejsou chyba dokumentu.
  return true
}

export async function attemptOfferDraft(
  ctx: MailOfferContext,
  msg: { graphId: string; internetMessageId: string; subject: string; hasAttachments: boolean },
): Promise<OfferAttempt> {
  const { deps, state } = ctx
  if (!msg.hasAttachments || !msg.graphId) return none('no_pdf')
  if (state.disabled) return none('forbidden')

  const list = await deps.listAttachments(msg.graphId)
  if (!list.ok) {
    if (list.reason === 'forbidden') {
      state.disabled = true
      logWarn('mailOffer', 'Graph odmítl přílohy (chybí oprávnění Mail.Read)')
      return none('forbidden')
    }
    if (list.reason === 'throttled') throw new MailOfferDefer('throttled')
    return none('download_failed')
  }

  const pick = pickOfferAttachment(list.items, msg.subject, deps.keywords)
  if (pick.kind === 'none') return none(pick.reason)
  const attachment = pick.attachment

  // Kapacita běhu: model je pomalý a denní cron má omezený čas.
  if (state.extractions >= MAIL_OFFER_MAX_PER_RUN) throw new MailOfferDefer('capacity')
  if (deps.remainingMs() < MAIL_OFFER_MIN_REMAINING_MS) throw new MailOfferDefer('time')

  const file = await deps.download(msg.graphId, attachment.id)
  if (!file.ok) {
    if (file.reason === 'too_large') return none('too_large')
    if (file.reason === 'forbidden') {
      state.disabled = true
      logWarn('mailOffer', 'Graph odmítl stažení přílohy (chybí oprávnění Mail.Read)')
      return none('forbidden')
    }
    if (file.reason === 'throttled') throw new MailOfferDefer('throttled')
    return none('download_failed')
  }
  const check = validatePdfBytes(file.bytes)
  if (!check.ok) return none(check.reason)

  const sha = sha256Hex(file.bytes)
  if (await deps.isKnownPdf(sha)) return none('duplicate_pdf')

  state.extractions++
  let raw: RawExtraction
  try {
    const timeoutMs = Math.max(5_000, Math.min(MAIL_OFFER_MODEL_TIMEOUT_MS, deps.remainingMs() - 2_000))
    raw = await deps.extract(Buffer.from(file.bytes).toString('base64'), timeoutMs)
  } catch (e) {
    const transient = isTransientModelError(e)
    // Jen druh chyby (a stav HTTP): zpráva výjimky může citovat kus dokumentu.
    logWarn('mailOffer', 'model nepřečetl nabídku', {
      kind: transient ? 'unavailable' : 'rejected',
      status: e instanceof AnthropicApiError ? e.status : undefined,
    })
    return none(transient ? 'model_unavailable' : 'model_failed')
  }

  const result = interpretOfferExtraction(raw)
  if (!result.ok) {
    if (result.reason === 'flagged') {
      // Jen názvy příznaků, nikdy text z dokumentu.
      logWarn('mailOffer', 'PDF nese známky pokynů pro AI, návrh se nevytvořil', { flags: result.flags })
    }
    return none(result.reason)
  }

  const proposalId = mailOfferProposalId(msg.internetMessageId, attachment.id)
  const draft = buildMailOfferDraft({
    proposalId,
    fileName: cleanAttachmentNames([attachment.name])[0] ?? 'nabidka.pdf',
    fields: result.fields,
    warnings: result.warnings,
    now: deps.now(),
  })
  return { kind: 'draft', proposalId, draft, pdfSha256: sha }
}

// ---------------------------------------------------------------------------
// Napojení na skutečný Graph, model a databázi

type Db = Pick<SupabaseClient, 'from'>

export function createLiveOfferDeps(args: {
  accessToken: string
  admin: Db
  remainingMs: () => number
  now: () => Date
  keywords: RegExp | null
}): MailOfferDeps {
  return {
    listAttachments: (id) => listMessageAttachments(args.accessToken, id),
    download: (id, att) => downloadMessageAttachment(args.accessToken, id, att, MAIL_OFFER_MAX_BYTES),
    extract: (b64, timeoutMs) => extractOfferFromPdf(b64, { timeoutMs }),
    isKnownPdf: async (sha) => {
      const { data, error } = await args.admin
        .from('mail_content_intake')
        .select('id')
        .eq('offer_pdf_sha256', sha)
        .in('status', ['queued', 'proposed'])
        .limit(1)
      return !error && (data ?? []).length > 0
    },
    remainingMs: args.remainingMs,
    now: args.now,
    keywords: args.keywords,
  }
}

/** Existují sloupce z migrace 0099? Bez nich se nabídky z příloh nečtou (zpráva projde běžnou cestou). */
export async function offerColumnsAvailable(admin: Db): Promise<boolean> {
  const { error } = await admin.from('mail_content_intake').select('offer_proposal_id').limit(1)
  return !error
}
