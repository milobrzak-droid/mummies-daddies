import { recordAudit } from '@/core/audit'
import { offerPdfFileName, renderOfferDocumentPdf } from '@/core/offerPdf'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { logError } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'
import { exportError, fileResponse, isCrossSiteRequest } from '@/lib/export/http'
import { PDF_CONTENT_TYPE } from '@/lib/export/pdf'
import { exportAuditPayload } from '@/domain/crm/exports'
import { canPrintScopeVersion, offerDocumentFromScopeVersion } from '@/domain/crm/offerPdfSource'
import { getScopeVersionForPdf } from '@/domain/crm/queries/scopeVersions'

// GET /cockpit/export/nabidka/<id verze> → PDF nabídky pro zákazníka
// z verze nabídky obchodu (deal_scope_version). Verze a částky jsou
// obchodní údaj: jen obchodní role (a RLS sales_only v DB). Do auditu jde
// id obchodu a verze, ne obsah.
export async function GET(req: Request, { params }: { params: Promise<{ verze: string }> }) {
  if (isCrossSiteRequest(req)) return exportError(403, 'Zakázáno.')
  const { verze } = await params
  const versionId = /^\d{1,15}$/.test(verze) ? Number(verze) : NaN
  if (!Number.isSafeInteger(versionId)) return exportError(400, 'Neplatné číslo verze nabídky.')

  const user = await tryRequireUser({ aal2: true })
  if (!user) return exportError(401, 'Nejsi přihlášený nebo nemáš ověřené dvoufázové přihlášení.')
  const { member } = await getCurrentMember()
  if (!memberSeesSales(member)) return exportError(403, 'Nabídky jsou jen pro obchod a vedení.')

  try {
    const version = await getScopeVersionForPdf(versionId)
    if (!version) return exportError(404, 'Verze nabídky neexistuje.')
    if (!canPrintScopeVersion(version)) return exportError(409, 'Nahrazenou nebo odmítnutou verzi zákazníkovi netiskneme.')
    const doc = offerDocumentFromScopeVersion(version, { today: pragueToday() })
    const bytes = await renderOfferDocumentPdf(doc)
    await recordAudit('export', 0, 'export.downloaded', null,
      exportAuditPayload('nabidka-pdf', 'pdf', null, { deal_id: version.deal_id, version_id: version.id }),
      { type: 'user', id: user.id })
    return fileResponse(bytes, offerPdfFileName(doc, `${version.deal_id}-v${version.version}`), PDF_CONTENT_TYPE)
  } catch (e) {
    logError('export.offerPdf', e, { versionId })
    return exportError(500, 'PDF nabídky se nepodařilo vytvořit.')
  }
}
