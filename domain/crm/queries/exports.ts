// Načtení dat exportu přehledu. Každý přehled čte STEJNÉ dotazy jako jeho
// stránka (domain/crm/queries/*) přes RLS klienta přihlášeného uživatele
// (createClient) a stejně filtruje — export tak nikdy neukáže víc, než
// člověk vidí v Cockpitu. Service role se tu nepoužívá.
import type { ExportDocument } from '@/lib/export/table'
import { pragueToday } from '@/lib/pragueDate'
import { isScopeVersionStatus } from '@/domain/crm/scopeVersion'
import { SHOP_ORDER_STATUSES, type ShopOrderStatus } from '@/core/cheesecakeOrder'
import { getSalesActivities, getSalesDeals, listContacts } from '@/domain/crm/queries/sales'
import { getMyTasks, getTasks, listAssignableMembers } from '@/domain/crm/queries/tasks'
import { listAccountsPage, type AccountListRow } from '@/domain/crm/queries/accountList'
import { listScopeVersionsForExport } from '@/domain/crm/queries/scopeVersions'
import { listShopOrdersForExport } from '@/domain/crm/queries/shopOrderExport'
import {
  EMPTY_STATUS_SETS, deriveStatusSets, parseAccountListParams, rankByOpenPipeline,
} from '@/domain/crm/accountList'
import { filterPipelineDeals, parsePipelineParams } from '@/domain/crm/pipelineFilter'
import { parseWeekChoice, weekWindow } from '@/domain/crm/changes'
import {
  ACTIVITY_COLUMNS, CONTACT_COLUMNS, OFFER_COLUMNS, SHOP_ORDER_COLUMNS,
  clientColumns, clientFilters, clientRows, contactRows, exportDocument, offerFilters, pipelineFilters, pipelineTable,
  shopOrderFilters, taskColumns, type ExportPrehled,
} from '@/domain/crm/exports'
import { buildWeeklyLeadershipReport, weeklyLeadershipDocument } from '@/domain/crm/weeklyLeadershipReport'
import { toExportTable } from '@/lib/export/table'

export type ExportViewer = {
  /** Jméno do hlavičky souboru („Exportoval/a"). */
  name: string | null
  canSeeSales: boolean
}

type Raw = Record<string, string | string[] | undefined>
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Stejný počet aktivit jako na stránce by byl málo; export bere delší historii. */
export const ACTIVITY_EXPORT_LIMIT = 5000
/** Pojistka proti nekonečnému stránkování seznamu klientů (50 × 400 = 20 000 firem). */
const MAX_ACCOUNT_PAGES = 400

async function memberNames(): Promise<Map<string, string>> {
  const members = await listAssignableMembers()
  return new Map(members.map((m) => [m.id, m.full_name]))
}

/** Celý seznam klientů se stejnými filtry a řazením jako /cockpit/clients (stránku po stránce). */
async function allAccounts(raw: Raw, canSeeSales: boolean) {
  const params = parseAccountListParams(raw, { canSeeSales })
  const deals = canSeeSales ? await getSalesDeals() : []
  const sets = canSeeSales ? deriveStatusSets(deals) : EMPTY_STATUS_SETS
  const ranking = canSeeSales && params.sort === 'pipeline' ? rankByOpenPipeline(deals) : []
  const rows: AccountListRow[] = []
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page++) {
    const res = await listAccountsPage({ ...params, page }, sets, ranking)
    // listAccountsPage ořízne stránku za koncem na poslední — tím seznam končí.
    if (res.page !== page) break
    rows.push(...res.rows)
    if (page >= res.pageCount || res.rows.length === 0) break
  }
  return { params, deals, sets, rows }
}

/**
 * Dokument exportu přehledu. Oprávnění (EXPORT_ACCESS) hlídá volající
 * (route handler) dřív, než sem sáhne; RLS v DB platí vždy navíc.
 */
export async function loadExportDocument(prehled: ExportPrehled, raw: Raw, viewer: ExportViewer, now: Date = new Date()): Promise<ExportDocument> {
  const meta = { generatedAt: now, generatedBy: viewer.name }
  switch (prehled) {
    case 'pipeline': {
      const params = parsePipelineParams(raw)
      const [deals, members] = await Promise.all([getSalesDeals(), memberNames()])
      return exportDocument('pipeline', [pipelineTable(filterPipelineDeals(deals, params))], pipelineFilters(params, members), meta)
    }
    case 'klienti': {
      const [{ params, deals, sets, rows }, contacts, members] = await Promise.all([
        allAccounts(raw, viewer.canSeeSales), listContacts(), memberNames(),
      ])
      return exportDocument('klienti', [
        toExportTable('Klienti', clientColumns(viewer.canSeeSales), clientRows(rows, deals, sets), { emptyText: 'Žádní klienti pro zvolené filtry.' }),
        toExportTable('Kontakty', CONTACT_COLUMNS, contactRows(contacts, rows), { emptyText: 'Vybrané firmy nemají kontakty.' }),
      ], clientFilters(params, members), meta)
    }
    case 'aktivity': {
      const activities = await getSalesActivities(ACTIVITY_EXPORT_LIMIT)
      return exportDocument('aktivity', [toExportTable('Aktivity', ACTIVITY_COLUMNS, activities, { emptyText: 'Tým zatím nic nezapsal.' })], [], meta)
    }
    case 'ukoly': {
      const view = first(raw.view) === 'team' ? 'team' : 'mine'
      const [all, members] = await Promise.all([view === 'mine' ? getMyTasks() : getTasks(), memberNames()])
      // Stejná pojistka jako na stránce: název obchodu jen obchodním rolím.
      const tasks = viewer.canSeeSales ? all : all.map((t) => ({ ...t, deal: null }))
      return exportDocument('ukoly', [toExportTable('Úkoly', taskColumns(members, viewer.canSeeSales), tasks, { emptyText: 'Žádné úkoly.' })],
        [{ label: 'Čí úkoly', value: view === 'team' ? 'celý tým' : 'moje' }], meta)
    }
    case 'nabidky': {
      const status = first(raw.stav) ?? null
      const valid = status && isScopeVersionStatus(status) ? status : null
      const offers = await listScopeVersionsForExport(valid)
      return exportDocument('nabidky', [toExportTable('Nabídky', OFFER_COLUMNS, offers, { emptyText: 'Žádné verze nabídek.' })], offerFilters(valid), meta)
    }
    case 'objednavky': {
      const status = first(raw.stav) ?? null
      const valid = status && (SHOP_ORDER_STATUSES as readonly string[]).includes(status) ? (status as ShopOrderStatus) : null
      const orders = await listShopOrdersForExport(valid)
      return exportDocument('objednavky', [toExportTable('Objednávky', SHOP_ORDER_COLUMNS, orders, { emptyText: 'Žádné objednávky.' })], shopOrderFilters(valid), meta)
    }
    case 'tydenni-prehled': {
      const today = pragueToday(now)
      const window = weekWindow(today, parseWeekChoice(raw.tyden, today))
      const [deals, offers] = await Promise.all([getSalesDeals(), listScopeVersionsForExport()])
      const report = buildWeeklyLeadershipReport({ deals, offers, range: window, generatedAt: now })
      return weeklyLeadershipDocument(report, viewer.name)
    }
  }
}
