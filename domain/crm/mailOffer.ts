// Nabídka z přílohy e-mailu (MAIL_OFFER_ATTACHMENT_ENABLED) — čistá logika, bez I/O.
// Zápis do databáze, Graph a model řeší domain/crm/mailOfferService.ts.
//
// Cíl: nová zakázka včetně ceny vstoupí do Cockpitu z e-mailu bez ruční práce.
// Zpráva ve složce „Cockpit" má PDF přílohu, která vypadá jako nabídka →
// Cockpit ji stáhne, přečte stejným krokem jako ruční import (PDF → návrh AI:
// klient, název, cena, měna, rozsah) a výsledek zařadí do fronty „Pošta
// k zařazení" jako NÁVRH ZAKÁZKY. Nic se nezaloží samo: klienta a obchod založí
// až potvrzení člověka (domain/crm/actions/offers.ts confirmOfferProposal).
//
// Co tu je:
//   1. přepínač a jeho závislosti (mailOfferStatus),
//   2. které přílohy se smějí stáhnout (pickOfferAttachment): jen PDF, a jen když
//      název souboru nebo předmět vypadá jako nabídka; ostatní typy se ignorují,
//   3. limity velikosti a počtu stran (validatePdfBytes),
//   4. deterministické id návrhu z (Message-ID, id přílohy) = idempotence,
//   5. přísný výklad výstupu modelu (interpretOfferExtraction): při známkách
//      pokynů pro AI v PDF se výstup zahodí celý (automat nemá člověka u okna).
//
// SOUKROMÍ: PDF se nikde netrvá (žije v paměti jednoho zpracování), obsah PDF se
// neloguje. Uloží se jen návrh (klient, název, částka…) do řádku fronty, dokud
// se nepotvrdí nebo nevyprší (migrace 0099).
import { createHash } from 'node:crypto'
import type { MessageAttachment } from '@/connectors/graph'
import type { RawExtraction } from '@/connectors/anthropic'
import type { InjectionFlag } from '@/core/untrusted'
import { sanitizeExtraction, type SanitizedOfferFields } from '@/domain/crm/offer-extract'
import { mailContentEnabledFromEnv } from '@/domain/crm/mailContent'

type Env = Record<string, string | undefined>

// ---------------------------------------------------------------------------
// Přepínač (výchozí VYPNUTO)

export type MailOfferStatus = 'off' | 'needs_content_intake' | 'needs_api_key' | 'on'

/** Přepínač: jen přesně `true`. */
export function mailOfferSwitchFromEnv(env: Env = process.env): boolean {
  return env.MAIL_OFFER_ATTACHMENT_ENABLED === 'true'
}

/**
 * Stav funkce: běží jen se zapnutým MAIL_CONTENT_INTAKE_ENABLED (nabídka se čte
 * jen ze zprávy ve složce „Cockpit") a s ANTHROPIC_API_KEY (čte ji model).
 */
export function mailOfferStatus(env: Env = process.env): MailOfferStatus {
  if (!mailOfferSwitchFromEnv(env)) return 'off'
  if (!mailContentEnabledFromEnv(env)) return 'needs_content_intake'
  if (!(env.ANTHROPIC_API_KEY ?? '').trim()) return 'needs_api_key'
  return 'on'
}

export const mailOfferEnabledFromEnv = (env: Env = process.env): boolean => mailOfferStatus(env) === 'on'

/** Věta pro Nastavení; null = vypnuto a není co říct. */
export function describeMailOfferStatus(env: Env = process.env): string | null {
  switch (mailOfferStatus(env)) {
    case 'off':
      return null
    case 'needs_content_intake':
      return 'Nabídky z příloh jsou zapnuté, ale nic se nečte: chybí zapnutá pošta s obsahem (MAIL_CONTENT_INTAKE_ENABLED).'
    case 'needs_api_key':
      return 'Nabídky z příloh jsou zapnuté, ale nic se nečte: chybí ANTHROPIC_API_KEY (nabídku čte model).'
    default:
      return 'Nabídky z příloh jsou zapnuté: PDF, které vypadá jako nabídka, se přečte a čeká ve frontě jako návrh zakázky ke tvému potvrzení. PDF se neukládá.'
  }
}

// ---------------------------------------------------------------------------
// Limity

