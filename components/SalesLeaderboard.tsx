// Žebříček obchodníků na /pipeline: kompaktní přehled nad daty, která
// buildSalesDashboard() (domain/crm/sales.ts) už počítá — obsahuje vždy
// každého vlastníka obchodu, role obchodník/vedení i s nulami, a řádek
// „Nepřiřazeno" pro obchody bez vlastníka. Řadíme od nejvyšší vážené
// pipeline, protože ta nejlíp odráží reálný stav rozjednaných obchodů.
import { DataTable } from '@/components/DataTable'
import { formatCzk } from '@/lib/format'
import type { SalesLeaderboardRow } from '@/domain/crm/sales'

export type SalesLeaderboardEntry = SalesLeaderboardRow & { dealCount: number }

export function SalesLeaderboard({ rows }: { rows: SalesLeaderboardEntry[] }) {
  const sorted = [...rows].sort((a, b) => b.weightedPipeline - a.weightedPipeline)
  return (
    <DataTable mobile="cards" label="Žebříček obchodníků"
      rows={sorted}
      empty="Žádný obchodník zatím nemá otevřený obchod."
      columns={[
        { header: 'Obchodník', cell: (row) => row.ownerName },
        { header: 'Otevřené obchody', cell: (row) => formatCzk(row.openPipeline) },
        { header: 'S pravděpodobností', cell: (row) => formatCzk(row.weightedPipeline) },
        { header: 'Vyhráno tento měsíc', cell: (row) => formatCzk(row.wonThisMonth) },
        { header: 'Počet obchodů', cell: (row) => row.dealCount },
      ]}
    />
  )
}
