// Šablona subagenta („schopnosti") Loop Core — kapitola 11 plánu přestavby.
// Návod pro autora další schopnosti: docs/PROVOZ.md.
//
// Schopnost je typovaná DEFINICE (data + čisté funkce), ne proces:
//
//   trigger       typ normalizované události, na který reaguje
//                 (core/connectors/contract.ts, NormalizedEvent.type)
//   inputSchema   zod tvar vstupu = událost + kontext z DB, který dodá nasazení
//   guard         tvrdé mantinely (bez dokladu, stará zpráva, už se řeší…) —
//                 platí vždy, model je nepřebije
//   rules         deterministické rozhodnutí (výchozí cesta, bez modelu)
//   prompt        prompt pro volitelný LLM klasifikátor; obsah ze zdroje jen
//                 přes wrapUntrusted (ochrana proti prompt injection)
//   outputSchema  zod tvar výstupu; ověřuje se u pravidel i u modelu
//   target/sink   kam výstup míří — dnes jediný sink 'case_proposal':
//                 NÁVRH pracovního případu, který přijme nebo zamítne člověk
//
// Nic tady nezná konkrétní firmu, konektor ani tabulku kromě tvaru návrhu.
// Hodnoty firmy přicházejí jako konfigurace `C` (z @/config přes nasazení),
// I/O (čtení kontextu, zápis návrhu, volání modelu) jako vstříknuté závislosti.
// Proto jde stejný kód pustit nad konfigurací jiné firmy beze změny
// (test/mail-to-case.test.ts to dělá s konfigurací firmy i s druhou, testovací firmou).
import { z } from 'zod'
import { dedupeEvents, eventKey, type NormalizedEvent } from '@/core/connectors/contract'

/** Id schopnosti = hodnota case_proposal.capability (CHECK v 0067). */
export const CAPABILITY_ID_RE = /^[a-z][a-z0-9_]{0,63}$/

export type ProposalMethod = 'rule' | 'llm'

export type Verdict<O> =
  | { kind: 'propose'; output: O; reasons: readonly string[] }
  | { kind: 'skip'; reason: string }

export interface CapabilityPrompt {
  system: string
  user: string
}

/** Výstup, který sink 'case_proposal' potřebuje (název a zdůvodnění návrhu). */
export interface CaseProposalOutput {
  title: string
  rationale: string
}

/** Kam návrh míří: uzel, firma a kroky, které případ dostane po přijetí. */
export interface CaseProposalTarget {
  node: string
  accountId: number | null
  steps: readonly string[]
}

export interface CapabilityDefinition<I, O extends CaseProposalOutput, C> {
  /** Stabilní id (CAPABILITY_ID_RE); návrhy ho nesou navždy. */
  id: string
  /** Český název do UI a promptu. */
  label: string
  /** NormalizedEvent.type, na který schopnost reaguje. */
  trigger: string
  sink: 'case_proposal'
  inputSchema: z.ZodType<I>
  outputSchema: z.ZodType<O>
  /** Chyby konfigurace firmy; neprázdné pole = schopnost se nespustí. */
  configIssues(config: C): string[]
  /** Důvod, proč návrh nesmí vzniknout ani s modelem; null = pokračuj. */
  guard(input: I, config: C): string | null
  /** Deterministické rozhodnutí (výchozí cesta). */
  rules(input: I, config: C): Verdict<O>
  /** Prompt pro volitelný klasifikátor (jen když nasazení dodá `classify`). */
  prompt(input: I, config: C): CapabilityPrompt
  target(input: I, config: C): CaseProposalTarget
}

// ---------------------------------------------------------------------------
// Návrh a sink

export interface ProposalDraft<E, O extends CaseProposalOutput> {
  capability: string
  /** eventKey(event) — idempotence: jeden návrh na jednu událost. */
  sourceKey: string
  event: NormalizedEvent<E>
  output: O
  reasons: readonly string[]
  method: ProposalMethod
  /** Návrh stroje je vždy jen návrh, dokud ho nepotvrdí člověk (0038). */
  infoState: 'ai_suggestion'
  target: CaseProposalTarget
}

export interface ProposalSink<E, O extends CaseProposalOutput> {
  /** Idempotentní: stejný (capability, sourceKey) podruhé vrátí 'duplicate'. */
  propose(draft: ProposalDraft<E, O>): Promise<'created' | 'duplicate'>
}

/** Volitelný LLM klasifikátor: dostane prompt, vrátí surový text odpovědi. */
export type Classifier = (prompt: CapabilityPrompt) => Promise<string>

/**
 * Chyba, po které nemá smysl zpracovávat další události (chybí migrace,
 * rozbitá konfigurace). Běžná chyba jedné události se jen započítá.
 */
export class CapabilityAbort extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CapabilityAbort'
  }
}

// ---------------------------------------------------------------------------
// Odpověď modelu

export const MODEL_REASON_MAX = 300

/** Tvar odpovědi klasifikátoru pro libovolný výstup schopnosti. */
export function modelAnswerSchema<O>(output: z.ZodType<O>) {
  return z
    .object({
      propose: z.boolean(),
      reason: z.string().trim().min(1).max(MODEL_REASON_MAX),
      output: output.nullable(),
    })
    .refine((a) => !a.propose || a.output !== null, { message: 'propose=true bez výstupu' })
}

