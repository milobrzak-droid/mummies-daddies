import { buttonClass } from '@/components/ui/Button'
import { exportHref, type ExportParams } from '@/lib/export/href'

// Dvě tlačítka „Excel" a „PDF" do záhlaví přehledu. Předají aktuální filtry
// stránky (stejné parametry jako v adrese), takže soubor obsahuje přesně to,
// co je vidět. Obyčejné <a> s download, ne next/link: export je GET se
// záznamem do auditu a nesmí se přednačítat (prefetch).
export function ExportButtons({
  prehled,
  params = {},
  label = 'Stáhnout přehled',
  title,
  formats = ['xlsx', 'pdf'],
}: {
  prehled: string
  params?: ExportParams
  /** Přístupný popis skupiny (čtečky obrazovky). */
  label?: string
  /** Viditelný popisek před tlačítky, když je na stránce víc exportů („Nabídky"). */
  title?: string
  formats?: readonly ('xlsx' | 'pdf')[]
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap items-center gap-2">
      {title && <span className="text-footnote font-semibold text-muted">{title}</span>}
      {formats.includes('xlsx') && (
        <a href={exportHref(prehled, 'xlsx', params)} download className={buttonClass('outline')} rel="nofollow">
          Excel
        </a>
      )}
      {formats.includes('pdf') && (
        <a href={exportHref(prehled, 'pdf', params)} download className={buttonClass('outline')} rel="nofollow">
          PDF
        </a>
      )}
    </div>
  )
}
