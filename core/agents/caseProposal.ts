// Sink 'case_proposal' šablony subagenta: zápis NÁVRHU pracovního případu
// (tabulka case_proposal, migrace 0067) a čisté pomocníky pro UI a akce.
//
// Zápis návrhu dělá jen server se service-role klientem (cron) — pro tým je
// tabulka SELECT-only. Přijetí/zamítnutí jde přes RPC accept_case_proposal /
// reject_case_proposal (aktér z auth.uid(), AAL2), viz core/actions/caseProposals.ts.
//
// Doložení: návrh bez odkazu na zdroj nevznikne. Sink nejdřív zapíše (nebo
// najde) řádek evidence ze zdrojové události — hodnoty jsou ze zdrojového
// systému (Graph message id a webLink), nikdy od uživatele, stejně jako
// u mail syncu (core/evidence.ts). case_proposal.evidence_id je NOT NULL.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { recordAudit } from '@/core/audit'
import { recordEvidence } from '@/core/evidence'
import { CapabilityAbort, type CaseProposalOutput, type ProposalDraft, type ProposalSink } from './template'

export type CaseProposalDb = Pick<SupabaseClient, 'from'>

export const CASE_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected'] as const
export type CaseProposalStatus = (typeof CASE_PROPOSAL_STATUSES)[number]

export const PROPOSAL_METHODS = ['rule', 'llm'] as const

/** Hláška, dokud tabulka / RPC z migrace 0067 neexistují. */
export const PROPOSALS_MIGRATION_PENDING_MESSAGE = 'Návrhy případů čekají na migraci 0067.'
export const PROPOSAL_ALREADY_DECIDED_MESSAGE = 'O návrhu už rozhodl někdo jiný. Obnovte stránku.'

export type CaseProposalInsert = {
  capability: string
  source_key: string
  occurred_at: string
  node: string
  account_id: number | null
  title: string
  rationale: string
  steps: string[]
  method: 'rule' | 'llm'
  info_state: 'ai_suggestion'
  evidence_id: number
  status: 'pending'
  created_by: string
}

/** Řádek case_proposal z návrhu šablony (čistá funkce). */
export function caseProposalRow<E, O extends CaseProposalOutput>(
  draft: ProposalDraft<E, O>,
  evidenceId: number,
  createdBy: string,
): CaseProposalInsert {
  return {
    capability: draft.capability,
    source_key: draft.sourceKey,
    occurred_at: draft.event.occurred_at,
    node: draft.target.node,
    account_id: draft.target.accountId,
    title: draft.output.title,
    rationale: draft.output.rationale,
    steps: [...draft.target.steps],
    method: draft.method,
    info_state: draft.infoState,
    evidence_id: evidenceId,
    status: 'pending',
    created_by: createdBy,
  }
}

type DbErr = { code?: string | null; message?: string | null } | null | undefined

/** Tabulka nebo RPC z 0067 ještě neexistují (42P01, PGRST205, PGRST202, 42883). */
export function isProposalsMigrationMissing(err: DbErr): boolean {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205' || err.code === 'PGRST202' || err.code === '42883') return true
  return /relation .* does not exist|could not find the (table|function)/i.test(err.message ?? '')
}

/**
 * Service-role sink. `createdBy` = aktér návrhu ('system:<schopnost>').
 * Chybějící migrace = CapabilityAbort (další události nemá smysl zkoušet).
 */
export function caseProposalSink<E, O extends CaseProposalOutput>(
  db: CaseProposalDb,
  opts: { createdBy: string },
): ProposalSink<E, O> {
  return {
    async propose(draft) {
      const ref = draft.event.evidence
      if (!ref) throw new Error('návrh bez odkazu na zdroj nevznikne')
      const evidence = await recordEvidence(db, ref, opts.createdBy)
      if (!evidence.ok) {
        throw new Error(evidence.reason === 'invalid' ? `evidence: ${evidence.issues.join('; ')}` : 'evidence: zápis selhal')
      }
      const row = caseProposalRow(draft, evidence.id, opts.createdBy)
      const { data, error } = await db
        .from('case_proposal')
        .upsert(row, { onConflict: 'capability,source_key', ignoreDuplicates: true })
        .select('id')
      if (error) {
        if (isProposalsMigrationMissing(error)) throw new CapabilityAbort(PROPOSALS_MIGRATION_PENDING_MESSAGE)
        // Druhý čekající návrh pro stejnou firmu a uzel (částečný UNIQUE index) = už se řeší.
        if (error.code === '23505') return 'duplicate'
        throw new Error(`case_proposal: ${error.code ?? 'chyba zápisu'}`)
      }
      const id = (data as { id: number }[] | null)?.[0]?.id
      if (!id) return 'duplicate'
      await recordAudit(
        'case_proposal',
        id,
        'case_proposal.created',
        null,
        { capability: row.capability, node: row.node, account_id: row.account_id, method: row.method },
        { type: 'system', id: draft.capability },
        { evidenceId: evidence.id, infoState: 'ai_suggestion' },
      )
      return 'created'
    },
  }
}

// ---------------------------------------------------------------------------
// Rozhodnutí člověka (formulář na /pripady)

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)

export const decideProposalSchema = z.object({
  proposal_id: z.coerce.number().int().positive(),
  accept: z.enum(['1', '0']),
  note: z.preprocess(emptyToNull, z.string().trim().max(2000).nullable()).default(null),
})

/** Chyba RPC 0067 → česká hláška; null = neznámá (volající zaloguje). */
export function proposalErrorMessage(err: DbErr): string | null {
  if (!err) return null
  if (isProposalsMigrationMissing(err)) return PROPOSALS_MIGRATION_PENDING_MESSAGE
  const msg = err.message ?? ''
  if (/Návrh už byl rozhodnut/i.test(msg)) return PROPOSAL_ALREADY_DECIDED_MESSAGE
  if (/Návrh \d+ neexistuje/i.test(msg) || err.code === 'P0002') return 'Návrh nebyl nalezen.'
  return null
}

export const PROPOSAL_METHOD_LABELS: Record<string, string> = {
  rule: 'návrh podle pravidla',
  llm: 'návrh AI',
}

export const proposalMethodLabel = (m: string): string => PROPOSAL_METHOD_LABELS[m] ?? m
