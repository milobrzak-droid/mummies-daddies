import { createClient } from '@/lib/supabase/server'
import { normalizeDealRows } from '@/lib/dealStageLegacy'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import { checkDealInvariant, isMissingColumnError } from '@/domain/crm/dealInvariant'
import type { InventoryReason } from '@/domain/crm/inventoryReasons'
import type { Deal, DealStage } from '@/lib/types'

// Inventura otevřených obchodů (kap. 5, rozhodnutí vlastníka 28. 9. 2026):
// Viktor prochází obchody, u kterých chybí `deal_kind` (workshop/implementace/
// provoz/jiné), nebo ve fázi „rozhodování" chybí rozhodovatel/termín
// rozhodnutí, nebo obchod porušuje checkDealInvariant (chybí vlastník nebo
// další krok). Stránka /inventura tyhle obchody vypíše s inline rychlou
// úpravou (viz domain/crm/actions/inventory.ts).
//
// Pole z migrace 0052 (deal_kind, decision_maker, decision_due — sdílený
// seznam DEAL_0052_COLUMNS z dealWrite.ts) nemusí existovat, pokud migrace
// ještě neběžela. Dotaz na to je tolerantní stejně jako zápis: nejdřív
// zkusí sloupce zahrnout, a když DB nahlásí chybějící sloupec (42703 /
// PGRST204), zopakuje dotaz bez nich — stránka pak jen zobrazí notici, že
// typ obchodu / rozhodovací pole se objeví po nasazení 0052.

// Důvody a jejich popisky žijí v domain/crm/inventoryReasons.ts, aby je
// klientská komponenta InventoryRow mohla importovat bez tohoto modulu
// (ten tahá lib/supabase/server → next/headers a rozbil by build).
export { INVENTORY_REASON_LABELS, type InventoryReason } from '@/domain/crm/inventoryReasons'

// Sloupce mimo 0052, které inventura potřebuje — id + zobrazení + vstupy
// pro checkDealInvariant a rychlou úpravu. Literální řetězce (ne skládané
// z pole) — typovaný .select() Supabase klienta umí zpracovat jen literál.
const SELECT_BASE = 'id, account_id, title, stage, owner_id, next_step, next_step_due, no_next_step_reason, created_at, updated_at, account:account!deal_account_id_fkey(id, name), owner:team_member!deal_owner_id_fkey(id, full_name, email)' as const

// Stejné jako SELECT_BASE, jen navíc tři pole z migrace 0052, která
// inventura potřebuje (deal_kind, decision_maker, decision_due).
const SELECT_WITH_0052 = `deal_kind, decision_maker, decision_due, ${SELECT_BASE}` as const

export type InventoryDealRow = Pick<
  Deal,
  'id' | 'account_id' | 'title' | 'stage' | 'owner_id' | 'next_step' | 'next_step_due'
  | 'no_next_step_reason' | 'created_at' | 'updated_at'
> & {
  deal_kind?: Deal['deal_kind']
  decision_maker?: Deal['decision_maker']
  decision_due?: Deal['decision_due']
  account: { id: number; name: string } | null
  owner: { id: string; full_name: string; email: string } | null
}

export type InventoryDeal = InventoryDealRow & { reasons: InventoryReason[] }

export type InventoryResult = {
  /** Obchody, které inventuru ještě potřebují — jen ty s alespoň jedním důvodem. */
  deals: InventoryDeal[]
  /** Kolik otevřených obchodů je celkem (pro čítač „Hotovo X z Y"). */
  totalOpen: number
  /** totalOpen - deals.length — otevřené obchody bez chybějícího pole. */
  done: number
  /** false = migrace 0052 ještě neběžela, typ obchodu / rozhodovací pole se nekontrolují. */
  columns0052Available: boolean
}

const filled = (v: string | null | undefined) => typeof v === 'string' && v.trim() !== ''

function reasonsFor(deal: InventoryDealRow, columns0052Available: boolean): InventoryReason[] {
  const reasons: InventoryReason[] = []
  if (columns0052Available && !deal.deal_kind) reasons.push('missing_deal_kind')
  if (deal.stage === ('rozhodovani' satisfies DealStage) && columns0052Available) {
    if (!filled(deal.decision_maker)) reasons.push('missing_decision_maker')
    if (!filled(deal.decision_due)) reasons.push('missing_decision_due')
  }
  reasons.push(...checkDealInvariant(deal))
  return reasons
}

export async function getInventoryDeals(): Promise<InventoryResult> {
  const s = await createClient()
  const first = await s.from('deal').select(SELECT_WITH_0052)
    .in('stage', OPEN_DEAL_STAGE_FILTER)
    .order('created_at', { ascending: true })
  let data: unknown = first.data
  let error: { code?: string; message?: string } | null = first.error
  let columns0052Available = true
  if (error && isMissingColumnError(error)) {
    columns0052Available = false
    const fallback = await s.from('deal').select(SELECT_BASE)
      .in('stage', OPEN_DEAL_STAGE_FILTER)
      .order('created_at', { ascending: true })
    data = fallback.data
    error = fallback.error
  }
  if (error) throw error

  const rows = normalizeDealRows((data ?? []) as unknown as InventoryDealRow[])
  const withReasons: InventoryDeal[] = rows.map((row) => ({
    ...row, reasons: reasonsFor(row, columns0052Available),
  }))
  const deals = withReasons.filter((d) => d.reasons.length > 0)
  const totalOpen = withReasons.length
  return { deals, totalOpen, done: totalOpen - deals.length, columns0052Available }
}
