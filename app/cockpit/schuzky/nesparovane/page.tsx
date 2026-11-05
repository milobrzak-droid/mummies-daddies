import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { UnmatchedNoteCard } from '@/components/UnmatchedNoteCard'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { listQueuedNotes } from '@/domain/crm/queries/meetingIntake'

export const dynamic = 'force-dynamic'

// Fronta zápisů z diktátu (Wispr Flow → POST /api/ingest/meeting-notes),
// které Cockpit nespároval na klienta jistě: neznámá firma, víc kandidátů,
// nebo bez nápovědy a bez jmenované firmy. Jen obchodní role (zápis ze
// schůzky je obchodní data — RLS 0078).
export default async function UnmatchedNotesPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const notes = await listQueuedNotes(50)

  return (
    <>
      <PageHeader
        title="Nespárované zápisy"
        eyebrow="Práce · Schůzky"
        back={{ href: '/cockpit/schuzky', label: 'Schůzky' }}
        subtitle={notes.length === 0
          ? 'Všechny zápisy z diktátu jsou přiřazené ke klientům.'
          : `Čeká ${notes.length} ${notes.length === 1 ? 'zápis' : notes.length < 5 ? 'zápisy' : 'zápisů'}, u kterých si Cockpit nebyl jistý klientem. Vyber klienta, nebo zápis zahoď.`}
      />
      <p className="mb-6 max-w-xl text-callout text-muted">
        Po přiřazení vznikne u klienta aktivita „schůzka“ a — jsou-li v textu řádky „úkol: …“ — návrh
        kroků ke schválení v <Link href="/cockpit/pripady?view=navrhy" className="underline">Případech</Link>.
        Zahozený zápis se smaže včetně textu. Jak zápis poslat: <code>docs/PROVOZ.md</code>.
      </p>
      {notes.length === 0 ? (
        <div className={CARD}>
          <EmptyState tone="calm" title="Nic k přiřazení" action={{ href: '/cockpit/schuzky', label: 'Zpět na schůzky' }}>
            Nový nejistý zápis z Wispr Flow se objeví tady.
          </EmptyState>
        </div>
      ) : (
        <ul className="m-0 list-none space-y-4 p-0">
          {notes.map((n) => <UnmatchedNoteCard key={n.id} note={n} />)}
        </ul>
      )}
    </>
  )
}
