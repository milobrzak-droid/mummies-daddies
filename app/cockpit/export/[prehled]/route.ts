import { COMPANY } from '@/config'
import { recordAudit } from '@/core/audit'
import { isModuleOn } from '@/core/modules'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { logError } from '@/lib/log'
import { isExportFormat } from '@/lib/export/href'
import { exportError, fileResponse, isCrossSiteRequest } from '@/lib/export/http'
import { exportFileName } from '@/lib/export/table'
import { renderXlsx, XLSX_CONTENT_TYPE } from '@/lib/export/xlsx'
import { renderTablePdf, PDF_CONTENT_TYPE } from '@/lib/export/pdf'
import { EXPORT_ACCESS, exportAuditPayload, isExportPrehled } from '@/domain/crm/exports'
import { loadExportDocument } from '@/domain/crm/queries/exports'

// GET /cockpit/export/<přehled>?format=xlsx|pdf&<stejné filtry jako stránka>
//
// Cockpit je za přihlášením (proxy.ts → lib/supabase/middleware.ts), brána
// se ale vynucuje i tady: interní role + AAL2, obchodní přehledy jen
// obchodním rolím (EXPORT_ACCESS). Data čte loadExportDocument stejnými
// dotazy jako stránka přes RLS uživatele. Do auditu jde kdo a co
// (přehled, formát, počet řádků, názvy filtrů), nikdy obsah.
export async function GET(req: Request, { params }: { params: Promise<{ prehled: string }> }) {
  if (isCrossSiteRequest(req)) return exportError(403, 'Zakázáno.')
  const { prehled } = await params
  if (!isExportPrehled(prehled)) return exportError(404, 'Takový přehled neexistuje.')
  const url = new URL(req.url)
  const format = url.searchParams.get('format') ?? 'xlsx'
  if (!isExportFormat(format)) return exportError(400, 'Formát musí být xlsx nebo pdf.')

  const user = await tryRequireUser({ aal2: true })
  if (!user) return exportError(401, 'Nejsi přihlášený nebo nemáš ověřené dvoufázové přihlášení.')
  const { member } = await getCurrentMember()
  const canSeeSales = memberSeesSales(member)
  if (EXPORT_ACCESS[prehled] === 'sales' && !canSeeSales) return exportError(403, 'Tenhle přehled je jen pro obchod a vedení.')
  if (prehled === 'objednavky' && !isModuleOn(COMPANY.modules, 'shopOrders')) return exportError(404, 'Modul objednávek je vypnutý.')
  if (prehled === 'agent' && !isModuleOn(COMPANY.modules, 'agent')) return exportError(404, 'Modul agenta je vypnutý.')

  const raw: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key)
    raw[key] = all.length > 1 ? all : all[0]
  }

  try {
    const doc = await loadExportDocument(prehled, raw, { name: member?.full_name ?? null, canSeeSales })
    const bytes = format === 'xlsx' ? await renderXlsx(doc) : await renderTablePdf(doc)
    await recordAudit('export', 0, 'export.downloaded', null, exportAuditPayload(prehled, format, doc), { type: 'user', id: user.id })
    return fileResponse(bytes, exportFileName(doc, format), format === 'xlsx' ? XLSX_CONTENT_TYPE : PDF_CONTENT_TYPE)
  } catch (e) {
    logError('export', e, { prehled, format })
    return exportError(500, 'Export se nepodařil. Zkus to prosím znovu.')
  }
}
