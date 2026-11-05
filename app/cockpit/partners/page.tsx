import { listPartners, listRegistrations } from '@/domain/crm/queries/partners'
import { DataTable } from '@/components/DataTable'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { Avatar } from '@/components/Avatar'
import { Chip, toneForKey } from '@/components/Chip'
import { ButtonLink } from '@/components/ui/Button'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ClientNumberTile } from '@/components/ui/ClientNumberTile'
import { ClientsTable, ClientsRowLink } from '@/components/ui/ClientsTable'
import { roleLabel } from '@/lib/domain'

// Partneři (doporučitelé, dodavatelé, distributoři): shrnutí nahoře, seznam
// s celým řádkem klikacím (vede na kartu partnera), registrace v programech pod ním.
export default async function PartnersPage() {
  const [partners, regs] = await Promise.all([listPartners(), listRegistrations()])
  const referrers = partners.filter((p) => p.roles?.includes('referrer')).length
  const suppliers = partners.filter((p) => p.roles?.includes('supplier')).length
  const registered = new Set(regs.map((r) => r.partner_id)).size
  return (
    <>
      <PageHeader title="Partneři" eyebrow="Co-selleři" subtitle="Kdo nám klienty doporučuje, dodává a s kým jsme v programech výrobců.">
        <ButtonLink href="/cockpit/partners/new" variant="primary">Založit partnera</ButtonLink>
      </PageHeader>
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />

      <div className="grid gap-4 mb-6 md:grid-cols-3">
        <ClientNumberTile
          tone="pink" label="Partneři" value={String(partners.length)}
          caption={partners.length === 1 ? 'partner v evidenci' : partners.length >= 2 && partners.length <= 4 ? 'partneři v evidenci' : 'partnerů v evidenci'}
          cells={[
            { label: 'Doporučitelé', value: String(referrers) },
            { label: 'Dodavatelé', value: String(suppliers) },
          ]}
        />
        <ClientNumberTile
          tone="sky" label="Programy" value={String(regs.length)}
          caption={regs.length === 1 ? 'registrace v programu' : regs.length >= 2 && regs.length <= 4 ? 'registrace v programech' : 'registrací v programech'}
          cells={[{ label: 'Partnerů s registrací', value: String(registered) }]}
        />
      </div>

      {partners.length === 0 ? (
        <div className={CARD}>
          <EmptyState title="Zatím žádní partneři." action={{ href: '/cockpit/partners/new', label: 'Založit partnera' }}>
            Doporučitelé a dodavatelé se ukážou tady; u klienta pak jde říct, přes koho přišel.
          </EmptyState>
        </div>
      ) : (
        <ClientsTable label="Partneři" mobile="cards" rows={partners} rowKey={(p) => p.id} columns={[
          {
            header: 'Název',
            cell: (p) => (
              <div className="flex items-center gap-3">
                <Avatar name={p.name} size={32} />
                <ClientsRowLink href={`/cockpit/partners/${p.id}/edit`}>{p.name}</ClientsRowLink>
              </div>
            ),
          },
          { header: 'Sektor', cell: (p) => (p.kind ? <Chip tone="neutral">{p.kind}</Chip> : <span className="text-muted">—</span>) },
          {
            header: 'Role',
            cell: (p) => (p.roles?.length ? (
              <div className="flex flex-wrap gap-1">
                {p.roles.map((r) => (
                  <Chip key={r} tone={r === 'referrer' ? 'violet' : r === 'supplier' ? 'blue' : 'neutral'}>{roleLabel(r)}</Chip>
                ))}
              </div>
            ) : <span className="text-muted">—</span>),
          },
          { header: 'Přes koho', cell: (p) => p.via?.name ?? <span className="text-muted">—</span> },
        ]} />
      )}

      <h2 className="m-0 mt-10 mb-3 font-heading text-title1 font-bold">Registrace v programech</h2>
      <DataTable mobile="cards"
        label="Registrace v programech"
        rows={regs}
        empty="Zatím žádné registrace v programech."
        emptyHint="Registrace se zapisují na kartě partnera."
        columns={[
          { header: 'Partner', cell: (r) => r.partner_name },
          { header: 'Program', cell: (r) => <Chip tone={toneForKey(r.program)}>{r.program}</Chip> },
          { header: 'Stav', cell: (r) => <Chip tone={toneForKey(r.status)}>{r.status}</Chip> },
          { header: 'Poznámka', cell: (r) => r.tier_note ?? <span className="text-muted">—</span> },
        ]}
      />
    </>
  )
}
