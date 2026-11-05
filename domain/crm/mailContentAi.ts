// Volitelné AI shrnutí zprávy ze složky „Cockpit" (MAIL_CONTENT_AI_ENABLED,
// výchozí vypnuto). Pravidla (mailContent.ts) rozhodují vždy; model je jen
// pomocník: dodá jednu až dvě věty shrnutí a u zprávy, ve které pravidla nic
// nenašla, druh (schválení / posun / změna / přílohy). Výstup modelu je
// NEDŮVĚRYHODNÝ (model četl cizí text) — prochází čištěním a zod schématem,
// a když v textu nebo ve výstupu jsou známky pokynů pro AI, zahodí se celý.
// Nic z něj se nevykoná; návrh potvrzuje člověk.
//
// Soukromí: model dostane jen předmět a nejnovější část textu (nejvýš 4 000
// znaků), bez adres odesílatele a příjemců, a jen když je přepínač zapnutý
// a chybí známky pokynů pro AI ve zprávě. Nic se na straně Cockpitu
// neukládá kromě krátkého shrnutí (nejvýš 300 znaků) ve zdůvodnění návrhu.
import { z } from 'zod'
import { summarizeMailWithModel, type RawMailSummary } from '@/connectors/anthropic'
import { detectInjectionMarkers, mergeInjectionFlags, sanitizeUntrustedText, type InjectionFlag } from '@/core/untrusted'
import { logError } from '@/lib/log'
import { maskPersonalData, MAIL_SIGNALS, type MailSignal } from '@/domain/crm/mailContent'

export const MAIL_AI_SUMMARY_MAX = 300

export type MailAiResult = {
  /** Druh, který model určil; null = „other" nebo nečitelné. */
  kind: MailSignal | null
  summary: string | null
  /** Nový termín YYYY-MM-DD, nebo null. */
  date: string | null
  /** Známky pokynů pro AI ve výstupu (neprázdné = výstup se zahodil). */
  flags: InjectionFlag[]
}

const lenient = <T>(fn: (v: unknown) => T) => z.unknown().optional().transform(fn)

const rawSchema = z.object({
  kind: lenient((v) => (typeof v === 'string' && (MAIL_SIGNALS as readonly string[]).includes(v) ? (v as MailSignal) : null)),
  summary: lenient((v) => {
    if (typeof v !== 'string') return null
    const clean = maskPersonalData(sanitizeUntrustedText(v, 2_000).text.replace(/\s+/g, ' ').trim())
    if (clean.length === 0) return null
    return clean.length > MAIL_AI_SUMMARY_MAX ? `${clean.slice(0, MAIL_AI_SUMMARY_MAX - 1).trimEnd()}…` : clean
  }),
  new_date: lenient((v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null
    const d = new Date(`${v.trim()}T00:00:00Z`)
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v.trim() ? v.trim() : null
  }),
})

/** Surový výstup modelu → očištěný výsledek; při známkách pokynů pro AI nic nepřevezme. */
export function sanitizeMailSummary(raw: RawMailSummary): MailAiResult {
  const parsed = rawSchema.parse({ ...raw })
  const reported = typeof raw.document_instructions === 'string' ? raw.document_instructions.trim() : ''
  const flags = mergeInjectionFlags(
    detectInjectionMarkers(`${typeof raw.summary === 'string' ? raw.summary : ''}\n${reported}`),
    reported.length > 0 ? (['model_reported'] as InjectionFlag[]) : [],
  )
  if (flags.length > 0) return { kind: null, summary: null, date: null, flags }
  return { kind: parsed.kind, summary: parsed.summary, date: parsed.new_date, flags: [] }
}

/**
 * Shrnutí zprávy modelem. Vrací null, když model nejde zavolat (chybí klíč,
 * výpadek) — volající pak jede jen s pravidly. Nikdy nevyhazuje a neloguje text.
 */
export async function summarizeMailContent(
  input: { subject: string; text: string },
  impl: (subject: string, text: string) => Promise<RawMailSummary> = summarizeMailWithModel,
): Promise<MailAiResult | null> {
  try {
    return sanitizeMailSummary(await impl(input.subject, input.text))
  } catch (e) {
    // Jen jméno chyby: zpráva výjimky může nést kus zprávy klienta.
    logError('mailContent.ai', e instanceof Error ? e.name : 'chyba')
    return null
  }
}

/** Má zpráva známky pokynů pro AI? Pak ji modelu vůbec neposíláme. */
export function mailLooksInjected(subject: string, text: string): InjectionFlag[] {
  return detectInjectionMarkers(`${subject}\n${text}`)
}
