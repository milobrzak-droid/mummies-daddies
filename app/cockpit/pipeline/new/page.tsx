import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { buttonClass } from '@/components/ui/Button'
import { AccountPicker } from '@/components/AccountPicker'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getAccountOption } from '@/domain/crm/queries/accounts'

export const dynamic = 'force-dynamic'

export default async function NewPipelineDealPage({
  searchParams,
}: { searchParams: Promise<{ account?: string }> }) {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  // Klient se hledá (AccountPicker) — ověří se jen ten zvolený, ne celý seznam firem.
  const selected = await getAccountOption(Number((await searchParams).account))
  if (selected) redirect(`/cockpit/clients/${selected.id}/deals/new`)

  return (
    <>
      <PageHeader title="Nový obchod" eyebrow="Obchody" subtitle="Nejdřív vyber klienta, ke kterému obchod patří." back={{ href: '/cockpit/pipeline', label: 'Obchody' }} />
      <form className="max-w-xl space-y-4 rounded-card border border-border bg-surface p-6 shadow-card">
        <label className="block text-callout text-muted">
          Klient
          <div className="mt-1.5">
            <AccountPicker name="account" required />
          </div>
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" className={buttonClass('primary')}>Pokračovat</button>
          <Link href="/cockpit/clients/new" className="text-callout text-muted">Klient ještě neexistuje? Založit ho →</Link>
        </div>
      </form>
    </>
  )
}
