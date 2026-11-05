import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { ImportOfferForm } from '@/components/ImportOfferForm'
import { ButtonLink } from '@/components/ui/Button'
import { canCurrentUserSeeSales } from '@/lib/queries/access'

// Čtení PDF modelem běží v server akci této stránky (proposeOffersFromPdfs) a
// ta dědí maxDuration stránky: volání modelu má strop 50 s
// (OFFER_PDF_TIMEOUT_MS), soubory se čtou souběžně, zbytek minuty je na
// uložení. Velikost: všechna PDF dohromady nejvýš 4 MB (bodySizeLimit).
export const maxDuration = 60

// Import nabídky zakládá obchod s částkami — jen obchodní role (0058).
// Výstup AI je jen návrh; obchod vzniká až po potvrzení (components/OfferProposalReview).
export default async function ImportOfferPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  return (
    <>
      <PageHeader
        title="Nahrát nabídku"
        eyebrow="Obchody · import z Coworku"
        back={{ href: '/cockpit/pipeline', label: 'Obchody' }}
        subtitle="Nahraj PDF nabídky — AI z něj připraví návrh klienta a projektu. Nic se nezaloží, dokud návrh nezkontroluješ a nepotvrdíš."
      >
        <ButtonLink href="/cockpit/import/zakazky" variant="outline">Import běžících zakázek</ButtonLink>
      </PageHeader>
      <ImportOfferForm />
    </>
  )
}
