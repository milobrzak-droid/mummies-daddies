// Dodávky pro API a MCP (nástroj get_deliveries). Stejné portfolio jako
// /dodavky, jen čtené servisním klientem, protože klíč API nemá přihlášenou
// session. Smí ho každá interní role (vlastník klíče je vždy interní, viz
// loadKeyOwner v lib/apiKeyAuth.ts). Přijatou nabídku čte portfolio jen
// s obchodní rolí a částky nečte vůbec — ty jsou u obchodů (get_deals),
// a tedy jen pro obchodní role.
import { createAdminClient } from '@/lib/supabase/admin'
import { pragueToday } from '@/lib/pragueDate'
import { getDeliveryPortfolio, type PortfolioSource } from '@/domain/delivery/queries/portfolio'
import { portfolioForApi, type PortfolioApi, type PortfolioApiQuery } from '@/domain/delivery/portfolio'

export type DeliveriesForApi = PortfolioApi & {
  /** Vedlejší zdroje, které se nenačetly; u dodávek pak může chybět (např. milníky). */
  unavailable?: PortfolioSource[]
}

export async function getDeliveriesForApi(
  q: PortfolioApiQuery & { canSeeSales: boolean; today?: string },
): Promise<{ ok: true; data: DeliveriesForApi } | { ok: false; error: string }> {
  const res = await getDeliveryPortfolio({
    today: q.today ?? pragueToday(),
    canSeeSales: q.canSeeSales,
    db: createAdminClient(),
    asService: true,
  })
  if (res.state === 'error') return { ok: false, error: `Dodávky se nepodařilo načíst: ${res.message}` }
  const data = portfolioForApi(res.items, q)
  return { ok: true, data: res.unavailable.length > 0 ? { ...data, unavailable: res.unavailable } : data }
}