/** Největší PDF, které se stáhne (Graph velikost hlásí předem, stahování se navíc přeruší). */
export const MAIL_OFFER_MAX_BYTES = 10 * 1024 * 1024
/** Nejvíc stran, které Cockpit modelu pošle; nabídka má pár stran, katalog ne. */
export const MAIL_OFFER_MAX_PAGES = 30
/** Nejvíc nabídek přečtených modelem za jeden běh (denní cron má omezený čas). */
export const MAIL_OFFER_MAX_PER_RUN = 2
/** Kolik času (ms) musí zbývat v rozpočtu běhu, aby se model volal; jinak se zpráva odloží na další běh. */
export const MAIL_OFFER_MIN_REMAINING_MS = 15_000
/** Strop jednoho volání modelu (ms). */
export const MAIL_OFFER_MODEL_TIMEOUT_MS = 20_000

// ---------------------------------------------------------------------------
// Která příloha vypadá jako nabídka

// Vzory běží nad textem bez diakritiky a malými písmeny.
const fold = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

const OFFER_WORDS = /(?<![a-z])(?:nabidk\w*|offer\w*|proposal\w*|quotation\w*|quote\w*|cenova\s+nabidka|cenovka|kalkulace|rozpocet)(?![a-z])/
// Doklady a smlouvy, které nabídkou nejsou, ani když se v názvu potká slovo nabídka.
const NOT_OFFER_WORDS = /(?<![a-z])(?:faktur\w*|invoice\w*|zalohov\w*|dobropis\w*|receipt\w*|paragon|nda|gdpr|smlouv\w*|contract\w*|objednavk\w*|order)(?![a-z])/

export function offerKeywordsFromEnv(env: Env = process.env): RegExp | null {
  const words = (env.MAIL_OFFER_ATTACHMENT_KEYWORDS ?? '')
    .split(',')
    .map((w) => fold(w.trim()).replace(/[^a-z0-9 ]/g, ''))
    .filter((w) => w.length >= 3 && w.length <= 40)
    .slice(0, 20)
  return words.length === 0 ? null : new RegExp(`(?<![a-z])(?:${words.join('|')})`)
}

export function isPdfAttachment(a: Pick<MessageAttachment, 'name' | 'contentType' | 'isFile' | 'isInline'>): boolean {
  if (!a.isFile || a.isInline) return false
  const byName = /\.pdf$/i.test(a.name.trim())
  return a.contentType === 'application/pdf' || (byName && (a.contentType === '' || a.contentType === 'application/octet-stream'))
}

export type OfferPick =
  | { kind: 'candidate'; attachment: MessageAttachment }
  | { kind: 'none'; reason: 'no_pdf' | 'not_offer' | 'too_large' }

/**
 * Vybere přílohu, která vypadá jako nabídka. Jen PDF (ostatní typy se ignorují a
 * nestahují). PDF vypadá jako nabídka, když: název souboru obsahuje slovo z
 * pravidel, NEBO předmět zprávy obsahuje takové slovo a zpráva má PDF právě jedno.
 * Název s „faktura", „smlouva" apod. nabídkou není. Víc kandidátů: první podle
 * pořadí v e-mailu. Velikost se kontroluje před stažením.
 */
export function pickOfferAttachment(
  attachments: readonly MessageAttachment[],
  subject: string,
  extra: RegExp | null = null,
): OfferPick {
  const pdfs = attachments.filter(isPdfAttachment)
  if (pdfs.length === 0) return { kind: 'none', reason: 'no_pdf' }
  const looks = (text: string): boolean => {
    const f = fold(text)
    return OFFER_WORDS.test(f) || (extra?.test(f) ?? false)
  }
  const nameOk = pdfs.filter((p) => looks(p.name) && !NOT_OFFER_WORDS.test(fold(p.name)))
  const subjectOk = pdfs.length === 1 && looks(subject) && !NOT_OFFER_WORDS.test(fold(pdfs[0].name))
  const chosen = nameOk[0] ?? (subjectOk ? pdfs[0] : null)
  if (!chosen) return { kind: 'none', reason: 'not_offer' }
  if (chosen.size > MAIL_OFFER_MAX_BYTES) return { kind: 'none', reason: 'too_large' }
  return { kind: 'candidate', attachment: chosen }
}

