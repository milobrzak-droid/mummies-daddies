// Schopnost „příchozí e-mail vytvoří doložený návrh pracovního případu"
// (kapitola 11 plánu přestavby; cílová architektura: „Skutečný produktový
// test"). První instance šablony core/agents/template.ts.
//
// Co dělá: pro PŘÍCHOZÍ zprávu spárovanou s firmou z CRM (NormalizedEvent
// typu message.inbound se subject = firma) navrhne pracovní případ v uzlu,
// který určí konfigurace firmy. Návrh je jen návrh (info_state
// 'ai_suggestion'); založí ho až člověk tlačítkem Přijmout na /pripady.
//
// Rozhodování (první verze je deterministická, bez modelu):
//   mantinely  bez dokladu (evidence) nic; zpráva starší než maxEventAgeDays
//              nic (první sync stáhne celou historii); firma už má v uzlu
//              otevřený případ nebo čekající návrh → nic; člověk návrh pro
//              firmu a uzel zamítl až po příchodu zprávy → nic (zamítnutí
//              platí pro poštu, kterou tehdy viděl; nová zpráva po něm je
//              nová informace)
//   pravidla   (zapíná je konfigurace firmy, stačí jedno)
//              - odpověď na naši zprávu: naše odchozí téže firmě nejvýš
//                replyWindowDays dní před touto příchozí
//              - první zpráva: s firmou dosud žádná pošta
//              - klíčová slova v titulku (jen konektor s content='title')
//   model      volitelně (Classifier za příznakem nasazení) — dostane jen
//              fakta a titulek obalený wrapUntrusted; mantinely nepřebije
//
// Nic tady není hodnota firmy: uzel, texty, okna i pravidla jsou MailToCaseConfig
// z konfigurace firmy (core/tenant.ts). Soukromí: žádný předmět ani tělo
// zprávy — Outlook konektor je nečte (0041); název návrhu skládá šablona
// z názvu firmy v CRM.
import { z } from 'zod'
import type { CompanyConfig, MailToCaseConfig } from '@/core/tenant'
import { UNTRUSTED_RULE, wrapUntrusted } from './untrustedText'
import type { CapabilityDefinition, Verdict } from './template'

export const MAIL_TO_CASE_ID = 'mail_to_case'
export const MAIL_TO_CASE_TRIGGER = 'message.inbound'
export const MAIL_TO_CASE_LABEL = 'Příchozí e-mail → návrh pracovního případu'

/** Konfigurace, se kterou schopnost běží: nastavení firmy + to, co z firmy potřebuje navíc. */
export interface MailToCaseRuntime {
  companyName: string
  timeZone: string
  nodes: readonly string[]
  nodeLabels: Readonly<Record<string, string>>
  settings: MailToCaseConfig
}

/** Z konfigurace firmy; null = schopnost je u firmy vypnutá. */
export function mailToCaseRuntime(tenant: CompanyConfig): MailToCaseRuntime | null {
  const settings = tenant.capabilities.mailToCase
  if (!settings) return null
  return {
    companyName: tenant.name,
    timeZone: tenant.timeZone,
    nodes: tenant.nodes,
    nodeLabels: tenant.nodeLabels,
    settings,
  }
}

// ---------------------------------------------------------------------------
// Vstup a výstup

const isoUtc = z.iso.datetime()

export const mailToCaseInputSchema = z.object({
  occurredAt: isoUtc,
  now: isoUtc,
  /** Titulek zprávy, jen když ho konektor smí předat; Outlook: vždy null. */
  title: z.string().max(300).nullable(),
  accountId: z.number().int().positive(),
  accountName: z.string().trim().min(1).max(300),
  /** Událost nese odkaz na zdroj (evidence). */
  hasEvidence: z.boolean(),
  /** Naše poslední odchozí zpráva téže firmě PŘED touto zprávou. */
  lastOutboundAt: isoUtc.nullable(),
  /** S firmou existuje pošta (v obou směrech) starší než tato zpráva. */
  hasEarlierMail: z.boolean(),
  /** Firma už má v cílovém uzlu aktivní případ nebo čekající návrh. */
  alreadyTracked: z.boolean(),
  /** Člověk zamítl návrh pro firmu a uzel AŽ PO příchodu této zprávy. */
  rejectedLater: z.boolean(),
})
export type MailToCaseInput = z.infer<typeof mailToCaseInputSchema>

export const mailToCaseOutputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  rationale: z.string().trim().min(1).max(1000),
})
export type MailToCaseOutput = z.infer<typeof mailToCaseOutputSchema>

// ---------------------------------------------------------------------------
// Pomocníci

const DAY_MS = 86_400_000
export const TITLE_PLACEHOLDER = '{firma}'

/** Název návrhu ze šablony firmy; `{firma}` = jméno firmy z CRM. */
export function renderProposalTitle(template: string, accountName: string): string {
  const title = template.split(TITLE_PLACEHOLDER).join(accountName.trim()).trim()
  return title.length > 300 ? `${title.slice(0, 299)}…` : title
}

/** Malá písmena bez diakritiky — „Poptávka" najde i „POPTAVKA". */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('cs-CZ', { timeZone, day: 'numeric', month: 'numeric', year: 'numeric' }).format(
    new Date(iso),
  )
}

