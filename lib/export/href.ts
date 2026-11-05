// Odkazy na exporty Cockpitu: /cockpit/export/<přehled>?format=xlsx|pdf&<filtry>.
// Filtry jsou stejné parametry, jaké má v adrese stránka přehledu.
import { COCKPIT_PREFIX } from '@/lib/routes'

export type ExportFormat = 'xlsx' | 'pdf'
export const EXPORT_FORMATS: readonly ExportFormat[] = ['xlsx', 'pdf']

export type ExportParams = Readonly<Record<string, string | number | null | undefined | readonly string[]>>

/** Parametry, které export nepřebírá (stránkování a formát řeší export sám). */
const DROPPED = new Set(['format', 'page'])

export function exportHref(prehled: string, format: ExportFormat, params: ExportParams = {}): string {
  const qs = new URLSearchParams({ format })
  for (const [key, raw] of Object.entries(params)) {
    if (DROPPED.has(key)) continue
    const values = Array.isArray(raw) ? raw : [raw]
    for (const v of values) {
      if (v === null || v === undefined || v === '') continue
      qs.append(key, String(v))
    }
  }
  return `${COCKPIT_PREFIX}/export/${encodeURIComponent(prehled)}?${qs.toString()}`
}

export function isExportFormat(v: unknown): v is ExportFormat {
  return v === 'xlsx' || v === 'pdf'
}

/** PDF nabídky pro zákazníka z verze nabídky obchodu. */
export function offerPdfHref(versionId: number): string {
  return `${COCKPIT_PREFIX}/export/nabidka/${versionId}`
}
