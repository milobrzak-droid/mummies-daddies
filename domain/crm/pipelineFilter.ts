// Filtry tabule obchodů (/cockpit/pipeline) jako čistá funkce. Stránka
// i export (/cockpit/export/pipeline) filtrují stejným kódem, takže Excel
// a PDF obsahují přesně to, co obchodník vidí na tabuli.
import { DEAL_STAGES, isDealKind, type DealKind } from '@/lib/domain'
import type { DealStage } from '@/lib/types'
import { OPEN_DEAL_STAGES, type SalesDealLike } from '@/domain/crm/sales'

/** Uzavřené fáze odvozené z DEAL_STAGES (open: false), v pořadí definice. */
export const CLOSED_DEAL_STAGES: DealStage[] = DEAL_STAGES.filter((s) => !s.open).map((s) => s.key)

export type PipelineState = 'open' | 'all' | DealStage
export type PipelineKind = 'all' | 'none' | DealKind

export type PipelineParams = {
  /** Hledaný text, jak ho uživatel zadal (pro odkazy a popis filtru). */
  rawQ: string
  /** Hledaný text malými písmeny bez okrajových mezer. */
  q: string
  owner: string
  state: PipelineState
  kind: PipelineKind
}

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function parsePipelineParams(raw: Raw): PipelineParams {
  const rawQ = first(raw.q) ?? ''
  const owner = first(raw.owner) || 'all'
  const allowedStates: string[] = ['open', 'all', ...CLOSED_DEAL_STAGES]
  const stateRaw = first(raw.state) ?? 'open'
  const state = (allowedStates.includes(stateRaw) ? stateRaw : 'open') as PipelineState
  // Typ obchodu (0052): 'none' = zatím neroztříděné (inventura).
  const kindRaw = first(raw.kind)
  const kind: PipelineKind = kindRaw === 'none' || isDealKind(kindRaw) ? kindRaw : 'all'
  return { rawQ, q: rawQ.trim().toLowerCase(), owner, state, kind }
}

/** Obchody, které tabule při daných filtrech ukazuje (pořadí zachované). */
export function filterPipelineDeals<D extends SalesDealLike>(deals: readonly D[], p: PipelineParams): D[] {
  return deals.filter((deal) => {
    if (p.owner !== 'all' && deal.owner_id !== p.owner) return false
    if (p.kind === 'none' && deal.deal_kind != null) return false
    if (p.kind !== 'all' && p.kind !== 'none' && deal.deal_kind !== p.kind) return false
    if (p.q && !`${deal.title} ${deal.account?.name ?? ''} ${deal.primary_contact?.full_name ?? ''}`.toLowerCase().includes(p.q)) return false
    if (p.state === 'open') return OPEN_DEAL_STAGES.includes(deal.stage)
    if (p.state === 'all') return true
    return deal.stage === p.state
  })
}

/** Fáze (sloupce) tabule pro zvolený stav. */
export function pipelineStages(state: PipelineState): DealStage[] {
  if (state === 'open') return OPEN_DEAL_STAGES
  if (state === 'all') return [...OPEN_DEAL_STAGES, ...CLOSED_DEAL_STAGES]
  return [state]
}
