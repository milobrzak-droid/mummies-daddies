import { redirect } from 'next/navigation'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { PageHeader } from '@/components/PageHeader'
import { BulkImport } from '@/components/BulkImport'
import { ImportBatchHistory } from '@/components/ImportBatchHistory'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ButtonLink } from '@/components/ui/Button'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { createClient } from '@/lib/supabase/server'
import { logError } from '@/lib/log'
import { listImportMembers } from '@/domain/crm/bulkImportService'
import { listImportBatches } from '@/domain/crm/queries/importBatches'
import type { ImportMember } from '@/domain/crm/bulkImport'

// Hromadný import běžících zakázek (migrace 0098, docs/PROVOZ.md).
// Zakládá obchody s cenami, proto jen obchodní role (0058); zápis dělá server
// přes servisní klíč a databázová funkce znovu ověří roli. Čtení PDF umělou
// inteligencí se ukáže jen s klíčem ANTHROPIC_API_KEY; tabulka funguje vždy.
// Každé PDF je jedno volání serveru (až desítky sekund), proto delší limit.
export const maxDuration = 60

export default async function BulkImportPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const { user, member } = await getCurrentMember()
  const pdfEnabled = !!process.env.ANTHROPIC_API_KEY

  let members: ImportMember[] = []
  try {
    members = await listImportMembers(await createClient())
  } catch (e) {
    logError('page.bulkImport.members', e)
  }
  const history = await listImportBatches()

  return (
    <>
      <PageHeader
        title="Import běžících zakázek"
        eyebrow="Obchody · hromadný import"
        back={{ href: '/cockpit/pipeline', label: 'Obchody' }}
        subtitle="Nahraj víc zakázek najednou z tabulky nebo z PDF nabídek. Každý řádek zkontroluješ a potvrdíš, nic se nezaloží samo. Chybný import jde vrátit."
      >
        <ButtonLink href="/cockpit/nabidka/import" variant="outline">Nahrát jednu nabídku</ButtonLink>
      </PageHeader>

      {history.state === 'missing_migration' ? (
        <Card>
          <FeaturePending migration="0098">Hromadný import zatím nic nezapisuje.</FeaturePending>
        </Card>
      ) : (
        <div className="space-y-6">
          <BulkImport pdfEnabled={pdfEnabled} members={members} meId={user?.id ?? ''} isAdmin={member?.is_admin ?? false} />
          <Card title="Dřívější importy" sub="Poslední dávky. „Vrátit import“ smaže jen to, co dávka vytvořila a na čem od té doby nikdo nepracoval.">
            {history.state === 'error' ? (
              <p role="alert" className="m-0 text-callout text-neg">Historii importů se nepodařilo načíst.</p>
            ) : history.batches.length === 0 ? (
              <EmptyState title="Zatím žádný import" compact>Po prvním potvrzeném řádku se tu objeví dávka i s tlačítkem pro vrácení.</EmptyState>
            ) : (
              <ImportBatchHistory batches={history.batches} />
            )}
          </Card>
        </div>
      )}
    </>
  )
}
