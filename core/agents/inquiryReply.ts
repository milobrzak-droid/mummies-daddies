// Text odpovědi agenta (nabídka, doptání), než jde do odchozí fronty (P3).
// Čisté funkce bez hodnot firmy.
//
// - Oslovení: jméno pochází od zákazníka (podpis e-mailu, formulář) a je to
//   nedůvěryhodný text. Do odpovědi smí jen „obyčejné jméno" — písmena,
//   mezery, tečka, apostrof a spojovník, nejvýš 60 znaků a 4 slova. Cokoli
//   jiného (odkaz, číslice, pokyn, emoji) = neutrální „Dobrý den,".
// - Patičku firmy (údaje firmy, nezávaznost, upozornění na automat) připojuje
//   odchozí fronta (P3) při odeslání; tady jen volitelný dovětek z konfigurace.

export const GREETING_NAME_MAX = 60
const NAME_RE = /^\p{L}[\p{L}\p{M}'’.-]*(?: \p{L}[\p{L}\p{M}'’.-]*){0,3}$/u

/** Jméno pro oslovení, nebo null (pak se oslovuje neutrálně). */
export function safeGreetingName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (t.length < 2 || t.length > GREETING_NAME_MAX) return null
  if (!NAME_RE.test(t)) return null
  return t
}

/** Tělo odpovědi + volitelný dovětek (prázdný = beze změny). */
export function composeReplyText(body: string, footer: string | null | undefined): string {
  const f = (footer ?? '').trim()
  return f ? `${body.trimEnd()}\n\n${f}` : body
}

export const REPLY_SUBJECT_MAX = 120
const REPLY_SUBJECT_FALLBACK = 'Vaše poptávka'
// Cokoli, z čeho poštovní klient udělá odkaz: adresa se schématem, mailto:,
// www., e-mailová adresa a holá doména (s cestou i bez).
const LINK_RE = /\b(?:https?|ftp):\/\/\S+|\bmailto:\S+|\bwww\.\S+|[^\s@]+@[^\s@]+\.[a-z]{2,24}\b|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/\S*)?/gi
// C0/C1 řídicí znaky, DEL, nulové šířky, BOM a znaky pro směr textu.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
const REPLY_PREFIX_RE = /^(?:(?:re|fw|fwd|odp|vs|aw|wg|tr)\s*(?:\[\d+\])?\s*:\s*)+/i

/**
 * Předmět odpovědi agenta: „Re: “ + předmět zákazníka. Předmět je
 * nedůvěryhodný text a odchází zpět zákazníkovi pod jménem firmy, proto:
 * řídicí a neviditelné znaky (konce řádků, nulové šířky, obrácení směru
 * textu) pryč, odkazy (http(s)://, www., mailto:, e-mail, holá doména)
 * nahradí „[odkaz]“, opakované předpony Re:/Fwd:/Odp: se sloučí do jedné
 * a výsledek má nejvýš REPLY_SUBJECT_MAX znaků (ořízne se na hranici slova
 * s „…“). Prázdný předmět → „Re: Vaše poptávka“.
 */
export function replySubject(raw: string | null | undefined): string {
  let t = (typeof raw === 'string' ? raw : '').normalize('NFC')
  t = t.replace(CONTROL_RE, ' ')
  t = t.replace(LINK_RE, '[odkaz]')
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(REPLY_PREFIX_RE, '').trim()
  if (!t) t = REPLY_SUBJECT_FALLBACK
  const prefix = 'Re: '
  const max = REPLY_SUBJECT_MAX - prefix.length
  if (t.length > max) {
    const cut = t.slice(0, max - 1)
    const space = cut.lastIndexOf(' ')
    t = `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
  }
  return prefix + t
}
