// Text oslovení ze SCHVÁLENÉ šablony (P7). Zástupné symboly {klic} se
// doplní jen z ověřených faktů signálu; chybí-li fakt, text nevznikne
// (agent nic nedomýšlí). Patička s identifikací odesílatele a odkazem na
// odhlášení je povinná a přidává se vždy.
//
// Model smí text nanejvýš STYLIZOVAT (volitelné, mimo tento modul):
// checkStylizedText ověří, že stylizace nepřidala čísla, data, odkazy ani
// e-maily, které v původním textu nebyly, a nezahodila odkaz na odhlášení.
import type { OutreachTemplate } from './config'
import type { VerifiedFact } from './signal'

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g

export function templatePlaceholders(t: Pick<OutreachTemplate, 'subject' | 'body'>): string[] {
  return [...new Set([...`${t.subject}\n${t.body}`.matchAll(PLACEHOLDER)].map((m) => m[1]))]
}

export type RenderedOutreach =
  | { ok: true; subject: string; text: string }
  | { ok: false; missing: string[] }

/** Hodnota faktu do textu: bez zalomení a bez znaků, které by vypadaly jako šablona. */
function safeValue(v: string): string {
  return v.replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim()
}

export function renderOutreach(
  template: Pick<OutreachTemplate, 'subject' | 'body'>,
  facts: readonly VerifiedFact[],
  opts: { footer: string; unsubscribeLink: string },
): RenderedOutreach {
  const values = new Map(facts.map((f) => [f.key, safeValue(f.value)]))
  const missing = templatePlaceholders(template).filter((k) => !values.get(k))
  if (missing.length) return { ok: false, missing }
  const fill = (s: string) => s.replace(PLACEHOLDER, (_, k: string) => values.get(k) ?? '')
  const subject = fill(template.subject).replace(/\s+/g, ' ').trim().slice(0, 200)
  const text = [
    fill(template.body).trim(),
    '',
    '--',
    opts.footer.trim(),
    `Nechcete od nás dostávat nabídky? Odhlásíte se jedním kliknutím: ${opts.unsubscribeLink}`,
  ].join('\n')
  return { ok: true, subject, text }
}

const TOKENS = /(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+|\d[\d.,: ]*\d|\d)/g

/** Prošla stylizace modelu? (žádná nová čísla/data/odkazy/adresy, odkaz na odhlášení zůstal) */
export function checkStylizedText(original: string, stylized: string, unsubscribeLink: string): boolean {
  if (!stylized.includes(unsubscribeLink)) return false
  if (stylized.length > original.length * 1.5 + 200) return false
  const known = new Set([...original.matchAll(TOKENS)].map((m) => m[0].replace(/\s/g, '')))
  return [...stylized.matchAll(TOKENS)].every((m) => known.has(m[0].replace(/\s/g, '')))
}

/**
 * Návrh oslovení PRO ČLOVĚKA (nová firma bez právního titulu pro e-mail):
 * kontext signálu, ověřená fakta a doporučený kanál. Nic se neodesílá.
 */
export function manualProposal(input: {
  kindLabel: string
  title: string
  url: string | null
  companyName: string | null
  facts: readonly VerifiedFact[]
  reasonLabel: string
}): { subject: string; body: string } {
  const lines = [
    `Proč: ${input.kindLabel} — ${input.title}`,
    ...(input.url ? [`Zdroj: ${input.url}`] : []),
    ...(input.facts.length ? ['Ověřená fakta ze zdroje:', ...input.facts.map((f) => `• ${f.key}: ${safeValue(f.value)}`)] : []),
    '',
    `E-mail se neposílá: ${input.reasonLabel}.`,
    'Doporučený postup: telefon nebo osobní kontakt; LinkedIn jen ručně. Při oslovení vycházejte jen z faktů výše,',
    'představte catering pro firemní akce a nabídněte nezávaznou kalkulaci. Nesouhlas s dalším oslovením zapište u kontaktu.',
  ]
  return { subject: `Oslovit: ${input.companyName ?? input.title}`.slice(0, 200), body: lines.join('\n').slice(0, 8000) }
}