/**
 * Surový text modelu → ověřená odpověď, nebo null. Bere první JSON objekt
 * v textu (model občas přidá ```json obal); cokoli jiného = null a běh
 * spadne zpět na pravidla.
 */
export function parseModelAnswer<O>(
  text: string,
  output: z.ZodType<O>,
): { propose: boolean; reason: string; output: O | null } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let json: unknown
  try {
    json = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const parsed = modelAnswerSchema(output).safeParse(json)
  if (!parsed.success) return null
  return { propose: parsed.data.propose, reason: parsed.data.reason, output: parsed.data.output as O | null }
}

// ---------------------------------------------------------------------------
// Běh schopnosti nad dávkou událostí

export interface CapabilityRunDeps<E, O extends CaseProposalOutput> {
  /**
   * Vstup pro jednu událost (událost + kontext z DB). null = událost nejde
   * posoudit (např. firma mezitím zmizela). Vyhodit CapabilityAbort = konec běhu.
   */
  loadInput(event: NormalizedEvent<E>): Promise<unknown>
  sink: ProposalSink<E, O>
  /** Jen za příznakem; bez něj rozhodují pravidla. */
  classify?: Classifier
  /** Pojistka proti záplavě návrhů z jednoho běhu (výchozí 20). */
  maxProposals?: number
  /**
   * Společný deadline běhu: true = další událost už nezačínat. Zbylé události
   * se jen spočítají do `deferred`.
   */
  shouldStop?: () => boolean
}

export interface CapabilityRunStats {
  capability: string
  /** Události správného typu po deduplikaci. */
  events: number
  proposed: number
  duplicates: number
  skipped: Record<string, number>
  llm: { calls: number; invalid: number; declined: number }
  errors: number
  firstError?: string
  /** Běh skončil předčasně (CapabilityAbort, chybná konfigurace). */
  aborted?: string
  /** Kolik událostí se kvůli deadlinu běhu nezpracovalo. */
  deferred?: number
}

export const DEFAULT_MAX_PROPOSALS = 20
const ERROR_MAX = 300

const shortMessage = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > ERROR_MAX ? m.slice(0, ERROR_MAX) : m
}

export async function runCapability<E, I, O extends CaseProposalOutput, C>(
  def: CapabilityDefinition<I, O, C>,
  config: C,
  events: readonly NormalizedEvent<E>[],
  deps: CapabilityRunDeps<E, O>,
): Promise<CapabilityRunStats> {
  const relevant = dedupeEvents(events.filter((e) => e.type === def.trigger))
  // Chronologicky: první zpráva založí návrh, další ho pak najdou jako „už se řeší".
  relevant.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
  const stats: CapabilityRunStats = {
    capability: def.id,
    events: relevant.length,
    proposed: 0,
    duplicates: 0,
    skipped: {},
    llm: { calls: 0, invalid: 0, declined: 0 },
    errors: 0,
  }
  const skip = (reason: string) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1
  }

  const issues = [...(CAPABILITY_ID_RE.test(def.id) ? [] : [`neplatné id schopnosti: ${def.id}`]), ...def.configIssues(config)]
  if (issues.length > 0) {
    stats.aborted = `konfigurace: ${issues.join('; ')}`
    return stats
  }
  const max = deps.maxProposals ?? DEFAULT_MAX_PROPOSALS

  for (const [i, event] of relevant.entries()) {
    if (deps.shouldStop?.()) {
      stats.deferred = relevant.length - i
      break
    }
    if (stats.proposed >= max) {
      skip('limit')
      continue
    }
    try {
      const raw = await deps.loadInput(event)
      if (raw === null || raw === undefined) {
        skip('no_context')
        continue
      }
      const parsedInput = def.inputSchema.safeParse(raw)
      if (!parsedInput.success) {
        skip('invalid_input')
        continue
      }
      const input = parsedInput.data
      const blocked = def.guard(input, config)
      if (blocked) {
        skip(blocked)
        continue
      }

      let verdict: Verdict<O> = def.rules(input, config)
      let method: ProposalMethod = 'rule'
      if (deps.classify) {
        stats.llm.calls++
        let answer: ReturnType<typeof parseModelAnswer<O>> = null
        try {
          answer = parseModelAnswer(await deps.classify(def.prompt(input, config)), def.outputSchema)
        } catch {
          answer = null
        }
        if (answer === null) {
          // Nečitelná odpověď nebo výpadek modelu: rozhodnou pravidla.
          stats.llm.invalid++
        } else if (!answer.propose) {
          stats.llm.declined++
          verdict = { kind: 'skip', reason: 'llm_declined' }
        } else if (answer.output !== null) {
          verdict = { kind: 'propose', output: answer.output, reasons: [answer.reason] }
          method = 'llm'
        }
      }
      if (verdict.kind === 'skip') {
        skip(verdict.reason)
        continue
      }
      const output = def.outputSchema.safeParse(verdict.output)
      if (!output.success) {
        skip('invalid_output')
        continue
      }

      const result = await deps.sink.propose({
        capability: def.id,
        sourceKey: eventKey(event),
        event,
        output: output.data,
        reasons: verdict.reasons,
        method,
        infoState: 'ai_suggestion',
        target: def.target(input, config),
      })
      if (result === 'created') stats.proposed++
      else stats.duplicates++
    } catch (e) {
      if (e instanceof CapabilityAbort) {
        stats.aborted = shortMessage(e)
        break
      }
      stats.errors++
      stats.firstError ??= shortMessage(e)
    }
  }
  return stats
}
