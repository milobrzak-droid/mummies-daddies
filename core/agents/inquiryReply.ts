// Text odpovědi agenta (nabídka, doptání), než jde do odchozí fronty (P3).
// Čisté funkce bez hodnot firmy.
//
// - Oslovení: jméno pochází od zákazníka (podpis e-mailu, formulář) a je to
//   nedůvěryhodný text. Do odpovědi smí jen „obyčejné jméno" — písmena,
//   mezery, tečka, apostrof a spojovník, nejvýš 60 znaků a 4 slova. Cokoli
//   jiného (odkaz, číslice, pokyn, emoji) = neutrální „Dobrý den,".
// - Patička firmy (údaje firmy, nezávaznost, upozornění na automat) se
//   připojí ke každé odpovědi.

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

/** Tělo odpovědi + patička firmy (prázdná patička = beze změny). */
export function composeReplyText(body: string, footer: string | null | undefined): string {
  const f = (footer ?? '').trim()
  return f ? `${body.trimEnd()}\n\n${f}` : body
}
