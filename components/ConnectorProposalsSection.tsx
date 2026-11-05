import { createClient } from '@/lib/supabase/server'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { ConnectorBatchApprove, ConnectorProposalCard } from '@/components/ConnectorProposalCard'
import { blocksBulkApprove } from '@/domain/crm/connectorProposals'
import { listPendingConnectorProposals, type PendingConnectorProposal } from '@/domain/crm/connectorProposalService'

// Sekce /rozhodnuti: návrhy zakázek z konektoru (Claude, propose_deal(s) /
// propose_deal_update). Čte session klient — RLS mail_content_intake pustí jen
// obchodní roli s 2FA. Dávka (např. „Z odeslané pošty 20.–24. 10.") má
// „Schválit vše" jen pro položky bez varování; s varováním se schvaluje po jednom.
export type ConnectorProposalsState = Awaited<ReturnType<typeof listPendingConnectorProposals>>

/** Načte frontu pro stránku; chyba sítě/DB = karta s chybou, ne pád stránky. */
export async function loadConnectorProposals(): Promise<ConnectorProposalsState> {
  try {
    return await listPendingConnectorProposals(await createClient())
  } catch {
    return { state: 'error' }
  }
}

export function ConnectorProposalsSection({ res, canDecide }: { res: ConnectorProposalsState; canDecide: boolean }) {
  if (res.state === 'missing_migration') {
    return (
      <FeaturePending card migration="0099">
        Pak sem budou chodit návrhy zakázek z Claude (konektor) ke schválení.
      </FeaturePending>
    )
  }
  if (res.state === 'error') {
    return (
      <div className={CARD}>
        <EmptyState title="Návrhy zakázek z konektoru se nepodařilo načíst." action={{ href: '/cockpit/rozhodnuti', label: 'Zkusit znovu' }}>
          Zkus to prosím za chvíli.
        </EmptyState>
      </div>
    )
  }
  if (res.items.length === 0) return null

  const groups = new Map<string, { label: string; items: PendingConnectorProposal[] }>()
  for (const item of res.items) {
    const key = item.draft.batch?.id ?? ''
    const g = groups.get(key) ?? { label: item.draft.batch?.label ?? 'Jednotlivé návrhy', items: [] }
    g.items.push(item)
    groups.set(key, g)
  }

  return (
    <section aria-label="Zakázky navržené z konektoru" className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="m-0 text-title2 text-ink">Zakázky navržené z Claude ({res.items.length})</h2>
        <p className="m-0 mt-1 max-w-2xl text-callout text-muted">
          Claude je navrhl z pošty nebo dokumentů. Obchod vznikne až tvým schválením; klienta, cenu i stav můžeš předtím opravit.
          Klientovi se nic neposílá.
        </p>
      </div>
      {[...groups.entries()].map(([key, g]) => {
        const ready = g.items.filter((i) => !blocksBulkApprove(i.draft)).length
        return (
          <div key={key || 'single'} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="m-0 text-headline text-ink">{g.label}</h3>
              {key && canDecide && ready > 0 && <ConnectorBatchApprove batchId={key} ready={ready} total={g.items.length} />}
            </div>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {g.items.map((i) => <ConnectorProposalCard key={i.id} id={i.id} draft={i.draft} deal={i.deal} canDecide={canDecide} />)}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