// ---------------------------------------------------------------------------
// Kontrola staženého PDF

export type PdfCheck =
  | { ok: true; pages: number | null }
  | { ok: false; reason: 'not_pdf' | 'too_large' | 'too_many_pages' | 'encrypted' }

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')

/**
 * Počet stran z textu PDF: největší /Count v okolí /Type /Pages, jinak počet
 * objektů /Type /Page. PDF s komprimovanými objekty (PDF 1.5) stránkový strom
 * skrývá → null (neznámé; ochranou je velikost a strop modelu).
 *
 * Soubor je cizí (příloha od klienta), proto jen lineární průchod a omezené
 * okno kolem každého výskytu: žádné vnořené hladové vzory, které by šlo
 * podstrčeným PDF zpomalit na minuty (běh pošty by pak padal každé ráno).
 */
export function estimatePdfPages(bytes: Uint8Array): number | null {
  const text = latin1(bytes)
  let counted = 0
  let seen = 0
  for (const m of text.matchAll(/\/Type\s*\/Pages(?![a-zA-Z])/g)) {
    if (++seen > 5_000) break
    const window = text.slice(Math.max(0, m.index - 400), m.index + 1_600)
    const c = /\/Count\s+(\d{1,6})/.exec(window)
    if (c) counted = Math.max(counted, Number(c[1]))
  }
  let singles = 0
  const single = /\/Type\s*\/Page(?![a-zA-Z])/g
  while (single.exec(text) !== null && ++singles <= 100_000);
  const pages = Math.max(counted, singles)
  return pages > 0 ? pages : null
}

export function validatePdfBytes(bytes: Uint8Array): PdfCheck {
  if (bytes.byteLength > MAIL_OFFER_MAX_BYTES) return { ok: false, reason: 'too_large' }
  // PDF začíná „%PDF-" (bývá povolený krátký předěl před hlavičkou).
  if (!latin1(bytes.subarray(0, 1024)).includes('%PDF-')) return { ok: false, reason: 'not_pdf' }
  if (/\/Encrypt\s*(?:\d|<|\/|\[)/.test(latin1(bytes))) return { ok: false, reason: 'encrypted' }
  const pages = estimatePdfPages(bytes)
  if (pages !== null && pages > MAIL_OFFER_MAX_PAGES) return { ok: false, reason: 'too_many_pages' }
  return { ok: true, pages }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---------------------------------------------------------------------------
// Idempotence: id návrhu z (Message-ID, id přílohy)

/**
 * UUID ve tvaru v4 odvozené z (Message-ID, id přílohy). Stejná příloha téže zprávy
 * dá vždy totéž id, takže ze zprávy nikdy nevzniknou dva návrhy ani dva obchody
 * (obchod má unikátní deal.source_pdf_path odvozenou z tohoto id, 0070).
 */
export function mailOfferProposalId(internetMessageId: string, attachmentId: string): string {
  const h = createHash('sha256').update(`${internetMessageId.trim()}\n${attachmentId}`).digest('hex')
  const variant = (0x8 | (parseInt(h[16], 16) & 0x3)).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ---------------------------------------------------------------------------
// Výklad výstupu modelu

export type OfferInterpretation =
  | { ok: true; fields: SanitizedOfferFields; warnings: string[] }
  /** Model nebo PDF nesou pokyny pro AI: výstup se zahodí celý. */
  | { ok: false; reason: 'flagged'; flags: InjectionFlag[] }
  /** Výstup nejde použít (chybí klient apod.). */
  | { ok: false; reason: 'invalid' }

/**
 * Výstup modelu je NEDŮVĚRYHODNÝ (model četl cizí PDF). Stejné čištění jako u
 * ručního importu (sanitizeExtraction), ale přísnější: u ručního importu vidí
 * příznaky člověk u obrazovky, tady se návrh při jakékoli známce pokynů pro AI
 * (v textu PDF i v hlášení modelu) nevytvoří vůbec.
 */
export function interpretOfferExtraction(raw: RawExtraction | unknown): OfferInterpretation {
  try {
    const { fields, warnings, flags } = sanitizeExtraction(raw)
    if (flags.length > 0) return { ok: false, reason: 'flagged', flags }
    return { ok: true, fields, warnings }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
