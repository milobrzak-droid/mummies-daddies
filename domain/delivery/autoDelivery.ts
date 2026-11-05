// Automatické založení dodávky po vyhrání obchodu (migrace 0080). Čisté
// funkce bez I/O: rozpoznání automaticky založené dodávky, shrnutí stavu
// dodávky u vyhraného obchodu pro kartu na detailu a překlad chyb RPC
// ensure_deal_delivery. Samotné zakládání dělá databáze (trigger
// deal_auto_delivery_*, jádro auto_delivery_create) — appka ho jen ukazuje
// a nabízí záložní tlačítko, kdyby dodávka z nějakého důvodu chyběla.
import { COMPANY } from '@/config'

/** engagement.origin u dodávky, kterou založil Cockpit po vyhrání obchodu. */
export const AUTO_DELIVERY_ORIGIN = 'auto_deal_won'

/** Verze migrace; bez ní dodávka po vyhrání sama nevzniká a RPC neexistuje. */
export const AUTO_DELIVERY_MIGRATION = '0080'

/** Významové auditní události, které zapisuje databáze (ne recordAudit). */
export const AUTO_DELIVERY_AUDIT_ACTIONS = {
  created: 'deal.delivery_auto_created',
  failed: 'deal.delivery_auto_failed',
} as const

/** SQLSTATE jádra: obchod není ve fázi Vyhráno (musí sedět s 0080). */
export const AUTO_DELIVERY_NOT_WON_CODE = 'AD001'

export const AUTO_DELIVERY_MISSING_MESSAGE =
  `Automatické zakládání dodávek čeká na migraci ${AUTO_DELIVERY_MIGRATION}. Zatím založ dodávku ručně na kartě klienta.`
export const AUTO_DELIVERY_NOT_WON_MESSAGE = 'Dodávku jde založit jen z vyhraného obchodu.'

type DbError = { code?: string | null; message?: string | null } | null | undefined

/** RPC ještě není v databázi (42883 = funkce neexistuje, PGRST202 = PostgREST ji nezná). */
export function isAutoDeliveryMissing(error: DbError): boolean {
  if (!error) return false
  if (error.code === '42883' || error.code === 'PGRST202') return true
  return /could not find the function .*ensure_deal_delivery|function .*ensure_deal_delivery.* does not exist/i.test(error.message ?? '')
}

/** Česká věta pro známé chyby RPC, jinak null (volající použije obecnou hlášku). */
export function autoDeliveryDbMessage(error: DbError): string | null {
  if (!error) return null
  if (isAutoDeliveryMissing(error)) return AUTO_DELIVERY_MISSING_MESSAGE
  if (error.code === AUTO_DELIVERY_NOT_WON_CODE) return AUTO_DELIVERY_NOT_WON_MESSAGE
  return null
}

export function isAutoDelivery(engagement: { origin?: string | null } | null | undefined): boolean {
  return engagement?.origin === AUTO_DELIVERY_ORIGIN
}

export type DealDeliveryRow = { id: number; origin?: string | null; kind: string; phase: string }

export type DealDeliverySummary =
  | { state: 'auto'; deliveries: DealDeliveryRow[] }
  | { state: 'manual'; deliveries: DealDeliveryRow[] }
  | { state: 'missing' }

/**
 * Stav dodávky u vyhraného obchodu: `auto` = aspoň jednu založil Cockpit,
 * `manual` = jen ruční, `missing` = žádná (záložní tlačítko). Automatická se
 * řadí první.
 */
export function summarizeDealDeliveries(deliveries: readonly DealDeliveryRow[]): DealDeliverySummary {
  if (deliveries.length === 0) return { state: 'missing' }
  const ordered = [...deliveries].sort((a, b) => Number(isAutoDelivery(b)) - Number(isAutoDelivery(a)) || a.id - b.id)
  return { state: ordered.some(isAutoDelivery) ? 'auto' : 'manual', deliveries: ordered }
}

/** Úkol pro vlastníka po založení dodávky (config.autoDelivery.startTask), null = firma to nedělá. */
export function startTaskInfo(): { title: string; workingDays: number } | null {
  const task = COMPANY.autoDelivery?.startTask
  return task ? { title: task.title, workingDays: task.workingDays } : null
}

/** „1 pracovního dne" / „3 pracovních dnů" (po „do"). */
export function workingDaysLabel(n: number): string {
  return n === 1 ? '1 pracovního dne' : `${n} pracovních dnů`
}

/** Výsledek RPC ensure_deal_delivery; null, když má neočekávaný tvar. */
export function parseEnsureResult(data: unknown): { engagementId: number; created: boolean } | null {
  if (!data || typeof data !== 'object') return null
  const { engagement_id, created } = data as { engagement_id?: unknown; created?: unknown }
  const id = Number(engagement_id)
  if (!Number.isSafeInteger(id) || id <= 0) return null
  return { engagementId: id, created: created === true }
}
