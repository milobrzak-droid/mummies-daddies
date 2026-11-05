// Retence údajů z webu (GDPR, balík P6): denní úloha volá RPC
// web_intake_retention z migrace 0106 (spam pryč po 30 dnech, vyřízené
// poptávky anonymizované po 12 měsících, předané či zrušené objednávky
// po 24 měsících). Do logu ani do odpovědi nejdou osobní údaje, jen počty.
//
// VÝCHOZÍ VYPNUTO: bez WEB_RETENTION_ENABLED=true route vrací 404.
export { isCronAuthorized } from '@/domain/crm/digestDelivery'

export const WEB_RETENTION_RPC = 'web_intake_retention'

export function webRetentionEnabled(env: Record<string, string | undefined>): boolean {
  return env.WEB_RETENTION_ENABLED === 'true'
}

export type RetentionCounts = { spam_deleted: number; inquiries_anonymized: number; orders_anonymized: number }

type RpcError = { code?: string; message?: string } | null
export type RetentionRpc = (fn: string) => PromiseLike<{ data: unknown; error: RpcError }>

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Spustí retenci. Chybu vrací jen jako kód (žádný text z databáze). */
export async function runWebRetention(rpc: RetentionRpc): Promise<{ ok: true; counts: RetentionCounts } | { ok: false; code: string }> {
  const { data, error } = await rpc(WEB_RETENTION_RPC)
  if (error) {
    // Dokud chybí migrace 0106 (PGRST202 / 42883), úloha nic nemění.
    return { ok: false, code: error.code ?? 'unknown' }
  }
  const d = (data ?? {}) as Record<string, unknown>
  return { ok: true, counts: { spam_deleted: count(d.spam_deleted), inquiries_anonymized: count(d.inquiries_anonymized), orders_anonymized: count(d.orders_anonymized) } }
}