/** Signály pravidel, které pro zprávu platí (prázdné = žádné pravidlo). */
export function ruleReasons(input: MailToCaseInput, cfg: MailToCaseRuntime): string[] {
  const s = cfg.settings
  const reasons: string[] = []
  if (s.replyWindowDays !== null && input.lastOutboundAt) {
    const gap = Date.parse(input.occurredAt) - Date.parse(input.lastOutboundAt)
    if (gap >= 0 && gap <= s.replyWindowDays * DAY_MS) {
      reasons.push(
        `Odpověď na naši zprávu z ${formatDay(input.lastOutboundAt, cfg.timeZone)} (do ${s.replyWindowDays} dní).`,
      )
    }
  }
  if (s.firstContact && !input.hasEarlierMail) {
    reasons.push('První zpráva od firmy — dosud s ní žádná pošta.')
  }
  if (s.keywords.length > 0 && input.title) {
    const title = foldText(input.title)
    const hit = s.keywords.find((k) => title.includes(foldText(k)))
    if (hit) reasons.push(`Klíčové slovo „${hit}" v titulku zprávy.`)
  }
  return reasons
}

// ---------------------------------------------------------------------------
// Definice

export const MAIL_TO_CASE: CapabilityDefinition<MailToCaseInput, MailToCaseOutput, MailToCaseRuntime> = {
  id: MAIL_TO_CASE_ID,
  label: MAIL_TO_CASE_LABEL,
  trigger: MAIL_TO_CASE_TRIGGER,
  sink: 'case_proposal',
  inputSchema: mailToCaseInputSchema,
  outputSchema: mailToCaseOutputSchema,

  configIssues(cfg) {
    const s = cfg.settings
    const issues: string[] = []
    if (!cfg.nodes.includes(s.node)) issues.push(`uzel ${s.node} firma nemá`)
    if (s.titleTemplate.trim() === '' || s.titleTemplate.length > 200) issues.push('šablona názvu je prázdná nebo delší než 200 znaků')
    if (!Number.isInteger(s.maxEventAgeDays) || s.maxEventAgeDays < 1 || s.maxEventAgeDays > 60) {
      issues.push('maxEventAgeDays musí být celé číslo 1–60')
    }
    if (s.replyWindowDays !== null && (!Number.isInteger(s.replyWindowDays) || s.replyWindowDays < 1 || s.replyWindowDays > 365)) {
      issues.push('replyWindowDays musí být null nebo celé číslo 1–365')
    }
    if (s.steps.length < 1 || s.steps.length > 10) issues.push('kroků musí být 1–10')
    for (const step of s.steps) if (step.trim() === '' || step.length > 300) issues.push('krok je prázdný nebo delší než 300 znaků')
    for (const k of s.keywords) if (k.trim() === '' || k.length > 60) issues.push('klíčové slovo je prázdné nebo delší než 60 znaků')
    if (s.replyWindowDays === null && !s.firstContact && s.keywords.length === 0) issues.push('žádné pravidlo není zapnuté')
    return issues
  },

  guard(input, cfg) {
    if (!input.hasEvidence) return 'no_evidence'
    if (Date.parse(input.now) - Date.parse(input.occurredAt) > cfg.settings.maxEventAgeDays * DAY_MS) return 'stale_event'
    if (input.alreadyTracked) return 'already_tracked'
    if (input.rejectedLater) return 'rejected_by_human'
    return null
  },

  rules(input, cfg): Verdict<MailToCaseOutput> {
    const reasons = ruleReasons(input, cfg)
    if (reasons.length === 0) return { kind: 'skip', reason: 'no_rule' }
    return {
      kind: 'propose',
      output: { title: renderProposalTitle(cfg.settings.titleTemplate, input.accountName), rationale: reasons.join(' ') },
      reasons,
    }
  },

  prompt(input, cfg) {
    const node = cfg.nodeLabels[cfg.settings.node] ?? cfg.settings.node
    const system = [
      `Jsi klasifikátor schopnosti „${MAIL_TO_CASE_LABEL}" ve firmě ${cfg.companyName}.`,
      `Rozhoduješ, zda příchozí zpráva od firmy z CRM má založit NÁVRH pracovního případu v uzlu „${node}".`,
      'Návrh vždy přijme nebo zamítne člověk; ty nic neodesíláš ani nezapisuješ.',
      UNTRUSTED_RULE,
      'Odpověz jediným JSON objektem bez dalšího textu:',
      '{"propose": true|false, "reason": "česky, nejvýš 300 znaků", "output": {"title": "…", "rationale": "…"} nebo null}.',
      'Když si nejsi jistý, odpověz propose=false.',
    ].join('\n')
    const reasons = ruleReasons(input, cfg)
    const user = [
      `Firma: ${wrapUntrusted('nazev_firmy', input.accountName, 300)}`,
      `Zpráva přišla: ${formatDay(input.occurredAt, cfg.timeZone)}`,
      `Naše poslední odchozí zpráva téže firmě: ${input.lastOutboundAt ? formatDay(input.lastOutboundAt, cfg.timeZone) : 'žádná'}`,
      `Dřívější pošta s firmou: ${input.hasEarlierMail ? 'ano' : 'ne'}`,
      `Titulek zprávy: ${input.title ? wrapUntrusted('titulek_zpravy', input.title, 300) : 'není k dispozici (konektor nese jen metadata)'}`,
      `Signály pravidel: ${reasons.length > 0 ? reasons.join(' ') : 'žádné'}`,
      `Navržený název případu: ${wrapUntrusted('navrzeny_nazev', renderProposalTitle(cfg.settings.titleTemplate, input.accountName), 300)}`,
    ].join('\n')
    return { system, user }
  },

  target(input, cfg) {
    return { node: cfg.settings.node, accountId: input.accountId, steps: cfg.settings.steps }
  },
}
