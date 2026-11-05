import { Card } from '@/components/ui/Card'
import { Chip } from '@/components/Chip'
import { DataTable } from '@/components/DataTable'
import { formatCzk } from '@/lib/format'
import type { ShopOrderOverview } from '@/domain/crm/shopOrderOverview'

// Objednávky cheesecaků z webu (P5): počty a tržba za období a nejbližší
// nepředané objednávky. Bez jména, kontaktu, adresy a věnování — detail a
// změna stavu jsou na stránce Objednávky (/cockpit/objednavky, balík P6).

const STATUS_TONE: Record<string, string> = { new: 'warn', confirmed: 'info', ready: 'pos', handed_over: 'neutral', cancelled: 'neg' }

export function ShopOrderOverviewCard({ shop, days }: { shop: ShopOrderOverview; days: number }) {
  return (
    <Card title="Objednávky cheesecaků z webu" sub={`Za posledních ${days} dní a nejbližší předání`} href="/cockpit/objednavky" hrefLabel="Všechny objednávky">
      <dl className="m-0 mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div><dt className="eyebrow">Přijato</dt><dd className="m-0 mt-1 big-num text-[28px] text-ink tabular-nums">{shop.received}</dd></div>
        <div><dt className="eyebrow">Tržba vč. DPH</dt><dd className="m-0 mt-1 big-num whitespace-nowrap text-[28px] text-ink tabular-nums">{formatCzk(shop.revenueCzk)}</dd></div>
        <div><dt className="eyebrow">Čeká na potvrzení</dt><dd className="m-0 mt-1 big-num text-[28px] text-ink tabular-nums">{shop.awaitingConfirmation}</dd></div>
        <div><dt className="eyebrow">Zrušeno</dt><dd className="m-0 mt-1 big-num text-[28px] text-ink tabular-nums">{shop.cancelled}</dd></div>
      </dl>
      <DataTable mobile="cards" label="Nejbližší předání objednávek"
        rows={shop.upcoming}
        empty="Žádná objednávka nečeká na předání."
        columns={[
          { header: 'Předání', cell: (o) => new Date(`${o.day}T12:00:00`).toLocaleDateString('cs-CZ') },
          { header: 'Objednávka', cell: (o) => `č. ${o.id}` },
          { header: 'Položky', cell: (o) => o.items },
          { header: 'Způsob', cell: (o) => o.fulfilmentLabel },
          { header: 'Cena', cell: (o) => formatCzk(o.totalCzk), align: 'right' },
          { header: 'Stav', cell: (o) => <Chip dot tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.statusLabel}</Chip> },
        ]}
      />
    </Card>
  )
}
